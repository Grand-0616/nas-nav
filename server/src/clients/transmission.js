'use strict';

const { fetchWithTimeout } = require('../utils/cookiejar');

// Transmission RPC 客户端
// 协议: https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md
class TransmissionClient {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.host = (cfg.host || '').replace(/\/+$/, '');
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.sessionId = null;
  }

  _base() {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'NAS-Nav/1.0',
      'Referer': this.host + '/transmission/web/'
    };
    if (this.username) {
      headers.Authorization = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    }
    if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId;
    return headers;
  }

  async _rpc(method, args) {
    let res = await fetchWithTimeout(`${this.host}/transmission/rpc`, {
      method: 'POST',
      headers: this._base(),
      body: JSON.stringify({ method, arguments: args || {} })
    });

    if (res.status === 409) {
      // 需要获取 Session-Id
      const sid = res.headers.get('x-transmission-session-id');
      if (!sid) throw new Error('Transmission 无法获取会话 ID');
      this.sessionId = sid;
      res = await fetchWithTimeout(`${this.host}/transmission/rpc`, {
        method: 'POST',
        headers: this._base(),
        body: JSON.stringify({ method, arguments: args || {} })
      });
    }

    if (res.status === 401) {
      throw new Error('Transmission 认证失败：请检查用户名/密码；若从公网/外网访问，还需在 Transmission 设置里把访问地址加入 rpc-whitelist 与 rpc-host-whitelist（默认只允许 127.0.0.1,::1）');
    }
    if (!res.ok) throw new Error(`Transmission RPC 错误: HTTP ${res.status}`);

    const data = await res.json();
    if (data.result !== 'success') throw new Error(`Transmission RPC 失败: ${data.result}`);
    return data.arguments || {};
  }

  // 版本 + 实时速率
  async getSession() {
    return this._rpc('session-get', {});
  }

  // 全局累计
  async getStats() {
    return this._rpc('session-stats', {});
  }

  // 种子列表（关键字段）
  async getTorrents() {
    return this._rpc('torrent-get', {
      fields: ['id', 'name', 'status', 'uploadedEver', 'downloadedEver', 'rateUpload', 'rateDownload', 'totalSize']
    });
  }

  async getStatus() {
    // 采样节流：同一个 client 会被「下载器页 15s 轮询」和「顶栏状态 30s 轮询」同时调用，
    // 两次调用可能只差几十毫秒。若不节流，dt 极小会把速率放大几十倍，或互相覆盖采样基准
    // 导致速率跳变/归零。这里保证最小采样间隔，间隔内的重复调用直接复用上次结果。
    const MIN_SAMPLE_MS = 2000;
    if (this._lastResult && this._lastSampleAt && Date.now() - this._lastSampleAt < MIN_SAMPLE_MS) {
      return this._lastResult;
    }
    const [session, stats, torrents] = await Promise.all([this.getSession(), this.getStats(), this.getTorrents()]);

    // session-get 的 arguments 直接就是会话字段
    const s = session || {};
    const cs = (stats['cumulative-stats']) || {};
    const cur = (stats['current-stats']) || {};

    let downloading = 0, uploading = 0, stopped = 0;
    for (const t of torrents.torrents || []) {
      const st = t.status;
      if (st === 3 || st === 4) downloading++;      // 下载中 / 等待下载
      else if (st === 5 || st === 6) uploading++;  // 做种 / 等待做种
      else if (st === 0) stopped++;
    }

    // 实时速率：TR 4.1+ 的 session-get 已不含 download-speed/upload-speed 字段，
    // 用两次 session-stats 的 current-stats 累计字节差 ÷ 时间差计算；
    // 首次调用无基准，用本次会话平均速率兜底（uploadedBytes / secondsActive）
    const now = Date.now();
    const upBytes = Number(cur['uploadedBytes']) || 0;
    const downBytes = Number(cur['downloadedBytes']) || 0;
    let upSpeed = 0, downSpeed = 0;
    if (this._lastStats) {
      const dt = (now - this._lastStats.time) / 1000;
      if (dt > 0) {
        upSpeed = Math.max(0, upBytes - this._lastStats.up) / dt;
        downSpeed = Math.max(0, downBytes - this._lastStats.down) / dt;
      }
    } else {
      const secs = Number(cur['secondsActive']) || 1;
      upSpeed = upBytes / secs;
      downSpeed = downBytes / secs;
    }
    this._lastStats = { time: now, up: upBytes, down: downBytes };

    const result = {
      online: true,
      version: s.version || '',
      downSpeed: Math.round(downSpeed),
      upSpeed: Math.round(upSpeed),
      downloading,
      uploading,
      stopped,
      totalUploaded: Number(cs['uploadedBytes'] ?? cs['uploaded-bytes']) || 0,
      totalDownloaded: Number(cs['downloadedBytes'] ?? cs['downloaded-bytes']) || 0
    };
    this._lastResult = result;
    this._lastSampleAt = now;
    return result;
  }
}

module.exports = { TransmissionClient };
