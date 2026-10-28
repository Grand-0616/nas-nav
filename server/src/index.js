'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getConfig, saveConfig, hasThemeBg, getThemeBg, saveThemeBg, clearThemeBg, THEME_BG_MAX_BYTES, CONFIG_DIR } = require('./config');
const { QBittorrentClient } = require('./clients/qbittorrent');
const { TransmissionClient } = require('./clients/transmission');
const { SiteApiClient } = require('./clients/siteApi');
const { SiteScrapeClient } = require('./clients/siteScrape');
const { SiteMteamClient } = require('./clients/siteMteam');
const { FeiniuMediaClient } = require('./clients/feiniuMedia');
const { MoviePilotClient } = require('./clients/moviepilot');
const { getSystemStatus } = require('./utils/sysMonitor');
const dockerMonitor = require('./utils/dockerMonitor');
const { HistoryStore, MAX_POINTS_FOR_CHART } = require('./utils/historyStore');
const alerter = require('./utils/alerter');
const sampler = require('./utils/sampler');

const app = express();
const PORT = Number(process.env.PORT || 8080);

// 解析前端静态目录：容器内 cwd=/app（public 在 /app/public），
// 本地开发 cwd=server/（public 在 nas-nav/public），按存在性自动选择，可用 PUBLIC_DIR 强制指定
function resolvePublicDir() {
  const candidates = [
    process.env.PUBLIC_DIR,
    path.join(__dirname, '..', '..', 'public'), // 源码相对：本地 nas-nav/public
    path.join(process.cwd(), 'public')          // 容器内 /app/public
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'index.html'))) return c;
    } catch (e) { /* ignore */ }
  }
  return candidates[0] || path.join(__dirname, '..', '..', 'public');
}
const PUBLIC_DIR = resolvePublicDir();

// 基础安全响应头（自托管面板，无第三方脚本）：放在最前面，静态资源也一并生效
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// 请求体上限：配置本身只存轻量设置（背景图已移到独立接口），2mb 足够覆盖
// 站点/服务的批量导入。超限由错误处理返回 413 JSON，不再落到通用 500。
// 背景图上传接口用自己的 8mb 解析器（见 /api/theme/bg），这里跳过，否则会被提前拦下。
const jsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.path === '/api/theme/bg') return next();
  return jsonParser(req, res, next);
});
app.use(express.static(PUBLIC_DIR, {
  // 静态资源走协商缓存（ETag / Last-Modified）而不是 7 天强缓存：
  // 原先 maxAge: '7d' 时，升级镜像后 index.html 会回源拿到新版本号，
  // 但只要发布时忘了改 ?v= 参数，浏览器就会继续用旧的 app.js / style.css，
  // 用户升级完看到的还是旧界面（本项目自己踩过两次）。改成 0 之后
  // 文件一变立即生效，代价只是每次多一个 304。
  maxAge: 0,
  setHeaders: (res) => {
    // 全部 no-cache：每次都向服务端确认，命中 ETag 时只回 304
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ---------- 基础 ----------
// 版本号统一从 package.json 读，避免与镜像 tag / README 三处不一致
const APP_VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();

// ---------- 访问认证 ----------
// 默认（未设置 ACCESS_TOKEN）不启用认证：纯局域网自托管，开箱即用。
// 一旦设置 ACCESS_TOKEN，所有 /api/* 都需要凭证；这样做了端口映射/反代时才不会把
// 「导出全部明文凭证」「容器启停」这类接口暴露给公网。
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || '').trim();
const AUTH_REQUIRED = ACCESS_TOKEN.length > 0;
const AUTH_COOKIE = 'nas_nav_auth';
// Cookie 里存 token 的 SHA-256 而不是明文：浏览器 DevTools / 中间代理都看不到原始口令
const AUTH_COOKIE_VALUE = AUTH_REQUIRED
  ? crypto.createHash('sha256').update('nas-nav|' + ACCESS_TOKEN).digest('hex')
  : '';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf-8');
  const bb = Buffer.from(String(b || ''), 'utf-8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 认证判定：优先 X-Auth-Token 请求头（脚本/API 调用），其次 Cookie（浏览器）
function isAuthed(req) {
  if (!AUTH_REQUIRED) return true;
  const h = req.get('x-auth-token');
  if (h && safeEqual(h, ACCESS_TOKEN)) return true;
  const c = parseCookies(req.get('cookie'))[AUTH_COOKIE];
  if (c && safeEqual(c, AUTH_COOKIE_VALUE)) return true;
  return false;
}

// 登录失败限速：同一 IP 10 分钟内最多 20 次失败，防止暴力猜测
const loginFails = new Map(); // ip -> { count, firstAt }
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 20;
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAILS;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
    loginFails.set(ip, { count: 1, firstAt: Date.now() });
  } else {
    rec.count++;
  }
}

app.get('/api/auth/status', (req, res) => {
  res.json({ ok: true, required: AUTH_REQUIRED, authed: isAuthed(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: true, required: false, authed: true });
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).json({ ok: false, error: '尝试次数过多，请 10 分钟后再试' });
  }
  const token = String((req.body && req.body.token) || '').trim();
  if (!token || !safeEqual(token, ACCESS_TOKEN)) {
    noteLoginFail(ip);
    return res.status(401).json({ ok: false, error: '访问令牌不正确' });
  }
  loginFails.delete(ip);
  // httpOnly + SameSite=Lax：脚本读不到，跨站请求也带不出去
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${AUTH_COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  res.json({ ok: true, required: true, authed: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// 认证闸门：健康检查与认证接口放行，其余 /api/* 一律校验
app.use('/api', (req, res, next) => {
  if (!AUTH_REQUIRED) return next();
  const p = req.path;
  if (p === '/health' || p.startsWith('/auth/')) return next();
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: '未授权：请输入访问令牌', authRequired: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'NAS 导航监控助手', version: APP_VERSION, authRequired: AUTH_REQUIRED });
});

// ---------- 配置读写 ----------
app.get('/api/config', (req, res) => {
  const cfg = getConfig();
  const ui = cfg.ui || { downloaderRefreshSec: 15, siteRefreshSec: 60 };
  // 脱敏：凭证不返回明文
  const sanitized = {
    services: cfg.services,
    ui: {
      ...ui,
      // 背景图已独立存放（/api/theme/bg），这里只告诉前端"有没有"，
      // 避免每次进页面都拖几百 KB 的 base64
      theme: {
        ...((ui && ui.theme) || {}),
        bgImage: '',
        hasBgImage: hasThemeBg()
      }
    },
    mediaServer: {
      enabled: !!(cfg.mediaServer && cfg.mediaServer.enabled),
      name: (cfg.mediaServer && cfg.mediaServer.name) || '飞牛影视',
      baseUrl: (cfg.mediaServer && cfg.mediaServer.baseUrl) || '',
      username: (cfg.mediaServer && cfg.mediaServer.username) || '',
      password: (cfg.mediaServer && cfg.mediaServer.password) ? '******' : ''
    },
    moviePilot: {
      enabled: !!(cfg.moviePilot && cfg.moviePilot.enabled),
      baseUrl: (cfg.moviePilot && cfg.moviePilot.baseUrl) || '',
      apiToken: (cfg.moviePilot && cfg.moviePilot.apiToken) ? '******' : ''
    },
    docker: {
      enabled: !!(cfg.docker && cfg.docker.enabled),
      baseUrl: (cfg.docker && cfg.docker.baseUrl) || '',
      allowActions: !!(cfg.docker && cfg.docker.allowActions),
      homeComps: (cfg.docker && Array.isArray(cfg.docker.homeComps))
        ? cfg.docker.homeComps
        : ['overview', 'top', 'net', 'grid']
    },
    downloaders: cfg.downloaders.map(d => ({
      ...d,
      password: d.password ? '******' : '',
      apiKey: d.apiKey ? '******' : ''
    })),
    sites: cfg.sites.map(s => ({
      ...s,
      passkey: s.passkey ? '******' : '',
      cookie: s.cookie ? '******' : ''
    })),
    history: {
      enabled: cfg.history ? cfg.history.enabled !== false : true,
      intervalMin: (cfg.history && cfg.history.intervalMin) || 60,
      keepDays: (cfg.history && cfg.history.keepDays) || 30
    },
    // 告警配置：渠道里的 token/webhook 也属于凭证，同样掩码
    alerts: (() => {
      const al = cfg.alerts || {};
      const ch = al.channels || {};
      return {
        enabled: !!al.enabled,
        siteOfflineTimes: al.siteOfflineTimes != null ? al.siteOfflineTimes : 2,
        ratioMin: al.ratioMin || 0,
        diskPctMax: al.diskPctMax != null ? al.diskPctMax : 90,
        containerAbnormal: al.containerAbnormal !== false,
        repeatMin: al.repeatMin || 180,
        channels: {
          bark: { enabled: !!(ch.bark && ch.bark.enabled), url: ch.bark && ch.bark.url ? '******' : '' },
          telegram: {
            enabled: !!(ch.telegram && ch.telegram.enabled),
            botToken: ch.telegram && ch.telegram.botToken ? '******' : '',
            chatId: (ch.telegram && ch.telegram.chatId) || ''
          },
          wecom: { enabled: !!(ch.wecom && ch.wecom.enabled), webhook: ch.wecom && ch.wecom.webhook ? '******' : '' },
          webhook: {
            enabled: !!(ch.webhook && ch.webhook.enabled),
            url: ch.webhook && ch.webhook.url ? '******' : '',
            method: (ch.webhook && ch.webhook.method) || 'POST'
          }
        }
      };
    })()
  };
  res.json(sanitized);
});

// 备份导出：返回完整明文配置（含全部凭证），供用户下载到本地/NAS 保存
app.get('/api/config/export', (req, res) => {
  const cfg = getConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="nas-nav-backup-${stamp}.json"`);
  res.send(JSON.stringify(cfg, null, 2));
});

// 恢复：覆盖当前配置；覆盖前先把当前配置备份为 config.restore-<时间戳>.json（可手动找回）
app.post('/api/config/restore', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.services)) {
    return res.status(400).json({ ok: false, error: '备份文件格式不正确（缺少 services 列表）' });
  }
  const old = getConfig();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(CONFIG_DIR, `config.restore-${stamp}.json`), JSON.stringify(old, null, 2), 'utf-8');
  } catch (e) { /* 备份失败不阻断恢复 */ }
  // 结构归一：只取受控字段，缺失回退默认
  const media = incoming.mediaServer || {};
  const docker = incoming.docker || {};
  const ui = incoming.ui || {};
  const theme = ui.theme || {};
  const mp = incoming.moviePilot || {};
  const next = {
    services: Array.isArray(incoming.services) ? incoming.services : [],
    downloaders: Array.isArray(incoming.downloaders) ? incoming.downloaders : [],
    sites: Array.isArray(incoming.sites) ? incoming.sites : [],
    mediaServer: {
      enabled: !!media.enabled,
      name: media.name || '飞牛影视',
      baseUrl: media.baseUrl || '',
      username: media.username || '',
      password: media.password || ''
    },
    moviePilot: {
      enabled: !!mp.enabled,
      baseUrl: mp.baseUrl || '',
      apiToken: mp.apiToken || ''
    },
    docker: {
      enabled: !!docker.enabled,
      baseUrl: docker.baseUrl || '',
      // 备份恢复时容器操作开关也一并恢复（旧备份无此字段则为关闭）
      allowActions: !!docker.allowActions,
      homeComps: Array.isArray(docker.homeComps) ? docker.homeComps : ['overview', 'top', 'net', 'grid']
    },
    ui: {
      downloaderRefreshSec: Number(ui.downloaderRefreshSec) || 15,
      siteRefreshSec: Number(ui.siteRefreshSec) || 60,
      // 旧备份可能没有 siteCacheSec，回退默认值而不是丢掉
      siteCacheSec: Math.min(3600, Math.max(30, Number(ui.siteCacheSec) || 300)),
      theme: {
        mode: theme.mode === 'light' ? 'light' : 'dark',
        accent: theme.accent || '#4ea1ff',
        density: ['compact', 'normal', 'comfort'].includes(theme.density) ? theme.density : 'normal',
        radius: ['small', 'medium', 'large'].includes(theme.radius) ? theme.radius : 'medium',
        bg: ['gradient', 'glass'].includes(theme.bg) ? theme.bg : 'gradient',
        anim: theme.anim !== false,
        // 旧备份里的背景图可能是 data URL：saveConfig → loadConfig 时会自动迁移到独立文件
        bgImage: (typeof theme.bgImage === 'string' && theme.bgImage.length <= 4000000) ? theme.bgImage : ''
      }
    },
    // 历史采样 + 告警配置：旧备份没有这两块，回退默认
    history: {
      enabled: incoming.history ? incoming.history.enabled !== false : true,
      intervalMin: Math.min(1440, Math.max(5, Number(incoming.history && incoming.history.intervalMin) || 60)),
      keepDays: Math.min(365, Math.max(1, Number(incoming.history && incoming.history.keepDays) || 30))
    },
    alerts: mergeAlerts(incoming.alerts, {})
  };
  saveConfig(next);
  invalidateClients();
  siteStatusCache.clear();
  faviconCache.clear();
  restartSampler();
  res.json({ ok: true, services: next.services.length, sites: next.sites.length, downloaders: next.downloaders.length });
});

// 保存配置时：保留未变化的旧凭证
// 关键约定：**请求体里没出现的字段一律视为"不修改"**，只有显式提交才覆盖。
// 前端 autoSave 在设置页未渲染时会提交不完整的 ui/mediaServer 等，旧实现用
// `!!undefined` 归一成 false，导致"在站点页加一个站点"就把影视墙/Docker/MP 静默关掉。
function has(obj, key) {
  return obj != null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}
function pickBool(incoming, key, fallback) {
  if (!incoming || !has(incoming, key)) return !!fallback;
  return !!incoming[key];
}
function pickStr(incoming, key, fallback, { trim = true, stripSlash = false } = {}) {
  if (!incoming || !has(incoming, key)) return fallback || '';
  let v = String(incoming[key] == null ? '' : incoming[key]);
  if (trim) v = v.trim();
  if (stripSlash) v = v.replace(/\/+$/, '');
  return v;
}
// 数值区间夹取：未提交 / 非法值 → 保留旧值（不再回落硬编码默认）
function pickNum(incoming, key, fallback, min, max) {
  if (!incoming || !has(incoming, key)) return fallback;
  const n = Number(incoming[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function pickEnum(incoming, key, fallback, allowed) {
  if (!incoming || !has(incoming, key)) return fallback;
  return allowed.includes(incoming[key]) ? incoming[key] : fallback;
}

// 告警配置合并：规则字段走"未提交即保留"，渠道里的凭证字段遇 ****** 也保留旧值
const ALERT_CHANNEL_KEEP = { bark: ['url'], telegram: ['botToken'], wecom: ['webhook'], webhook: ['url'] };
function mergeAlerts(incoming, old) {
  const o = old || {};
  const i = incoming && typeof incoming === 'object' ? incoming : null;
  const chIn = i && i.channels && typeof i.channels === 'object' ? i.channels : null;
  const chOld = o.channels || {};
  const channels = {};
  for (const name of ['bark', 'telegram', 'wecom', 'webhook']) {
    const src = (chIn && chIn[name]) || {};
    const prev = chOld[name] || {};
    const out = { enabled: has(src, 'enabled') ? !!src.enabled : !!prev.enabled };
    for (const k of Object.keys(prev)) {
      if (k === 'enabled') continue;
      const v = src[k];
      // ****** 或未提交 → 保留旧值
      out[k] = (v === undefined || v === '******') ? prev[k] : String(v).trim();
    }
    // 新字段（旧配置里没有的）
    for (const k of Object.keys(src)) {
      if (out[k] !== undefined) continue;
      if (src[k] === '******') continue;
      out[k] = typeof src[k] === 'string' ? src[k].trim() : src[k];
    }
    if (name === 'webhook' && !out.method) out.method = 'POST';
    channels[name] = out;
  }
  return {
    enabled: pickBool(i, 'enabled', o.enabled),
    siteOfflineTimes: pickNum(i, 'siteOfflineTimes', o.siteOfflineTimes != null ? o.siteOfflineTimes : 2, 1, 20),
    ratioMin: pickNum(i, 'ratioMin', o.ratioMin || 0, 0, 100),
    diskPctMax: pickNum(i, 'diskPctMax', o.diskPctMax != null ? o.diskPctMax : 90, 0, 100),
    containerAbnormal: pickBool(i, 'containerAbnormal', o.containerAbnormal !== false),
    repeatMin: pickNum(i, 'repeatMin', o.repeatMin || 180, 5, 10080),
    channels
  };
}

app.put('/api/config', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const old = getConfig();
  const oldUi = old.ui || {};
  const oldTheme = oldUi.theme || {};
  const oldMedia = old.mediaServer || {};
  const oldMp = old.moviePilot || {};
  const oldDocker = old.docker || {};
  const oldHistory = old.history || {};
  const oldAlerts = old.alerts || {};
  const inUi = body.ui;
  const inTheme = inUi && typeof inUi === 'object' ? inUi.theme : undefined;
  const inMedia = body.mediaServer;
  const inMp = body.moviePilot;
  const inDocker = body.docker;

  const next = {
    services: Array.isArray(body.services) ? body.services : old.services,
    downloaders: Array.isArray(body.downloaders) ? body.downloaders : old.downloaders,
    sites: Array.isArray(body.sites) ? body.sites : old.sites,
    mediaServer: {
      enabled: pickBool(inMedia, 'enabled', oldMedia.enabled),
      name: pickStr(inMedia, 'name', oldMedia.name) || '飞牛影视',
      baseUrl: pickStr(inMedia, 'baseUrl', oldMedia.baseUrl, { stripSlash: true }),
      username: pickStr(inMedia, 'username', oldMedia.username),
      // 掩码 ****** / 空 = 未修改
      password: (inMedia && has(inMedia, 'password') && inMedia.password && inMedia.password !== '******')
        ? String(inMedia.password)
        : (oldMedia.password || '')
    },
    moviePilot: {
      enabled: pickBool(inMp, 'enabled', oldMp.enabled),
      baseUrl: pickStr(inMp, 'baseUrl', oldMp.baseUrl, { stripSlash: true }),
      apiToken: (inMp && has(inMp, 'apiToken') && inMp.apiToken && inMp.apiToken !== '******')
        ? String(inMp.apiToken).trim()
        : (oldMp.apiToken || '')
    },
    ui: {
      downloaderRefreshSec: pickNum(inUi, 'downloaderRefreshSec', oldUi.downloaderRefreshSec || 15, 5, 300),
      siteRefreshSec: pickNum(inUi, 'siteRefreshSec', oldUi.siteRefreshSec || 60, 10, 600),
      siteCacheSec: pickNum(inUi, 'siteCacheSec', oldUi.siteCacheSec || 300, 30, 3600),
      theme: {
        mode: pickEnum(inTheme, 'mode', oldTheme.mode === 'light' ? 'light' : 'dark', ['light', 'dark']),
        accent: pickStr(inTheme, 'accent', oldTheme.accent) || '#4ea1ff',
        density: pickEnum(inTheme, 'density', oldTheme.density || 'normal', ['compact', 'normal', 'comfort']),
        radius: pickEnum(inTheme, 'radius', oldTheme.radius || 'medium', ['small', 'medium', 'large']),
        bg: pickEnum(inTheme, 'bg', oldTheme.bg || 'gradient', ['gradient', 'glass']),
        anim: (inTheme && has(inTheme, 'anim') && typeof inTheme.anim === 'boolean') ? inTheme.anim : (oldTheme.anim !== false),
        // 背景图走独立接口（/api/theme/bg）。语义：
        //   提交非空 http(s) 地址 → 设为外链背景
        //   bgClear: true        → 清空外链 + 删除已上传的图片文件
        //   其他（含空串）       → 保持原值
        // 不能把空串当"清空"：GET /api/config 永远返回 bgImage:''（图片不内联），
        // 那样每次自动保存都会把用户上传的背景图删掉。
        bgImage: (() => {
          if (inTheme && has(inTheme, 'bgImage') && typeof inTheme.bgImage === 'string') {
            const v = inTheme.bgImage.trim();
            if (/^https?:\/\//i.test(v)) return v;
          }
          return inTheme && inTheme.bgClear === true ? '' : (oldTheme.bgImage || '');
        })()
      }
    },
    docker: {
      enabled: pickBool(inDocker, 'enabled', oldDocker.enabled),
      // baseUrl：null/undefined 回退旧值；空字符串明确清空（恢复本机 socket 模式）
      baseUrl: pickStr(inDocker, 'baseUrl', oldDocker.baseUrl, { stripSlash: true }),
      // 容器启停开关：默认关闭，需要用户显式打开
      allowActions: pickBool(inDocker, 'allowActions', oldDocker.allowActions),
      homeComps: (inDocker && Array.isArray(inDocker.homeComps))
        ? inDocker.homeComps
        : (Array.isArray(oldDocker.homeComps) ? oldDocker.homeComps : ['overview', 'top', 'net', 'grid'])
    },
    history: {
      enabled: pickBool(body.history, 'enabled', oldHistory.enabled !== false),
      intervalMin: pickNum(body.history, 'intervalMin', oldHistory.intervalMin || 60, 5, 1440),
      keepDays: pickNum(body.history, 'keepDays', oldHistory.keepDays || 30, 1, 365)
    },
    alerts: mergeAlerts(body.alerts, oldAlerts)
  };

  // 背景图显式清除（bgClear）时，把独立文件一并删掉（否则 hasBgImage 仍为 true）
  if (inTheme && inTheme.bgClear === true) {
    clearThemeBg();
  }

  // 凭证回填：如果前端提交的是掩码 ******，保留旧值
  for (const d of next.downloaders) {
    const oldD = (old.downloaders || []).find(x => x.id === d.id);
    if (d.password === '******' && oldD) d.password = oldD.password;
    if (d.apiKey === '******' && oldD) d.apiKey = oldD.apiKey;
  }
  for (const s of next.sites) {
    const oldS = (old.sites || []).find(x => x.id === s.id);
    if (s.passkey === '******' && oldS) s.passkey = oldS.passkey;
    if (s.cookie === '******' && oldS) s.cookie = oldS.cookie;
  }

  saveConfig(next);
  invalidateClients(); // 配置可能改了凭证/地址，废弃旧 client（TR 采样基准、qB 会话、MP 缓存、飞牛 token）
  restartSampler();    // 采样间隔/告警规则可能变了，按新配置重建定时器
  // 站点状态缓存只失效「新增 / 删除 / 关键配置变更」的站点；
  // 纯分组、图标等非关键调整不影响缓存，避免保存配置后全量重抓 PT 站
  const oldSites = new Map((old.sites || []).map(s => [s.id, s]));
  for (const s of next.sites) {
    const os = oldSites.get(s.id);
    if (!os || siteCacheKeyChanged(s, os)) siteStatusCache.delete(s.id);
  }
  for (const s of old.sites || []) {
    if (!next.sites.some(n => n.id === s.id)) siteStatusCache.delete(s.id);
  }
  res.json({ ok: true, hasBgImage: hasThemeBg() });
});

// ---------- 主题背景图（独立文件，不占 config.json）----------
// 上传：POST /api/theme/bg  body = { dataUrl } 或 { data: base64, contentType }
// 单独给 8mb 的解析上限：base64 会让体积膨胀约 1.33 倍，4MB 原图编码后约 5.4MB
const bgJsonParser = express.json({ limit: '8mb' });
app.post('/api/theme/bg', bgJsonParser, (req, res) => {
  const b = req.body || {};
  let buf = null;
  let ct = 'image/jpeg';
  if (typeof b.dataUrl === 'string' && /^data:/i.test(b.dataUrl)) {
    const m = b.dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return res.status(400).json({ ok: false, error: '图片数据格式不正确' });
    ct = (m[1] && /^image\//.test(m[1])) ? m[1] : 'image/jpeg';
    try {
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf-8');
    } catch (e) {
      return res.status(400).json({ ok: false, error: '图片 base64 解码失败' });
    }
  } else if (typeof b.data === 'string' && b.data) {
    ct = (typeof b.contentType === 'string' && /^image\//.test(b.contentType)) ? b.contentType : 'image/jpeg';
    buf = Buffer.from(b.data, 'base64');
  }
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: '缺少图片数据' });
  try {
    const saved = saveThemeBg(buf, ct);
    res.json({ ok: true, size: saved.size, contentType: saved.contentType, maxBytes: THEME_BG_MAX_BYTES });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

// 读取背景图：直接以图片流返回，浏览器可长缓存（换图时 URL 带 ?v=时间戳）
app.get('/api/theme/bg', (req, res) => {
  const bg = getThemeBg();
  if (!bg) return res.status(404).json({ ok: false, error: '未设置背景图' });
  res.set('Content-Type', bg.contentType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(bg.buf);
});

app.delete('/api/theme/bg', (req, res) => {
  clearThemeBg();
  res.json({ ok: true });
});

// ---------- 下载器 ----------
function buildDownloader(d) {
  if (d.type === 'transmission') return new TransmissionClient(d);
  return new QBittorrentClient(d); // 默认 qbittorrent
}

// 下载器 client 按 id 缓存实例：Transmission 实时速率靠「两次采样差值」计算，
// qB 登录会话也可复用；配置变更后整体清空
const downloaderClients = new Map(); // id -> client

// 全部下载器状态的合并缓存（声明必须在 invalidateClients 之前，否则调用时会落入 TDZ）
const DL_STATUS_TTL = 3000;
let dlStatusCache = { at: 0, data: null, key: '' };

function getDownloaderClient(d) {
  if (!d || !d.id) return buildDownloader(d); // test 等临时对象不缓存
  let c = downloaderClients.get(d.id);
  if (!c || c.host !== (d.host || '').replace(/\/+$/, '') || c.authMode !== d.authMode) {
    c = buildDownloader(d);
    downloaderClients.set(d.id, c);
  }
  return c;
}

// MoviePilot / 飞牛影视 client 也要复用实例，否则它们的内部缓存全部失效：
//  - MoviePilotClient 的 10s 看板缓存是实例字段，每次 new 等于缓存命中率 0
//  - FeiniuMediaClient 的登录 token 与「登录互斥锁」也是实例字段，
//    海报墙首屏几十张海报 = 几十次并发登录，会触发服务端登录限流（返回 Password Incorrect）
const mpClients = new Map();     // key: baseUrl|apiToken
const mediaClients = new Map();  // key: baseUrl|username|password
function getMpClient(cfg) {
  const mp = cfg || {};
  const key = (mp.baseUrl || '') + '|' + (mp.apiToken || '');
  let c = mpClients.get(key);
  if (!c) { c = new MoviePilotClient(mp); mpClients.set(key, c); }
  return c;
}
function getMediaClient(cfg) {
  const ms = cfg || {};
  const key = (ms.baseUrl || '') + '|' + (ms.username || '') + '|' + (ms.password || '');
  let c = mediaClients.get(key);
  if (!c) { c = new FeiniuMediaClient(ms); mediaClients.set(key, c); }
  return c;
}
// 配置变更后统一废弃所有缓存 client
function invalidateClients() {
  downloaderClients.clear();
  mpClients.clear();
  mediaClients.clear();
  dlStatusCache = { at: 0, data: null, key: '' }; // 下载器状态合并缓存一并失效
}

function maskHost(host) {
  try {
    const u = new URL(host);
    const parts = u.hostname.split('.');
    const masked = parts.map((p, i) => (i < parts.length - 1 ? p.replace(/./g, '*') : p)).join('.');
    return `${u.protocol}//${masked}${u.port ? ':' + u.port : ''}`;
  } catch (e) {
    return host;
  }
}

// 测试单个下载器
app.post('/api/downloaders/test', async (req, res) => {
  const d = req.body;
  if (!d || !d.host) return res.status(400).json({ ok: false, error: '缺少下载器地址' });
  const client = buildDownloader({ ...d, id: d.id || 'test' });
  try {
    const status = await client.getStatus();
    res.json({ ok: true, version: status.version });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// 单个下载器状态（聚合与单卡刷新共用）
async function fetchDownloaderStatus(d) {
  const client = getDownloaderClient(d);
  try {
    const status = await client.getStatus();
    return {
      id: d.id, name: d.name, type: d.type, host: maskHost(d.host),
      online: true, version: status.version,
      downSpeed: status.downSpeed, upSpeed: status.upSpeed,
      downloading: status.downloading, uploading: status.uploading, stopped: status.stopped,
      totalUploaded: status.totalUploaded, totalDownloaded: status.totalDownloaded,
      error: null
    };
  } catch (e) {
    return {
      id: d.id, name: d.name, type: d.type, host: maskHost(d.host),
      online: false, version: '', downSpeed: 0, upSpeed: 0,
      downloading: 0, uploading: 0, stopped: 0,
      totalUploaded: 0, totalDownloaded: 0,
      error: e.message || String(e)
    };
  }
}

// 全部下载器状态（带 3 秒合并缓存）：
// 「下载器页 15s 轮询」和「顶栏状态 30s 轮询」会同时打这些接口，不合并的话
// 每个下载器（qB 每次 4 个请求）会被重复拉取一遍。
function downloaderConfigKey(list) {
  return list.map(d => [d.id, d.host, d.type, d.authMode, d.enabled].join('|')).join(';;');
}
async function getAllDownloaderStatus() {
  const cfg = getConfig();
  const enabled = cfg.downloaders.filter(d => d.enabled && d.host);
  const key = downloaderConfigKey(enabled);
  const now = Date.now();
  if (dlStatusCache.data && dlStatusCache.key === key && now - dlStatusCache.at < DL_STATUS_TTL) {
    return dlStatusCache.data;
  }
  const results = await Promise.all(enabled.map(fetchDownloaderStatus));
  dlStatusCache = { at: Date.now(), data: results, key };
  return results;
}

// 聚合所有启用下载器的实时状态
app.get('/api/downloaders/status', async (req, res) => {
  const results = await getAllDownloaderStatus();

  const online = results.filter(r => r.online);
  res.json({
    totalDown: results.reduce((s, r) => s + r.downSpeed, 0),
    totalUp: results.reduce((s, r) => s + r.upSpeed, 0),
    online: online.length,
    offline: results.length - online.length,
    totalUploaded: online.reduce((s, r) => s + r.totalUploaded, 0),
    totalDownloaded: online.reduce((s, r) => s + r.totalDownloaded, 0),
    items: results
  });
});

// 单下载器状态（卡片绿点点击手动刷新）
app.get('/api/downloaders/status/:id', async (req, res) => {
  const cfg = getConfig();
  const d = cfg.downloaders.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ ok: false, error: '下载器不存在' });
  const item = await fetchDownloaderStatus(d);
  res.json({ ok: true, item });
});

// ---------- 服务导航 ----------
// 服务在线状态探测：对启用的服务 URL 做可达性检查（2xx/3xx 视为在线），供首页卡片显示状态点
app.get('/api/services/status', async (req, res) => {
  const cfg = getConfig();
  const services = cfg.services.filter(s => s.enabled && s.url);
  const results = await Promise.all(services.map(async s => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(s.url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'NAS-Nav/1.0', 'Accept-Language': 'zh-CN,zh;q=0.9' }
      });
      clearTimeout(timer);
      return { id: s.id, online: r.status >= 200 && r.status < 400, status: r.status, error: null };
    } catch (e) {
      clearTimeout(timer);
      const msg = (e && e.name === 'AbortError') ? '连接超时'
        : (e && e.cause && e.cause.code) || (e && e.message) || String(e);
      return { id: s.id, online: false, status: 0, error: msg };
    }
  }));
  res.json({ items: results });
});

// ---------- 服务自动发现 ----------
// 已知服务目录：Docker 容器名/镜像匹配 + 宿主端口探测（host 项目）
const SERVICE_CATALOG = [
  { key: 'iyuu', name: 'IYUU 自动辅种', icon: 'iy', ports: [9898], re: /iyuu/i },
  { key: 'lucky', name: 'Lucky', icon: 'lu', ports: [16601, 16610], re: /lucky/i },
  { key: 'mp', name: 'MoviePilot', icon: 'mp', ports: [3000, 3007], re: /moviepilot|^mp$|mp[-_.]/i },
  { key: 'qb', name: 'qBittorrent', icon: 'qb', ports: [8080, 8090], re: /qbittorrent|qbt|qb[-_.]/i },
  { key: 'tr', name: 'Transmission', icon: 'tr', ports: [9091], re: /transmission/i },
  { key: 'jf', name: 'Jellyfin', icon: 'jf', ports: [8096], re: /jellyfin/i },
  { key: 'emby', name: 'Emby', icon: 'em', ports: [8096], re: /emby/i },
  { key: 'alist', name: 'Alist', icon: 'al', ports: [5244], re: /alist/i },
  { key: 'nastool', name: 'NasTools', icon: 'nt', ports: [3000], re: /nastool|nas-tools/i },
  { key: 'plex', name: 'Plex', icon: 'px', ports: [32400], re: /plex/i },
  { key: 'navidrome', name: 'Navidrome', icon: 'nd', ports: [4533], re: /navidrome/i },
  { key: 'photoprism', name: 'PhotoPrism', icon: 'pp', ports: [2342], re: /photoprism/i },
  { key: 'portainer', name: 'Portainer', icon: 'po', ports: [9000, 9443], re: /portainer/i },
  { key: 'feiniu', name: '飞牛影视', icon: 'fn', ports: [5666], re: /feiniu|fnos|fn-movie|fnmovie/i },
  { key: 'syncthing', name: 'Syncthing', icon: 'sy', ports: [8384], re: /syncthing/i },
  { key: 'aria2', name: 'Aria2', icon: 'a2', ports: [6800], re: /aria2/i },
  { key: 'jackett', name: 'Jackett', icon: 'jk', ports: [9117], re: /jackett/i },
  { key: 'prowlarr', name: 'Prowlarr', icon: 'pw', ports: [9696], re: /prowlarr/i },
  { key: 'sonarr', name: 'Sonarr', icon: 'sn', ports: [8989], re: /sonarr/i },
  { key: 'radarr', name: 'Radarr', icon: 'rd', ports: [7878], re: /radarr/i },
  { key: 'rsshub', name: 'RSSHub', icon: 'rh', ports: [1200], re: /rsshub/i },
  { key: 'filebrowser', name: 'FileBrowser', icon: 'fb', ports: [8080], re: /filebrowser/i },
  { key: 'ddnsgo', name: 'DDNS-GO', icon: 'dg', ports: [9876], re: /ddns-go|ddnsgo/i },
  { key: 'homepage', name: 'Homepage', icon: 'hp', ports: [3000], re: /homepage/i },
  { key: 'immich', name: 'Immich', icon: 'im', ports: [2283], re: /immich/i },
  { key: 'xui', name: 'X-UI', icon: 'xi', ports: [54321, 2053], re: /x-ui|xui/i },
  { key: 'nginx', name: 'Nginx', icon: 'ng', ports: [80, 443], re: /nginx/i }
];
const svcUid = () => 'svc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 宿主机局域网 IP（供「服务地址」表单自动填充）
// 注意：/proc/net/route 里的是**默认网关**，不是 NAS 自己的地址（旧实现填的是路由器 IP）。
// 正确来源按优先级：docker.baseUrl 里的 IP → 宿主 /proc/net/fib_trie 的本地 /32 地址
// → 容器自身网卡（非 docker 网桥网段）→ 网关兜底。
function isPrivateV4(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
// 排除 docker 默认网桥 / 容器网段（这些不是 NAS 的局域网地址）
function isDockerRange(ip) {
  return /^172\.17\./.test(ip) || /^172\.18\./.test(ip) || /^172\.19\./.test(ip) ||
    /^172\.2\d\./.test(ip) || /^172\.3[01]\./.test(ip);
}
function detectLanIp(cfg) {
  try {
    if (cfg && cfg.docker && cfg.docker.baseUrl) {
      const h = new URL(cfg.docker.baseUrl).hostname;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
    }
  } catch (e) { /* 忽略 */ }
  // 宿主 fib_trie：形如 "  |-- 192.168.50.20\n     /32 host LOCAL"
  try {
    const raw = fs.readFileSync('/host/proc/net/fib_trie', 'utf8');
    const cands = [];
    const re = /^\s*\|--\s+(\d+\.\d+\.\d+\.\d+)\s*\n\s*\/32 host LOCAL/gm;
    let m;
    while ((m = re.exec(raw)) !== null) cands.push(m[1]);
    const pick = cands.find(ip => isPrivateV4(ip) && !isDockerRange(ip) && !/^127\./.test(ip));
    if (pick) return pick;
  } catch (e) { /* 未挂载 /host/proc 时走下一档 */ }
  // 容器自身网卡（host 网络模式部署时就是宿主地址）
  try {
    const os = require('os');
    const ifs = os.networkInterfaces();
    const cands = [];
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (!isPrivateV4(a.address)) continue;
        if (isDockerRange(a.address)) continue;
        cands.push(a.address);
      }
    }
    if (cands.length) return cands[0];
  } catch (e) { /* 忽略 */ }
  // 最后兜底：默认网关（容器内通常是 docker 网桥地址，仅作提示）
  try {
    const raw = fs.readFileSync('/host/proc/net/route', 'utf8');
    for (const line of raw.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 3 && p[1] === '00000000' && p[2] !== '00000000' && p[2] !== '0000000000000000') {
        const gw = p[2];
        return [3, 2, 1, 0].map(i => parseInt(gw.slice(i * 2, i * 2 + 2), 16)).join('.');
      }
    }
  } catch (e) { /* 忽略 */ }
  return '';
}

app.get('/api/services/discover', async (req, res) => {
  const cfg = getConfig();
  const addedUrls = new Set((cfg.services || []).map(s => s.url));
  const items = [];
  let dockerAvailable = false;

  // 1) Docker 容器发现：容器名/镜像匹配目录，读端口映射生成 URL
  try {
    const containers = await dockerMonitor.listContainers(cfg.docker || {});
    if (containers && containers.length) dockerAvailable = true;
    for (const c of containers) {
      const hay = (c.name || '') + ' ' + (c.image || '');
      const hit = SERVICE_CATALOG.find(x => x.re.test(hay));
      const p = (c.portsArr || []).length ? c.portsArr[0].hostPort : '';
      const url = p ? 'http://host.docker.internal:' + p : '';
      items.push({
        id: 'docker_' + (c.id || Math.random().toString(36).slice(2, 8)),
        source: 'docker',
        name: hit ? hit.name : (c.name || c.image || '未知容器'),
        icon: hit ? hit.icon : 'ct',
        url,
        port: p || '',
        container: c.name,
        image: c.image,
        running: c.state === 'running',
        added: !!(url && addedUrls.has(url))
      });
    }
  } catch (e) { dockerAvailable = false; }

  // 2) 宿主端口探测（host 项目）：探测目录中已知端口是否开放
  let host = 'host.docker.internal';
  if (cfg.docker && cfg.docker.baseUrl) {
    try { host = new URL(cfg.docker.baseUrl).hostname; } catch (e) { /* 保持默认 */ }
  }
  const probed = new Set();
  const hostChecks = [];
  for (const hit of SERVICE_CATALOG) {
    for (const port of hit.ports) {
      if (probed.has(hit.key + ':' + port)) continue;
      probed.add(hit.key + ':' + port);
      hostChecks.push({ hit, port });
    }
  }
  await Promise.all(hostChecks.map(async ({ hit, port }) => {
    try {
      const r = await fetch(`http://${host}:${port}/`, {
        signal: AbortSignal.timeout(1500),
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual'
      });
      if (!r.ok && r.status >= 400 && r.status < 600) return; // 明确 4xx/5xx 不算
      const url = `http://${host}:${port}`;
      items.push({
        id: 'port_' + hit.key + '_' + port,
        source: 'port',
        name: hit.name,
        icon: hit.icon,
        url,
        port: String(port),
        running: true,
        added: addedUrls.has(url)
      });
    } catch (e) { /* 端口未开放 */ }
  }));

  // 已添加的排后面，运行中的排前面
  items.sort((a, b) => (a.added ? 1 : 0) - (b.added ? 1 : 0) || (b.running ? 1 : 0) - (a.running ? 1 : 0));
  res.json({ ok: true, dockerAvailable, host, lanIp: detectLanIp(cfg), items });
});

// 导入勾选的服务到导航配置（按 URL 去重）
app.post('/api/services/import', (req, res) => {
  const cfg = getConfig();
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const svcs = Array.isArray(cfg.services) ? cfg.services : [];
  const urlSet = new Set(svcs.map(s => s.url));
  let added = 0;
  for (const it of items) {
    const url = String(it.url || '').trim().replace(/\/+$/, '');
    if (!url || urlSet.has(url)) continue;
    // 只接受 http(s)，过滤 javascript: 等可执行协议
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    } catch (e) { continue; }
    const name = String(it.name || '').trim() || '新服务';
    const cat = String(it.category || '').trim() || '工具服务';
    const icon = String(it.icon || '').trim() || 'nav';
    svcs.push({ id: svcUid(), name, icon, url, category: cat, enabled: true });
    urlSet.add(url);
    added++;
  }
  cfg.services = svcs;
  saveConfig(cfg);
  res.json({ ok: true, added, total: svcs.length });
});

// 宿主机局域网 IP（服务添加时"局域网 IP"模式自动填充；轻量接口，不打端口扫描）
app.get('/api/system/lanip', (req, res) => {
  res.json({ ok: true, lanIp: detectLanIp(getConfig()) });
});

// ---------- 系统监控 ----------
// 宿主系统状态：CPU/内存/磁盘/网络（经 /host/proc /host/root 只读挂载读取）
app.get('/api/system/status', (req, res) => {
  res.json(getSystemStatus());
});

// ---------- Docker 容器监控 ----------
// detail=1 时补充重启次数 / 健康检查（设置页容器操作列表用）；默认轻量（首页总览用）
app.get('/api/docker/containers', async (req, res) => {
  const cfg = getConfig();
  const docker = cfg.docker || {};
  if (!docker.enabled) {
    return res.json({ ok: true, connected: false, disabled: true, items: [] });
  }
  try {
    const items = await dockerMonitor.listContainers(docker, req.query.detail === '1');
    res.json({ ok: true, connected: true, items });
  } catch (e) {
    res.json({ ok: true, connected: false, error: e.message, items: [] });
  }
});

app.get('/api/docker/stats', async (req, res) => {
  const cfg = getConfig();
  const docker = cfg.docker || {};
  if (!docker.enabled) {
    return res.json({ ok: true, connected: false, disabled: true, items: [] });
  }
  try {
    const items = await dockerMonitor.containerStats(docker);
    res.json({ ok: true, connected: true, items });
  } catch (e) {
    res.json({ ok: true, connected: false, error: e.message, items: [] });
  }
});

// 容器操作：启动 / 停止 / 重启 / 暂停 / 恢复
// 需要显式开启 docker.allowActions，避免默认给面板一个"能停掉 NAS 所有容器"的开关
app.post('/api/docker/containers/:ref/action', async (req, res) => {
  const cfg = getConfig();
  const docker = cfg.docker || {};
  if (!docker.enabled) {
    return res.status(400).json({ ok: false, error: 'Docker 容器监控未启用' });
  }
  if (!docker.allowActions) {
    return res.status(403).json({ ok: false, error: '容器操作未开启：请到「设置 → Docker 容器监控」勾选「允许容器启停」' });
  }
  const action = String((req.body && req.body.action) || req.query.action || '').trim();
  if (!dockerMonitor.CONTAINER_ACTIONS.includes(action)) {
    return res.status(400).json({ ok: false, error: '不支持的操作：' + action + '（可选：' + dockerMonitor.CONTAINER_ACTIONS.join(' / ') + '）' });
  }
  try {
    const r = await dockerMonitor.containerAction(docker, req.params.ref, action);
    console.log('[docker] ' + action + ' ' + r.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    const msg = e.message || String(e);
    // 标识校验失败属于客户端输入问题，返回 400；连不上 daemon 才是 500
    const isClientError = /容器标识非法|缺少容器标识|不支持的操作/.test(msg);
    res.status(isClientError ? 400 : 500).json({ ok: false, error: msg });
  }
});

// ---------- 站点 favicon 自动获取 ----------
// 仅允许拉取「已配置站点」自己域名下的图标（防 SSRF）：先试 /favicon.ico，再解析首页 <link rel=icon>；缓存 24 小时
const faviconCache = new Map(); // host -> { buf, ct, at }
const FAVICON_TTL = 24 * 60 * 60 * 1000;
app.get('/api/site/favicon/:id', async (req, res) => {
  const cfg = getConfig();
  const site = cfg.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: '站点不存在' });
  const rawUrl = site.profileUrl || site.apiUrl || site.url;
  let origin;
  try {
    const u = new URL(rawUrl);
    origin = u.protocol + '//' + u.host;
  } catch (e) {
    return res.status(400).json({ ok: false, error: '站点地址无效' });
  }
  const cached = faviconCache.get(origin);
  // ?refresh=1 强制重抓（站点图标手动获取按钮）
  if (cached && req.query.refresh !== '1' && Date.now() - cached.at < FAVICON_TTL) {
    res.set('Content-Type', cached.ct);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buf);
  }
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const tryFetch = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: UA, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { buf, ct: r.headers.get('content-type') || 'image/png' };
  };
  let got = null;
  try { got = await tryFetch(origin + '/favicon.ico'); } catch (e) { /* next */ }
  if (!got) {
    try {
      const r = await fetch(origin + '/', { signal: AbortSignal.timeout(6000), headers: UA, redirect: 'follow' });
      const html = await r.text();
      const m = html.match(/<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)/i)
        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i);
      if (m) {
        const abs = new URL(m[1], origin + '/').toString();
        if (abs.startsWith(origin)) got = await tryFetch(abs).catch(() => null);
      }
    } catch (e) { /* next */ }
  }
  if (!got) return res.status(404).json({ ok: false, error: '未找到该站点图标' });
  faviconCache.set(origin, { buf: got.buf, ct: got.ct, at: Date.now() });
  if (faviconCache.size > 400) {
    let n = 0;
    for (const [k] of faviconCache) { faviconCache.delete(k); if (++n >= 200) break; }
  }
  res.set('Content-Type', got.ct);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(got.buf);
});

// ---------- 飞牛影视媒体服务器 ----------
let mediaCache = { at: 0, data: null, error: null };

// 媒体墙概览：媒体库统计 / 媒体库 / 继续观看 / 最近条目（带 60s 缓存，可 ?refresh=1 强制刷新）
app.get('/api/media/overview', async (req, res) => {
  const cfg = getConfig();
  const ms = cfg.mediaServer || {};
  if (!ms.enabled || !ms.baseUrl || !ms.username) {
    return res.json({ ok: true, connected: false, configured: false, data: null });
  }
  if (!mediaCache.data || Date.now() - mediaCache.at > 60000 || req.query.refresh === '1') {
    const client = getMediaClient(ms); // 复用实例，登录 token 与登录互斥锁才能生效
    try {
      const data = await client.getOverview();
      mediaCache = { at: Date.now(), data, error: null };
    } catch (e) {
      mediaCache = { at: Date.now() - 55000, data: mediaCache.data, error: e.message || String(e) };
      return res.json({ ok: true, connected: false, configured: true, error: mediaCache.error, data: mediaCache.data });
    }
  }
  res.json({ ok: true, connected: true, configured: true, error: mediaCache.error, data: mediaCache.data });
});

// 媒体服务器连接状态（供设置页测试）：配置完整时主动探一次，而不是只看内存缓存
// （否则容器重启后 mediaCache 为空，会一直显示"未连接"）
app.get('/api/media/status', async (req, res) => {
  const cfg = getConfig();
  const ms = cfg.mediaServer || {};
  const configured = !!(ms.enabled && ms.baseUrl && ms.username);
  let connected = false;
  let error = mediaCache.error;
  if (configured) {
    if (mediaCache.data && Date.now() - mediaCache.at < 60000) {
      connected = true;
      error = mediaCache.error;
    } else {
      try {
        const data = await getMediaClient(ms).getOverview();
        mediaCache = { at: Date.now(), data, error: null };
        connected = true;
        error = null;
      } catch (e) {
        error = e.message || String(e);
      }
    }
  }
  res.json({
    ok: true,
    configured,
    connected,
    error,
    name: ms.name || '飞牛影视',
    baseUrl: ms.baseUrl || ''
  });
});

// 海报代理：飞牛影视海报接口需要登录态（Cookie + authx 签名），浏览器无法直接加载，
// 由服务端统一取回并转发；上游取 ?w=400 小图（原图约 2.3MB，小图约 30KB），
// 内存缓存 6 小时（上限 600 张，超限清除最旧一半），第二次起秒回
const posterCache = new Map(); // url -> { buf, ct, at }
const POSTER_TTL = 6 * 60 * 60 * 1000;
const POSTER_MAX = 600;
app.get('/api/media/poster', async (req, res) => {
  const cfg = getConfig();
  const ms = cfg.mediaServer || {};
  const url = String(req.query.url || '');
  if (!ms.baseUrl) {
    return res.status(400).json({ ok: false, error: '未配置媒体服务器' });
  }
  // SSRF 防护：URL 解析后严格比较 protocol/host/port，并限定路径前缀，防字符串前缀绕过
  let u, b;
  try {
    u = new URL(url);
    b = new URL(ms.baseUrl);
  } catch (e) {
    return res.status(400).json({ ok: false, error: '非法图片地址' });
  }
  const sameHost = u.protocol === b.protocol && u.hostname === b.hostname && (u.port || '80') === (b.port || '80');
  const pathPrefix = ((b.pathname || '/').replace(/\/+$/, '')) + '/v/';
  if (!sameHost || !u.pathname.startsWith(pathPrefix)) {
    return res.status(400).json({ ok: false, error: '非法图片地址' });
  }
  const cached = posterCache.get(url);
  if (cached && Date.now() - cached.at < POSTER_TTL) {
    res.set('Content-Type', cached.ct);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buf);
  }
  const client = getMediaClient(ms); // 复用实例：海报墙首屏几十张图共用一次登录
  try {
    const token = await client._ensureToken();
    const u2 = new URL(url);
    u2.searchParams.set('w', '400');
    // 签名只对 pathname（query 不参与）
    const upstream = await fetch(u2.toString(), {
      headers: { 'Cookie': `Trim-MC-token=${token}`, 'authx': client._authx(u2.pathname, null, 'GET') },
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: '海报获取失败 HTTP ' + upstream.status });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    posterCache.set(url, { buf, ct, at: Date.now() });
    if (posterCache.size > POSTER_MAX) {
      let removed = 0;
      for (const [k] of posterCache) {
        posterCache.delete(k);
        if (++removed >= Math.floor(POSTER_MAX / 2)) break;
      }
    }
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- PT 站点 ----------
function buildSite(s) {
  if (s.mode === 'mteam') return new SiteMteamClient(s);
  if (s.mode === 'cookie') return new SiteScrapeClient(s);
  return new SiteApiClient(s); // 默认 api
}

// 并发池：限制同时进行的抓取数量（站点多时防止瞬时打爆 PT 站限流/风控）
async function runPool(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
const SITE_CONCURRENCY = 4;

// 站点状态缓存：F5 / 切换页面 / 保存配置等高频操作不会重复访问 PT 站。
// TTL 取站点刷新间隔的 80%（默认 60s → 48s）：定时轮询到期必抓，期间任意操作命中缓存。
const siteStatusCache = new Map(); // siteId -> { t, item }
function siteCacheTTL(cfg) {
  // 单位毫秒：缓存时长独立可配（默认 300s）。PT 站数据不频繁变化，缓存期内所有操作都不真实访问站点
  return Math.max(30, Number(((cfg.ui && cfg.ui.siteCacheSec) || 300))) * 1000;
}
// 站点「关键字段」变更判定：分组/图标等非关键调整不清缓存，避免无谓重抓
const SITE_CACHE_KEYS = ['mode', 'apiUrl', 'passkey', 'profileUrl', 'cookie', 'apiKey', 'name', 'badge', 'enabled'];
function siteCacheKeyChanged(a, b) {
  return SITE_CACHE_KEYS.some(k => (a ? a[k] : undefined) !== (b ? b[k] : undefined));
}

// 顶栏「连接状态」聚合：轻量状态总览。站点部分只读缓存统计，不触发抓取 PT 站
// ---------- MoviePilot 深度看板 ----------
// client 复用（见 getMpClient）：MoviePilotClient 的 10s 看板缓存是实例字段，
// 每次 new 会让缓存彻底失效，轮询等于每轮真打 8 个 MP 接口
function buildMp() {
  const cfg = getConfig();
  const mp = cfg.moviePilot || {};
  return { cfg: mp, client: getMpClient(mp) };
}

// 连接测试：ping + 系统摘要
app.get('/api/mp/status', async (req, res) => {
  const { cfg, client } = buildMp();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiToken) {
    return res.json({ ok: false, connected: false, error: '未启用或未配置地址/API Token' });
  }
  try {
    const info = await client.ping();
    client.lastError = null;
    res.json({
      ok: true,
      connected: true,
      version: (info && info.version) || '',
      hostname: (info && info.hostname) || '',
      os: (info && info.operating_system) || ''
    });
  } catch (e) {
    client.lastError = e.message || String(e);
    res.json({ ok: false, connected: false, error: client.lastError });
  }
});

// 看板聚合数据（服务端 10s 缓存，避免轮询频繁访问 MP）
app.get('/api/mp/dashboard', async (req, res) => {
  const { cfg, client } = buildMp();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiToken) {
    return res.json({ ok: false, error: '未启用或未配置地址/API Token' });
  }
  try {
    const data = await client.getDashboard();
    res.json({ ok: true, data });
  } catch (e) {
    client.lastError = e.message || String(e);
    res.json({ ok: false, error: client.lastError });
  }
});

// 搜索资源（MP 页搜索订阅用：search/title 走站点索引）
app.get('/api/mp/search', async (req, res) => {
  const { cfg, client } = buildMp();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiToken) {
    return res.json({ ok: false, error: '未启用或未配置地址/API Token' });
  }
  const keyword = String(req.query.title || '').trim();
  if (!keyword) return res.json({ ok: false, error: '请输入搜索关键词' });
  try {
    const list = await client.searchMedia(keyword, req.query.type === 'tv' ? 'tv' : 'movie');
    res.json({ ok: true, items: list });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// 新增订阅（MP 页点「订阅」；无 tmdbid 时走 keyword 订阅）
app.post('/api/mp/subscribe', async (req, res) => {
  const { cfg, client } = buildMp();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiToken) {
    return res.json({ ok: false, error: '未启用或未配置地址/API Token' });
  }
  const b = req.body || {};
  const name = b.name || b.keyword || '';
  if (!name) return res.json({ ok: false, error: '缺少订阅名称' });
  const payload = {
    name: name,
    type: b.type && b.type !== '未知' ? b.type : 'movie',
    year: b.year ? String(b.year) : '',
    keyword: b.keyword || '',
    tmdbid: Number(b.tmdbid) || 0,
    doubanid: b.doubanid ? String(b.doubanid) : '',
    bangumiid: Number(b.bangumiid) || 0,
    anilistid: Number(b.anilistid) || 0,
    season: Number(b.season) || 0,
    poster: b.poster || '',
    backdrop: b.backdrop || '',
    vote: b.vote != null ? Number(b.vote) : 0,
    description: b.description || '',
    media_source: b.media_source || (Number(b.tmdbid) ? 'themoviedb' : ''),
    media_id: b.media_id || (Number(b.tmdbid) ? String(Number(b.tmdbid)) : ''),
    username: ''
  };
  try {
    const r = await client.addSubscribe(payload);
    res.json({ ok: true, data: r, name: payload.name });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// 已安装插件列表
app.get('/api/mp/plugins', async (req, res) => {
  const { cfg, client } = buildMp();
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiToken) {
    return res.json({ ok: false, error: '未启用或未配置地址/API Token' });
  }
  try {
    const list = await client.getPlugins();
    res.json({ ok: true, items: list });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/overview/status', async (req, res) => {
  const cfg = getConfig();
  const now = Date.now();
  let downloaders = [];
  try {
    // 走合并缓存：和「下载器页」的轮询共用同一份结果，避免同一秒内被拉两遍
    downloaders = await Promise.race([
      getAllDownloaderStatus(),
      new Promise(res => setTimeout(() => res([]), 6000))
    ]);
  } catch (e) { /* ignore */ }
  const ms = cfg.mediaServer || {};
  const media = {
    configured: !!(ms.enabled && ms.baseUrl && ms.username),
    // 连接判定：配置完整且无已知错误即视为连接（mediaCache 为内存缓存，容器重启后为空不代表未连接）
    connected: !!(ms.enabled && ms.baseUrl && ms.username && (mediaCache.data || !mediaCache.error)),
    error: mediaCache.error || null
  };
  let docker = { enabled: !!(cfg.docker && cfg.docker.enabled), connected: false, containers: 0, error: null };
  if (docker.enabled) {
    try {
      const items = await dockerMonitor.listContainers(cfg.docker);
      docker.connected = true;
      docker.containers = items.length;
    } catch (e) { docker.error = e.message || String(e); }
  }
  let mp = { enabled: !!(cfg.moviePilot && cfg.moviePilot.enabled), connected: false, error: null, version: '' };
  if (mp.enabled) {
    try {
      const info = await getMpClient(cfg.moviePilot).ping();
      mp.connected = true;
      mp.version = (info && info.version) || '';
    } catch (e) { mp.error = e.message || String(e); }
  }
  const sitesEnabled = cfg.sites.filter(s => s.enabled);
  const ttl = siteCacheTTL(cfg);
  let cachedCount = 0;
  let onlineCount = 0;
  let oldest = null;
  const failList = [];
  for (const s of sitesEnabled) {
    const hit = siteStatusCache.get(s.id);
    const fresh = hit && now - hit.t < ttl;
    if (fresh) cachedCount++;
    if (hit && hit.item && hit.item.online) onlineCount++;
    else if (fresh) failList.push({ name: s.name, error: (hit.item && hit.item.error) || '抓取失败' });
    if (hit && (oldest === null || hit.t < oldest)) oldest = hit.t;
  }
  res.json({
    ok: true,
    version: APP_VERSION,
    downloaders: {
      total: cfg.downloaders.filter(d => d.enabled && d.host).length,
      online: downloaders.filter(d => d.online).length,
      items: downloaders
    },
    media,
    docker,
    mp,
    sites: {
      enabled: sitesEnabled.length,
      cached: cachedCount,
      online: onlineCount,
      failed: failList.length,
      failList: failList,
      lastFetchAt: oldest,
      refreshSec: (cfg.ui && cfg.ui.siteCacheSec) || 300
    }
  });
});

app.post('/api/sites/test', async (req, res) => {
  const s = req.body;
  if (!s) return res.status(400).json({ ok: false, error: '缺少站点配置' });
  const client = buildSite({ ...s, id: s.id || 'test' });
  try {
    const status = await client.getStatus();
    res.json({ ok: true, status });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// 抓取一批站点的最新状态（只抓缓存过期/缺失的）
// 抽成独立函数：/api/sites/status、后台采样器、告警巡检都复用它，保证三处口径一致
async function refreshSites(enabled, cfg) {
  const ttl = siteCacheTTL(cfg || getConfig());
  const now = Date.now();
  // 只抓「无缓存 / 已过期」的站点；其余直接命中缓存（F5、切页、保存配置都不会重复访问 PT 站）
  const stale = enabled.filter(s => {
    const hit = siteStatusCache.get(s.id);
    return !hit || (now - hit.t) >= ttl;
  });
  if (!stale.length) return;

  // 总预算：站点多时最坏情况（N 站 / 并发 4 × 单站 8s 超时）会让前端转圈近一分钟。
  // 这里给整批一个总时限，超时的站点回落到上次缓存并标记 stale，不让整个页面等着。
  const BUDGET_MS = 15000;
  const started = Date.now();
  const fetched = await runPool(stale, SITE_CONCURRENCY, async s => {
    const client = buildSite(s);
    const visitUrl = (s.mode === 'cookie' ? s.profileUrl : (s.mode === 'api' ? s.apiUrl : 'https://kp.m-team.cc')) || '';
    const badge = s.badge || (s.mode === 'api' ? 'API' : (s.mode === 'mteam' ? 'MT' : 'NP'));
    const elapsed = Date.now() - started;
    if (elapsed > BUDGET_MS) {
      // 预算已用完：不再发新请求，返回缓存副本（保留上次数据，标记为未及时更新）
      const hit = siteStatusCache.get(s.id);
      if (hit && hit.item) return { ...hit.item, stale: true };
      return {
        id: s.id, name: s.name, badge, visitUrl, group: s.group || '常用', online: false, account: '', ratio: null,
        uploaded: 0, downloaded: 0, seeding: 0, leeching: 0, bonus: 0, error: '本轮抓取超出时间预算，稍后自动重试'
      };
    }
    try {
      // 单个站点也限制在剩余预算内，避免最后一波拖满
      const remain = Math.max(2000, BUDGET_MS - elapsed);
      const status = await Promise.race([
        client.getStatus(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('抓取超时（超出本轮时间预算）')), remain))
      ]);
      return { id: s.id, name: s.name, badge, visitUrl, group: s.group || '常用', online: true, ...status, error: null };
    } catch (e) {
      return {
        id: s.id, name: s.name, badge, visitUrl, group: s.group || '常用', online: false, account: '', ratio: null, uploaded: 0, downloaded: 0,
        seeding: 0, leeching: 0, bonus: 0, error: e.message || String(e)
      };
    }
  });
  // 超时/预算耗尽的结果不写入缓存时间戳，下一轮还会重试
  for (const r of fetched) {
    if (r.stale) continue;
    siteStatusCache.set(r.id, { t: now, item: r });
  }
}

// 供采样/告警使用：返回全部启用站点的最新状态（命中缓存则不重新抓）
async function collectSiteStatus() {
  const cfg = getConfig();
  const enabled = cfg.sites.filter(s => s.enabled && (
    s.mode === 'mteam' ? s.apiKey : (s.mode === 'cookie' ? s.profileUrl : s.apiUrl)
  ));
  await refreshSites(enabled, cfg);
  return enabled.map(s => {
    const hit = siteStatusCache.get(s.id);
    if (hit) return hit.item;
    return {
      id: s.id, name: s.name, group: s.group || '常用', online: false, account: '',
      ratio: null, uploaded: 0, downloaded: 0, seeding: 0, leeching: 0, bonus: 0,
      error: '状态尚未获取'
    };
  });
}

app.get('/api/sites/status', async (req, res) => {
  const cfg = getConfig();
  const enabled = cfg.sites.filter(s => s.enabled && (
    s.mode === 'mteam' ? s.apiKey : (s.mode === 'cookie' ? s.profileUrl : s.apiUrl)
  ));
  await refreshSites(enabled, cfg);

  const results = enabled.map(s => {
    const hit = siteStatusCache.get(s.id);
    return hit ? hit.item : {
      id: s.id, name: s.name, badge: s.badge || 'NP', visitUrl: '',
      group: s.group || '常用', online: false, account: '', ratio: null,
      uploaded: 0, downloaded: 0, seeding: 0, leeching: 0, bonus: 0,
      error: '状态尚未获取'
    };
  });

  const online = results.filter(r => r.online);
  res.json({
    totalUploaded: online.reduce((s, r) => s + (r.uploaded || 0), 0),
    totalDownloaded: online.reduce((s, r) => s + (r.downloaded || 0), 0),
    online: online.length,
    offline: results.length - online.length,
    items: results
  });
});

// 站点排序：按前端拖拽后的 id 顺序重排，持久化到配置
app.post('/api/sites/reorder', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: '缺少排序列表' });
  const cfg = getConfig();
  const map = new Map(cfg.sites.map(s => [s.id, s]));
  const reordered = [];
  for (const id of ids) {
    const s = map.get(id);
    if (s) { reordered.push(s); map.delete(id); }
  }
  for (const s of map.values()) reordered.push(s); // 未在列表中的排到末尾
  cfg.sites = reordered;
  saveConfig(cfg);
  res.json({ ok: true, count: reordered.length });
});

// 单站手动刷新（绿点点击触发，不影响自动刷新）
// 加冷却：绿点可以被连点，PT 站有严格限流，短时间内反复打容易被临时封 IP
const siteManualCooldown = new Map(); // siteId -> lastAt
const SITE_MANUAL_COOLDOWN_MS = 5000;

app.get('/api/sites/status/:id', async (req, res) => {
  const cfg = getConfig();
  const s = cfg.sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: '站点不存在' });
  if (!s.enabled || !(s.mode === 'mteam' ? s.apiKey : (s.mode === 'cookie' ? s.profileUrl : s.apiUrl))) {
    return res.status(400).json({ ok: false, error: '站点未启用或未配置地址' });
  }
  const now = Date.now();
  const last = siteManualCooldown.get(s.id) || 0;
  const cached = siteStatusCache.get(s.id);
  if (now - last < SITE_MANUAL_COOLDOWN_MS) {
    // 冷却期内：直接回上次结果，并告诉前端还剩多久
    const wait = Math.ceil((SITE_MANUAL_COOLDOWN_MS - (now - last)) / 1000);
    if (cached && cached.item) {
      return res.json({ ok: true, item: cached.item, cooldown: wait, cached: true });
    }
    return res.status(429).json({ ok: false, error: `刷新过于频繁，请 ${wait} 秒后再试` });
  }
  siteManualCooldown.set(s.id, now);
  const client = buildSite(s);
  const visitUrl = (s.mode === 'cookie' ? s.profileUrl : (s.mode === 'api' ? s.apiUrl : 'https://kp.m-team.cc')) || '';
  const base = { id: s.id, name: s.name, badge: s.badge || (s.mode === 'api' ? 'API' : (s.mode === 'mteam' ? 'MT' : 'NP')), visitUrl, group: s.group || '常用' };
  try {
    const status = await client.getStatus();
    const item = { ...base, online: true, ...status, error: null };
    siteStatusCache.set(s.id, { t: Date.now(), item }); // 手动刷新结果入缓存，避免随后自动轮询重复访问
    res.json({ ok: true, item });
  } catch (e) {
    const item = {
      ...base, online: false, account: '', ratio: null, uploaded: 0, downloaded: 0,
      seeding: 0, leeching: 0, bonus: 0, error: e.message || String(e)
    };
    siteStatusCache.set(s.id, { t: Date.now(), item });
    res.json({ ok: true, item });
  }
});

// ---------- 历史趋势 ----------
const historyStore = new HistoryStore(path.join(CONFIG_DIR, 'history'));

// 历史数据：?days=7 返回最近 N 天的聚合点（默认 7 天，最多 365）
app.get('/api/history', (req, res) => {
  const cfg = getConfig();
  const h = cfg.history || {};
  if (h.enabled === false) {
    return res.json({ ok: true, enabled: false, points: [], message: '历史采样已关闭' });
  }
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
  let raw = [];
  try { raw = historyStore.readRange(days); } catch (e) { return res.json({ ok: false, error: e.message }); }
  const maxPoints = Math.min(MAX_POINTS_FOR_CHART, Math.max(20, parseInt(req.query.max, 10) || MAX_POINTS_FOR_CHART));
  const { points, buckets } = HistoryStore.buildSeries(raw, maxPoints);
  res.json({
    ok: true,
    enabled: true,
    days,
    total: raw.length,
    buckets,
    keepDays: h.keepDays || 30,
    intervalMin: h.intervalMin || 60,
    points
  });
});

// 采样器状态 + 手动触发一次（调试用）
app.get('/api/history/status', (req, res) => {
  res.json({ ok: true, ...samplerStatus(), historyFile: path.join(CONFIG_DIR, 'history') });
});

app.post('/api/history/sample', async (req, res) => {
  const r = await sampler.runOnce(samplerDeps());
  res.json({ ok: !!r.ok, result: r });
});

// ---------- 告警 ----------
app.get('/api/alerts/events', (req, res) => {
  res.json({ ok: true, items: alerter.getRecentEvents() });
});

// 测试通知：直接推一条到已启用的渠道，不走规则判定
app.post('/api/alerts/test', async (req, res) => {
  const cfg = getConfig();
  const al = cfg.alerts || {};
  const ch = al.channels || {};
  const anyEnabled = Object.keys(ch).some(k => ch[k] && ch[k].enabled);
  if (!anyEnabled) {
    return res.json({ ok: false, error: '没有启用任何通知渠道，请先填写并勾选至少一个渠道' });
  }
  try {
    const results = await alerter.testChannel(ch, '全部已启用渠道');
    const failed = results.filter(r => !r.ok);
    res.json({
      ok: failed.length === 0,
      results,
      error: failed.length ? failed.map(f => `${f.channel}: ${f.error}`).join('；') : null
    });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// 立即跑一次告警判定（不写历史），方便调试规则
app.post('/api/alerts/check', async (req, res) => {
  const cfg = getConfig();
  try {
    const sites = await collectSiteStatus();
    const s = getSystemStatus();
    const containers = (cfg.docker && cfg.docker.enabled)
      ? await dockerMonitor.listContainers(cfg.docker).catch(() => [])
      : [];
    const hits = await alerter.evaluate(cfg, {
      sites,
      sys: { cpu: s.cpu ? s.cpu.pct : null, mem: s.mem ? s.mem.pct : null, disk: s.disk ? s.disk.pct : null },
      containers
    }, { dryRun: !(cfg.alerts && cfg.alerts.enabled) });
    res.json({ ok: true, enabled: !!(cfg.alerts && cfg.alerts.enabled), hits });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/api/alerts/reset', (req, res) => {
  alerter.reset();
  res.json({ ok: true });
});

// ---------- 采样器接线 ----------
function samplerDeps() {
  return {
    getConfig,
    historyStore,
    collectSites: collectSiteStatus,
    getSystemStatus,
    listContainers: dockerMonitor.listContainers,
    getAllDownloaderStatus,
    alerter
  };
}
function restartSampler() {
  try { sampler.start(samplerDeps()); } catch (e) { console.error('[sampler] 启动失败:', e.message); }
}
function samplerStatus() {
  return sampler.status();
}

// 统一错误处理：请求体超限 / JSON 语法错误单独给出可读提示，不再笼统 500
app.use((err, req, res, next) => {
  const type = err && (err.type || '');
  if (type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: '请求内容过大：主题背景图请走「上传」按钮（独立接口），配置文件本身只存轻量设置'
    });
  }
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ ok: false, error: '请求体不是合法 JSON' });
  }
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: (err && err.message) || '服务器内部错误' });
});

// 兜底：未匹配的 /api 路径返回 JSON（而不是 express 默认 HTML 404）
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在：' + req.method + ' ' + req.path });
});

// 未捕获异常不要让整个面板静默退出（NAS 上没人看着日志）
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(PORT, () => {
  console.log(`NAS 导航监控助手已启动: http://0.0.0.0:${PORT}`);
  console.log(`配置文件位置: ${require('./config').CONFIG_FILE}`);
  console.log(`历史数据目录: ${path.join(CONFIG_DIR, 'history')}`);
  if (AUTH_REQUIRED) console.log('访问认证：已开启');
  else console.log('访问认证：未开启（仅建议局域网使用；如需外网访问请设置 ACCESS_TOKEN）');
  // 延迟到监听之后再起采样器，避免启动阶段和配置初始化抢资源
  restartSampler();
});
