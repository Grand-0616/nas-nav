'use strict';

const fs = require('fs');
const path = require('path');

// 配置文件目录解析（按优先级）：
// 1) 环境变量 CONFIG_DIR（Docker 部署时由 docker-compose 显式指定为挂载点 /app/config）
// 2) 容器内固定挂载点 /app/config（__dirname=/app/src 时 ../.. 会错误地跳到根目录 /）
// 3) 本地源码目录 nas-nav/config（__dirname=nas-nav/server/src）
function resolveConfigDir() {
  if (process.env.CONFIG_DIR) return process.env.CONFIG_DIR;
  const candidates = [
    '/app/config',                                // Docker 挂载点（容器内固定）
    path.join(__dirname, '..', '..', 'config')    // 本地开发 nas-nav/config
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return candidates[0];
}
const CONFIG_DIR = resolveConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// 主题背景图单独落盘：base64 塞进 config.json 会让每次保存都重写几 MB，
// 也会让 /api/config 每次返回几 MB。这里存成独立文件，config 里只留一个布尔标记。
const THEME_BG_FILE = path.join(CONFIG_DIR, 'theme-bg.img');
const THEME_BG_META = path.join(CONFIG_DIR, 'theme-bg.json');
const THEME_BG_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_CONFIG = {
  services: [
    { id: 'svc_1', name: 'qBittorrent', icon: 'qb', url: '', category: '下载管理', enabled: true },
    { id: 'svc_2', name: 'Transmission', icon: 'tr', url: '', category: '下载管理', enabled: true },
    { id: 'svc_3', name: 'Jellyfin', icon: 'jf', url: '', category: '媒体影音', enabled: true },
    { id: 'svc_4', name: 'Alist', icon: 'al', url: '', category: '文件管理', enabled: true },
    { id: 'svc_5', name: 'PhotoPrism', icon: 'pp', url: '', category: '媒体影音', enabled: true },
    { id: 'svc_6', name: '导航页', icon: 'nav', url: '', category: '工具服务', enabled: true }
  ],
  downloaders: [],
  sites: [],
  // 飞牛影视媒体服务器（凭证仅存 NAS 本地）
  mediaServer: { enabled: false, name: '飞牛影视', baseUrl: '', username: '', password: '' },
  // MoviePilot 深度看板（API Token 认证）
  moviePilot: { enabled: false, baseUrl: '', apiToken: '' },
  // Docker 容器监控（baseUrl 留空 = 使用容器内挂载的 unix socket /var/run/docker.sock；
  // 远程 Docker 可填 http://host:2375 或 https://host:2376）
  // allowActions：是否允许在面板里启停/重启容器，默认关闭（涉及宿主机服务可用性）
  docker: { enabled: false, baseUrl: '', allowActions: false, homeComps: ['overview', 'top', 'net', 'grid'] },
  // 历史采样：每小时落一条快照，用于趋势图
  history: { enabled: true, intervalMin: 60, keepDays: 30 },
  // 告警规则 + 通知渠道
  alerts: {
    enabled: false,
    // 站点连续离线几次才告警（避免一次抖动就推送）
    siteOfflineTimes: 2,
    // 分享率低于该值告警；0 / null 表示不检查
    ratioMin: 0,
    // 磁盘使用率高于该值告警，0 表示不检查
    diskPctMax: 90,
    // 容器异常（重启中 / 非 0 退出 / 健康检查失败）告警
    containerAbnormal: true,
    // 同一问题重复推送的最小间隔（分钟）
    repeatMin: 180,
    // 通知渠道
    channels: {
      bark: { enabled: false, url: '' },              // 如 https://api.day.app/xxxxx
      telegram: { enabled: false, botToken: '', chatId: '' },
      wecom: { enabled: false, webhook: '' },          // 企业微信群机器人 webhook
      webhook: { enabled: false, url: '', method: 'POST' } // 通用 JSON webhook
    }
  },
  // 界面刷新间隔（秒）+ 主题外观
  ui: {
    downloaderRefreshSec: 15,
    siteRefreshSec: 60,
    // 站点数据缓存时长（秒）：PT 站数据不频繁变化，缓存期内 F5/切页/保存都不会真实访问站点
    siteCacheSec: 300,
    theme: { mode: 'dark', accent: '#4ea1ff', density: 'normal', radius: 'medium', bg: 'gradient', anim: true, bgImage: '' }
  }
};

let cache = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  ensureDir(CONFIG_DIR);
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return cache;
  }
  try {
    // 去掉 UTF-8 BOM：Windows 记事本/PowerShell 保存会带 \uFEFF，JSON.parse 会直接失败
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    // 合并默认结构，保证新字段可用（兼容旧配置文件缺少 ui 的情况）
    const media = parsed.mediaServer || {};
    const docker = parsed.docker || {};
    const ui = parsed.ui || {};
    const theme = ui.theme || {};
    const mp = parsed.moviePilot || {};
    cache = {
      services: Array.isArray(parsed.services) ? parsed.services.map(s => ({
        ...s,
        category: (typeof s.category === 'string' && s.category.trim()) ? s.category.trim() : '未分类',
        name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : '未命名服务',
        url: (typeof s.url === 'string') ? s.url : '',
        enabled: s.enabled !== false
      })) : [],
      downloaders: Array.isArray(parsed.downloaders) ? parsed.downloaders : [],
      sites: Array.isArray(parsed.sites) ? parsed.sites.map(s => {
        let g = (typeof s.group === 'string') ? s.group.trim() : '';
        // 分组防御：空串 / 纯问号（乱码）/ 含替换字符 U+FFFD 的分组统一回退「常用」
        if (!g || /^\?+$/.test(g) || g.indexOf('\uFFFD') >= 0) g = '常用';
        return { ...s, group: g };
      }) : [],
      mediaServer: {
        enabled: !!media.enabled,
        name: media.name || DEFAULT_CONFIG.mediaServer.name,
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
        allowActions: !!docker.allowActions,
        homeComps: Array.isArray(docker.homeComps) ? docker.homeComps : DEFAULT_CONFIG.docker.homeComps
      },
      ui: {
        downloaderRefreshSec: Number(ui.downloaderRefreshSec) || DEFAULT_CONFIG.ui.downloaderRefreshSec,
        siteRefreshSec: Number(ui.siteRefreshSec) || DEFAULT_CONFIG.ui.siteRefreshSec,
        siteCacheSec: Number(ui.siteCacheSec) || DEFAULT_CONFIG.ui.siteCacheSec,
        theme: {
          mode: theme.mode === 'light' ? 'light' : 'dark',
          accent: theme.accent || DEFAULT_CONFIG.ui.theme.accent,
          density: ['compact', 'normal', 'comfort'].includes(theme.density) ? theme.density : 'normal',
          radius: ['small', 'medium', 'large'].includes(theme.radius) ? theme.radius : 'medium',
          bg: ['gradient', 'glass'].includes(theme.bg) ? theme.bg : 'gradient',
          anim: theme.anim !== false,
          // 只保留 http(s) 形式的背景图地址；data: 内联图片会在 loadConfig 末尾迁移到独立文件
          bgImage: (typeof theme.bgImage === 'string' && theme.bgImage.length <= 4000000) ? theme.bgImage : ''
        }
      }
    };
    migrateLegacyBgImage(cache.ui.theme);
    // 迁移后立刻落盘，避免每次启动都重复解码同一份 base64
    if (cache.ui.theme.bgImage === '' && parsed.ui && parsed.ui.theme && /^data:/i.test(String(parsed.ui.theme.bgImage || ''))) {
      try { saveConfig(cache); } catch (e) { /* 落盘失败不影响本次启动 */ }
    }
    return cache;
  } catch (e) {
    // 配置损坏时不要整站挂掉：把坏文件改名留档，用默认配置继续启动，
    // 用户可以在「备份恢复」里找回（NAS 上没人盯着日志，起不来等于失联）
    try {
      const bad = CONFIG_FILE + '.bad-' + Date.now();
      fs.renameSync(CONFIG_FILE, bad);
      console.error('[config] 配置文件解析失败，已另存为 ' + bad + '，本次以默认配置启动');
    } catch (e2) { /* 改名失败就继续用内存默认值 */ }
    // 立刻写一份默认配置，避免下次启动又找不到文件（用户仍可从 .bad-* 手动找回）
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8'); } catch (e3) { /* ignore */ }
    cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return cache;
  }
}

// 旧版把背景图 base64 直接存在 config.json 里。这里一次性迁移到 theme-bg.img，
// 之后 config.json 只留一个 bgImage 布尔标记，避免每次保存都重写几 MB。
function migrateLegacyBgImage(theme) {
  if (!theme || typeof theme.bgImage !== 'string') return;
  const v = theme.bgImage;
  if (!/^data:/i.test(v)) return; // http(s) URL 体积很小，继续留在配置里
  try {
    const m = v.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new Error('无法解析 data URL');
    const ct = m[1] || 'image/jpeg';
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf-8');
    if (buf.length && buf.length <= THEME_BG_MAX_BYTES) {
      fs.writeFileSync(THEME_BG_FILE, buf);
      fs.writeFileSync(THEME_BG_META, JSON.stringify({ contentType: ct }), 'utf-8');
    }
  } catch (e) { /* 迁移失败就当没有背景，不阻断启动 */ }
  theme.bgImage = '';
}

// ---------- 主题背景图（独立文件，不占 config.json）----------
function hasThemeBg() {
  try { return fs.existsSync(THEME_BG_FILE) && fs.statSync(THEME_BG_FILE).size > 0; } catch (e) { return false; }
}

function getThemeBg() {
  try {
    if (!hasThemeBg()) return null;
    const buf = fs.readFileSync(THEME_BG_FILE);
    let contentType = 'image/jpeg';
    try {
      const meta = JSON.parse(fs.readFileSync(THEME_BG_META, 'utf-8'));
      if (meta && typeof meta.contentType === 'string' && /^image\//.test(meta.contentType)) contentType = meta.contentType;
    } catch (e) { /* 元信息缺失时按 jpeg 兜底 */ }
    return { buf, contentType, size: buf.length };
  } catch (e) { return null; }
}

function saveThemeBg(buf, contentType) {
  ensureDir(CONFIG_DIR);
  if (!buf || !buf.length) throw new Error('图片内容为空');
  if (buf.length > THEME_BG_MAX_BYTES) {
    throw new Error(`背景图过大（${(buf.length / 1048576).toFixed(1)}MB），上限 ${THEME_BG_MAX_BYTES / 1048576}MB`);
  }
  fs.writeFileSync(THEME_BG_FILE, buf);
  fs.writeFileSync(THEME_BG_META, JSON.stringify({ contentType: contentType || 'image/jpeg' }), 'utf-8');
  return { size: buf.length, contentType: contentType || 'image/jpeg' };
}

function clearThemeBg() {
  for (const f of [THEME_BG_FILE, THEME_BG_META]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

function getConfig() {
  if (!cache) loadConfig();
  return cache;
}

function saveConfig(next) {
  ensureDir(CONFIG_DIR);
  // 原子写：先写临时文件再 rename，避免进程崩溃时配置文件被写坏（JSON 损坏会启动失败）
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_FILE);
  // 配置里含全部凭证（PT cookie / passkey / 影视密码），只允许属主读写
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (e) { /* 部分文件系统不支持 chmod */ }
  cache = next;
  return next;
}

module.exports = {
  getConfig, saveConfig, loadConfig, CONFIG_FILE, CONFIG_DIR,
  hasThemeBg, getThemeBg, saveThemeBg, clearThemeBg, THEME_BG_MAX_BYTES
};
