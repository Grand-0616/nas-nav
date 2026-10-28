'use strict';

/**
 * 飞牛影视（fnOS Media）客户端
 * - 登录：POST /v/api/v2/user/loginByPassword {username, password: sha256hex} → token
 * - 签名：请求头 authx = nonce={rand6}&timestamp={ms}&sign={md5(盐_path_nonce_ts_bodyHash_apiKey)}
 *   盐与 apiKey 从官方前端 chunk 逆向所得（apiKey 为字节数组 XOR 169 解码的固定值）
 * - 数据：媒体库统计 / 媒体库列表 / 继续观看 / 条目列表，海报 /v/api/v1/sys/img/...
 * 凭证仅存于 NAS 本地配置文件，绝不进入任何对外交付物。
 */

const crypto = require('crypto');

const SALT = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
// 官方客户端固定 apiKey（chunk 内字节数组逐字节 XOR 169 后 UTF-8 解码）
const API_KEY = Buffer.from([
  152, 159, 234, 234, 236, 235, 154, 237, 132, 232, 235, 157, 155, 132, 153, 158, 158, 237,
  132, 154, 159, 232, 152, 132, 239, 154, 156, 156, 154, 155, 157, 236, 157, 155, 154, 158
].map(b => b ^ 169)).toString('utf-8');

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 登录 token 缓存 6 小时，过期自动重登

class FeiniuMediaClient {
  constructor(cfg) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.token = '';
    this.tokenAt = 0;
    this.lastError = null;
  }

  _md5(s) { return crypto.createHash('md5').update(s, 'utf-8').digest('hex'); }

  _authx(path, data, method) {
    const bodyHash = method === 'GET'
      ? this._md5('')
      : this._md5(data == null ? '' : JSON.stringify(data));
    const nonce = String(Math.floor(Math.random() * 9e5) + 1e5);
    const ts = String(Date.now());
    const sign = this._md5([SALT, path, nonce, ts, bodyHash, API_KEY].join('_'));
    return `nonce=${nonce}&timestamp=${ts}&sign=${sign}`;
  }

  async _ensureToken() {
    if (this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    // 登录互斥：服务器限制并发登录（并发多个登录会返回 Password Incorrect），同一时刻只允许一个登录，其余等待复用
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin() {
    if (!this.username || !this.password) {
      throw new Error('未配置飞牛影视账号密码');
    }
    const pwHash = crypto.createHash('sha256').update(this.password, 'utf-8').digest('hex');
    const body = JSON.stringify({ username: this.username, password: pwHash, remember: false });
    const res = await fetch(this.baseUrl + '/v/api/v2/user/loginByPassword', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j || j.code !== 0 || !j.data || !j.data.token) {
      this.lastError = (j && j.msg) || '登录失败（HTTP ' + res.status + '）';
      throw new Error('飞牛影视登录失败：' + this.lastError);
    }
    this.token = j.data.token;
    this.tokenAt = Date.now();
    this.lastError = null;
    return this.token;
  }

  async _call(path, data, method) {
    const token = await this._ensureToken();
    const url = this.baseUrl + path;
    const body = data == null ? undefined : JSON.stringify(data);
    const res = await fetch(url, {
      method: method || (data == null ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `Trim-MC-token=${token}`,
        'authx': this._authx(path, data, method || (data == null ? 'GET' : 'POST'))
      },
      body,
      signal: AbortSignal.timeout(12000)
    });
    const j = await res.json().catch(() => null);
    if (!j || j.code !== 0) {
      const msg = (j && j.msg) || ('接口返回 HTTP ' + res.status);
      // token 失效时强制重登一次
      if (j && j.code === 5000) {
        this.token = '';
        return this._call(path, data, method);
      }
      throw new Error('飞牛影视 ' + path + '：' + msg);
    }
    return j.data;
  }

  _poster(p) {
    if (!p) return '';
    if (/^https?:\/\//.test(p)) return p;
    return this.baseUrl + '/v/api/v1/sys/img' + (p.startsWith('/') ? p : '/' + p);
  }

  _itemUrl(it) {
    if (it.type === 'Movie' || it.type === 'movie') {
      return this.baseUrl + '/v/movie/' + it.guid;
    }
    if (it.parent_guid) {
      return this.baseUrl + '/v/tv/' + it.parent_guid;
    }
    return this.baseUrl + '/v/';
  }

  /** 聚合：媒体库统计 + 媒体库列表 + 继续观看 + 最近条目 */
  async getOverview() {
    const [sum, libs, play, recent] = await Promise.all([
      this._call('/v/api/v1/mediadb/sum', null, 'GET'),
      this._call('/v/api/v1/mediadb/list', null, 'GET'),
      this._call('/v/api/v1/play/list', null, 'GET'),
      this._call('/v/api/v1/item/list', { page: 1, pageSize: 24 }, 'POST')
    ]);

    const libCount = new Map();
    for (const k of Object.keys(sum || {})) {
      if (k === 'total' || k === 'movie' || k === 'tv' || k === 'video' || k === 'live' || k === 'favorite') continue;
      libCount.set(k, sum[k]);
    }

    const libraries = (libs || []).map(l => ({
      guid: l.guid,
      title: l.title,
      category: l.category || '',
      count: libCount.get(l.guid) || 0,
      poster: this._poster((l.posters && l.posters[0]) || l.poster || '')
    }));

    const playItems = (play || []).map(it => ({
      guid: it.guid,
      title: it.tv_title || it.title,
      subtitle: it.type === 'Episode'
        ? `第${it.season_number || 0}季·第${it.episode_number || 0}集`
        : '电影',
      type: it.type || '',
      poster: this._poster(it.poster),
      runtime: it.runtime || 0,
      duration: it.duration || 0,
      url: this._itemUrl(it)
    }));

    const list = (recent && recent.list) || [];
    // 条目：按类型排序（电影/剧集优先于短视频），去重同标题
    const seen = new Set();
    const recentItems = [];
    for (const it of list) {
      const t = it.title || it.tv_title || '';
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const isMovie = (it.type || '').toLowerCase() === 'movie';
      const isEpisode = (it.type || '').toLowerCase() === 'episode';
      if (!isMovie && !isEpisode) continue; // 只保留电影/剧集条目
      recentItems.push({
        guid: it.guid,
        title: t,
        tvTitle: it.tv_title || '',
        type: it.type || '',
        season: it.season_number || 0,
        episode: it.episode_number || 0,
        poster: this._poster(it.poster),
        url: this._itemUrl(it)
      });
      if (recentItems.length >= 18) break;
    }

    return {
      connected: true,
      version: '',
      summary: {
        total: sum.total || 0,
        movie: sum.movie || 0,
        tv: sum.tv || 0,
        video: sum.video || 0,
        live: sum.live || 0,
        favorite: sum.favorite || 0
      },
      libraries,
      play: playItems,
      recent: recentItems,
      serverUrl: this.baseUrl
    };
  }
}

module.exports = { FeiniuMediaClient };
