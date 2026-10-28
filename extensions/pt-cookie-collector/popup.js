'use strict';

const STORE_KEY = 'pt_cookie_sites_v1';

const $ = (id) => document.getElementById(id);
const siteLine = $('siteLine');
const metaLine = $('metaLine');
const logBox = $('log');

function setLog(t) { logBox.textContent = t; }
function appendLog(t) { logBox.textContent += (logBox.textContent ? '\n' : '') + t; }

// ---------- cookie 多路查询（参考 Pocket Qt 扩展策略）----------
async function getAllCookies(url, tabId) {
  let stores = [];
  try { stores = await chrome.cookies.getAllCookieStores(); } catch (e) { /* ignore */ }
  const storeId = (stores && stores.length) ? (stores.find(s => s.tabIds && s.tabIds.includes(tabId)) || {}).id : undefined;
  let host;
  try { host = new URL(url).hostname; } catch (e) { return []; }

  let partitionKey;
  if (typeof chrome.cookies.getPartitionKey === 'function') {
    try { partitionKey = (await chrome.cookies.getPartitionKey({ tabId, frameId: 0 })).partitionKey; } catch (e) { /* ignore */ }
  }

  const queries = [
    storeId ? { url, storeId } : { url },
    storeId ? { domain: host, storeId } : { domain: host },
    partitionKey ? (storeId ? { url, storeId, partitionKey } : { url, partitionKey }) : null,
    partitionKey ? (storeId ? { domain: host, storeId, partitionKey } : { domain: host, partitionKey }) : null,
    storeId ? { storeId } : {},
    partitionKey ? (storeId ? { storeId, partitionKey } : { partitionKey }) : null
  ].filter(Boolean);

  const settled = await Promise.allSettled(queries.map(q => chrome.cookies.getAll(q)));
  const map = new Map();
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const c of r.value) {
      const pk = c.partitionKey ? `${c.partitionKey.topLevelSite || ''}\u0000${c.partitionKey.hasCrossSiteAncestor || ''}` : '';
      const key = `${c.name}\u0000${c.domain}\u0000${c.path}\u0000${pk}`;
      if (!map.has(key)) map.set(key, c);
    }
  }
  return [...map.values()];
}

// ---------- 过滤 + 组装 Cookie 请求头 ----------
function isRealValue(v) { return !!v && !/^(deleted|removed|""|0)$/i.test(String(v).trim()); }

function domainMatches(host, domain) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const d = String(domain || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

function pathMatches(path, cookiePath) {
  const p = path || '/';
  const cp = cookiePath || '/';
  if (cp === '/') return true;
  if (!p.startsWith(cp)) return false;
  return cp.endsWith('/') || p.length === cp.length || p[cp.length] === '/';
}

function buildCookieHeader(cookieList, pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch (e) { return ''; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || '/';
  const https = u.protocol === 'https:';
  const scored = cookieList
    .filter(c => c && c.name && domainMatches(host, c.domain) && pathMatches(path, c.path) && (!c.secure || https))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  const seen = {};
  const parts = [];
  for (const c of scored) {
    const name = String(c.name).trim();
    const val = String(c.value || '').trim();
    if (!name || !isRealValue(val) || seen[name]) continue;
    seen[name] = true;
    parts.push(name + '=' + val);
  }
  return parts.join('; ');
}

// ---------- 站点名：从网址域名提取主域名主体（pandapt.net -> pandapt，pt.novahd.top -> novahd）----------
function siteName(base) {
  try {
    const host = new URL(base).hostname.replace(/^www\./, '').toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return host;
    const parts = host.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  } catch (e) { return base; }
}

function guessAccount(title) {
  if (!title) return '';
  const t = title.replace(/[\s\-—·|_]+/g, ' ').trim();
  const seg = t.split(' ')[0];
  if (seg && /^[\w\u4e00-\u9fa5@.\-]{2,40}$/.test(seg)) return seg;
  return '';
}

// ---------- 存储 ----------
function loadStore() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORE_KEY, (obj) => {
      try { resolve(JSON.parse(obj[STORE_KEY] || '[]')); } catch (e) { resolve([]); }
    });
  });
}
function saveStore(arr) {
  return new Promise((resolve) => {
    const obj = {};
    obj[STORE_KEY] = JSON.stringify(arr);
    chrome.storage.local.set(obj, resolve);
  });
}

// ---------- 主流程 ----------
let current = { url: '', title: '', cookie: '' };

async function readCurrentTab() {
  siteLine.innerHTML = '<span class="spinner"></span> 读取当前标签页…';
  metaLine.textContent = '';
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    siteLine.textContent = '读取标签页失败';
    return;
  }
  if (!tab || !tab.url) {
    siteLine.textContent = '未找到当前页面';
    return;
  }
  let u;
  try { u = new URL(tab.url); } catch (e) {
    siteLine.textContent = '当前页面不是 http/https 站点';
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    siteLine.textContent = '请在 PT 站点页面使用本插件';
    return;
  }
  const all = await getAllCookies(u.href, tab.id);
  const cookie = buildCookieHeader(all, u.href);
  current = { url: u.href, title: tab.title || '', cookie };
  siteLine.textContent = siteName(u.origin) || u.hostname;
  const n = cookie ? cookie.split(';').length : 0;
  if (n > 0) {
    metaLine.innerHTML = `<span class="count">✓ ${n} 个 Cookie</span>（${cookie.length} 字符）<br>${u.hostname}`;
  } else {
    metaLine.innerHTML = `<span class="warn">✗ 未获取到 Cookie</span>（原始 ${all.length} 条，过滤后 0 条）<br>${u.hostname}`;
  }
}

$('collectBtn').addEventListener('click', async () => {
  const btn = $('collectBtn');
  btn.disabled = true;
  setLog('收集当前站点…');
  if (!current.cookie) {
    await readCurrentTab();
    if (!current.cookie) {
      setLog('当前页面没有可用的 Cookie：\n1. 确认已登录（右上角显示用户名）；\n2. 若使用无痕/访客窗口，请改用普通窗口登录后再收集。');
      btn.disabled = false;
      return;
    }
  }
  const arr = await loadStore();
  const name = siteName(current.url);
  const idx = arr.findIndex(x => x.base === new URL(current.url).origin);
  const item = {
    name,
    base: new URL(current.url).origin,
    url: current.url,
    account: guessAccount(current.title),
    cookie: current.cookie,
    at: new Date().toISOString()
  };
  if (idx >= 0) arr[idx] = item; else arr.push(item);
  await saveStore(arr);
  const n = current.cookie.split(';').length;
  setLog(`✓ 已收集：${name}（${n} 个 Cookie）\n全部收集完后点「导出全部 JSON」`);
  btn.disabled = false;
});

$('exportBtn').addEventListener('click', async () => {
  const arr = await loadStore();
  if (!arr.length) {
    setLog('还没有收集记录，请先在已登录的 PT 站页面点「收集当前站点」。');
    return;
  }
  const out = arr.map(it => ({
    name: it.name,
    baseUrl: it.base,
    profileUrl: it.url,
    account: it.account || '',
    cookie: it.cookie
  }));
  const text = JSON.stringify(out, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // 剪贴板 API 在 popup 可能受限，回退到临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  setLog(`✓ 已复制 ${out.length} 个站点到剪贴板！\n回到 NAS 导航面板 → 设置 → 站点 → 批量导入 → 粘贴 → 保存配置。`);
});

$('clearBtn').addEventListener('click', async () => {
  await saveStore([]);
  setLog('已清除全部收集记录。');
});

readCurrentTab();
