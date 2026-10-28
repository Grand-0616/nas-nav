'use strict';

const http = require('http');
const https = require('https');

// 统一请求超时（毫秒）。下载器与站点网络不可达时快速失败，避免接口挂起
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);

// ---------- TLS 校验收窄 ----------
// 旧实现靠全局 NODE_TLS_REJECT_UNAUTHORIZED=0 放宽证书校验，副作用是**所有**出站
// HTTPS 都不再验证（包括公网 PT 站），等于给中间人开了口子。
// 这里改成按目标地址判断：只有「内网 / 私有地址」才放宽（NAS 上自签证书是常态），
// 公网地址保持严格校验。可用 ALLOW_INSECURE_TLS=1 强制全局放宽（不推荐）。
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || '') === '1';

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1') return true;
  // *.local / *.lan / *.home.arpa 等常见内网域名
  if (/\.(local|lan|home|home\.arpa|internal|intranet)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;            // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  return false;
}

// 是否需要对这个 URL 放宽证书校验（仅 https + 内网地址）
function shouldRelaxTls(url) {
  if (ALLOW_INSECURE_TLS) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return isPrivateHost(u.hostname);
  } catch (e) { return false; }
}

// ---------- 最小 Response 兼容层 ----------
// Node 内置 fetch 的 dispatcher 来自 undici，而 undici 并未作为可 require 的模块暴露，
// 拿不到 Agent 就无法做"按请求"放宽证书。这里用 node:https 自己发一次，
// 并把结果包装成调用方用到的那几个 Response 能力（status/ok/headers/text/json/arrayBuffer）。
function makeHeaders(rawHeaders) {
  const map = new Map();
  for (const k of Object.keys(rawHeaders || {})) {
    const v = rawHeaders[k];
    map.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
  }
  return {
    get(name) {
      const v = map.get(String(name || '').toLowerCase());
      return v === undefined ? null : v;
    },
    getSetCookie() {
      const v = rawHeaders['set-cookie'];
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    },
    has(name) { return map.has(String(name || '').toLowerCase()); },
    entries() { return map.entries(); }
  };
}

function makeResponse(status, headers, bodyBuffer) {
  return {
    status,
    statusText: '',
    ok: status >= 200 && status < 300,
    headers,
    async text() { return bodyBuffer.toString('utf-8'); },
    async json() { return JSON.parse(bodyBuffer.toString('utf-8')); },
    async arrayBuffer() {
      return bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength);
    }
  };
}

// 用 node:https 发请求（仅在需要放宽证书时使用），支持手动/自动重定向
function httpsRequestLoose(url, options, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法：' + url)); }
    const isHttps = u.protocol === 'https:';
    if (!isHttps && u.protocol !== 'http:') return reject(new Error('只支持 http/https'));

    const reqOpts = {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: REQUEST_TIMEOUT_MS,
      // 只有 https 才有意义；这里按需放宽
      rejectUnauthorized: !isHttps
    };
    if (isHttps) reqOpts.rejectUnauthorized = !shouldRelaxTls(url);

    const req = (isHttps ? https : http).request(u, reqOpts, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      const follow = options.redirect !== 'manual' && options.redirect !== 'error';
      if (follow && status >= 300 && status < 400 && location && redirectsLeft > 0) {
        res.resume(); // 丢弃重定向响应体
        let next;
        try { next = new URL(location, url).toString(); } catch (e) { next = ''; }
        if (!next || !/^https?:/i.test(next)) return resolve(makeResponse(status, makeHeaders(res.headers), Buffer.alloc(0)));
        return resolve(httpsRequestLoose(next, options, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(makeResponse(status, makeHeaders(res.headers), Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    const body = options.body;
    if (body != null) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) req.write(body);
      else if (body && typeof body.toString === 'function') req.write(body.toString());
    }
    req.end();
  });
}

async function fetchWithTimeout(url, options) {
  const opts = options || {};
  const relaxed = shouldRelaxTls(url);
  try {
    if (relaxed) {
      // 内网 https：走自建请求，按需放宽证书；超时由 socket timeout 控制
      const res = await httpsRequestLoose(url, opts, 5);
      if (res.status === 0) throw new Error('连接超时');
      return res;
    }
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.message === 'TIMEOUT')) {
      throw new Error(`连接超时（${REQUEST_TIMEOUT_MS / 1000}s），请检查地址是否可达`);
    }
    const code = e && e.cause && e.cause.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
      throw new Error(`无法连接到目标地址（${code}）。提示：本面板运行在 Docker 容器内，若下载器在宿主机/本机，请填宿主机局域网 IP 或 http://host.docker.internal:端口，不要填 localhost/127.0.0.1（那指向容器自身）`);
    }
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'CERT_HAS_EXPIRED' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      throw new Error(`HTTPS 证书校验失败（${code}）：公网地址保持严格证书校验。若这是你自己的内网设备，请改用局域网 IP（内网地址会自动放宽）`);
    }
    throw e;
  }
}

// 极简 Cookie Jar：Node 内置 fetch 无 cookie 管理，这里手动维护会话 Cookie
class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> { value, domain }
  }

  _parseSetCookie(setCookieHeader, url) {
    if (!setCookieHeader) return;
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const line of list) {
      if (!line) continue;
      const parts = line.split(';');
      const first = parts[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      let domain = '';
      for (const p of parts) {
        const t = p.trim().toLowerCase();
        if (t.startsWith('domain=')) domain = t.slice(7).trim();
      }
      this.cookies.set(name, { value, domain: domain || (url ? new URL(url).hostname : '') });
    }
  }

  headerFor(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [name, c] of this.cookies) {
      if (!c.domain || host.endsWith(c.domain)) {
        parts.push(`${name}=${c.value}`);
      }
    }
    return parts.join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}

module.exports = { CookieJar, fetchWithTimeout, REQUEST_TIMEOUT_MS, isPrivateHost, shouldRelaxTls };
