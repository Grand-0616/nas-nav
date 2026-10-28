// ==UserScript==
// @name         PT Cookie Collector（PT站点Cookie收集器）
// @namespace    nas-nav
// @version      1.0.6
// @description  在你已登录的 PT 站点页面上自动收集完整 Cookie（含 httpOnly），一键导出 JSON 供 NAS 导航面板批量导入。需要配合 Tampermonkey 使用。
// @author       NAS-Nav
// @match        http://*/*
// @match        https://*/*
// @grant        GM_cookie
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'pt_cookie_sites_v1';

  // 是否是真实凭证值（跳过 deleted / 空 / "移除" 这类删除标记）
  function isRealValue(v) {
    if (!v) return false;
    return !/^(deleted|removed|""|0)$/i.test(String(v).trim());
  }

  // cookie domain 与当前 host 匹配（含子域规则，如 .pandapt.net 匹配 pandapt.net / www.pandapt.net）
  function domainMatches(host, domain) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    const d = String(domain || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    if (!h || !d) return false;
    return h === d || h.endsWith('.' + d);
  }

  // cookie path 与当前路径匹配（/ 匹配一切；/abc 匹配 /abc 及 /abc/...）
  function pathMatches(path, cookiePath) {
    const p = path || '/';
    const cp = cookiePath || '/';
    if (cp === '/') return true;
    if (!p.startsWith(cp)) return false;
    return cp.endsWith('/') || p.length === cp.length || p[cp.length] === '/';
  }

  // 借鉴 Chrome 扩展「Pocket Qt 站点导入」的 Cookie 组装逻辑：
  // 按 域名/path/secure 过滤出对当前页面真正生效的 cookie，
  // 同名 cookie 按 path 长度排序（长 path 优先，即浏览器实际生效的那个），再拼接成请求头。
  function buildCookieHeader(cookieList, pageUrl) {
    let u;
    try { u = new URL(pageUrl); } catch (e) { u = null; }
    if (!u) return '';
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

  // 从响应头 Set-Cookie 解析 name=value 片段（fallback 用）
  function parseSetCookies(respHeaders) {
    const out = [];
    if (!respHeaders) return out;
    const lines = String(respHeaders).toLowerCase().split('\r\n');
    for (const l of lines) {
      if (!l.startsWith('set-cookie:')) continue;
      const seg = l.slice('set-cookie:'.length).trim();
      const eq = seg.indexOf('=');
      if (eq > 0) {
        const name = seg.slice(0, eq).trim();
        const val = seg.slice(eq + 1).split(';')[0].trim();
        if (name && isRealValue(val) && !out.some(p => p.startsWith(name + '='))) {
          out.push(name + '=' + val);
        }
      }
    }
    return out;
  }

  // 把 cookie 数组拼成请求头字符串（过滤无效项，name 去重）
  function joinCookie(arr) {
    const seen = {};
    const parts = [];
    for (const c of arr) {
      if (!c) continue;
      const eq = c.indexOf('=');
      if (eq <= 0) continue;
      const name = c.slice(0, eq).trim();
      const val = c.slice(eq + 1).trim();
      if (!isRealValue(val) || seen[name]) continue;
      seen[name] = true;
      parts.push(name + '=' + val);
    }
    return parts.join('; ');
  }

  // 兼容两种 GM_cookie.list 调用风格（Promise 或回调），带 3 秒超时保护
  function gmCookieList(query) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (cookies, err) => {
        if (settled) return;
        settled = true;
        resolve({ cookies: cookies || null, err: err || null });
      };
      try {
        const ret = GM_cookie.list(query, (cookies, err) => done(cookies, err));
        if (ret && typeof ret.then === 'function') {
          ret.then(
            (cookies) => done(Array.isArray(cookies) ? cookies : null, null),
            (err) => done(null, err)
          );
        }
      } catch (e) {
        done(null, e);
      }
      setTimeout(() => done(null, new Error('timeout(3s)')), 3000);
    });
  }

  // 借鉴 Chrome 扩展「Pocket Qt 站点导入」的查询策略：url / domain / 全量 三路查询取并集
  // （单按 url 查询在部分环境下会返回空，多路查询谁命中用谁），按 name+domain+path 去重
  async function gmCookieListAll(pageUrl) {
    let host = '';
    try { host = new URL(pageUrl).hostname; } catch (e) { /* ignore */ }
    const queries = [
      { url: pageUrl },
      { domain: host },
      {}
    ];
    const counts = { url: 0, domain: 0, all: 0 };
    const errs = [];
    const results = [];
    for (const q of queries) {
      const { cookies, err } = await gmCookieList(q);
      const key = q.url ? 'url' : (q.domain ? 'domain' : 'all');
      if (err) { errs.push(key + ': ' + String(err)); continue; }
      if (cookies && cookies.length) {
        counts[key] = cookies.length;
        results.push(...cookies);
      }
    }
    const seen = new Map();
    for (const c of results) {
      if (!c || !c.name) continue;
      const k = `${c.name}\u0000${c.domain || ''}\u0000${c.path || ''}`;
      if (!seen.has(k)) seen.set(k, c);
    }
    return { cookies: [...seen.values()], counts, errs };
  }

  // 收集当前站点：
  // 方式1（最可靠）：GM_cookie API 直接读浏览器 cookie 存储（含 httpOnly），按域名/path/secure 过滤组装
  // 方式2（兜底）：请求站点根路径取响应 Set-Cookie + document.cookie
  // 无论成败都返回 diag 诊断信息，便于定位问题
  function collectCurrent() {
    return new Promise((resolve) => {
      const meta = {
        base: location.origin,
        url: location.href,
        title: (document.title || '').trim(),
        at: new Date().toISOString()
      };
      const diag = {
        gmCookie: (typeof GM_cookie !== 'undefined')
          ? (typeof GM_cookie.list === 'function' ? 'available' : 'no-list')
          : 'undefined',
        apiCount: 0,
        apiCounts: '',
        apiErr: '',
        fallbackStatus: 0,
        setCookieCount: 0,
        docCookieCount: document.cookie.split(';').filter(Boolean).length
      };
      const done = (cookie) => resolve(Object.assign({}, meta, { cookie: cookie || '', diag }));

      let usedApi = false;
      try {
        if (typeof GM_cookie !== 'undefined' && GM_cookie.list) {
          usedApi = true;
          gmCookieListAll(location.href).then(({ cookies, counts, errs }) => {
            diag.apiCount = cookies.length;
            diag.apiCounts = `url:${counts.url} domain:${counts.domain} all:${counts.all}`;
            if (errs.length) diag.apiErr = errs.join(' | ');
            if (cookies.length) {
              const cookie = buildCookieHeader(cookies, location.href);
              if (cookie) return done(cookie);
            }
            fallback();
          });
        }
      } catch (e) {
        diag.apiErr = 'exception: ' + e.message;
      }
      if (!usedApi) fallback();

      function fallback() {
        GM_xmlhttpRequest({
          method: 'GET',
          url: location.origin + '/',
          timeout: 15000,
          onload: (res) => {
            diag.fallbackStatus = res.status;
            const parts = parseSetCookies(res.responseHeaders);
            diag.setCookieCount = parts.length;
            for (const c of document.cookie.split(';')) {
              const c2 = c.trim();
              if (!c2) continue;
              const nm = c2.split('=')[0].trim();
              if (!parts.some(p => p.startsWith(nm + '='))) parts.push(c2);
            }
            done(joinCookie(parts));
          },
          onerror: (e) => {
            diag.fallbackStatus = -1;
            diag.apiErr = (diag.apiErr ? diag.apiErr + '; ' : '') + 'xhr-error';
            done(document.cookie);
          }
        });
      }
    });
  }

  // 从标题猜测账号（取首个独立词，如 "grand0616 熊猫高清 - 个人中心" -> grand0616）
  function guessAccount(title) {
    if (!title) return '';
    const t = title.replace(/[\s\-—·|_]+/g, ' ').trim();
    const seg = t.split(' ')[0];
    if (seg && /^[\w\u4e00-\u9fa5@.\-]{2,40}$/.test(seg)) return seg;
    return '';
  }

  // 输出面板批量导入格式
  function toImportFormat(items) {
    return items.map(it => ({
      name: it.name,
      baseUrl: it.base,
      profileUrl: it.url,
      account: it.account || guessAccount(it.title),
      cookie: it.cookie
    }));
  }

  function loadStore() {
    try { return GM_getValue(STORE_KEY, '[]'); } catch (e) { return '[]'; }
  }
  function saveStore(arr) {
    try { GM_setValue(STORE_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }

  // 站点名：从网址域名提取主域名主体（pandapt.net -> pandapt，pt.novahd.top -> novahd）
  function siteName(base) {
    try {
      const host = new URL(base).hostname.replace(/^www\./, '').toLowerCase();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return host;
      const parts = host.split('.');
      return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    } catch (e) { return base; }
  }

  // 菜单1：收集当前站点
  GM_registerMenuCommand('1. 收集当前站点 Cookie', async () => {
    try {
      const data = await collectCurrent();
      if (!data.cookie) {
        const d = data.diag || {};
        let msg = '未能获取到 Cookie。\n\n—— 诊断信息 ——\n'
          + `· GM_cookie API：${d.gmCookie}\n`
          + `· GM_cookie 三路查询（url/domain/全量）返回：${d.apiCounts || '未执行'}\n`
          + (d.apiErr ? `· 查询错误：${d.apiErr}\n` : '')
          + `· 去重后 Cookie 数：${d.apiCount}\n`
          + `· 站点首页请求状态：${d.fallbackStatus === -1 ? '请求失败' : (d.fallbackStatus || '未执行')}，Set-Cookie ${d.setCookieCount} 条\n`
          + `· 页面可见 Cookie（document.cookie）：${d.docCookieCount} 条\n\n`
          + '—— 排查建议 ——\n'
          + '1. 确认右上角显示你的用户名（已登录）；\n'
          + '2. 若三路查询全为 0：很可能你正用「无痕模式/访客模式」访问站点，请改用普通窗口（登录一次）再收集；\n'
          + '3. 打开 Tampermonkey 设置 → 扩展程序权限，确认「读取和更改站点数据」已允许（Chrome 需在扩展详情页开启）；\n'
          + '4. 把这条完整诊断信息发给我，我来定位。';
        alert(msg);
        return;
      }
      let arr = [];
      try { arr = JSON.parse(loadStore()); } catch (e) { arr = []; }
      const name = siteName(data.base);
      const idx = arr.findIndex(x => x.base === data.base);
      const item = { name, ...data };
      if (idx >= 0) arr[idx] = item; else arr.push(item);
      saveStore(arr);
      const n = data.cookie.split(';').length;
      alert(`已收集：${name}\nCookie 共 ${n} 项（${data.cookie.length} 字符）\n\n继续在下一个已登录的 PT 站页面执行本操作，全部收集完后选「2. 导出」。`);
    } catch (e) {
      alert('收集失败：' + e.message);
    }
  });

  // 菜单2：导出全部
  GM_registerMenuCommand('2. 导出全部站点 Cookie（JSON 到剪贴板）', () => {
    let arr = [];
    try { arr = JSON.parse(loadStore()); } catch (e) { arr = []; }
    if (!arr.length) { alert('还没有收集过任何站点，请先在已登录的 PT 站页面执行「1. 收集当前站点 Cookie」'); return; }
    const out = toImportFormat(arr);
    const text = JSON.stringify(out, null, 2);
    try {
      GM_setClipboard(text);
      alert(`已复制 ${out.length} 个站点的 Cookie 到剪贴板！\n\n回到 NAS 导航面板 → 设置 → 站点 → 批量导入，粘贴即可。\n\n（若复制失败，请按 F12 在控制台执行：copy(${JSON.stringify(text)}) ）`);
    } catch (e) {
      alert('复制失败，请手动复制控制台输出：\n' + text);
    }
  });

  // 菜单3：清除记录
  GM_registerMenuCommand('3. 清除已收集的 Cookie 记录', () => {
    saveStore('[]');
    alert('已清除全部收集记录（不影响浏览器登录态）。');
  });
})();
