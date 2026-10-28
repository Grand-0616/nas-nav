'use strict';

/**
 * MoviePilot 客户端
 * - 认证：API_TOKEN，通过 query ?token=xxx 传递（api_token_query）
 * - 看板端点（均带 2 后缀、API_TOKEN 认证）：
 *   GET /api/v1/dashboard/statistic2   媒体库数量统计
 *   GET /api/v1/dashboard/downloader2  下载器汇总（速度/流量/剩余空间）
 *   GET /api/v1/dashboard/storage2     本地存储空间
 *   GET /api/v1/dashboard/cpu2         CPU 使用率
 *   GET /api/v1/dashboard/memory2      内存信息
 *   GET /api/v1/dashboard/network2     网络流量（下行/上行 bytes/s）
 *   GET /api/v1/dashboard/system       系统摘要（版本/主机/系统/运行时长）
 *   GET /api/v1/subscribe/list         所有订阅（API_TOKEN）
 * - 连接测试：GET /api/v1/system/ping
 * 凭证仅存于 NAS 本地配置文件，绝不进入任何对外交付物。
 */

const DASHBOARD_CACHE_MS = 10000; // 看板聚合缓存 10s，避免轮询频繁打 MP

class MoviePilotClient {
  constructor(cfg) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    this.apiToken = cfg.apiToken || '';
    this.lastError = null;
    this._dashCache = null;
    this._dashAt = 0;
  }

  // 拼 API 路径：兼容用户填根地址（如 http://host:3001）或已带 /api/v1 前缀
  _url(apiPath) {
    if (/\/api\/v1\/?$/.test(this.baseUrl)) {
      return this.baseUrl + apiPath.replace(/^\/api\/v1/, '');
    }
    return this.baseUrl + '/api/v1' + apiPath;
  }

  _headers() {
    return { Accept: 'application/json' };
  }

  async _get(apiPath, timeoutMs) {
    const sep = apiPath.indexOf('?') >= 0 ? '&' : '?';
    const url = this._url(apiPath) + sep + 'token=' + encodeURIComponent(this.apiToken);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(url, { headers: this._headers(), signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 120) : ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async _send(apiPath, payload, method, timeoutMs) {
    const sep = apiPath.indexOf('?') >= 0 ? '&' : '?';
    const url = this._url(apiPath) + sep + 'token=' + encodeURIComponent(this.apiToken);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
    try {
      const res = await fetch(url, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 120) : ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 搜索资源（search/title 走 MP 站点索引，返回可下载种子；剥离 cookie/UA 等敏感字段，只取前 N 条）
  async searchMedia(keyword, type) {
    if (!keyword || !keyword.trim()) throw new Error('搜索关键词不能为空');
    const raw = await this._get('/search/title?keyword=' + encodeURIComponent(keyword.trim()), 25000);
    const list = (raw && raw.data && Array.isArray(raw.data)) ? raw.data : [];
    const out = [];
    for (const item of list.slice(0, 30)) {
      const mi = item.meta_info || {};
      const ti = item.torrent_info || {};
      const name = mi.name || mi.title || ti.title || '';
      if (!name) continue;
      out.push({
        name: name,
        title: ti.title || mi.title || name,
        year: mi.year || '',
        type: mi.type || '未知',
        resource_type: mi.resource_type || '',
        resource_pix: mi.resource_pix || '',
        video_encode: mi.video_encode || '',
        audio_encode: mi.audio_encode || '',
        tmdbid: mi.tmdbid || 0,
        season: mi.season || 0,
        site_name: ti.site_name || '',
        site_id: ti.site != null ? ti.site : '',
        size: ti.size || 0,
        seeders: ti.seeders || 0,
        peers: ti.peers || 0,
        grabs: ti.grabs || 0,
        pubdate: ti.pubdate || '',
        page_url: ti.page_url || '',
        upload_factor: ti.uploadvolumefactor != null ? ti.uploadvolumefactor : '',
        download_factor: ti.downloadvolumefactor != null ? ti.downloadvolumefactor : '',
        desc: (ti.description || '').replace(/<[^>]+>/g, '').slice(0, 120)
      });
    }
    return out;
  }

  // 新增订阅（Subscribe 对象；无 tmdbid 时用 keyword 订阅，MP 自动识别/搜索）
  async addSubscribe(payload) {
    const res = await this._send('/subscribe/', payload, 'POST');
    if (res && res.success === false) throw new Error((res.msg || res.message || '订阅失败'));
    return res;
  }

  // 已安装插件列表（installed 返回 ID 数组；逐 ID 拉配置提取启用状态/cron，无元信息接口则用 ID 作名）
  async getPlugins() {
    const ids = await this._get('/plugin/installed', 8000);
    if (!Array.isArray(ids)) return [];
    const results = await Promise.allSettled(ids.slice(0, 40).map(async (id) => {
      const p = await this._get('/plugin/' + encodeURIComponent(id), 6000);
      return { id, conf: p };
    }));
    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => {
        const { id, conf } = r.value;
        const enabled = conf && conf.enabled != null ? !!conf.enabled : null;
        const cron = conf && conf.cron ? String(conf.cron) : '';
        return { id, name: id, enabled, cron, version: '', author: '' };
      })
      .filter(Boolean);
  }

  // 连接测试：ping + 系统摘要（版本/主机）
  async ping() {
    if (!this.apiToken) throw new Error('未配置 API Token');
    await this._get('/system/ping', 5000);
    let info = null;
    try {
      info = await this._get('/dashboard/system', 5000);
    } catch (e) { /* 版本信息失败不影响连通性判断 */ }
    return info;
  }

  // 聚合看板数据（带缓存）
  async getDashboard() {
    if (this._dashCache && Date.now() - this._dashAt < DASHBOARD_CACHE_MS) {
      return this._dashCache;
    }
    const [stat, dl, storage, cpu, mem, net, subs, sysP] = await Promise.allSettled([
      this._get('/dashboard/statistic2'),
      this._get('/dashboard/downloader2'),
      this._get('/dashboard/storage2'),
      this._get('/dashboard/cpu2'),
      this._get('/dashboard/memory2'),
      this._get('/dashboard/network2'),
      this._get('/subscribe/list', 12000),
      this._get('/dashboard/system')
    ]);

    const pick = (p, d) => (p.status === 'fulfilled' && p.value != null) ? p.value : d;
    const errOf = (p) => (p.status === 'rejected') ? String(p.reason && p.reason.message || p.reason) : null;

    const stats = pick(stat, {});
    const downloader = pick(dl, {});
    const storageData = pick(storage, {});
    const sys = pick(sysP, {});
    // network2 返回 [下行, 上行] bytes/s（MoviePilot 官方定义），部分版本可能为空
    const netArr = Array.isArray(net.value) ? net.value : (net.status === 'fulfilled' ? net.value : null);
    const netDown = netArr && netArr.length > 0 ? netArr[0] : null;
    const netUp = netArr && netArr.length > 1 ? netArr[1] : null;

    const subsList = Array.isArray(subs.value) ? subs.value : [];
    const subStates = { R: 0, P: 0, S: 0 };
    for (const s of subsList) {
      const st = String(s.state || '');
      if (subStates[st] != null) subStates[st]++;
    }

    const errors = [stat, dl, storage, cpu, mem, net, subs, sys]
      .map(errOf).filter(Boolean);

    const data = {
      media: {
        movieCount: stats.movie_count || 0,
        tvCount: stats.tv_count || 0,
        episodeCount: stats.episode_count || 0,
        movieCountMonth: stats.movie_count_month || 0,
        tvCountMonth: stats.tv_count_month || 0,
        episodeCountMonth: stats.episode_count_month || 0
      },
      downloader: {
        downloadSpeed: downloader.download_speed || 0,
        uploadSpeed: downloader.upload_speed || 0,
        downloadSize: downloader.download_size || 0,
        uploadSize: downloader.upload_size || 0,
        freeSpace: downloader.free_space || 0
      },
      storage: {
        total: storageData.total_storage || 0,
        used: storageData.used_storage || 0
      },
      system: {
        hostname: sys.hostname || '',
        os: sys.operating_system || '',
        version: sys.version || '',
        runtimeSec: sys.runtime || 0
      },
      cpu: typeof cpu.value === 'number' ? cpu.value : null,
      mem: pick(mem, {}),
      net: { down: netDown, up: netUp },
      subscribe: {
        total: subsList.length,
        running: subStates.R,
        pending: subStates.P,
        stopped: subStates.S
      },
      partialErrors: errors,
      fetchedAt: Date.now()
    };
    this._dashCache = data;
    this._dashAt = Date.now();
    this.lastError = errors.length ? errors[0] : null;
    return data;
  }

  invalidate() { this._dashCache = null; this._dashAt = 0; }
}

module.exports = { MoviePilotClient };
