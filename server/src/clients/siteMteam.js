'use strict';

const { parseSize, parseNum } = require('../utils/format');
const { fetchWithTimeout } = require('../utils/cookiejar');

// M-Team（馒头）专用客户端
// 认证：x-api-key 请求头（站内「控制台 → 实验室 → 存取令牌」生成）
// 数据接口（均为 POST，返回 { code, message, data }）：
//   /api/member/profile           → username / uploaded / downloaded / bonus / shareRate
//   /api/tracker/myPeerStatistics → seederCount / leecherCount
class SiteMteamClient {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.apiKey = (cfg.apiKey || '').trim();
    this.base = (cfg.apiUrl || 'https://api.m-team.cc').trim().replace(/\/+$/, '');
  }

  async _post(path, body) {
    if (!this.apiKey) throw new Error('未配置 API Key（M-Team 需在站内生成存取令牌）');
    const res = await fetchWithTimeout(this.base + path, {
      method: 'POST',
      headers: {
        'User-Agent': 'NAS-Nav/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'x-api-key': this.apiKey
      },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('接口返回不是有效 JSON'); }
    if (j.code !== '0' && j.code !== 0 && j.code !== 'SUCCESS' && String(j.code).toUpperCase() !== 'SUCCESS') {
      throw new Error('接口返回错误: ' + (j.message || String(j.code)));
    }
    return j.data;
  }

  async getStatus() {
    // M-Team 服务端限流严格（约 1 req/s、突发 3），两个接口串行 + 间隔，避免瞬时打爆
    const profile = await this._post('/api/member/profile', {});
    await new Promise(r => setTimeout(r, 400));
    const stats = await this._post('/api/tracker/myPeerStatistics', {});
    const mc = (profile && profile.memberCount) || {};
    const uploaded = parseSize(mc.uploaded);
    const downloaded = parseSize(mc.downloaded);
    let ratio = null;
    if (mc.shareRate !== undefined && mc.shareRate !== null && String(mc.shareRate).trim() !== '') {
      ratio = parseFloat(String(mc.shareRate));
      if (isNaN(ratio)) ratio = null;
    } else if (uploaded > 0 && downloaded > 0) {
      ratio = uploaded / downloaded;
    }
    return {
      online: true,
      account: (profile && profile.username) ? String(profile.username) : '',
      ratio,
      uploaded,
      downloaded,
      seeding: stats ? parseNum(stats.seederCount) : 0,
      leeching: stats ? parseNum(stats.leecherCount) : 0,
      bonus: parseNum(mc.bonus)
    };
  }
}

module.exports = { SiteMteamClient };
