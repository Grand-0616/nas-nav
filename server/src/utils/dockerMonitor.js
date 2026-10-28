'use strict';

// Docker 容器监控：通过 Docker Engine API 读取容器列表与实时 CPU/内存占用，并支持对容器启停/重启。
// 连接方式：
//  1) baseUrl 为空 → 使用容器内挂载的 unix socket /var/run/docker.sock（NAS/群晖上挂载宿主 socket）
//  2) baseUrl = http://host:2375 或 https://host:2376 → 远程/其他 Docker daemon
// 读取类请求为 GET；容器启停/重启为 POST（仅由「设置 → Docker 容器监控 → 容器操作」显式触发）。

const http = require('http');
const https = require('https');
const fs = require('fs');

const SOCKET_PATH = '/var/run/docker.sock';
const STATS_TTL = 3000; // stats 内存缓存 3 秒，避免高频轮询压垮 daemon

// stats 缓存含上次网络累计字节，用于差分计算实时网络速率
let statsCache = { at: 0, data: null, net: null };

function getDockerHost(cfg) {
  const base = (cfg && cfg.baseUrl) ? String(cfg.baseUrl).trim().replace(/\/+$/, '') : '';
  if (!base) return { type: 'socket', socketPath: SOCKET_PATH };
  if (base.startsWith('https://')) return { type: 'https', host: base.slice(8), port: 443, base };
  if (base.startsWith('http://')) {
    const rest = base.slice(7);
    const slash = rest.indexOf('/');
    const hostport = slash >= 0 ? rest.slice(0, slash) : rest;
    const port = hostport.includes(':') ? Number(hostport.split(':')[1]) : 2375;
    return { type: 'http', host: hostport.split(':')[0], port, base };
  }
  return { type: 'socket', socketPath: base }; // 直接填 socket 路径
}

function requestDocker(opts, path, timeoutMs, method) {
  return new Promise((resolve, reject) => {
    const reqOpts = { method: method || 'GET', path, headers: { Host: 'docker' }, timeout: timeoutMs || 6000 };
    if (opts.type === 'socket') {
      if (!fs.existsSync(opts.socketPath)) {
        return reject(new Error('未找到 Docker socket：' + opts.socketPath));
      }
      reqOpts.socketPath = opts.socketPath;
    } else if (opts.type === 'https') {
      reqOpts.hostname = opts.host;
      reqOpts.port = opts.port;
      reqOpts.rejectUnauthorized = false;
    } else {
      reqOpts.hostname = opts.host;
      reqOpts.port = opts.port;
    }
    const lib = opts.type === 'https' ? https : http;
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('Docker API HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
        }
        // POST 操作类接口返回 204 无 body；GET 接口解析 JSON
        if (!body.trim()) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Docker API 响应解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Docker API 请求超时')); });
    req.on('error', (e) => reject(new Error('无法连接 Docker：' + e.message)));
    req.end();
  });
}

// 并发闸：Docker daemon 对 /stats 这类重接口敏感，40 个容器同时打会明显拖慢宿主机
async function mapLimit(list, limit, fn) {
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

// 容器列表：/containers/json（含运行中与已停止）
// detail=true 时补充重启次数与健康检查状态（容器操作列表用）
async function listContainers(cfg, detail) {
  const opts = getDockerHost(cfg);
  const list = await requestDocker(opts, '/containers/json?all=1');
  const base = (list || []).map(c => {
    // 从 Status 文本提取退出码：如 "Exited (137) 2 hours ago"、"Restarting (1) 2 seconds ago"
    const m = String(c.Status || '').match(/\((\d+)\)/);
    const exitCode = m ? Number(m[1]) : null;
    const state = c.State || 'unknown';
    const abnormal = state === 'restarting' || (state === 'exited' && exitCode !== 0);
    return {
      id: c.Id ? c.Id.slice(0, 12) : '',
      fullId: c.Id || '',
      name: ((c.Names && c.Names[0]) || '').replace(/^\//, ''),
      image: c.Image || '',
      state,
      status: c.Status || '',
      exitCode,
      abnormal,
      ports: (c.Ports || []).map(p => (p.PublicPort ? p.PublicPort + '→' : '') + p.PrivatePort + '/' + (p.Type || 'tcp')).join(', '),
      portsArr: (c.Ports || []).map(p => ({
        hostPort: p.PublicPort || '',
        containerPort: p.PrivatePort || '',
        protocol: p.Type || 'tcp'
      })).filter(p => p.hostPort),
      createdAt: c.Created || 0
    };
  });
  if (!detail) return base;
  // 限并发 5：容器多时避免一次打几十个 inspect
  return mapLimit(base, 5, async (c) => {
    try {
      const j = await requestDocker(opts, '/containers/' + c.id + '/json', 4000);
      c.restartCount = (j && j.RestartCount) || 0;
      const h = j && j.State && j.State.Health;
      c.health = h ? (h.Status || 'none') : 'none';
      c.startedAt = (j && j.State && j.State.StartedAt) || '';
      if (h && h.Status === 'unhealthy') c.abnormal = true;
      return c;
    } catch (e) { c.restartCount = 0; c.health = 'none'; return c; }
  });
}

// 容器实时资源占用：/containers/{id}/stats?stream=false（CPU %、内存 %、网络收发速率）
async function containerStats(cfg) {
  const opts = getDockerHost(cfg);
  const now = Date.now();
  if (statsCache.data && now - statsCache.at < STATS_TTL) return statsCache.data;
  // 只统计 running：已停止容器没有 CPU/网络数据，逐个查只是白等超时
  const list = (await requestDocker(opts, '/containers/json')).filter(c => (c.State || '') === 'running');
  // 限并发 5：容器多时避免几十个 /stats 同时打到 daemon
  const out = await mapLimit(list, 5, async (c) => {
    const id = c.Id;
    try {
      const s = await requestDocker(opts, '/containers/' + id + '/stats?stream=false', 5000);
      const cpuDelta = s.cpu_stats && s.cpu_stats.cpu_usage && s.cpu_stats.cpu_usage.total_usage || 0;
      const cpuPrev = s.precpu_stats && s.precpu_stats.cpu_usage && s.precpu_stats.cpu_usage.total_usage || 0;
      const sysDelta = s.cpu_stats && s.cpu_stats.system_cpu_usage || 0;
      const sysPrev = s.precpu_stats && s.precpu_stats.system_cpu_usage || 0;
      const onlineCpus = (s.cpu_stats && s.cpu_stats.online_cpus) || 1;
      let cpuPct = 0;
      if (sysDelta > sysPrev && cpuDelta >= cpuPrev) {
        cpuPct = ((cpuDelta - cpuPrev) / (sysDelta - sysPrev)) * onlineCpus * 100;
        if (cpuPct > 100) cpuPct = Math.min(100, cpuPct / onlineCpus);
      }
      const mem = s.memory_stats || {};
      const memUsage = mem.usage || 0;
      const memLimit = (mem.limit || 0) > 0 ? mem.limit : null;
      let memPct = 0;
      if (memLimit) memPct = Math.min(100, (memUsage / memLimit) * 100);
      // 网络累计收发字节：所有网络接口求和
      let netRx = 0, netTx = 0;
      const nets = s.networks || {};
      for (const k of Object.keys(nets)) {
        netRx += nets[k].rx_bytes || 0;
        netTx += nets[k].tx_bytes || 0;
      }
      const name = ((c.Names && c.Names[0]) || '').replace(/^\//, '');
      return {
        id: id.slice(0, 12),
        name,
        cpuPct: Math.round(cpuPct * 10) / 10,
        memPct: Math.round(memPct * 10) / 10,
        memUsage,
        memLimit,
        netRx,
        netTx
      };
    } catch (e) { return null; } /* 单个容器 stats 失败跳过 */
  });
  const items = out.filter(Boolean);
  // 与上次采样差分计算实时网络速率（KB/s）
  const prevNet = statsCache.net || {};
  const dt = statsCache.at ? (Date.now() - statsCache.at) / 1000 : 0;
  for (const it of items) {
    const prev = prevNet[it.name];
    if (prev && dt > 0) {
      it.netRxRate = Math.max(0, Math.round((it.netRx - prev.rx) / dt / 1024 * 10) / 10);
      it.netTxRate = Math.max(0, Math.round((it.netTx - prev.tx) / dt / 1024 * 10) / 10);
    } else {
      it.netRxRate = 0;
      it.netTxRate = 0;
    }
  }
  const net = {};
  for (const it of items) net[it.name] = { rx: it.netRx, tx: it.netTx };
  statsCache = { at: Date.now(), data: items, net };
  return items;
}

// ---------- 容器操作 ----------
// 只暴露 启动 / 停止 / 重启 / 暂停 / 恢复；不做删除（删容器会连带数据卷语义，风险不对等）
const CONTAINER_ACTIONS = {
  start: { method: 'POST', path: '/start' },
  stop: { method: 'POST', path: '/stop?t=10' },
  restart: { method: 'POST', path: '/restart?t=10' },
  pause: { method: 'POST', path: '/pause' },
  unpause: { method: 'POST', path: '/unpause' }
};

// 容器名/ID 白名单校验：Docker API 路径是拼接的，必须挡住 ../ 之类的注入
function assertContainerRef(ref) {
  const s = String(ref || '').trim();
  if (!s) throw new Error('缺少容器标识');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s)) {
    throw new Error('容器标识非法（只允许字母、数字、下划线、点、连字符）');
  }
  return s;
}

async function containerAction(cfg, ref, action) {
  const act = CONTAINER_ACTIONS[action];
  if (!act) throw new Error('不支持的操作：' + action);
  const id = assertContainerRef(ref);
  const opts = getDockerHost(cfg);
  // 操作后让 stats 缓存失效，前端刷新能立刻看到新状态
  statsCache = { at: 0, data: null, net: statsCache.net };
  await requestDocker(opts, '/containers/' + encodeURIComponent(id) + act.path, 30000, act.method);
  return { id, action };
}

module.exports = { listContainers, containerStats, containerAction, CONTAINER_ACTIONS: Object.keys(CONTAINER_ACTIONS) };
