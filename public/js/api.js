'use strict';

// API 封装
const API = {
  // 401 统一处理：抛出带 authRequired 标记的错误，由 app.js 弹出登录框
  async _req(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      let authRequired = false;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
        if (j && j.authRequired) authRequired = true;
      } catch (e) { /* ignore */ }
      const err = new Error(msg);
      err.status = res.status;
      err.authRequired = authRequired || res.status === 401;
      throw err;
    }
    return res.json();
  },

  // ---------- 认证 ----------
  authStatus() {
    return this._req('/api/auth/status');
  },
  login(token) {
    return this._req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
  },
  logout() {
    return this._req('/api/auth/logout', { method: 'POST' });
  },

  getConfig() {
    return this._req('/api/config');
  },

  saveConfig(cfg) {
    return this._req('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
  },

  getDownloaderStatus() {
    return this._req('/api/downloaders/status');
  },

  getServicesStatus() {
    return this._req('/api/services/status');
  },

  // 服务自动发现（Docker 容器 + 宿主端口探测）
  discoverServices() {
    return this._req('/api/services/discover');
  },

  // 导入发现的服务（按 URL 去重）
  importServices(items) {
    return this._req('/api/services/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
  },

  getSystemStatus() {
    return this._req('/api/system/status');
  },

  // 宿主机局域网 IP（轻量，服务添加表单自动填充用）
  getLanIp() {
    return this._req('/api/system/lanip');
  },

  // Docker 容器监控
  getDockerContainers(detail) {
    return this._req('/api/docker/containers' + (detail ? '?detail=1' : ''));
  },

  getDockerStats() {
    return this._req('/api/docker/stats');
  },

  // 容器操作：start / stop / restart / pause / unpause
  dockerAction(ref, action) {
    return this._req('/api/docker/containers/' + encodeURIComponent(ref) + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
  },

  // 备份导出（返回完整明文配置，含凭证，供用户下载）
  async exportConfig() {
    const res = await fetch('/api/config/export');
    if (!res.ok) throw new Error('导出失败 HTTP ' + res.status);
    return res.blob();
  },

  // 恢复配置（覆盖当前，服务端先自动备份当前配置）
  restoreConfig(cfg) {
    return this._req('/api/config/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
  },

  // 主题背景图（独立接口，不再塞进 config.json）
  uploadThemeBg(dataUrl) {
    return this._req('/api/theme/bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    });
  },

  clearThemeBg() {
    return this._req('/api/theme/bg', { method: 'DELETE' });
  },

  // 飞牛影视媒体墙（?refresh=1 强制刷新）
  getMediaOverview(force) {
    return this._req('/api/media/overview' + (force ? '?refresh=1' : ''));
  },

  getMediaStatus() {
    return this._req('/api/media/status');
  },

  // MoviePilot 深度看板（服务端 10s 缓存）
  getMpDashboard() {
    return this._req('/api/mp/dashboard');
  },

  getMpStatus() {
    return this._req('/api/mp/status');
  },

  getMpSearch(title, type) {
    return this._req('/api/mp/search?title=' + encodeURIComponent(title) + '&type=' + (type === 'tv' ? 'tv' : 'movie'));
  },

  addMpSubscribe(payload) {
    return this._req('/api/mp/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  getMpPlugins() {
    return this._req('/api/mp/plugins');
  },

  getDownloaderStatusOne(id) {
    return this._req('/api/downloaders/status/' + encodeURIComponent(id));
  },

  getSiteStatus() {
    return this._req('/api/sites/status');
  },

  // 顶栏「连接状态」总览（轻量聚合，不触发站点抓取）
  getOverviewStatus() {
    return this._req('/api/overview/status');
  },

  // 单站手动刷新（绿点点击）
  getSiteStatusOne(id) {
    return this._req('/api/sites/status/' + encodeURIComponent(id));
  },

  // 站点排序（拖动整理后持久化到配置）
  reorderSites(ids) {
    return this._req('/api/sites/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
  },

  // 历史趋势（?days=7）
  getHistory(days) {
    return this._req('/api/history?days=' + (parseInt(days, 10) || 7));
  },

  getHistoryStatus() {
    return this._req('/api/history/status');
  },

  sampleNow() {
    return this._req('/api/history/sample', { method: 'POST' });
  },

  // 告警
  getAlertEvents() {
    return this._req('/api/alerts/events');
  },

  testAlert() {
    return this._req('/api/alerts/test', { method: 'POST' });
  },

  checkAlerts() {
    return this._req('/api/alerts/check', { method: 'POST' });
  },

  resetAlerts() {
    return this._req('/api/alerts/reset', { method: 'POST' });
  },

  testDownloader(item) {
    return this._req('/api/downloaders/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
  },

  testSite(item) {
    return this._req('/api/sites/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
  }
};

// 工具
function fmtSize(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}
function fmtSpeed(bps) {
  return fmtSize(bps) + '/s';
}
function fmtNum(n) {
  if (!n || isNaN(n) || n <= 0) return '0';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
