'use strict';

// 宿主系统监控：通过 docker-compose 只读挂载的 /host/proc /host/root 读取宿主机
// CPU/内存/磁盘/网络。本地非容器运行（无 /host 挂载）时自动回退读本机 /proc。
// 采用「缓存差值」策略：接口本身不等待，用上一次采样的值计算速率与占用，响应快。

const fs = require('fs');

let prev = null; // { cpuBusy, cpuTotal, netRx, netTx, ts }

function procDir() {
  return fs.existsSync('/host/proc') ? '/host/proc' : '/proc';
}

function readProc(rel) {
  try {
    return fs.readFileSync(require('path').join(procDir(), rel), 'utf8');
  } catch (e) {
    return null;
  }
}

function readCpu() {
  const s = readProc('stat');
  if (!s) return null;
  const line = s.split('\n').find(l => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

function readMem() {
  const s = readProc('meminfo');
  if (!s) return null;
  const grab = (k) => {
    const m = s.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
    return m ? Number(m[1]) * 1024 : null; // kB -> bytes
  };
  const total = grab('MemTotal');
  const avail = grab('MemAvailable');
  if (total == null || avail == null) return null;
  return { total, used: Math.max(total - avail, 0) };
}

function readDisk() {
  const root = fs.existsSync('/host/root') ? '/host/root' : '/';
  const pick = (p) => {
    try {
      const st = fs.statfsSync(p);
      const bsize = st.bsize || 4096;
      const total = st.blocks * bsize;
      const used = (st.blocks - st.bfree) * bsize;
      if (total > 0) return { total, used };
    } catch (e) { /* skip */ }
    return null;
  };
  // 优先遍历宿主挂载表，取第一个真实文件系统卷（排除虚拟/伪文件系统），NAS 上即真实数据卷
  const mounts = readProc('mounts');
  if (mounts) {
    for (const line of mounts.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const [, mp, type] = parts;
      if (!/^(ext\d|btrfs|xfs|vfat|f2fs|zfs|jfs|reiserfs)$/.test(type)) continue;
      if (mp.startsWith('/host/')) continue;
      // 排除系统/虚拟路径，只统计真实数据卷（NAS 上为 / 或 /volume1 /mnt/data 等）
      if (/^\/(etc|proc|sys|dev|run|var|tmp|boot|usr|opt|srv|app|snap)(\/|$)/.test(mp)) continue;
      const target = mp === '/' ? root : root + mp;
      const r = pick(target);
      if (r) return { ...r, mount: mp === '/' ? '/' : mp };
    }
  }
  // 回退：直接统计根挂载
  const r = pick(root);
  if (r) return { ...r, mount: '/' };
  return null;
}

function readNet() {
  const s = readProc('net/dev');
  if (!s) return null;
  let rx = 0, tx = 0;
  for (const line of s.split('\n')) {
    const m = line.match(/^\s*([^:\s]+):\s*(\d+)\s+(\d+)/);
    if (!m) continue;
    const iface = m[1];
    if (iface === 'lo') continue;
    rx += Number(m[2]);
    tx += Number(m[3]);
  }
  return { rx, tx };
}

function cores() {
  const s = readProc('cpuinfo');
  if (s) {
    const n = (s.match(/^processor\s*:/gm) || []).length;
    if (n > 0) return n;
  }
  return null;
}

function getSystemStatus() {
  const now = Date.now();
  const cpu = readCpu();
  const mem = readMem();
  const disk = readDisk();
  const net = readNet();
  const coreCount = cores();

  let cpuPct = null, downSpeed = null, upSpeed = null;
  if (prev && prev.ts && cpu && prev.cpu) {
    const dTotal = cpu.total - prev.cpu.total;
    if (dTotal > 0) cpuPct = Math.min(100, Math.max(0, ((cpu.busy - prev.cpu.busy) / dTotal) * 100));
  }
  if (prev && prev.ts && net && prev.net) {
    const dt = (now - prev.ts) / 1000;
    if (dt > 0) {
      downSpeed = Math.max(0, net.rx - prev.net.rx) / dt;
      upSpeed = Math.max(0, net.tx - prev.net.tx) / dt;
    }
  }
  if (cpu && net) prev = { cpu: { busy: cpu.busy, total: cpu.total }, net, ts: now };

  const memPct = mem ? Math.round((mem.used / mem.total) * 100) : null;
  const diskPct = disk ? Math.round((disk.used / disk.total) * 100) : null;
  const reason = (!mem && !disk && !cpu) ? '未挂载宿主 /proc /root（docker-compose 需包含只读挂载）' : null;

  return {
    cpu: cpuPct == null ? null : { pct: Math.round(cpuPct * 10) / 10, cores: coreCount },
    mem: mem ? { used: mem.used, total: mem.total, pct: memPct } : null,
    disk: disk ? { used: disk.used, total: disk.total, pct: diskPct, mount: disk.mount } : null,
    net: downSpeed == null ? null : { down: downSpeed, up: upSpeed },
    error: reason
  };
}

module.exports = { getSystemStatus };
