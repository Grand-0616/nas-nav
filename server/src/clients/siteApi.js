'use strict';

const { parseSize, parseNum } = require('../utils/format');
const { fetchWithTimeout } = require('../utils/cookiejar');

// PT 站点 - API/passkey 模式
// 支持站点提供的 getuserinfo 类接口，返回 XML 或 JSON
// 配置: { mode: 'api', apiUrl: 'https://site/getuserinfo.php?passkey={passkey}', passkey: 'xxx' }
// apiUrl 中 {passkey} 占位符会被替换为实际 passkey
// 部分站点（如 M-Team）用 API Key 认证：{ apiKey: 'xxx' } 会以 x-api-key 请求头发送
class SiteApiClient {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.apiUrl = (cfg.apiUrl || '').trim();
    this.passkey = (cfg.passkey || '').trim();
    this.apiKey = (cfg.apiKey || '').trim();
  }

  async _request() {
    let url = this.apiUrl;
    if (this.passkey) url = url.replace(/\{passkey\}/g, encodeURIComponent(this.passkey));
    if (/\{passkey\}/.test(url) && !this.passkey) {
      throw new Error('未配置 passkey');
    }
    const headers = { 'User-Agent': 'NAS-Nav/1.0', 'Accept': 'application/json, text/plain, */*' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error('接口返回为空');
    return text;
  }

  // 通用字段提取（多字段名容错）
  _pick(obj, keys) {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
    }
    return null;
  }

  _parseXml(xmlText) {
    // 简易 XML 解析：只提取 <tag>value</tag> 对（NexusPHP getuserinfo 结构足够简单）
    const out = {};
    const re = /<([a-zA-Z_][\w-]*)>([^<]*)<\/\1>/g;
    let m;
    while ((m = re.exec(xmlText)) !== null) {
      out[m[1].toLowerCase()] = m[2].trim();
    }
    return out;
  }

  async getStatus() {
    const text = await this._request();
    const trimmed = text.trim();
    let obj = null;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { obj = JSON.parse(trimmed); } catch (e) { obj = null; }
    }
    if (!obj && (trimmed.startsWith('<') || /^<\?xml/i.test(trimmed))) {
      obj = this._parseXml(trimmed);
    }
    if (!obj) {
      // 兜底：尝试从纯文本 key=value 行解析（部分站点返回这种格式）
      obj = {};
      for (const line of trimmed.split(/[\r\n]+/)) {
        const eq = line.indexOf('=');
        if (eq > 0) obj[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
      }
    }

    // M-Team 等站点返回 { code, message, data: {...} }，业务字段在 data 子对象里
    let payload = obj;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const d = obj.data;
      const hasBusiness = d && typeof d === 'object' && (
        d.uploaded !== undefined || d.downloaded !== undefined || d.bonus !== undefined ||
        d.ratio !== undefined || d.username !== undefined || d.user !== undefined ||
        d.seeding !== undefined || d.seeders !== undefined || d.leeching !== undefined
      );
      if (hasBusiness) payload = d;
    }

    const val = (keys) => this._pick(payload, keys);
    const ratio = val(['ratio', 'share_ratio', 'rate', 'shareratio']);
    const uploaded = val(['uploaded', 'upload', 'uploadedtotal', 'uploaded_total', 'up', 'uploadSize']);
    const downloaded = val(['downloaded', 'download', 'downloadedtotal', 'downloaded_total', 'down', 'downloadSize']);
    const bonus = val(['bonus', 'magic', 'points', 'my_bonus', 'karma', 'bonus_points', 'pm', 'bonusLeft']);
    const seeding = val(['seeding', 'seeding_count', 'torrents_seeding', 'seedings', 'seeders', 'seedingCount']);
    const leeching = val(['leeching', 'leeching_count', 'torrents_leeching', 'leechings', 'downloading', 'leechers', 'leechingCount']);
    const username = val(['username', 'user', 'account', 'name', 'nickname']);

    if (ratio === null && uploaded === null && bonus === null) {
      throw new Error('无法从接口返回中解析出有效数据，请检查 apiUrl 是否指向正确的接口');
    }

    const seedingCount = parseNum(seeding);
    const leechingCount = parseNum(leeching);

    return {
      online: true,
      account: username ? String(username) : '',
      ratio: ratio === null ? null : parseFloat(String(ratio)),
      uploaded: parseSize(uploaded),
      downloaded: parseSize(downloaded),
      seeding: seedingCount,
      leeching: leechingCount,
      bonus: parseNum(bonus)
    };
  }
}

module.exports = { SiteApiClient };
