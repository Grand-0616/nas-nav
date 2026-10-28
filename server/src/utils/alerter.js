'use strict';

/**
 * 告警引擎：规则判定 + 去重 + 恢复通知 + 多渠道推送。
 *
 * 设计要点：
 *  - 每个「问题」有稳定 key（如 site:abc:offline），同一 key 在 repeatMin 内不重复推送；
 *  - 问题消失时推一条「已恢复」，然后把状态清空，下次再出问题会立即推；
 *  - 判定需要连续命中（如站点连续 2 次离线）才触发，避免一次网络抖动就轰炸；
 *  - 推送失败只记日志，不影响主流程。
 */

const https = require('https');
const http = require('http');

// ---------- 状态 ----------
// key -> { since: 首次命中时间, lastPush: 上次推送时间, hits: 连续命中次数, title, detail }
const states = new Map();
// 最近事件（供前端展示，最多保留 100 条）
const recentEvents = [];
const MAX_EVENTS = 100;

function pushEvent(ev) {
  recentEvents.unshift({ at: Date.now(), ...ev });
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

// ---------- HTTP 发送 ----------
function postJson(url, body, method) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法：' + url)); }
    const isHttps = u.protocol === 'https:';
    if (!isHttps && u.protocol !== 'http:') return reject(new Error('只支持 http/https'));
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = (isHttps ? https : http).request(u, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 10000,
      // 通知渠道多用公网 HTTPS，保持严格证书校验
      rejectUnauthorized: true
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        }
        resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('通知发送超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request(u, { method: 'GET', timeout: 10000, rejectUnauthorized: true }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// ---------- 各渠道 ----------
const SENDERS = {
  async bark(cfg, title, body) {
    if (!cfg.url) throw new Error('未填写 Bark 推送地址');
    // Bark 支持 path 形式：https://api.day.app/KEY/标题/内容
    const base = cfg.url.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=nas-nav`;
    await getText(url);
  },

  async telegram(cfg, title, body) {
    if (!cfg.botToken || !cfg.chatId) throw new Error('未填写 Bot Token 或 Chat ID');
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    await postJson(url, {
      chat_id: cfg.chatId,
      text: `${title}\n\n${body}`,
      disable_web_page_preview: true
    });
  },

  async wecom(cfg, title, body) {
    if (!cfg.webhook) throw new Error('未填写企业微信 Webhook');
    // 企业微信 markdown 消息
    await postJson(cfg.webhook, {
      msgtype: 'markdown',
      markdown: { content: `**${title}**\n${body}` }
    });
  },

  async webhook(cfg, title, body, extra) {
    if (!cfg.url) throw new Error('未填写 Webhook 地址');
    await postJson(cfg.url, {
      source: 'nas-nav',
      title,
      body,
      level: extra && extra.level || 'warning',
      key: extra && extra.key || '',
      at: new Date().toISOString()
    }, cfg.method === 'PUT' ? 'PUT' : 'POST');
  }
};

async function dispatch(channels, title, body, extra) {
  const results = [];
  for (const name of Object.keys(SENDERS)) {
    const c = channels && channels[name];
    if (!c || !c.enabled) continue;
    try {
      await SENDERS[name](c, title, body, extra);
      results.push({ channel: name, ok: true });
    } catch (e) {
      results.push({ channel: name, ok: false, error: e.message || String(e) });
      console.error(`[alert] ${name} 推送失败: ${e.message}`);
    }
  }
  return results;
}

// ---------- 规则判定 ----------
/**
 * @param {object} cfg     完整配置
 * @param {object} ctx     现场数据 { sites: [...], sys: {...}, docker: [...] }
 * @param {object} opts    { dryRun: 只在测试时用 }
 * @returns {Promise<Array>} 本次产生的推送结果
 */
async function evaluate(cfg, ctx, opts) {
  const a = (cfg && cfg.alerts) || {};
  const now = Date.now();
  const repeatMs = Math.max(1, Number(a.repeatMin) || 180) * 60 * 1000;
  const offlineTimes = Math.max(1, Number(a.siteOfflineTimes) || 2);
  const ratioMin = Number(a.ratioMin) || 0;
  const diskMax = Number(a.diskPctMax) || 0;
  const results = [];

  // 当前命中集合：key -> { title, detail }
  const active = new Map();

  // 1) 站点离线
  for (const s of (ctx.sites || [])) {
    if (!s || !s.id) continue;
    if (s.online === false && s.error) {
      active.set('site:' + s.id + ':offline', {
        title: `站点离线：${s.name || s.id}`,
        detail: s.error || '抓取失败',
        kind: 'site-offline',
        name: s.name || s.id
      });
    }
  }

  // 2) 分享率偏低
  if (ratioMin > 0) {
    for (const s of (ctx.sites || [])) {
      if (!s || !s.id || s.online === false) continue;
      if (s.ratio != null && Number(s.ratio) < ratioMin) {
        active.set('site:' + s.id + ':ratio', {
          title: `分享率偏低：${s.name || s.id}`,
          detail: `当前分享率 ${Number(s.ratio).toFixed(3)}，低于阈值 ${ratioMin}`,
          kind: 'site-ratio',
          name: s.name || s.id
        });
      }
    }
  }

  // 3) 磁盘水位
  if (diskMax > 0 && ctx.sys && ctx.sys.disk != null && Number(ctx.sys.disk) >= diskMax) {
    active.set('sys:disk', {
      title: '磁盘空间不足',
      detail: `当前使用率 ${Math.round(Number(ctx.sys.disk))}%，超过阈值 ${diskMax}%`,
      kind: 'disk',
      name: 'NAS 存储'
    });
  }

  // 4) 容器异常
  if (a.containerAbnormal) {
    for (const c of (ctx.containers || [])) {
      if (!c || !c.abnormal) continue;
      active.set('docker:' + (c.name || c.id), {
        title: `容器异常：${c.name || c.id}`,
        detail: c.health === 'unhealthy' ? '健康检查未通过' : (c.status || c.state || '状态异常'),
        kind: 'container',
        name: c.name || c.id
      });
    }
  }

  // 连续命中计数 + 判定
  const toPush = [];
  for (const [key, info] of active) {
    const st = states.get(key);
    if (!st) {
      // 首次命中：记录但先不推送（等连续命中次数达标）
      states.set(key, { since: now, lastPush: 0, hits: 1, title: info.title, detail: info.detail });
      if (offlineTimes <= 1) toPush.push({ key, info, isRecovery: false });
      continue;
    }
    st.hits++;
    st.title = info.title;
    st.detail = info.detail;
    const enough = st.hits >= offlineTimes;
    const due = st.lastPush === 0 || (now - st.lastPush) >= repeatMs;
    if (enough && due) {
      st.lastPush = now;
      toPush.push({ key, info, isRecovery: false });
    }
  }

  // 恢复：之前有状态，这次不在 active 里
  for (const [key, st] of Array.from(states)) {
    if (active.has(key)) continue;
    states.delete(key);
    toPush.push({
      key,
      info: { title: `已恢复：${st.title.replace(/^.*?：/, '')}`, detail: `持续 ${formatDuration(now - st.since)}后恢复`, kind: 'recovery', name: st.title },
      isRecovery: true
    });
  }

  if (opts && opts.dryRun) return toPush.map(p => ({ key: p.key, title: p.info.title, detail: p.info.detail, isRecovery: p.isRecovery }));

  // 推送
  for (const p of toPush) {
    const level = p.isRecovery ? 'info' : 'warning';
    const title = `[NAS 导航] ${p.info.title}`;
    const body = `${p.info.detail}\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    const r = await dispatch(a.channels, title, body, { level, key: p.key });
    pushEvent({ type: p.isRecovery ? 'recover' : 'alert', key: p.key, title: p.info.title, detail: p.info.detail, channels: r });
    results.push({ key: p.key, title: p.info.title, isRecovery: p.isRecovery, channels: r });
  }
  return results;
}

function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分钟`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

// 测试推送：直接发一条，不走规则
async function testChannel(channels, channelName) {
  const title = '[NAS 导航] 测试通知';
  const body = `这是一条测试消息，收到说明「${channelName}」配置正确。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  return dispatch(channels, title, body, { level: 'info', key: 'test' });
}

function reset() {
  states.clear();
  recentEvents.length = 0;
}

function getRecentEvents() {
  return recentEvents.slice(0, MAX_EVENTS);
}

module.exports = { evaluate, testChannel, reset, getRecentEvents, SENDERS };
