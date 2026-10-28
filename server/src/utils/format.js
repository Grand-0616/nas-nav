'use strict';

// 站点/下载器返回的各种数值文本解析工具

// b/kb/mb/gb/tb/pb 与 KiB/MiB/GiB/TiB（二进制前缀，换算相同）
const UNITS = {
  b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2,
  gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4,
  pb: 1024 ** 5, pib: 1024 ** 5
};

// "185 GB" / "1.5TB" / "683.2 MB" / "1024" / "↑1.64 GB"（带箭头/图标前缀） -> 字节数
function parseSize(text) {
  if (text == null) return 0;
  const t = String(text).replace(/,/g, '').trim();
  if (!t) return 0;
  const m = t.match(/^[^\d]*([\d.]+)\s*([a-zA-Z]*)$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (isNaN(num)) return 0;
  const unit = (m[2] || 'b').toLowerCase();
  const mult = UNITS[unit] || 1;
  return Math.round(num * mult);
}

// "68.3K" / "68300" / "68,300" / "1.2k" / "373,532 魔力值" / "0 个" -> 数字（K=千）
// 容忍数字后携带中文等尾随文本（如 "做种中 0 个"、"373,532 魔力值"）
function parseNum(text) {
  if (text == null) return 0;
  const t = String(text).replace(/,/g, '').trim();
  if (!t) return 0;
  const m = t.match(/^([\d.]+)\s*([kK]?)\s*[^\d]*$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (isNaN(num)) return 0;
  return m[2] ? Math.round(num * 1000) : Math.round(num);
}

// 字节数 -> 人类可读 "1.78 TB"
function fmtSize(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

// 字节/秒 -> "3.7 MB/s"
function fmtSpeed(bytesPerSec) {
  return fmtSize(bytesPerSec) + '/s';
}

module.exports = { parseSize, parseNum, fmtSize, fmtSpeed };
