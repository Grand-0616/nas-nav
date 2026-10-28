'use strict';

const { CookieJar, fetchWithTimeout } = require('../utils/cookiejar');

// qBittorrent Web API 客户端 (v2)
// 文档: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
// 支持两种认证方式：
//   authMode='password'（默认）: 用户名密码 cookie 登录（/api/v2/auth/login）
//   authMode='apikey': API 密钥认证（qBittorrent >= v5.2.0 / WebAPI v2.14.1），
//                     每个请求带 Authorization: Bearer <apiKey>，无需登录流程
class QBittorrentClient {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.host = (cfg.host || '').replace(/\/+$/, '');
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.authMode = cfg.authMode === 'apikey' ? 'apikey' : 'password';
    this.apiKey = cfg.apiKey || '';
    this.jar = new CookieJar();
    this.sid = null;
  }

  _base(extra) {
    // Referer/Origin 必须与 WebUI 地址一致：qBittorrent 从 4.1 起对 /api/v2 做
    // Host/Referer 防 CSRF 校验，外网跨域访问不带 Referer 会被 403 拒绝
    return {
      'User-Agent': 'NAS-Nav/1.0',
      'Referer': this.host + '/',
      'Origin': this.host,
      ...(extra || {})
    };
  }

  async _login() {
    if (this.sid) return true;
    // API 密钥模式：无登录流程
    if (this.authMode === 'apikey') {
      if (!this.apiKey) throw new Error('未配置 API 密钥');
      this.sid = 'apikey';
      return true;
    }
    const url = `${this.host}/api/v2/auth/login`;
    const body = new URLSearchParams({ username: this.username, password: this.password });
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: this._base({ 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.host + '/' }),
      body: body.toString(),
      redirect: 'manual'
    });
    this.jar._parseSetCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie'), url);
    const text = await res.text();
    if (text.trim() === 'Ok.') {
      this.sid = this.jar.headerFor(this.host);
      return true;
    }
    throw new Error('qBittorrent 登录失败，请检查用户名/密码');
  }

  _authHeaders() {
    if (this.authMode === 'apikey') {
      return { Authorization: 'Bearer ' + this.apiKey };
    }
    return { Cookie: this.sid };
  }

  async _get(path) {
    await this._login();
    const headers = this._base(this._authHeaders());
    let res = await fetchWithTimeout(`${this.host}${path}`, { headers });
    if (res.status === 403 && this.authMode !== 'apikey') {
      // 会话过期，重新登录
      this.sid = null;
      await this._login();
      res = await fetchWithTimeout(`${this.host}${path}`, { headers: this._base(this._authHeaders()) });
    }
    if (res.status === 403 && this.authMode === 'apikey') {
      throw new Error('API 密钥无效或已被撤销，请在 qBittorrent WebUI 设置中重新生成；若从公网访问，还需确认 WebUI 已启用「Bypass authentication for clients on localhost」或地址与 WebUI 设置中的 Host 一致');
    }
    if (res.status === 401) throw new Error('qBittorrent 认证失败：账号密码或 API 密钥不正确（qB 5.x 默认「WebUI 口令认证方式」若选 API 密钥，需用 API 密钥登录）');
    if (!res.ok) throw new Error(`qBittorrent API 错误: HTTP ${res.status}`);
    return res;
  }

  // 获取版本（同时验证在线）
  async getVersion() {
    const res = await this._get('/api/v2/app/version');
    return (await res.text()).trim();
  }

  // 全局传输信息: 实时速率 + 累计数据
  async getTransferInfo() {
    const res = await this._get('/api/v2/transfer/info');
    return res.json();
  }

  // 种子列表: 统计任务状态
  async getTorrents() {
    const res = await this._get('/api/v2/torrents/info');
    return res.json();
  }

  // 主数据(server_state 含全局累计)
  async getMainData() {
    const res = await this._get('/api/v2/sync/maindata');
    return res.json();
  }

  // 聚合一次完整状态
  async getStatus() {
    const [version, transfer, torrents, maindata] = await Promise.all([
      this.getVersion(),
      this.getTransferInfo(),
      this.getTorrents(),
      this.getMainData()
    ]);

    let downloading = 0, uploading = 0, stopped = 0;
    for (const t of torrents) {
      const s = t.state || '';
      if (/downloading|queueddl|stalleddl|checkingdl|metadl|forceddl/i.test(s)) downloading++;
      else if (/uploading|queuedup|stalledup|checkingup|forcedup/i.test(s)) uploading++;
      else if (/stopped|paused/i.test(s)) stopped++;
    }

    const ss = (maindata && maindata.server_state) || {};
    return {
      online: true,
      version: version || '',
      downSpeed: Number(transfer.dl_info_speed) || 0,
      upSpeed: Number(transfer.up_info_speed) || 0,
      downloading,
      uploading,
      stopped,
      totalUploaded: Number(ss.total_uploaded) || 0,
      totalDownloaded: Number(ss.total_downloaded) || 0
    };
  }
}

module.exports = { QBittorrentClient };
