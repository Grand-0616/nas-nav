'use strict';

const cheerio = require('cheerio');
const { parseSize, parseNum } = require('../utils/format');
const { fetchWithTimeout } = require('../utils/cookiejar');

// PT 站点 - cookie 抓取模式
// 通过配置的登录 Cookie 抓取个人资料页，解析站点字段
// 支持两种页面结构：
//   1. NexusPHP 传统表格（<td class="rowhead">字段名</td><td>值</td>）
//   2. 自定义布局页面（div/span 或纯文本 "字段名: 值"），通过全文正则兜底解析
class SiteScrapeClient {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.profileUrl = (cfg.profileUrl || '').trim();
    this.cookie = (cfg.cookie || '').trim();
    this.accountHint = (cfg.account || '').trim();
  }

  async _fetchHtml() {
    if (!this.profileUrl) throw new Error('未配置个人资料页地址');
    if (!this.cookie) throw new Error('未配置站点 Cookie');
    const res = await fetchWithTimeout(this.profileUrl, {
      headers: { 'User-Agent': 'NAS-Nav/1.0', Cookie: this.cookie, Referer: new URL(this.profileUrl).origin + '/' }
    });
    if (res.status === 401 || res.status === 403) throw new Error('Cookie 无效或无权限，请更新站点 Cookie');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // ---- 方式一：表格结构（NexusPHP 传统个人资料页）----
  _rowValue($, rowLabelRegex) {
    const $trs = $('tr');
    for (let i = 0; i < $trs.length; i++) {
      const $tr = $trs.eq(i);
      const $tds = $tr.find('td');
      if ($tds.length < 2) continue;
      const label = $tds.eq(0).text().replace(/\s+/g, ' ').trim();
      // 关键防护一：单格布局页面（用户信息整体塞在一个 td 里）的 td[0] 文本
      // 会包含 "分享率" 等关键词，但其长度远超真实表格 label，必须跳过，
      // 否则会误判命中并从 td[1] 取到无意义符号，导致全文兜底失效。
      if (!label || label.length > 30) continue;
      // 关键防护二：首页常带"全站统计"表格（总上传量/总下载量/种子总数等），
      // 这些是全局数据不是当前账号数据，必须跳过，否则会把 PB 级总量误当用户数据。
      if (/总|總|站内|站內|本站|全站|全網|全網/.test(label)) continue;
      if (!rowLabelRegex.test(label)) continue;
      const $val = $tds.eq(1);
      const link = $val.find('a[title]').first();
      let text = link.length ? link.attr('title') : '';
      if (!text) text = $val.text();
      text = text.replace(/\s+/g, ' ').trim();
      // 值不能是纯符号/纯装饰内容（如 ⇥ ●），否则视为误判
      if (!text || /^[^\w\d.:,，。%+\-\/\\]+$/.test(text)) continue;
      return text;
    }
    return null;
  }

  // ---- 方式二：图片标记后取数字（当前活动: <img arrowup>238 <img arrowdown>0）----
  _imgNumber($, imgClass) {
    const $img = $(`img.${imgClass}`).first();
    if (!$img.length) return null;
    let node = $img.get(0).nextSibling;
    let raw = '';
    while (node) {
      if (node.nodeType === 3) raw += node.nodeValue;
      else break;
      node = node.nextSibling;
    }
    const m = raw.match(/([\d,]+)/);
    return m ? m[1] : null;
  }

  // ---- 方式二·乙：箭头 em 标记（<em class="seed-arrow">↑</em>466）----
  _emNumber($, emClass) {
    const $em = $(`em.${emClass}`).first();    if (!$em.length) return null;
    let node = $em.get(0).nextSibling;
    let raw = '';
    while (node) {
      if (node.nodeType === 3) raw += node.nodeValue;
      else break;
      node = node.nextSibling;
    }
    const m = raw.match(/([\d,]+)/);
    return m ? m[1] : null;
  }

  // ---- 方式二·丙：i/span 图标 + title 标记（<i class="fas fa-seedling" title="当前做种"></i> 432）----
  // keepfrds 等新版 UI：图标无文字，数字在父元素文本中
  _iconNumber($, titleText) {
    let found = null;
    $('i, span').each(function () {
      const title = $(this).attr('title') || '';
      if (title.indexOf(titleText) < 0) return;
      const text = $(this).parent().text().replace(/\s+/g, ' ').trim();
      const m = text.match(/([\d,]+)/);
      if (m) {
        found = m[1];
        return false;
      }
    });
    return found === null ? null : found;
  }

  // ---- 方式二·丁：img alt 图标 + 兄弟文本（<img alt="上传">&nbsp;192.14 GB，hhanclub 等 Tailwind 新版 UI）----
  // 优先取 img 后的文本节点，其次 img 后的兄弟元素文本，最后取父元素文本
  _imgAltValue($, altText) {
    let found = null;
    $('img').each(function () {
      const $img = $(this);
      if (($img.attr('alt') || '') !== altText) return;
      let node = this.nextSibling;
      let raw = '';
      while (node) {
        if (node.nodeType === 3) raw += node.nodeValue;
        else break;
        node = node.nextSibling;
      }
      raw = raw.trim();
      if (!raw && $img.next().length) raw = $img.next().text();
      if (!raw) raw = $img.parent().text();
      raw = raw.replace(/\s+/g, ' ').trim();
      // 去掉标签前缀文本（如 "[分享率]: 5.841" 只取数值）
      const m = raw.match(/([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)?)/i);
      if (m) {
        found = m[1];
        return false;
      }
    });
    return found === null ? null : found;
  }

  // 取所有匹配中数值最大者（同名 alt 图标在页面多处出现时，用户区的值通常最大，如 alt="下载数"）
  _imgAltValueMax($, altText) {
    let best = null;
    let bestNum = -1;
    $('img').each(function () {
      const $img = $(this);
      if (($img.attr('alt') || '') !== altText) return;
      let node = this.nextSibling;
      let raw = '';
      while (node) {
        if (node.nodeType === 3) raw += node.nodeValue;
        else break;
        node = node.nextSibling;
      }
      raw = raw.trim();
      if (!raw && $img.next().length) raw = $img.next().text();
      if (!raw) raw = $img.parent().text();
      raw = raw.replace(/\s+/g, ' ').trim();
      const m = raw.match(/([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)?)/i);
      if (!m) return;
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(num) && num > bestNum) {
        bestNum = num;
        best = m[1];
      }
    });
    return best;
  }

  // ---- 方式二点五：标签-值对结构（Vue SPA / 自定义指标区）----
  // 三种形态统一抽取，命中即返回"值"文本：
  //   A) dl/dt/dd：<dl><dt><span>分享率</span></dt><dd><span>1.602</span></dd></dl>
  //   B) title 属性：<span title="分享率:"><i>↔</i>无限</span>
  //   C) span 对：<div><span>做种中</span><span>0 个</span></div>
  _pairValue($, keywordRe) {
    // A) dt/dd（RousiPro 侧栏等）
    const $dls = $('dl');
    for (let i = 0; i < $dls.length; i++) {
      const $dl = $dls.eq(i);
      const $dts = $dl.find('dt');
      const $dds = $dl.find('dd');
      for (let j = 0; j < $dts.length; j++) {
        const label = $dts.eq(j).text().replace(/\s+/g, ' ').trim();
        if (!label || label.length > 20 || !keywordRe.test(label)) continue;
        // 跳过全站统计（总上传量/总下载量等是全局数据）
        if (/总|總|站内|站內|本站|全站|全網|全網/.test(label)) continue;
        const $dd = $dds.eq(j);
        let text = $dd.attr('aria-label') || '';
        if (!text) text = $dd.text();
        text = text.replace(/\s+/g, ' ').trim();
        if (!text || /^[^\w\d.:,，。%+\-\/\\]+$/.test(text)) continue;
        return text;
      }
    }
    // B) title 属性（PlayLet 指标区等）
    const $ti = $('[title]');
    for (let i = 0; i < $ti.length; i++) {
      const $el = $ti.eq(i);
      const label = ($el.attr('title') || '').replace(/\s+/g, ' ').trim();
      if (!label || !keywordRe.test(label)) continue;
      let text = $el.text().replace(/\s+/g, ' ').trim();
      if (!text || /^[^\w\d.:,，。%+\-\/\\]+$/.test(text)) continue;
      return text;
    }
    // C) span 对（同父下相邻直接子 span/strong：标签 + 值）
    // 覆盖 <div><span>标签</span><span>值</span></div> 与 <div><span>标签</span><strong>值</strong></div>
    const $spans = $('div span, li span');
    for (let i = 0; i < $spans.length; i++) {
      const $el = $spans.eq(i);
      const label = $el.text().replace(/\s+/g, ' ').trim();
      if (!label || label.length > 20 || !keywordRe.test(label)) continue;
      // 跳过全站统计（总上传量/种子总数等是全局数据）
      if (/总|總|站内|站內|本站|全站|全網|全網/.test(label)) continue;
      const $parent = $el.parent();
      const $sibs = $parent.children('span, strong');
      const idx = $sibs.toArray().indexOf($el.get(0));
      const $val = $sibs.eq(idx + 1);
      if (!$val.length) continue;
      let text = $val.text().replace(/\s+/g, ' ').trim();
      if (!text || /^[^\w\d.:,，。%+\-\/\\]+$/.test(text)) continue;
      return text;
    }
    return null;
  }

  // ---- 方式三：全文正则兜底（自定义布局页面）----
  // 页面文本规整后按 "字段名: 值" 模式匹配，兼容 全角冒号/空格/千分位
  // data-uploader-stats 属性解析（Audiences 等自定义 NexusPHP 变体）
  // 形如 data-uploader-stats="[{&quot;label&quot;:&quot;上传量：&quot;,&quot;value&quot;:&quot;90.51 GB&quot;},...]"
  // 命中即返回完整状态（该结构覆盖全部字段），未命中返回 null 走常规解析
  _uploaderStats(html) {
    const m = html.match(/data-uploader-stats=["'](\[.*?\])["']/);
    if (!m) return null;
    let arr;
    try {
      arr = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr)) return null;
    const map = {};
    for (const it of arr) {
      if (it && it.label) {
        const k = String(it.label).replace(/[：:\s]/g, '');
        map[k] = String(it.value != null ? it.value : '');
      }
    }
    const upRaw = map['上传量'] || map['上傳量'] || map['Uploaded'];
    const downRaw = map['下载量'] || map['下載量'] || map['Downloaded'];
    const bonusRaw = map['做种积分'] || map['做種積分'] || map['魔力值'] || map['爆米花'] || map['Bonus'];
    const actRaw = map['活跃'] || map['當前活動'] || map['Active'];
    const accountRaw = (html.match(/data-uploader-label="([^"]+)"/) || [])[1] || '';

    let seeding = 0, leeching = 0;
    if (actRaw) {
      const sm = actRaw.match(/↑\s*([\d,]+)/);
      const lm = actRaw.match(/↓\s*([\d,]+)/);
      if (sm) seeding = parseInt(sm[1].replace(/,/g, ''), 10) || 0;
      if (lm) leeching = parseInt(lm[1].replace(/,/g, ''), 10) || 0;
    }
    // 分享率：页面常显示"无限"（∞），此时 ratio=null
    let ratio = null;
    const rm = html.match(/site-userbar__compact-metric--ratio[\s\S]{0,120}?<span>([^<]*)<\/span>/i);
    if (rm && !/无限|無限|∞/.test(rm[1])) {
      const rv = parseFloat(String(rm[1]).replace(/[,\s]/g, ''));
      if (!isNaN(rv)) ratio = rv;
    }
    return {
      online: true,
      account: accountRaw,
      ratio,
      uploaded: parseSize(upRaw),
      downloaded: parseSize(downRaw),
      seeding,
      leeching,
      bonus: parseNum(bonusRaw)
    };
  }

  _text($, patterns) {
    const text = $('body').text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return (m[1] || '').trim();
    }
    return null;
  }

  // 用页面纯文本统一抽取一组字段（返回 null 表示未匹配）
  _grab($, kind) {
    const all = [
      { kind: 'ratio', patterns: [
        /分享率[：:\s]*([\d.,]+|無限|无限)/,
        /分享比[：:\s]*([\d.,]+|無限|无限)/,
        /上傳率[：:\s]*([\d.,]+|無限|无限)/,
        /Ratio[：:\s]*([\d.,]+|無限|无限)/i
      ]},
      { kind: 'uploaded', patterns: [
        /(?<!总)(?<!站)(?<!網)上传量?[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i,
        /(?<!总)(?<!站)(?<!網)上傳量?[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i,
        /(?<!总)(?<!站)(?<!網)Uploaded[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i
      ]},
      { kind: 'downloaded', patterns: [
        /(?<!总)(?<!站)(?<!網)下载量?[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i,
        /(?<!总)(?<!站)(?<!網)下載量?[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i,
        /(?<!总)(?<!站)(?<!網)Downloaded[：:\s]*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i
      ]},
      { kind: 'seeding_leeching', patterns: [
        // "当前活动: ✦238✦0" / "当前活动: 238/0" / "当前活动: 238 0"
        /当前活动[：:\s]*✦?\s*([\d,]+)\s*✦\s*([\d,]+)/,
        /當前活動[：:\s]*✦?\s*([\d,]+)\s*✦\s*([\d,]+)/,
        /当前活动[：:\s]*([\d,]+)\s*[\/／]\s*([\d,]+)/,
        /當前活動[：:\s]*([\d,]+)\s*[\/／]\s*([\d,]+)/,
        /当前活动[：:\s]*([\d,]+)\s+([\d,]+)/,
        /當前活動[：:\s]*([\d,]+)\s+([\d,]+)/,
        /做种[：:\s]*([\d,]+)\s*[\/／]\s*([\d,]+)/,
        /做種[：:\s]*([\d,]+)\s*[\/／]\s*([\d,]+)/
      ]},
      { kind: 'seeding', patterns: [
        /(?<!总)(?<!站)(?<!網)做种数[：:\s]*([\d,]+)/,
        /(?<!总)(?<!站)(?<!網)做種數[：:\s]*([\d,]+)/,
        /做种中[：:\s]*([\d,]+)\s*个/,
        /做種中[：:\s]*([\d,]+)\s*個/,
        /(?<!总)(?<!站)(?<!網)做种[：:\s]*([\d,]+)/,
        /(?<!总)(?<!站)(?<!網)做種[：:\s]*([\d,]+)/,
        /正在做种[：:\s]*([\d,]+)/,
        /正在做種[：:\s]*([\d,]+)/,
        /(?<!总)(?<!站)(?<!網)Seeding[：:\s]*([\d,]+)/i
      ]},
      { kind: 'leeching', patterns: [
        /(?<!总)(?<!站)(?<!網)下载数[：:\s]*([\d,]+)/,
        /(?<!总)(?<!站)(?<!網)下載數[：:\s]*([\d,]+)/,
        /下载中[：:\s]*([\d,]+)\s*个/,
        /下載中[：:\s]*([\d,]+)\s*個/,
        /正在下载[：:\s]*([\d,]+)/,
        /正在下載[：:\s]*([\d,]+)/,
        /(?<!总)(?<!站)(?<!網)Leechers?[：:\s]*([\d,]+)/i,
        /(?<!总)(?<!站)(?<!網)Leeching[：:\s]*([\d,]+)/i
      ]},
      { kind: 'bonus', patterns: [
        // 各站点的魔力/积分字段名不一：冰晶(Ubuntu系)、U币、G值(游戏站)、工分(PTLGS)、魔力值(常见)
        // 一律要求冒号/使用格式，避免把公告文本（如"50W 魔力 4."）误当积分
        /冰晶[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /U币[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /U幣[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /G值[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /G值[：:\s]*([\d.,]+[Kk]?)/,
        // 工分需排除"工分增量"（考核指标文本）
        /工分(?!增量)[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /魔力值[^：:]{0,12}?[：:]\s*([\d.,]+[Kk]?)/,
        /魔力值[：:\s]*([\d.,]+[Kk]?)/,
        /积分[：:\s]*([\d.,]+[Kk]?)/,
        /Bonus[：:\s]*([\d.,]+[Kk]?)/i,
        /My Bonus[：:\s]*([\d.,]+[Kk]?)/i,
        /Karma[：:\s]*([\d.,]+[Kk]?)/i
      ]}
    ];
    const item = all.find(x => x.kind === kind);
    if (!item) return null;
    return this._text($, item.patterns);
  }

  // ---- 外站专用 UI（IPT / seedpool / HD-Space）----
  // 这三个国外站各有独立用户信息条，登录后每个页面头部都带完整统计数据，
  // 通用表格/span 对解析取不到，这里按各自结构精确抽取。
  _parseSpecialUi($) {
    const ipt = this._parseIptStats($);
    if (ipt !== null) return ipt;
    const sp = this._parseSeedpoolStats($);
    if (sp !== null) return sp;
    const hd = this._parseHdspaceStats($);
    if (hd !== null) return hd;
    return null;
  }

  // IPTorrents：div.stats 用户条，<span class="tTipWrap"><div class="tTip ttop">Uploaded</div>…10 GB</span>
  // 用户名 <a class="uname">zerowei001</a>；做种/下载在 <a href="/peers?u=…">↑ 1 ↓ 0</a>
  _parseIptStats($) {
    const $uname = $('a.uname').first();
    if (!$uname.length || !$('.stats').length) return null;
    let uploaded = null, downloaded = null, ratio = null, bonus = null;
    $('.stats .tTipWrap').each(function () {
      const label = $(this).find('.tTip.ttop').first().text().replace(/\s+/g, ' ').trim();
      const raw = $(this).text().replace(/\s+/g, ' ').trim();
      const size = raw.match(/([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))\b/i);
      if (label === 'Uploaded') uploaded = size ? size[1] : null;
      else if (label === 'Downloaded') downloaded = size ? size[1] : null;
      else if (label === 'Ratio') {
        const v = raw.match(/([\d.,]+)\s*$/);
        if (v) ratio = parseFloat(v[1].replace(/,/g, ''));
      } else if (label === 'Bonus Points') {
        const v = raw.match(/([\d.,]+)/);
        if (v) bonus = parseFloat(v[1].replace(/,/g, ''));
      }
    });
    let seeding = 0, leeching = 0;
    const $peers = $('a[href*="/peers?u="]').first();
    if ($peers.length) {
      const m = $peers.text().match(/([\d,]+)\s*([\d,]+)/);
      if (m) {
        seeding = parseInt(m[1].replace(/,/g, ''), 10) || 0;
        leeching = parseInt(m[2].replace(/,/g, ''), 10) || 0;
      }
    }
    const account = $uname.clone().children('.tTip').remove().end().text().replace(/\s+/g, ' ').trim();
    if (!account && uploaded === null && downloaded === null) return null;
    return {
      online: true,
      account,
      ratio,
      uploaded: parseSize(uploaded),
      downloaded: parseSize(downloaded),
      seeding,
      leeching,
      bonus
    };
  }

  // SeedPool（Gzero 系）：ul.top-nav__ratio-bar，每个 li 一个指标
  // 上传 li 内两个 a：第一个是数值(50 GiB)，第二个是做种数(0)；下载同理
  _parseSeedpoolStats($) {
    const $bar = $('ul.top-nav__ratio-bar').first();
    if (!$bar.length) return null;
    const $uname = $('a.top-nav__username').first();
    const firstA = sel => $bar.find(sel).first().find('a').first().text().replace(/\s+/g, ' ').trim();
    const secondA = sel => $bar.find(sel).first().find('a').eq(1).text().replace(/\s+/g, ' ').trim();
    const upFirst = firstA('.ratio-bar__uploaded');
    const downFirst = firstA('.ratio-bar__downloaded');
    const upSecond = secondA('.ratio-bar__uploaded');
    const downSecond = secondA('.ratio-bar__downloaded');
    const ratioRaw = $bar.find('.ratio-bar__ratio a').text().replace(/\s+/g, ' ').trim();
    const bonusRaw = $bar.find('.ratio-bar__points a').text().replace(/\s+/g, ' ').trim();
    const account = $uname.length ? $uname.text().replace(/\s+/g, ' ').trim() : '';
    const num = s => { const v = (s || '').replace(/[(),()]/g, '').match(/([\d.,]+)/); return v ? parseFloat(v[1].replace(/,/g, '')) : null; };
    const ratio = num(ratioRaw);
    if (!account && !upFirst && !downFirst) return null;
    return {
      online: true,
      account,
      ratio: ratio !== null && !isNaN(ratio) ? ratio : null,
      uploaded: parseSize(upFirst),
      downloaded: parseSize(downFirst),
      seeding: parseInt((upSecond || '0').replace(/[()]/g, ''), 10) || 0,
      leeching: parseInt((downSecond || '0').replace(/[()]/g, ''), 10) || 0,
      bonus: num(bonusRaw)
    };
  }

  // HD-Space：首页顶部统计行 "UP: 10.00 GB / DL: 0.00 KB / Ratio: --- / Bonus: ---"
  // 用户名 "Welcome back <span>zerowei001</span>"
  _parseHdspaceStats($) {
    const bodyText = $('body').text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
    if (!bodyText.includes('UP:') || !bodyText.includes('DL:')) return null;
    const mUser = bodyText.match(/Welcome\s+back\s+([^\s(]+)/);
    const mUp = bodyText.match(/UP:\s*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))/i);
    const mDown = bodyText.match(/DL:\s*([\d.,]+\s*(?:TiB|GiB|MiB|KiB|TB|GB|MB|KB|B))/i);
    const mRatio = bodyText.match(/Ratio:\s*([\d.,]+|---|--|∞)/i);
    const mBonus = bodyText.match(/Bonus:\s*([\d.,]+|---|--|∞)/i);
    let ratio = null;
    if (mRatio && !/^-+$|∞/.test(mRatio[1])) ratio = parseFloat(mRatio[1].replace(/,/g, ''));
    const account = mUser ? mUser[1] : '';
    if (!account && !mUp && !mDown) return null;
    return {
      online: true,
      account,
      ratio,
      uploaded: mUp ? parseSize(mUp[1]) : 0,
      downloaded: mDown ? parseSize(mDown[1]) : 0,
      seeding: 0,
      leeching: 0,
      bonus: mBonus && !/^-+$/.test(mBonus[1]) ? parseFloat(mBonus[1].replace(/,/g, '')) : 0
    };
  }

  // ---- PeerGo 引擎 SPA（rousi.pro 等私有分享社区）----
  // 服务端 HTML 只有 React 骨架，数据全部由前端调 /api/v1/me/* 填充，
  // cheerio 解析不可行；带登录 Cookie 直接请求统计 API。
  async _fetchPeerGoStats() {
    const origin = new URL(this.profileUrl).origin;
    const headers = {
      'User-Agent': 'NAS-Nav/1.0',
      'Cookie': this.cookie,
      'Accept': 'application/json'
    };
    const [tr, ec] = await Promise.all([
      fetchWithTimeout(origin + '/api/v1/me/traffic?limit=1', { headers }),
      fetchWithTimeout(origin + '/api/v1/me/economy?limit=1', { headers })
    ]);
    if (!tr.ok || !ec.ok) {
      throw new Error(`PeerGo API 请求失败 (HTTP ${tr.status}/${ec.status})，Cookie 可能已失效，请重新获取站点 Cookie`);
    }
    const traffic = await tr.json();
    const eco = await ec.json();
    const totals = (traffic && traffic.totals) || {};
    // PeerGo 返回字节字符串：credited_uploaded_bytes=记入上传、charged_downloaded_bytes=计费下载
    const uploaded = parseInt(totals.credited_uploaded_bytes || '0', 10);
    const downloaded = parseInt(totals.charged_downloaded_bytes || '0', 10);
    let ratio = null;
    if (downloaded > 0) ratio = Math.round((uploaded / downloaded) * 1000) / 1000;
    // 账号名：profileUrl 末段就是用户名（https://rousi.pro/user/grand0616 → grand0616），最可靠；
    // accountHint 若存了导入时的垃圾值（如 "????"）则忽略，回退 profileUrl
    let account = '';
    const seg = (this.profileUrl || '').split('/').filter(Boolean).pop();
    if (seg && seg.length >= 2 && seg.length <= 32 && /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(seg)) {
      account = seg;
    } else if (this.accountHint && /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(this.accountHint)) {
      account = this.accountHint;
    }
    return {
      online: true,
      account,
      ratio,
      uploaded,
      downloaded,
      seeding: 0,
      leeching: 0,
      bonus: parseInt((eco && eco.magic_balance) || '0', 10)
    };
  }

  async getStatus() {
    const html = await this._fetchHtml();
    // PeerGo SPA 检测：页面是 React 骨架（__reactRouterContext + PeerGo），数据走 API
    if (html.includes('window.__reactRouterContext') && html.includes('PeerGo')) {
      return this._fetchPeerGoStats();
    }
    const $ = cheerio.load(html);

    // 专用结构优先：data-uploader-stats 属性（Audiences 等自定义 NexusPHP 变体）
    const ustat = this._uploaderStats(html);
    if (ustat !== null) return ustat;

    // 外站专用 UI 优先：IPT 用户条 / seedpool ratio-bar / HD-Space 顶部统计
    const special = this._parseSpecialUi($);
    if (special !== null) return special;

    // 表格结构优先
    let ratioRaw = this._rowValue($, /分享率|Ratio|分享比/);
    let upRaw = this._rowValue($, /^上传量|上传量|Uploaded/);
    let downRaw = this._rowValue($, /^下载量|下载量|Downloaded/);
    let seedingRaw = this._rowValue($, /做种数|做种|正在做种|Seeding|种子数/);
    let leechingRaw = this._rowValue($, /下载数|正在下载|Leeching|Leechers|下载中/);
    let bonusRaw = this._rowValue($, /魔力值|积分|Bonus|Points|Karma|My Bonus/);

    // 做种/下载：图片箭头标记最精确（<img arrowup>238 / <em class="seed-arrow">↑</em>466）
    // 优先于表格——首页"全站做种数"统计表常被表格解析误当用户数据
    let seedingImg = this._imgNumber($, 'arrowup') || this._emNumber($, 'seed-arrow') || this._iconNumber($, '当前做种') || this._iconNumber($, 'Torrents seeding') || this._iconNumber($, '做种');
    let leechingImg = this._imgNumber($, 'arrowdown') || this._emNumber($, 'leech-arrow') || this._iconNumber($, '当前下载') || this._iconNumber($, 'Torrents leeching') || this._iconNumber($, '下载');
    if (seedingImg !== null) seedingRaw = seedingImg;
    if (leechingImg !== null) leechingRaw = leechingImg;
    // img alt 图标 + 兄弟文本（hhanclub 等 Tailwind 新版 UI）：用于分享率/上传/下载/做种/积分
    if (seedingRaw === null) seedingRaw = this._imgAltValue($, '做种数') || this._imgAltValue($, '当前做种') || this._imgAltValue($, '种子数');
    if (ratioRaw === null) ratioRaw = this._imgAltValue($, '分享率');
    if (upRaw === null) upRaw = this._imgAltValue($, '上传量') || this._imgAltValue($, '上传') || this._imgAltValue($, '已上传');
    if (downRaw === null) downRaw = this._imgAltValue($, '下载量') || this._imgAltValue($, '下载') || this._imgAltValueMax($, '下载数');
    if (leechingRaw === null) leechingRaw = this._imgAltValueMax($, '下载数');
    if (bonusRaw === null) bonusRaw = this._imgAltValue($, '憨豆') || this._imgAltValue($, '魔力值') || this._imgAltValue($, '积分');

    // 标签-值对结构（dt/dd、title 属性、span 对）——Vue SPA / 自定义指标区
    if (ratioRaw === null) ratioRaw = this._pairValue($, /分享率|分享比|Ratio|上傳率|上传率/i);
    if (upRaw === null) upRaw = this._pairValue($, /上传量|上传|Uploaded|上傳量|上傳/i);
    if (downRaw === null) downRaw = this._pairValue($, /下载量|Downloaded|下載量|^下载$|^下載$/i);
    if (seedingRaw === null) seedingRaw = this._pairValue($, /做种中|做種中|做种数|做種數|正在做种|正在做種|Seeding|种子数|種子數/i);
    if (leechingRaw === null) leechingRaw = this._pairValue($, /下载中|下載中|下载数|下載數|正在下载|正在下載|Leeching|Leechers/i);
    if (bonusRaw === null) bonusRaw = this._pairValue($, /魔力值|魔力|U币|U幣|积分|積分|Bonus|Points|Karma/i);

    // 解析缺失的字段用全文正则兜底
    if (ratioRaw === null) ratioRaw = this._grab($, 'ratio');
    if (upRaw === null) upRaw = this._grab($, 'uploaded');
    if (downRaw === null) downRaw = this._grab($, 'downloaded');
    if (seedingRaw === null || leechingRaw === null) {
      const sl = this._grab($, 'seeding_leeching');
      if (sl !== null) {
        const parts = sl.split(/[✦\/／\s]+/);
        if (seedingRaw === null && parts[0]) seedingRaw = parts[0];
        if (leechingRaw === null && parts[1]) leechingRaw = parts[1];
      }
    }
    if (seedingRaw === null) seedingRaw = this._grab($, 'seeding');
    if (leechingRaw === null) leechingRaw = this._grab($, 'leeching');
    if (bonusRaw === null) bonusRaw = this._grab($, 'bonus');

    // 处理 "做种/下载: 203/0" 同行格式
    let seeding = parseNum(seedingRaw);
    let leeching = parseNum(leechingRaw);
    if (seedingRaw && /[\/／✦]/.test(seedingRaw) && leechingRaw === null) {
      const parts = seedingRaw.split(/[\/／✦]/);
      seeding = parseNum(parts[0]);
      leeching = parseNum(parts[1]);
    }

    // 账号：优先自动提取页面内嵌的用户名（欢迎回来/欢迎光临 → @用户名），
    // 失败再回退到用户手动配置的 accountHint（过滤"首页"等导入时误填的非用户名词），最后才是页面标题
    let account = '';
    const bodyText = $('body').text();
    const mWelcome = bodyText.match(/欢迎(?:回来|光临)[，,:：]?\s*([^\s<，,。]+)/);
    const mWelcomeT = bodyText.match(/歡迎(?:回來|光臨)[，,:：]?\s*([^\s<，,。]+)/);
    // a.User_Name 链接文本（hhanclub 等面板式新版 UI，用户名直接写在个人资料链接里）
    const $userLink = $('a.User_Name, a.user-name, a.userdetails').filter((i, el) => {
      const t = $(el).text().trim();
      return t && t.length >= 2 && t.length <= 32;
    }).first();
    // @用户名（排除 CSS 语法 @charset/@media/@import 等）
    const mAt = bodyText.match(/@(?!charset|media|import|supports|keyframes|font-face|document|namespace|viewport|counter|page|layer|property|tailwind|apply|config)([A-Za-z0-9_\-]{2,32})/);
    const hintOk = this.accountHint && !/^(首页|个人资料|个人中心|未识别账号|未識別帳號|用户资料|用戶資料|profile|我的)$/i.test(this.accountHint) && html.includes(this.accountHint);
    if (mWelcome) account = mWelcome[1];
    else if (mWelcomeT) account = mWelcomeT[1];
    else if ($userLink.length) account = $userLink.text().trim();
    else if (mAt) account = mAt[1];
    else if (hintOk) account = this.accountHint;
    else {
      const title = $('title').text().replace(/\s+/g, ' ').trim();
      if (title) account = title;
    }

    const hasAny = ratioRaw !== null || upRaw !== null || downRaw !== null || seedingRaw !== null || bonusRaw !== null;
    if (!hasAny) {
      const bodyText = $('body').text();
      if (/登录|请先登录|logout|Login/i.test(bodyText) && !/退出|Logout/i.test(bodyText)) {
        throw new Error('页面提示未登录，Cookie 可能已失效');
      }
      throw new Error('无法从页面解析出有效数据，请确认 profileUrl 指向个人资料页且 Cookie 有效');
    }

    // 分享率："無限/无限" → null（前端显示 --）
    let ratio = null;
    if (ratioRaw !== null) {
      const rt = String(ratioRaw).replace(/,/g, '');
      if (!/無限|无限/i.test(rt)) {
        ratio = parseFloat(rt);
        if (isNaN(ratio)) ratio = null;
      }
    }

    let bonus = parseNum(bonusRaw);

    // 合理性过滤：做种/下载数是小整数，PT 站做种上限通常数万；
    // 解析出 50 万以上的值多为"魔力值/积分"等大数被全文正则误抓。
    // 若此时积分仍为 0，将误抓值回填到积分（大多数站点魔力值恰为大数）。
    if (seeding > 500000) {
      if (bonus === 0) bonus = seeding;
      seeding = 0;
    }
    if (leeching > 500000) leeching = 0;

    return {
      online: true,
      account,
      ratio,
      uploaded: parseSize(upRaw),
      downloaded: parseSize(downRaw),
      seeding,
      leeching,
      bonus
    };
  }
}

module.exports = { SiteScrapeClient };
