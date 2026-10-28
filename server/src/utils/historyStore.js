'use strict';

/**
 * 历史采样存储：零依赖，按天分文件的 JSONL。
 *
 * 为什么不用 SQLite：
 *  - Node 24 才内置 node:sqlite，而镜像基于 node:20-alpine，老版本上没有；
 *  - 引入 better-sqlite3 需要编译工具链，会让 NAS 上的镜像构建变慢变脆；
 *  - 这个场景写入频率极低（默认每小时一条快照），JSONL 完全够用，
 *    而且用户可以直接用文本工具查看/导出。
 *
 * 文件布局：<CONFIG_DIR>/history/YYYY-MM-DD.jsonl
 * 每行一个快照：{ t: 毫秒时间戳, sites: [...], sys: {...}, docker: {...} }
 */

const fs = require('fs');
const path = require('path');

const MAX_POINTS_FOR_CHART = 400; // 图表最多返回的点数，超出按桶聚合

class HistoryStore {
  constructor(dir) {
    this.dir = dir;
    this.keepDays = 30;
    this._lastPruneDay = '';
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* ignore */ }
  }

  _fileFor(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return path.join(this.dir, `${y}-${m}-${d}.jsonl`);
  }

  // 追加一条快照（同步写：频率很低，且要保证进程崩溃前已落盘）
  append(snapshot) {
    this._ensureDir();
    const line = JSON.stringify({ t: Date.now(), ...snapshot });
    fs.appendFileSync(this._fileFor(new Date()), line + '\n', 'utf-8');
    this._maybePrune();
  }

  // 读取某天的快照
  readDay(date) {
    const f = this._fileFor(date);
    let raw;
    try { raw = fs.readFileSync(f, 'utf-8'); } catch (e) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (e) { /* 跳过损坏行，不影响整体 */ }
    }
    return out;
  }

  // 读取最近 days 天
  readRange(days) {
    const out = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      out.push(...this.readDay(d));
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // 超过保留期的日文件自动删除（每天最多检查一次）
  _maybePrune() {
    const todayKey = this._fileFor(new Date()).slice(-16, -6);
    if (this._lastPruneDay === todayKey) return;
    this._lastPruneDay = todayKey;
    let files;
    try { files = fs.readdirSync(this.dir); } catch (e) { return; }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(1, this.keepDays));
    const cutoffName = this._fileFor(cutoff).split(path.sep).pop();
    for (const f of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      if (f < cutoffName) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* ignore */ }
      }
    }
  }

  /**
   * 聚合为图表数据。
   * @param {Array} snapshots 原始快照
   * @param {number} maxPoints 最多返回点数
   * @returns {{ points: Array, buckets: number }}
   */
  static buildSeries(snapshots, maxPoints) {
    const limit = maxPoints || MAX_POINTS_FOR_CHART;
    if (snapshots.length <= limit) {
      return { points: snapshots.map(s => HistoryStore._flatten(s)), buckets: snapshots.length };
    }
    // 分桶：每桶取最后一条（保留最新值），避免平均掉峰谷
    const bucketSize = Math.ceil(snapshots.length / limit);
    const points = [];
    for (let i = 0; i < snapshots.length; i += bucketSize) {
      const chunk = snapshots.slice(i, i + bucketSize);
      if (chunk.length) points.push(HistoryStore._flatten(chunk[chunk.length - 1]));
    }
    return { points, buckets: bucketSize };
  }

  // 把快照压成图表要用的扁平结构
  static _flatten(s) {
    const sites = s.sites || {};
    // sites 是 { siteId: { online, ratio, uploaded, downloaded, seeding, bonus } }
    let up = 0, down = 0, online = 0, total = 0, seeding = 0;
    const perSite = {};
    for (const id of Object.keys(sites)) {
      const v = sites[id] || {};
      total++;
      if (v.online) online++;
      up += Number(v.uploaded) || 0;
      down += Number(v.downloaded) || 0;
      seeding += Number(v.seeding) || 0;
      perSite[id] = {
        on: v.online ? 1 : 0,
        r: v.ratio == null ? null : Number(v.ratio),
        u: Number(v.uploaded) || 0,
        d: Number(v.downloaded) || 0
      };
    }
    return {
      t: s.t,
      siteOn: online,
      siteTotal: total,
      up,
      down,
      seeding,
      cpu: s.sys && s.sys.cpu != null ? s.sys.cpu : null,
      mem: s.sys && s.sys.mem != null ? s.sys.mem : null,
      disk: s.sys && s.sys.disk != null ? s.sys.disk : null,
      dl: s.down && s.down.down != null ? s.down.down : null,
      ul: s.down && s.down.up != null ? s.down.up : null,
      sites: perSite
    };
  }
}

module.exports = { HistoryStore, MAX_POINTS_FOR_CHART };
