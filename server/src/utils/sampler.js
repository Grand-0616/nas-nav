'use strict';

/**
 * 后台采样器：定时抓一次现状 → 写历史 → 跑告警规则。
 *
 * 为什么放在后台而不是「前端轮询时顺手写」：
 *  - 只有有人打开页面才有数据，NAS 面板大部分时间没人看，趋势会断档；
 *  - 前端刷新频率（15s/60s）与采样频率（1 小时）不是一个量级，混在一起会写出海量数据。
 */

const { HistoryStore } = require('./historyStore');

let timer = null;
let running = false;
let lastRunAt = 0;
let lastError = null;
let lastResult = null;

/**
 * 启动 / 重载采样器。配置变更时调用即可。
 * @param {object} deps {
 *   getConfig, historyStore, collectSites, getSystemStatus,
 *   listContainers, getAllDownloaderStatus, alerter
 * }
 */
function start(deps) {
  stop();
  schedule(deps);
}

function schedule(deps) {
  const cfg = deps.getConfig();
  const h = cfg.history || {};
  if (h.enabled === false) return; // 用户关闭了历史采样与告警巡检
  const intervalMin = Math.min(1440, Math.max(5, Number(h.intervalMin) || 60));
  const intervalMs = intervalMin * 60 * 1000;
  timer = setInterval(() => { runOnce(deps).catch(e => { lastError = e.message; }); }, intervalMs);
  if (timer.unref) timer.unref(); // 不阻止进程退出
  // 启动后先跑一次（延迟 30s，避开启动时的配置初始化）
  const boot = setTimeout(() => { runOnce(deps).catch(e => { lastError = e.message; }); }, 30000);
  if (boot.unref) boot.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 执行一次采样 + 告警判定。
 * @returns {Promise<object>} { ok, at, snapshot, alerts }
 */
async function runOnce(deps, opts) {
  if (running) return { ok: false, skipped: true, reason: '上一次采样尚未结束' };
  running = true;
  const startedAt = Date.now();
  try {
    const cfg = deps.getConfig();

    // 1) 站点：复用主流程的缓存/抓取逻辑，避免重复打 PT 站
    let sites = [];
    try { sites = await deps.collectSites(); } catch (e) { lastError = '站点采集失败：' + e.message; }

    // 2) 系统
    let sys = null;
    try {
      const s = deps.getSystemStatus();
      sys = {
        cpu: s.cpu ? s.cpu.pct : null,
        mem: s.mem ? s.mem.pct : null,
        disk: s.disk ? s.disk.pct : null
      };
    } catch (e) { /* ignore */ }

    // 3) 下载器
    let down = { down: null, up: null };
    try {
      const dl = await deps.getAllDownloaderStatus();
      const online = dl.filter(d => d.online);
      down = {
        down: online.reduce((a, d) => a + (d.downSpeed || 0), 0),
        up: online.reduce((a, d) => a + (d.upSpeed || 0), 0)
      };
    } catch (e) { /* ignore */ }

    // 4) 容器
    let containers = [];
    if (cfg.docker && cfg.docker.enabled) {
      try { containers = await deps.listContainers(cfg.docker); } catch (e) { /* ignore */ }
    }

    // 组装快照
    const siteMap = {};
    for (const s of sites) {
      if (!s || !s.id) continue;
      siteMap[s.id] = {
        online: !!s.online,
        ratio: s.ratio == null ? null : Number(s.ratio),
        uploaded: Number(s.uploaded) || 0,
        downloaded: Number(s.downloaded) || 0,
        seeding: Number(s.seeding) || 0,
        bonus: Number(s.bonus) || 0
      };
    }
    const snapshot = { sites: siteMap, sys, down };

    // 5) 写历史（历史模块自己判断开关）
    const h = cfg.history || {};
    if (h.enabled !== false && deps.historyStore) {
      deps.historyStore.keepDays = Math.min(365, Math.max(1, Number(h.keepDays) || 30));
      deps.historyStore.append(snapshot);
    }

    // 6) 告警判定
    let alerts = [];
    if (cfg.alerts && cfg.alerts.enabled) {
      alerts = await deps.alerter.evaluate(cfg, {
        sites,
        sys: sys || {},
        containers
      }, opts);
    }

    lastRunAt = Date.now();
    lastError = null;
    lastResult = {
      ok: true,
      at: lastRunAt,
      tookMs: lastRunAt - startedAt,
      siteCount: sites.length,
      alertCount: alerts.length,
      alerts: alerts.map(a => ({ title: a.title, isRecovery: a.isRecovery }))
    };
    return lastResult;
  } catch (e) {
    lastError = e.message || String(e);
    return { ok: false, error: lastError };
  } finally {
    running = false;
  }
}

function status() {
  return {
    running,
    lastRunAt: lastRunAt || null,
    lastError,
    lastResult
  };
}

module.exports = { start, stop, runOnce, status, HistoryStore };
