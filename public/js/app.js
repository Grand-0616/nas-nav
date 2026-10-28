'use strict';

/* ===== 状态 ===== */
const state = {
  view: 'home',
  config: { services: [], downloaders: [], sites: [] },
  activeTab: 'system',
  editing: null,       // 正在编辑的对象
  editingType: null,   // downloaders | sites | services
  timers: {},
  serversCache: null,  // 上次下载器页渲染缓存（避免切换页面空白）
  siteCache: null,     // 上次站点页渲染缓存
  sortMode: false,     // 站点页拖拽整理模式
  siteGroup: '全部',   // 站点页分组筛选（全部 / 各分组）
  netMode: 'lan',      // 服务访问模式：lan 内网 / wan 外网（localStorage 持久化）
  settingsReady: false, // 设置页表单是否已回填过；未回填时 DOM 里是浏览器默认值，不能当作"用户输入"提交
  bgVersion: null      // 上传背景图的版本号（换图后加时间戳绕过浏览器长缓存）
};

/* ===== DOM 快捷 ===== */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
};

const TITLES = { home: '首页', apps: '服务', servers: '下载器', sites: '站点', moviepilot: 'MoviePilot', settings: '设置' };

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ===== 视图切换 ===== */
function switchView(view) {
  state.view = view;
  $('#pageTitle').textContent = TITLES[view];
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  document.querySelectorAll('.side-item, .bottom-item').forEach(it => {
    it.classList.toggle('active', it.dataset.view === view);
  });
  // 记住当前页面，刷新后不回到首页；URL hash 同步（replaceState 不触发 hashchange 循环）
  try { localStorage.setItem('nas-nav-view', view); } catch (e) { /* ignore */ }
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'settings') {
    try { localStorage.setItem('nas-nav-settings-tab', state.activeTab); } catch (e) { /* ignore */ }
  }
  clearInterval(state.timers.servers);
  clearInterval(state.timers.sites);
  clearInterval(state.timers.home);
  clearInterval(state.timers.apps);
  clearInterval(state.timers.clock);

  if (view === 'home') {
    renderHome();
    state.timers.home = setInterval(renderHome, 60 * 1000); // 监控/状态点每分钟刷新
  } else if (view === 'apps') {
    renderApps();
    state.timers.apps = setInterval(renderApps, 60 * 1000); // 服务状态点每分钟刷新
  } else if (view === 'servers') {
    const sec = (state.config.ui && state.config.ui.downloaderRefreshSec) || 15;
    renderServers();
    state.timers.servers = setInterval(renderServers, sec * 1000);
  }
  else if (view === 'sites') {
    const sec = (state.config.ui && state.config.ui.siteRefreshSec) || 60;
    renderSites();
    state.timers.sites = setInterval(renderSites, sec * 1000);
  }
  else if (view === 'moviepilot') {
    renderMoviePilot();
    // 只刷看板数据，不重建页面（否则会冲掉用户正在输入的搜索框）
    state.timers.home = setInterval(() => {
      if (state.view === 'moviepilot') renderMoviePilotDash();
    }, 60 * 1000);
  }
  else if (view === 'settings') renderSettings();
}

/* ===== 首页：时钟 + 系统监控 + Docker + 影视墙（服务导航已独立到「服务」页，MoviePilot 已独立到「MoviePilot」页） ===== */
async function renderHome() {
  renderHomeHero();        // 欢迎语 + 时钟 + 日期
  renderHomeMonitor();     // 系统监控卡（异步回填，不阻塞）
  renderHomeDocker();      // Docker 容器监控（异步回填，不阻塞）
  renderHomeMedia();       // 飞牛影视墙（异步回填，不阻塞）
}

/* 首页影视墙：飞牛影视媒体库统计 + 继续观看 + 最近海报（可手动刷新） */
let mediaShown = false;
async function renderHomeMedia(force) {
  const wrap = $('#homeMedia');
  if (!wrap) return;
  const cfg = state.config;
  if (!(cfg.mediaServer && cfg.mediaServer.enabled)) { wrap.innerHTML = ''; mediaShown = false; return; }
  let data = null;
  try {
    const r = await API.getMediaOverview(force);
    data = r && r.connected && r.data ? r.data : null;
  } catch (e) { /* ignore */ }
  if (!data) {
    wrap.innerHTML = `<div class="home-group media-group">
      <div class="home-group-title">影视墙 <span class="stat-tag">飞牛影视</span></div>
      <div class="media-empty">媒体服务器未连接（检查设置页的飞牛影视配置）<button class="btn btn-sm" onclick="renderHomeMedia(true)">重试</button></div>
    </div>`;
    mediaShown = false;
    return;
  }
  mediaShown = true;
  const s = data.summary || {};
  const escU = (u) => esc(u);
  // 海报经服务端代理（飞牛海报接口需要登录态）
  const posterSrc = (p) => p ? '/api/media/poster?url=' + encodeURIComponent(p) : '';
  let html = `<div class="home-group media-group">
    <div class="home-group-title">影视墙 <span class="stat-tag">飞牛影视</span>
      <button class="btn btn-sm media-refresh" title="手动刷新影视数据" onclick="renderHomeMedia(true)">↻</button>
    </div>
    <div class="media-summary">
      <div class="media-stat"><b>${s.total || 0}</b><span>全部</span></div>
      <div class="media-stat"><b>${s.movie || 0}</b><span>电影</span></div>
      <div class="media-stat"><b>${s.tv || 0}</b><span>剧集</span></div>
      <div class="media-stat"><b>${s.video || 0}</b><span>短视频</span></div>
      ${s.live ? `<div class="media-stat"><b>${s.live}</b><span>直播</span></div>` : ''}
    </div>`;

  // 媒体库（最上）
  if (data.libraries && data.libraries.length) {
    html += `<div class="media-sub-title">媒体库</div><div class="media-libs">`;
    for (const l of data.libraries.slice(0, 8)) {
      html += `<a class="media-lib" href="${escU(data.serverUrl || cfg.mediaServer.baseUrl) + '/v/'}" target="_blank" rel="noopener">
        ${l.poster ? `<img loading="lazy" src="${escU(posterSrc(l.poster))}" alt="" onerror="this.style.visibility='hidden'">` : ''}
        <div class="media-lib-name">${esc(l.title)}</div><div class="media-lib-count">${l.count || 0}</div>
      </a>`;
    }
    html += `</div>`;
  }

  // 继续观看
  if (data.play && data.play.length) {
    html += `<div class="media-sub-title">继续观看</div><div class="media-play">`;
    for (const it of data.play.slice(0, 6)) {
      html += `<a class="media-play-item" href="${escU(it.url)}" target="_blank" rel="noopener" title="${esc(it.title)}">
        ${it.poster ? `<img loading="lazy" src="${escU(posterSrc(it.poster))}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="media-noimg">' + esc((it.title || '?').slice(0, 1)) + '</div>'}
        <div class="media-play-meta"><div class="media-play-name">${esc(it.title)}</div><div class="media-play-sub">${esc(it.subtitle || '')}</div></div>
      </a>`;
    }
    html += `</div>`;
  }

  // 最近条目海报墙
  if (data.recent && data.recent.length) {
    html += `<div class="media-sub-title">最近入库</div><div class="media-posters">`;
    for (const it of data.recent.slice(0, 18)) {
      const tag = it.type === 'Movie' ? '电影' : (it.episode ? `S${it.season}E${it.episode}` : '');
      html += `<a class="media-poster" href="${escU(it.url)}" target="_blank" rel="noopener" title="${esc(it.title)}">
        ${it.poster ? `<img loading="lazy" src="${escU(posterSrc(it.poster))}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="media-noimg">' + esc((it.title || '?').slice(0, 1)) + '</div>'}
        <div class="media-poster-meta"><div class="media-poster-name">${esc(it.title)}</div>${tag ? `<div class="media-poster-tag">${esc(tag)}</div>` : ''}</div>
      </a>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  wrap.innerHTML = html;
}

/* ===== MoviePilot 独立页：未配置引导 / 看板 + 搜索订阅 + 插件 ===== */
let mpSearchType = 'movie';
let mpPageReady = false;   // MP 页骨架是否已渲染（避免自动刷新重建页面冲掉搜索框）
let mpPluginsLoaded = false; // 插件列表只在进入页面时拉一次（1+40 个请求，不必跟 60s 轮询）
let mpPluginsCache = null;

async function renderMoviePilot() {
  const page = $('#mpPage');
  if (!page) return;
  const cfg = state.config;
  const mp = cfg.moviePilot || {};
  // 未配置：引导去设置
  if (!mp.enabled || !mp.baseUrl || !mp.apiToken) {
    page.innerHTML = `<div class="home-group media-group">
      <div class="home-group-title">MoviePilot <span class="stat-tag">独立页</span></div>
      <div class="mp-empty">
        <div class="mp-empty-icon">🎬</div>
        <div class="mp-empty-title">尚未配置 MoviePilot</div>
        <div class="mp-empty-desc">配置地址与 API Token 后，这里将显示媒体库统计、下载器汇总、系统资源、订阅概况，并支持搜索影视资源一键订阅、查看已安装插件。</div>
        <button class="btn btn-primary" onclick="gotoMpSettings()">去设置配置</button>
      </div>
    </div>`;
    mpPageReady = false;
    return;
  }
  // 已经渲染过就不重建骨架：60 秒的自动刷新只刷看板数据，
  // 否则用户正在输入的搜索框会被整页 innerHTML 冲掉
  if (mpPageReady && $('#mpDashBox')) {
    renderMoviePilotDash();
    return;
  }
  const wrap = page;
  // 骨架先出（框架立即显示，数据异步回填）
  wrap.innerHTML = `<div class="home-group media-group">
      <div class="home-group-title">MoviePilot <span class="stat-tag">看板</span>
        <button class="btn btn-sm media-refresh" title="刷新看板数据" onclick="renderMoviePilotDash(true)">↻</button>
      </div>
      <div id="mpDashBox" class="mp-grid-loading">正在加载看板数据…</div>
    </div>
    <div class="home-group media-group">
      <div class="home-group-title">搜索订阅 <span class="stat-tag">MoviePilot</span></div>
      <div class="mp-search-bar">
        <div class="seg" id="mpSearchTypeSeg">
          <button class="seg-btn ${mpSearchType === 'movie' ? 'active' : ''}" data-type="movie">电影</button>
          <button class="seg-btn ${mpSearchType === 'tv' ? 'active' : ''}" data-type="tv">剧集</button>
        </div>
        <input id="mpSearchInput" class="toolbar-search" placeholder="搜索片名 / 资源名…" autocomplete="off">
        <button class="btn btn-primary" id="mpSearchBtn">搜索</button>
      </div>
      <div id="mpSearchResult" class="mp-search-hint">搜索走 MoviePilot 站点索引（不依赖 TMDB），输入片名即可列出各站种子资源，点「订阅」加入 MoviePilot 自动搜索下载。</div>
    </div>
    <div class="home-group media-group">
      <div class="home-group-title">插件 <span class="stat-tag">已安装</span>
        <button class="btn btn-sm media-refresh" title="刷新插件列表" onclick="renderMpPlugins(true)">↻</button>
      </div>
      <div id="mpPluginsBox" class="mp-grid-loading">正在加载插件列表…</div>
    </div>`;
  mpPageReady = true;
  // 搜索框内容在重绘后恢复（切换页面回来不会丢）
  const inp = $('#mpSearchInput');
  if (inp && mpSearchState.input) inp.value = mpSearchState.input;
  if (mpSearchState.items && mpSearchState.items.length) renderMpResults();
  renderMoviePilotDash();
  renderMpPlugins();
  bindMpSearchEvents();
}

// 去设置配置：切到设置页并高亮 MoviePilot 配置区
function gotoMpSettings() {
  switchView('settings');
  state.activeTab = 'system';
  try { localStorage.setItem('nas-nav-settings-tab', 'system'); } catch (e) { /* ignore */ }
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'system'));
  ['system', 'theme', 'backup'].forEach(t => {
    const pane = $('#pane-' + t);
    if (pane) pane.classList.toggle('hidden', t !== 'system');
  });
  const box = $('#f_mpUrl');
  if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.focus(); }
}

async function renderMoviePilotDash(force) {
  const box = $('#mpDashBox');
  if (!box) return;
  let r = null;
  try { r = await API.getMpDashboard(); } catch (e) { /* ignore */ }
  if (!r || !r.ok || !r.data) {
    box.innerHTML = `<div class="media-empty">无法获取看板数据：${esc((r && r.error) || '未连接')}<button class="btn btn-sm" onclick="renderMoviePilotDash(true)">重试</button></div>`;
    return;
  }
  const d = r.data;
  const sys = d.system || {};
  const m = d.media || {};
  const dl = d.downloader || {};
  const st = d.storage || {};
  const mem = d.mem || {};
  const sub = d.subscribe || {};
  const netDown = d.net && d.net.down != null ? fmtSize(d.net.down) + '/s' : '--';
  const netUp = d.net && d.net.up != null ? fmtSize(d.net.up) + '/s' : '--';
  const cpuTxt = d.cpu != null ? d.cpu.toFixed(1) + '%' : '--';
  const memPct = mem.usage != null ? mem.usage.toFixed(1) + '%' : (mem.total ? ((mem.used / mem.total) * 100).toFixed(1) + '%' : '--');
  const memTxt = (mem.used != null && mem.total != null) ? `${fmtSize(mem.used)} / ${fmtSize(mem.total)}` : '--';
  const stPct = st.total ? Math.min(100, (st.used / st.total) * 100) : 0;
  const upTxt = sys.runtimeSec ? fmtUptime(sys.runtimeSec) : '';
  const partErr = (d.partialErrors && d.partialErrors.length)
    ? `<div class="mp-partial">部分数据获取失败：${esc(d.partialErrors.join('；'))}</div>` : '';
  const verTxt = sys.version ? `${esc(sys.version)}${sys.hostname ? ' · ' + esc(sys.hostname) : ''}` : (sys.hostname ? esc(sys.hostname) : '');
  box.innerHTML = `${partErr}
    <div class="mp-ver-line">${verTxt || ''}${upTxt ? ' · 运行 ' + upTxt : ''}${sys.os ? ' · ' + esc(sys.os) : ''}</div>
    <div class="mp-grid">
      <div class="mp-card">
        <div class="mp-card-title">媒体库</div>
        <div class="mp-nums">
          <span class="mp-num"><b>${m.movieCount || 0}</b><i>电影</i></span>
          <span class="mp-num"><b>${m.tvCount || 0}</b><i>剧集</i></span>
          <span class="mp-num"><b>${m.episodeCount || 0}</b><i>集数</i></span>
          <span class="mp-num dim"><b>+${m.movieCountMonth || 0}</b><i>本月电影</i></span>
          <span class="mp-num dim"><b>+${m.tvCountMonth || 0}</b><i>本月剧集</i></span>
        </div>
      </div>
      <div class="mp-card">
        <div class="mp-card-title">下载器</div>
        <div class="mp-nums">
          <span class="mp-num"><b class="down">↓ ${fmtSize(dl.downloadSpeed)}/s</b><i>下载</i></span>
          <span class="mp-num"><b class="up">↑ ${fmtSize(dl.uploadSpeed)}/s</b><i>上传</i></span>
          <span class="mp-num dim"><b>${fmtSize(dl.downloadSize)}</b><i>累计下载</i></span>
          <span class="mp-num dim"><b>${fmtSize(dl.uploadSize)}</b><i>累计上传</i></span>
          <span class="mp-num dim"><b>${fmtSize(dl.freeSpace)}</b><i>剩余空间</i></span>
        </div>
      </div>
      <div class="mp-card">
        <div class="mp-card-title">系统资源</div>
        <div class="mp-nums">
          <span class="mp-num"><b>${cpuTxt}</b><i>CPU</i></span>
          <span class="mp-num"><b>${memPct}</b><i>内存</i></span>
          <span class="mp-num dim"><b>${memTxt}</b><i>内存用量</i></span>
          <span class="mp-num dim"><b>${netDown}</b><i>下行</i></span>
          <span class="mp-num dim"><b>${netUp}</b><i>上行</i></span>
        </div>
      </div>
      <div class="mp-card">
        <div class="mp-card-title">存储与订阅</div>
        ${st.total || st.used ? `<div class="mp-storage"><div class="mp-storage-bar"><span style="width:${stPct.toFixed(1)}%"></span></div>
          <span class="mp-meta">${fmtSize(st.used)} / ${fmtSize(st.total)}（${stPct.toFixed(1)}%）</span></div>` : `<div class="mp-meta" style="margin:0 0 8px">存储统计未启用（MoviePilot 未返回数据）</div>`}
        <div class="mp-nums">
          <span class="mp-num"><b>${sub.total || 0}</b><i>订阅</i></span>
          <span class="mp-num ok-text"><b>${sub.running || 0}</b><i>进行中</i></span>
          <span class="mp-num dim"><b>${sub.pending || 0}</b><i>待搜索</i></span>
          <span class="mp-num dim"><b>${sub.stopped || 0}</b><i>已停止</i></span>
        </div>
      </div>
    </div>`;
  // 定时刷新由 switchView 统一管理（见 view === 'moviepilot' 分支），
  // 这里不再自己起 interval，避免两套定时器叠加导致重复请求
  mpPageReady = true;
}

/* 搜索订阅 */
let mpSearchState = { items: [], type: '全部', site: '全部', input: '' };
function bindMpSearchEvents() {
  const seg = $('#mpSearchTypeSeg');
  if (seg && !seg.dataset.bound) {
    seg.dataset.bound = '1';
    seg.querySelectorAll('.seg-btn').forEach(b => {
      b.onclick = () => {
        mpSearchType = b.dataset.type;
        seg.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      };
    });
  }
  const inp = $('#mpSearchInput');
  const btn = $('#mpSearchBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.onclick = () => doMpSearch();
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') doMpSearch(); });
  }
}
async function doMpSearch() {
  const inp = $('#mpSearchInput');
  const box = $('#mpSearchResult');
  if (!inp || !box) return;
  const title = (inp.value || '').trim();
  if (!title) { box.innerHTML = '<div class="mp-search-hint">请输入搜索关键词</div>'; return; }
  box.innerHTML = '<div class="mp-search-hint">搜索中…（MoviePilot 全站索引，约需 10-30 秒）</div>';
  let r = null;
  try { r = await API.getMpSearch(title, mpSearchType); } catch (e) { /* ignore */ }
  if (!r || !r.ok) {
    box.innerHTML = `<div class="mp-search-hint">搜索失败：${esc((r && r.error) || '未知错误')}</div>`;
    return;
  }
  const items = r.items || [];
  if (!items.length) {
    mpSearchState = { items: [], type: '全部', site: '全部', input: title };
    box.innerHTML = '<div class="mp-search-hint">未找到「' + esc(title) + '」相关资源</div>';
    return;
  }
  // 记住关键词：页面重绘后能把输入框和结果恢复回来
  mpSearchState = { items, type: '全部', site: '全部', input: title };
  renderMpResults();
}
// 渲染搜索结果 + 筛选标签（类型/站点，本地过滤不重新请求）
function renderMpResults() {
  const box = $('#mpSearchResult');
  if (!box) return;
  const { items, type, site } = mpSearchState;
  const typeSet = [...new Set(items.map(i => i.type || '未知').filter(Boolean))];
  const siteSet = [...new Set(items.map(i => i.site_name).filter(Boolean))];
  const types = ['全部'].concat(typeSet).slice(0, 6);
  const sites = ['全部'].concat(siteSet).slice(0, 8);
  const filtered = items.filter(i =>
    (type === '全部' || (i.type || '未知') === type) &&
    (site === '全部' || i.site_name === site));
  const typeTags = `<div class="mp-filter-bar" id="mpFilterType">` + types.map(t =>
    `<button class="tag-btn${t === type ? ' active' : ''}" onclick="setMpFilter('type','${esc(t.replace(/'/g, "\\'"))}')">${esc(t)}</button>`).join('') + `</div>`;
  const siteTags = `<div class="mp-filter-bar" id="mpFilterSite">` + sites.map(s =>
    `<button class="tag-btn${s === site ? ' active' : ''}" onclick="setMpFilter('site','${esc(s.replace(/'/g, "\\'"))}')">${esc(s)}</button>`).join('') + `</div>`;
  const body = filtered.length
    ? `<div class="mp-search-list">` + filtered.map(it => mpResourceCard(it)).join('') + `</div>`
    : `<div class="mp-search-hint">无匹配资源（可切换上方筛选）</div>`;
  box.innerHTML = `<div class="mp-result-head">共 ${items.length} 条资源${site !== '全部' ? ' · ' + esc(site) : ''}${type !== '全部' ? ' · ' + esc(type) : ''}</div>` + typeTags + siteTags + body;
}
function setMpFilter(kind, val) {
  if (kind === 'type') mpSearchState.type = val;
  else mpSearchState.site = val;
  renderMpResults();
}
// 搜索结果资源卡（search/title：站点种子信息）
function mpResourceCard(it) {
  const name = it.name || '';
  const year = it.year || '';
  const size = it.size ? fmtSize(it.size) : '';
  const pix = it.resource_pix || '';
  const enc = it.video_encode || '';
  const audio = it.audio_encode || '';
  const seed = it.seeders != null ? it.seeders : '';
  const factor = it.upload_factor != null ? Number(it.upload_factor) : null;
  const factorTxt = factor != null && !isNaN(factor) ? (factor > 1 ? '×' + factor : (factor < 1 ? (factor === 0 ? '免费' : '×' + factor) : '1x')) : '';
  const site = it.site_name || '';
  const desc = it.desc || '';
  const tmdb = it.tmdbid || 0;
  const season = it.season || 0;
  return `<div class="mp-res-card">
    <div class="mp-res-main">
      <div class="mp-res-name">${esc(name)}</div>
      <div class="mp-res-meta">
        ${site ? `<span class="mp-res-site">${esc(site)}</span>` : ''}
        ${pix ? `<span>${esc(pix)}</span>` : ''}
        ${enc ? `<span>${esc(enc)}</span>` : ''}
        ${audio ? `<span>${esc(audio)}</span>` : ''}
      </div>
      ${desc ? `<div class="mp-res-desc">${esc(desc)}</div>` : ''}
    </div>
    <div class="mp-res-side">
      <div class="mp-res-nums">
        ${year ? `<span>${esc(year)}</span>` : ''}
        ${size ? `<span>${esc(size)}</span>` : ''}
        ${seed !== '' ? `<span class="ok-text">做种 ${seed}</span>` : ''}
        ${factorTxt ? `<span class="factor-text">${factorTxt}</span>` : ''}
      </div>
      <button class="btn btn-sm btn-primary" onclick="mpSubscribe('${esc(name.replace(/'/g, "\\'"))}', '${esc(name.replace(/'/g, "\\'"))}', ${tmdb}, ${season})">订阅</button>
    </div>
  </div>`;
}
async function mpSubscribe(name, keyword, tmdbid, season) {
  const btn = event && event.target || null;
  if (btn) { btn.disabled = true; btn.textContent = '订阅中…'; }
  try {
    const r = await API.addMpSubscribe({ name, keyword, tmdbid, season, type: '' });
    if (r && r.ok) {
      showToast('已添加订阅：《' + name + '》');
      if (btn) { btn.disabled = true; btn.textContent = '已订阅 ✓'; }
    } else {
      const err = (r && r.error) || '未知错误';
      showToast('订阅失败：' + err);
      if (/500|Internal|识别|无法/.test(err)) {
        showToast('MoviePilot 无法识别该媒体（多为 TMDB 外网不通），可到 MoviePilot 内手动添加订阅');
      }
      if (btn) { btn.disabled = false; btn.textContent = '订阅'; }
    }
  } catch (e) {
    showToast('订阅失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '订阅'; }
  }
}

/* 插件列表：只在首次进入页面时拉取（1 + 最多 40 个请求），
   之后跟随 60 秒重绘会直接用缓存；点 ↻ 传 force=true 强制刷新 */
async function renderMpPlugins(force) {
  const box = $('#mpPluginsBox');
  if (!box) return;
  if (!force && mpPluginsLoaded && mpPluginsCache) {
    paintMpPlugins(box, mpPluginsCache);
    return;
  }
  let r = null;
  try { r = await API.getMpPlugins(); } catch (e) { /* ignore */ }
  if (!r || !r.ok) {
    box.innerHTML = `<div class="media-empty">无法获取插件列表：${esc((r && r.error) || '未知错误')}<button class="btn btn-sm" onclick="renderMpPlugins(true)">重试</button></div>`;
    return;
  }
  mpPluginsCache = r.items || [];
  mpPluginsLoaded = true;
  paintMpPlugins(box, mpPluginsCache);
}

function paintMpPlugins(box, items) {
  if (!items.length) { box.innerHTML = '<div class="media-empty">未安装任何插件</div>'; return; }
  box.innerHTML = `<div class="mp-plugin-grid">` + items.map(p => {
    const st = p.enabled === true ? '<span class="mp-plugin-state on">启用</span>' : (p.enabled === false ? '<span class="mp-plugin-state">停用</span>' : '');
    return `<div class="mp-plugin-card">
      <div class="mp-plugin-head">
        <span class="mp-plugin-name">${esc(p.name || p.id)}</span>${st}
      </div>
      ${p.cron ? `<div class="mp-plugin-meta">定时：<code>${esc(p.cron)}</code></div>` : ''}
    </div>`;
  }).join('') + `</div>`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return (d ? d + '天' : '') + h + '小时' + m + '分';
}
function renderHomeHero() {
  const greet = $('#homeGreet'), clock = $('#homeClock'), date = $('#homeDate');
  if (!greet || !clock || !date) return;
  clearInterval(state.timers.clock);
  const tick = () => {
    const d = new Date();
    const h = d.getHours();
    const g = h < 5 ? '夜深了，注意休息' : h < 8 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    greet.textContent = g;
    clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    date.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wd}`;
  };
  tick();
  state.timers.clock = setInterval(tick, 1000);
}

/* 首页系统监控卡：CPU / 内存 / 磁盘 / 网络（进度条分级着色） */
async function renderHomeMonitor() {
  const wrap = $('#homeMonitor');
  if (!wrap) return;
  let data = null;
  try { data = await API.getSystemStatus(); } catch (e) { /* ignore */ }
  if (!data) { wrap.innerHTML = ''; return; }
  const pctCls = (p) => p == null ? 'mon-unknown' : (p >= 90 ? 'mon-danger' : p >= 70 ? 'mon-warn' : 'mon-ok');
  const bar = (p) => p == null
    ? `<div class="mon-bar"><div class="mon-fill mon-unknown" style="width:0"></div></div><div class="mon-num">--</div>`
    : `<div class="mon-bar"><div class="mon-fill ${pctCls(p)}" style="width:${Math.min(p, 100)}%"></div></div><div class="mon-num">${p}%</div>`;

  let html = `<div class="home-group-title">系统监控 <span class="stat-tag">NAS</span></div><div class="mon-grid">`;

  // CPU
  html += `<div class="mon-card">
    <div class="mon-head"><span class="mon-icon">⚙</span>CPU 占用${data.cpu && data.cpu.cores ? `<span class="mon-core">${data.cpu.cores} 核</span>` : ''}</div>
    ${bar(data.cpu ? data.cpu.pct : null)}
  </div>`;

  // 内存
  html += `<div class="mon-card">
    <div class="mon-head"><span class="mon-icon">▤</span>内存占用</div>
    ${bar(data.mem ? data.mem.pct : null)}
    <div class="mon-sub">${data.mem ? fmtSize(data.mem.used) + ' / ' + fmtSize(data.mem.total) : '--'}</div>
  </div>`;

  // 磁盘
  html += `<div class="mon-card">
    <div class="mon-head"><span class="mon-icon">▣</span>磁盘空间${data.disk && data.disk.mount ? `<span class="mon-core">${esc(data.disk.mount)}</span>` : ''}</div>
    ${bar(data.disk ? data.disk.pct : null)}
    <div class="mon-sub">${data.disk ? fmtSize(data.disk.used) + ' / ' + fmtSize(data.disk.total) : '--'}</div>
  </div>`;

  // 网络
  html += `<div class="mon-card">
    <div class="mon-head"><span class="mon-icon">⇅</span>网络速率</div>
    <div class="mon-net">
      <div><span class="mon-dir down">▼ 下载</span><span class="mon-speed">${data.net ? fmtSpeed(data.net.down) : '--'}</span></div>
      <div><span class="mon-dir up">▲ 上传</span><span class="mon-speed">${data.net ? fmtSpeed(data.net.up) : '--'}</span></div>
    </div>
  </div>`;

  if (data.error) html += `<div class="mon-error">${esc(data.error)}</div>`;
  html += '</div>';
  wrap.innerHTML = html;
}

/* 首页 Docker 容器监控（配置启用后显示；未连接时给出提示） */
let dockerTimer = null;

/* Docker 首页组件定义：组件 id → 名称/说明（顺序与开关存 config.docker.homeComps） */
const DOCKER_COMPS = [
  { id: 'overview', label: '健康总览', desc: '运行 / 停止 / 异常计数' },
  { id: 'top', label: '资源占用 Top', desc: 'CPU / 内存占用排行前 5' },
  { id: 'net', label: '网络流量 Top', desc: '实时下载 / 上传速率排行前 5' },
  { id: 'grid', label: '容器列表', desc: '全部容器状态与资源' }
];
function dockerCompOrder() {
  const cfg = ((state.config || {}).docker || {}).homeComps;
  if (Array.isArray(cfg) && cfg.length) {
    // 只保留仍存在的组件 id，并把默认组件里缺失的补到末尾
    const def = DOCKER_COMPS.map(c => c.id);
    const have = cfg.filter(id => def.includes(id));
    for (const id of def) if (!have.includes(id)) have.push(id);
    return have;
  }
  return DOCKER_COMPS.map(c => c.id);
}

/* 首页 Docker：按配置的组件顺序渲染（健康总览 / 资源 Top / 网络 Top / 容器列表） */
async function renderHomeDocker() {
  const wrap = $('#homeDocker');
  const dc = (state.config && state.config.docker) || {};
  if (!wrap) return;
  if (!dc.enabled) { wrap.innerHTML = ''; return; }
  let data = null;
  try { data = await API.getDockerContainers(); } catch (e) { /* ignore */ }
  if (!data || !data.ok) { wrap.innerHTML = ''; return; }
  let statsMap = {};
  if (data.connected) {
    try {
      const st = await API.getDockerStats();
      if (st.ok && st.connected) {
        for (const it of st.items) statsMap[it.name] = it;
      }
    } catch (e) { /* ignore */ }
  }
  if (!data.connected) {
    wrap.innerHTML = `<div class="home-group-title">Docker 容器 <span class="stat-tag">监控</span></div>
      <div class="docker-note">${data.disabled ? '' : '无法连接 Docker：' + esc(data.error || '未找到 Docker socket')}（NAS 部署需在 docker-compose 挂载 /var/run/docker.sock，或配置远程 API 地址）</div>`;
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    wrap.innerHTML = `<div class="home-group-title">Docker 容器 <span class="stat-tag">监控</span></div><div class="docker-note">未发现容器</div>`;
    return;
  }
  const order = dockerCompOrder();
  let html = `<div class="home-group-title">Docker 容器 <span class="stat-tag">监控</span> <span class="docker-count">${items.length}</span></div>`;
  for (const id of order) {
    if (id === 'overview') html += dockerOverviewHtml(items);
    else if (id === 'top') html += dockerTopHtml(statsMap);
    else if (id === 'net') html += dockerNetHtml(statsMap);
    else if (id === 'grid') html += dockerGridHtml(items, statsMap);
  }
  wrap.innerHTML = html;
  if (dockerTimer) clearInterval(dockerTimer);
  dockerTimer = setInterval(() => {
    if (state.view === 'home') renderHomeDocker();
  }, 15000);
}

/* 组件 1：健康总览横条 */
function dockerOverviewHtml(items) {
  const run = items.filter(c => c.state === 'running').length;
  const stop = items.filter(c => c.state === 'exited').length;
  const bad = items.filter(c => c.abnormal).length;
  return `<div class="docker-overview">
    <span class="docker-ov-item"><i class="dot-ov ok"></i>运行 ${run}</span>
    <span class="docker-ov-item"><i class="dot-ov muted"></i>停止 ${stop}</span>
    ${bad ? `<span class="docker-ov-item"><i class="dot-ov bad"></i>异常 ${bad}</span>` : `<span class="docker-ov-item ok-text">全部正常</span>`}
  </div>`;
}

/* 组件 2：资源占用 Top（CPU 降序前 5） */
function dockerTopHtml(statsMap) {
  const top = Object.values(statsMap)
    .filter(s => s.cpuPct != null)
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, 5);
  if (!top.length) return '';
  return `<div class="docker-top-title">资源占用 Top</div><div class="docker-top-list">` + top.map((s, i) => {
    const cpuCls = s.cpuPct >= 90 ? 'mon-danger' : s.cpuPct >= 70 ? 'mon-warn' : 'mon-ok';
    const memCls = s.memPct >= 90 ? 'mon-danger' : s.memPct >= 70 ? 'mon-warn' : 'mon-ok';
    return `<div class="docker-top-row">
      <span class="docker-top-rank">${i + 1}</span>
      <span class="docker-top-name" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="docker-top-bar"><span class="docker-top-fill ${cpuCls}" style="width:${Math.min(s.cpuPct, 100)}%"></span></span>
      <span class="docker-top-num"><b class="${cpuCls}">${s.cpuPct}%</b> CPU</span>
      <span class="docker-top-mem"><b class="${memCls}">${s.memPct}%</b> 内存</span>
    </div>`;
  }).join('') + `</div>`;
}

/* 组件 3：网络流量 Top（下载速率降序前 5，显示 ↓下载 / ↑上传） */
function dockerNetHtml(statsMap) {
  const top = Object.values(statsMap)
    .filter(s => s.netRxRate != null && s.netRxRate > 0)
    .sort((a, b) => b.netRxRate - a.netRxRate)
    .slice(0, 5);
  if (!top.length) return '';
  const max = Math.max.apply(null, top.map(s => s.netRxRate)) || 1;
  return `<div class="docker-top-title">网络流量 Top</div><div class="docker-top-list">` + top.map((s, i) => {
    const w = Math.max(4, Math.round(s.netRxRate / max * 100));
    return `<div class="docker-top-row">
      <span class="docker-top-rank">${i + 1}</span>
      <span class="docker-top-name" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="docker-top-bar"><span class="docker-top-fill net-fill" style="width:${w}%"></span></span>
      <span class="docker-top-num">↓ ${fmtSize(s.netRxRate * 1024)}/s</span>
      <span class="docker-top-mem">↑ ${fmtSize(s.netTxRate * 1024)}/s</span>
    </div>`;
  }).join('') + `</div>`;
}

/* 组件 4：容器列表网格 */
function dockerGridHtml(items, statsMap) {
  const allowActs = !!((state.config.docker || {}).allowActions);
  let html = `<div class="docker-grid">`;
  for (const c of items) {
    const st = statsMap[c.name] || {};
    const cpu = st.cpuPct;
    const mem = st.memPct;
    const pctCls = (p) => p == null ? '' : (p >= 90 ? 'mon-danger' : p >= 70 ? 'mon-warn' : 'mon-ok');
    const running = c.state === 'running';
    const paused = c.state === 'paused';
    // 操作的可用性：运行中可停/重启/暂停；已暂停可恢复/停；其余可启动
    let ops = '';
    if (allowActs) {
      const ref = esc(c.name || c.id);
      const btn = (act, label, cls) =>
        `<button class="btn-xs${cls ? ' ' + cls : ''}" onclick="dockerAction('${ref}','${act}',this)">${label}</button>`;
      if (running) ops = btn('stop', '停止', 'danger') + btn('restart', '重启') + btn('pause', '暂停');
      else if (paused) ops = btn('unpause', '恢复') + btn('stop', '停止', 'danger');
      else ops = btn('start', '启动');
    }
    html += `<div class="docker-card">
      <div class="docker-head">
        <span class="docker-dot ${running ? 'ok' : c.abnormal ? 'bad' : 'off'}"></span>
        <span class="docker-name" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="docker-state ${c.abnormal ? 'txt-danger' : ''}" title="${esc(c.status)}">${esc(c.state)}${c.exitCode != null && c.state === 'exited' ? ' (' + c.exitCode + ')' : ''}</span>
      </div>
      <div class="docker-img" title="${esc(c.image)}">${esc(c.image)}</div>
      ${c.ports ? `<div class="docker-ports">${esc(c.ports)}</div>` : ''}
      <div class="docker-metrics">
        <div class="docker-metric"><span>CPU</span>${cpu == null ? '<b class="mon-unknown">--</b>' : `<b class="${pctCls(cpu)}">${cpu}%</b>`}${cpu == null ? '' : `<div class="mon-bar"><div class="mon-fill ${pctCls(cpu)}" style="width:${Math.min(cpu, 100)}%"></div></div>`}</div>
        <div class="docker-metric"><span>内存</span>${mem == null ? '<b class="mon-unknown">--</b>' : `<b class="${pctCls(mem)}">${mem}%</b>`}${mem == null ? '' : `<div class="mon-bar"><div class="mon-fill ${pctCls(mem)}" style="width:${Math.min(mem, 100)}%"></div></div>`}</div>
      </div>
      ${ops ? `<div class="docker-ops">${ops}</div>` : ''}
    </div>`;
  }
  return html + '</div>';
}

/* 容器操作：启动 / 停止 / 重启 / 暂停 / 恢复 */
async function dockerAction(ref, action, btnEl) {
  const label = { start: '启动', stop: '停止', restart: '重启', pause: '暂停', unpause: '恢复' }[action] || action;
  if (action === 'stop' || action === 'restart') {
    if (!window.confirm(`确定要${label}「${ref}」吗？\n\n停止容器会中断该服务当前的所有连接。`)) return;
  }
  if (btnEl) {
    if (btnEl.disabled) return;
    btnEl.disabled = true;
    btnEl.textContent = label + '中…';
  }
  try {
    const r = await API.dockerAction(ref, action);
    if (r && r.ok) {
      showToast(`已${label}「${ref}」`);
      setTimeout(() => { if (state.view === 'home') renderHomeDocker(); }, 800); // 等 daemon 状态落定
    } else {
      showToast(`${label}失败：${(r && r.error) || '未知错误'}`);
    }
  } catch (e) {
    showToast(`${label}失败：${e.message}`);
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = label; }
  }
}

/* ===== 服务页：服务导航卡片（分类分组 + 状态点 + 搜索过滤 + 自动发现） ===== */
function renderApps() {
  const cfg = state.config;
  const wrap = $('#servicesContent');
  if (!wrap) return;
  wrap.innerHTML = '';
  renderServicesGrid(wrap, {});
  API.getServicesStatus().then(r => {
    const m = Object.fromEntries(r.items.map(x => [x.id, x]));
    if (state.view === 'apps') renderServicesGrid(wrap, m);
  }).catch(() => { /* ignore */ });
}

function renderServicesGrid(wrap, svcStatus) {
  const cfg = state.config;
  const q = (($('#svcSearch') || {}).value || '').trim().toLowerCase();
  const groups = {};
  for (const s of cfg.services) {
    if (!s.enabled) continue;
    if (q && !(s.name || '').toLowerCase().includes(q) && !(s.url || '').toLowerCase().includes(q) && !(s.category || '').toLowerCase().includes(q)) continue;
    (groups[s.category || '未分类'] = groups[s.category || '未分类'] || []).push(s);
  }
  const keys = Object.keys(groups);
  wrap.innerHTML = '';

  if (!keys.length) {
    wrap.appendChild(el('div', 'empty-tip',
      (q ? `没有匹配「${esc(q)}」的服务` : '还没有配置任何服务入口') +
      '<br><br><button class="btn btn-primary tip-btn" onclick="openDiscover()">🔍 自动发现服务</button> ' +
      '<button class="btn tip-btn" onclick="openEditor(null,\'services\')">+ 手动添加</button>'));
    return;
  }

  for (const k of keys) {
    const group = el('div', 'home-group');
    group.appendChild(el('div', 'home-group-title', esc(k)));
    const grid = el('div', 'home-grid');
    for (const s of groups[k]) {
      const iconText = { qb: 'qB', tr: 'TR', jf: 'JF', al: 'AL', pp: 'PP', nav: '◧', ds: 'DS', sm: 'SM',
        iy: 'IY', lu: 'LU', mp: 'MP', em: 'EM', nt: 'NT', px: 'PX', nd: 'ND', po: 'PO', fn: 'FN',
        sy: 'SY', a2: 'A2', jk: 'JK', pw: 'PW', sn: 'SN', rd: 'RD', rh: 'RH', fb: 'FB', dg: 'DG',
        hp: 'HP', im: 'IM', xi: 'XI', ng: 'NG', ct: 'CT' }[s.icon] || (s.name || '?').slice(0, 1).toUpperCase();
      const st = svcStatus[s.id];
      const dotCls = !s.url ? 'dot-none' : (st ? (st.online ? 'dot-on' : 'dot-off') : 'dot-unknown');
      // 内外网切换：外网模式且有外网域名时打开外网地址，否则内网地址
      const openUrl = (state.netMode === 'wan' && s.wanUrl) ? s.wanUrl : s.url;
      const card = el('a', 'service-card',
        `<div class="service-icon">${esc(iconText)}</div>
         <div class="service-name">${esc(s.name)}</div>
         <button class="card-edit" title="设置" onclick="openEditor(findSvc('${esc(s.id)}'),'services');return false;">⚙</button>
         <span class="service-dot ${dotCls}" title="${!s.url ? '未配置地址' : st ? (st.online ? '在线' : '离线：' + esc(st.error || '不可达')) : '探测中…'}"></span>`);
      if (openUrl) card.href = openUrl;
      card.target = '_blank';
      grid.appendChild(card);
    }
    group.appendChild(grid);
    wrap.appendChild(group);
  }
}

function findSvc(id) {
  return (state.config.services || []).find(x => x.id === id) || null;
}

/* 服务页搜索过滤 */
let svcSearchBound = false;
function bindSvcSearch() {
  const input = $('#svcSearch');
  if (!input || svcSearchBound) return;
  svcSearchBound = true;
  input.addEventListener('input', () => renderApps());
}

/* 服务自动发现：打开发现面板并扫描 */
async function openDiscover() {
  const mask = $('#discoverMask');
  if (!mask) return;
  mask.classList.remove('hidden');
  $('#discoverHint').textContent = '正在扫描 Docker 容器与宿主端口…';
  $('#discoverList').innerHTML = '';
  $('#discoverMsg').textContent = '';
  let res;
  try {
    res = await API.discoverServices();
  } catch (e) {
    $('#discoverHint').textContent = '扫描失败：' + e.message;
    return;
  }
  const items = res.items || [];
  const host = res.host || 'host.docker.internal';
  const dockerOk = res.dockerAvailable;
  state.lanIp = res.lanIp || '';
  $('#discoverHint').innerHTML =
    `发现 ${items.length} 个候选服务。来源：<b>${dockerOk ? 'Docker 容器 ✓' : 'Docker 未连接（仅端口探测）'}</b> · 探测地址 <code>${esc(host)}</code> · 已添加的服务自动跳过导入。` +
    `<br><span class="hint">URL 默认用 ${esc(host)} 占位，可编辑；建议导入后点 ⚙ 在「访问地址」里切换 Docker 内 / 局域网 IP / 域名 三种形式再保存。</span>`;
  const list = $('#discoverList');
  list.innerHTML = '';
  if (!items.length) {
    list.appendChild(el('div', 'empty-tip', '没有发现服务。检查：① Docker 容器监控是否启用；② 服务是否为 Docker 部署且映射了端口；③ host 服务是否在探测端口上监听。'));
    return;
  }
  // 表头：经典全选小方框（只作用于未添加的候选；勾选状态实时反映）
  const head = el('div', 'discover-head');
  const hBox = document.createElement('input');
  hBox.type = 'checkbox';
  hBox.className = 'discover-check discover-selall';
  hBox.id = 'discoverSelAll';
  hBox.title = '全选 / 全不选（未添加的服务）';
  head.appendChild(hBox);
  head.appendChild(el('span', 'discover-h-name', '服务名'));
  head.appendChild(el('span', 'discover-h-url', '访问地址'));
  head.appendChild(el('span', 'discover-h-tag', '来源'));
  head.appendChild(el('span', 'discover-h-meta', ''));
  list.appendChild(head);
  // 表头全选 / 全不选
  hBox.onchange = () => {
    document.querySelectorAll('.discover-item:not(.added) .discover-check').forEach(c => { c.checked = hBox.checked; });
    hBox.indeterminate = false;
  };
  // 行勾选变化 → 同步表头三态
  list.addEventListener('change', e => {
    if (e.target && e.target.classList.contains('discover-check') && e.target.id !== 'discoverSelAll') syncDiscoverHead();
  });
  const addedN = items.filter(x => x.added).length;
  for (const it of items) {
    const row = el('div', 'discover-item' + (it.added ? ' added' : ''));
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'discover-check';
    box.checked = !it.added;
    box.dataset.idx = items.indexOf(it);
    const nameIn = document.createElement('input');
    nameIn.className = 'discover-name';
    nameIn.value = it.name;
    nameIn.dataset.idx = items.indexOf(it);
    const urlIn = document.createElement('input');
    urlIn.className = 'discover-url';
    urlIn.value = it.url;
    urlIn.dataset.idx = items.indexOf(it);
    const tag = el('span', 'discover-tag ' + (it.source === 'docker' ? 'src-docker' : 'src-port'),
      it.source === 'docker' ? (it.running ? 'Docker·运行中' : 'Docker·已停止') : '端口探测');
    const portTxt = it.port ? ` :${it.port}` : '';
    const meta = el('div', 'discover-meta', esc(it.container || it.image || ''));
    row.appendChild(box);
    row.appendChild(nameIn);
    row.appendChild(urlIn);
    row.appendChild(tag);
    row.appendChild(meta);
    list.appendChild(row);
  }
  if (addedN) $('#discoverMsg').textContent = `${addedN} 项已添加（自动跳过，勾选可重新导入同地址不生效）`;
  syncDiscoverHead(); // 初始状态：所有未添加行默认勾选 → 表头显示全选
  bindDiscoverEvents();
}

/* 同步表头全选框三态：全选 / 部分 / 全不选（只看未添加的行） */
function syncDiscoverHead() {
  const h = $('#discoverSelAll');
  if (!h) return;
  const rows = document.querySelectorAll('.discover-item:not(.added) .discover-check');
  const checked = document.querySelectorAll('.discover-item:not(.added) .discover-check:checked').length;
  h.checked = rows.length > 0 && checked === rows.length;
  h.indeterminate = checked > 0 && checked < rows.length;
}

function bindDiscoverEvents() {
  const importBtn = $('#discoverImport');
  if (discoverBound) return;
  discoverBound = true;
  importBtn.onclick = async () => {
    const rows = document.querySelectorAll('.discover-item:not(.added)');
    const picked = [];
    for (const r of rows) {
      const cb = r.querySelector('.discover-check');
      if (!cb || !cb.checked) continue;
      const name = r.querySelector('.discover-name').value.trim();
      const url = r.querySelector('.discover-url').value.trim();
      if (!url) continue;
      picked.push({ name, url, icon: '', category: '工具服务' });
    }
    if (!picked.length) { showToast('请先勾选要导入的服务'); return; }
    try {
      const r = await API.importServices(picked);
      state.config = await API.getConfig();
      showToast(`已导入 ${r.added} 个服务`);
      closeDiscover();
      renderApps();
    } catch (e) { showToast('导入失败：' + e.message); }
  };
}
let discoverBound = false;
function closeDiscover() {
  const mask = $('#discoverMask');
  if (mask) mask.classList.add('hidden');
}
function bindDiscoverClose() {
  $('#discoverClose').onclick = closeDiscover;
  $('#discoverCancel').onclick = closeDiscover;
  $('#discoverMask').addEventListener('click', (e) => {
    if (e.target === $('#discoverMask')) closeDiscover();
  });
}

function cleanUrl(u) {
  if (!u) return '未配置地址';
  try { return new URL(u).hostname; } catch (e) { return u; }
}

/* ===== 下载器页 ===== */
async function renderServers() {
  const statsEl = $('#serverStats');
  const cardsEl = $('#serverCards');
  const enabled = state.config.downloaders.filter(d => d.enabled && d.host);
  if (!enabled.length) {
    statsEl.innerHTML = '';
    cardsEl.innerHTML = '<div class="empty-tip">还没有配置下载器，配置后即可实时监控<br><br>' +
      '<button class="btn btn-primary tip-btn" onclick="openEditor(null,\'downloaders\')">+ 添加下载器</button></div>';
    return;
  }
  // 立即显示上次数据（或加载中），避免切换页面时空白闪烁
  if (state.serversCache) {
    statsEl.innerHTML = state.serversCache.stats;
    cardsEl.innerHTML = state.serversCache.cards;
  } else {
    statsEl.innerHTML = '';
    cardsEl.innerHTML = '<div class="empty-tip">正在获取下载器数据…</div>';
  }
  try {
    const data = await API.getDownloaderStatus();
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-label">总下载速率</div><div class="stat-value blue">${fmtSpeed(data.totalDown)}</div></div>
      <div class="stat-card"><div class="stat-label">总上传速率</div><div class="stat-value green">${fmtSpeed(data.totalUp)}</div></div>
      <div class="stat-card"><div class="stat-label">在线 / 离线</div><div class="stat-value small">在线 <span class="stat-value green">${data.online}</span> · 离线 <span class="stat-value orange">${data.offline}</span></div></div>
      <div class="stat-card"><div class="stat-label">累计下载 / 上传</div><div class="stat-value small">${fmtSize(data.totalDownloaded)}<div class="stat-sub">上传 ${fmtSize(data.totalUploaded)}</div></div></div>`;
    cardsEl.innerHTML = '';
    for (const it of data.items) cardsEl.appendChild(serverCard(it));
    state.serversCache = { stats: statsEl.innerHTML, cards: cardsEl.innerHTML, items: data.items };
  } catch (e) {
    statsEl.innerHTML = '';
    cardsEl.innerHTML = `<div class="empty-tip">加载失败：${esc(e.message)}</div>`;
  }
}

function serverCard(it) {
  const typeBadge = it.type === 'transmission' ? 'tr' : 'qb';
  const typeLabel = it.type === 'transmission' ? 'TR' : 'qB';
  const card = el('div', 'monitor-card' + (it.online ? '' : ' offline'));
  card.dataset.dlId = it.id;
  card.innerHTML = `
    <div class="card-head">
      <div class="badge ${typeBadge}">${typeLabel}</div>
      <div>
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub">${esc(it.host)}</div>
      </div>
      <div class="card-version">${esc(it.version || '')}</div>
      <button class="card-edit" title="设置" onclick="editItem('downloaders','${esc(it.id)}')">⚙</button>
      ${it.online
        ? `<span class="dot-online clickable" title="点击刷新" onclick="refreshDownloader('${esc(it.id)}', this)"></span>`
        : `<span class="dot-offline clickable" title="点击刷新" onclick="refreshDownloader('${esc(it.id)}', this)"></span>`}
    </div>
    <div class="metric-row">
      <div class="metric"><div class="metric-label">下载速率</div><div class="metric-value blue">${fmtSpeed(it.downSpeed)}</div></div>
      <div class="metric"><div class="metric-label">上传速率</div><div class="metric-value green">${fmtSpeed(it.upSpeed)}</div></div>
    </div>
    <div class="task-stats">
      <div class="ts">下载中<b>${it.downloading}</b></div>
      <div class="ts">上传中<b>${it.uploading}</b></div>
      <div class="ts">已停止<b>${it.stopped}</b></div>
      <div class="ts">累计上传<b>${fmtSize(it.totalUploaded)}</b></div>
      <div class="ts">累计下载<b>${fmtSize(it.totalDownloaded)}</b></div>
    </div>
    ${it.error ? `<div class="card-error">${esc(it.error)}</div>` : ''}`;
  return card;
}

/* 下载器卡片绿点：点击手动刷新单卡 */
async function refreshDownloader(id, dotEl) {
  if (dotEl && dotEl.classList.contains('loading')) return; // 防连点
  if (dotEl) dotEl.classList.add('loading');
  try {
    const data = await API.getDownloaderStatusOne(id);
    if (!data.ok) throw new Error(data.error || '刷新失败');
    const it = data.item;
    const cache = state.serversCache;
    if (!cache) { renderServers(); return; }
    // 合并到缓存 items 并重算汇总
    const idx = cache.items.findIndex(x => x.id === id);
    if (idx >= 0) cache.items[idx] = it; else cache.items.push(it);
    const online = cache.items.filter(x => x.online);
    cache.stats = `
      <div class="stat-card"><div class="stat-label">总下载速率</div><div class="stat-value blue">${fmtSpeed(cache.items.reduce((s, x) => s + x.downSpeed, 0))}</div></div>
      <div class="stat-card"><div class="stat-label">总上传速率</div><div class="stat-value green">${fmtSpeed(cache.items.reduce((s, x) => s + x.upSpeed, 0))}</div></div>
      <div class="stat-card"><div class="stat-label">在线 / 离线</div><div class="stat-value small">在线 <span class="stat-value green">${online.length}</span> · 离线 <span class="stat-value orange">${cache.items.length - online.length}</span></div></div>
      <div class="stat-card"><div class="stat-label">累计下载 / 上传</div><div class="stat-value small">${fmtSize(online.reduce((s, x) => s + x.totalDownloaded, 0))}<div class="stat-sub">上传 ${fmtSize(online.reduce((s, x) => s + x.totalUploaded, 0))}</div></div></div>`;
    // 只替换这一张卡片，其余不动
    const cardsEl = $('#serverCards');
    const old = cardsEl && cardsEl.querySelector('[data-dl-id="' + CSS.escape(id) + '"]');
    const newCard = serverCard(it);
    if (old && old.parentNode) old.replaceWith(newCard);
    else if (cardsEl) cardsEl.appendChild(newCard);
    cache.cards = cardsEl ? cardsEl.innerHTML : '';
    const statsEl = $('#serverStats');
    if (statsEl) statsEl.innerHTML = cache.stats;
    showToast('「' + it.name + '」已刷新');
  } catch (e) {
    showToast('刷新失败：' + (e.message || '未知错误'));
  } finally {
    if (dotEl) dotEl.classList.remove('loading');
  }
}

/* ===== 站点页 ===== */
async function renderSites() {
  const statsEl = $('#siteStats');
  const cardsEl = $('#siteCards');
  const enabled = state.config.sites.filter(s => s.enabled && (s.mode === 'cookie' ? s.profileUrl : s.apiUrl));
  if (!enabled.length) {
    statsEl.innerHTML = '';
    cardsEl.innerHTML = '<div class="empty-tip">还没有配置 PT 站点，配置后即可实时监控<br><br>' +
      '<button class="btn btn-primary tip-btn" onclick="openEditor(null,\'sites\')">+ 添加站点</button></div>';
    return;
  }
  // 立即显示上次数据（或骨架屏），避免切换页面时空白闪烁
  if (state.siteCache) {
    statsEl.innerHTML = state.siteCache.stats;
    cardsEl.innerHTML = state.siteCache.cards;
  } else {
    // 骨架屏：先出卡片框架，数据回来后填充
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-label">总计上传</div><div class="sk-line w70"></div></div>
      <div class="stat-card"><div class="stat-label">总计下载</div><div class="sk-line w70"></div></div>
      <div class="stat-card"><div class="stat-label">在线 / 离线</div><div class="sk-line w50"></div></div>
      <div class="stat-card"><div class="stat-label">站点总数</div><div class="sk-line w40"></div></div>`;
    cardsEl.innerHTML = '';
    for (const s of enabled) cardsEl.appendChild(siteSkeleton(s));
  }
  try {
    const data = await API.getSiteStatus();
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-label">总计上传</div><div class="stat-value green">${fmtSize(data.totalUploaded)}</div></div>
      <div class="stat-card"><div class="stat-label">总计下载</div><div class="stat-value blue">${fmtSize(data.totalDownloaded)}</div></div>
      <div class="stat-card"><div class="stat-label">在线 / 离线</div><div class="stat-value small">在线 <span class="stat-value green">${data.online}</span> · 离线 <span class="stat-value orange">${data.offline}</span></div></div>
      <div class="stat-card"><div class="stat-label">站点总数</div><div class="stat-value small">${data.items.length}</div></div>`;
    // 分组筛选条（全部 + 各分组），只过滤卡片显示，统计卡保持全量
    renderSiteGroups(data.items);
    const shown = state.siteGroup === '全部' ? data.items : data.items.filter(x => (x.group || '常用') === state.siteGroup);
    cardsEl.innerHTML = '';
    for (const it of shown) cardsEl.appendChild(siteCard(it));
    state.siteCache = { stats: statsEl.innerHTML, cards: cardsEl.innerHTML, items: data.items };
  } catch (e) {
    statsEl.innerHTML = '';
    cardsEl.innerHTML = `<div class="empty-tip">加载失败：${esc(e.message)}</div>`;
  }
}

/* 站点分组筛选条：聚合 items 中的分组并渲染 chips */
function renderSiteGroups(items) {
  const bar = $('#siteGroups');
  if (!bar) return;
  const groups = ['全部'];
  for (const it of items) {
    const g = it.group || '常用';
    if (!groups.includes(g)) groups.push(g);
  }
  bar.innerHTML = '';
  for (const g of groups) {
    const count = g === '全部' ? items.length : items.filter(x => (x.group || '常用') === g).length;
    const chip = el('button', 'group-chip' + (g === state.siteGroup ? ' active' : ''), `${esc(g)} ${count}`);
    chip.onclick = () => {
      state.siteGroup = g;
      const cardsEl = $('#siteCards');
      if (cardsEl) {
        cardsEl.innerHTML = '';
        const shown = g === '全部' ? items : items.filter(x => (x.group || '常用') === g);
        for (const it of shown) cardsEl.appendChild(siteCard(it));
        if (state.siteCache) state.siteCache.cards = cardsEl.innerHTML;
      }
      renderSiteGroups(items);
    };
    bar.appendChild(chip);
  }
  // 分组管理入口（重命名 / 删除已有分组）
  const mgr = el('button', 'group-chip group-mgr-btn', '⚙ 分组管理');
  mgr.title = '重命名 / 删除已有分组';
  mgr.onclick = openGroupManager;
  bar.appendChild(mgr);
}

/* 站点分组管理：重命名 / 删除已有分组（删除后组内站点移入「常用」） */
function openGroupManager() {
  state.editing = null;
  state.editingType = 'sites';
  $('#modalTitle').textContent = '站点分组管理';
  $('#modalMsg').textContent = '';
  $('#modalMsg').style.color = '';
  $('#modalDelete').hidden = true;
  $('#modalTest').hidden = true;
  const items = state.config.sites || [];
  const gOf = (s) => (s.group || '').trim() || '常用';
  const names = [];
  for (const s of items) { const g = gOf(s); if (!names.includes(g)) names.push(g); }
  const body = $('#modalBody');
  body.innerHTML = '';
  const box = el('div', 'group-mgr');
  for (const g of names) {
    const row = el('div', 'group-mgr-row');
    const input = document.createElement('input');
    input.className = 'group-mgr-name';
    input.value = g;
    input.dataset.old = g;
    const count = el('span', 'group-mgr-count', items.filter(s => gOf(s) === g).length + ' 站');
    const delBtn = el('button', 'btn btn-danger btn-sm', '删除');
    delBtn.onclick = () => {
      if (window.confirm(`删除分组「${g}」？该组 ${items.filter(s => gOf(s) === g).length} 个站点将移入「${g === '常用' ? '未分组' : '常用'}」。`)) {
        row.classList.add('removed');
        delBtn.disabled = true;
      }
    };
    row.appendChild(input); row.appendChild(count); row.appendChild(delBtn);
    box.appendChild(row);
  }
  body.appendChild(box);
  $('#modalMask').classList.remove('hidden');
  $('#modalSave').textContent = '保存';
  $('#modalSave').onclick = () => {
    const rows = box.querySelectorAll('.group-mgr-row');
    const map = new Map(); // 旧名 -> 新名
    const dels = new Set(); // 待删除分组
    rows.forEach(r => {
      const old = r.querySelector('input').dataset.old;
      if (r.classList.contains('removed')) { dels.add(old); return; }
      const nv = r.querySelector('input').value.trim();
      if (nv && nv !== old) map.set(old, nv);
    });
    for (const s of items) {
      const g = gOf(s);
      if (dels.has(g)) s.group = g === '常用' ? '未分组' : '常用';
      else if (map.has(g)) s.group = map.get(g);
    }
    closeModal();
    // 本地同步分组显示（不整页重抓，避免与保存的竞态导致旧分组闪现）
    const cache = state.siteCache;
    if (cache && cache.items) {
      for (const it of cache.items) {
        const g = (it.group || '').trim() || '常用';
        if (dels.has(g)) it.group = g === '常用' ? '未分组' : '常用';
        else if (map.has(g)) it.group = map.get(g);
      }
      renderSiteGroups(cache.items);
      const cardsEl = $('#siteCards');
      if (cardsEl) {
        cardsEl.innerHTML = '';
        const shown = state.siteGroup === '全部' ? cache.items : cache.items.filter(x => (x.group || '常用') === state.siteGroup);
        for (const it of shown) cardsEl.appendChild(siteCard(it));
        cache.cards = cardsEl.innerHTML;
      }
    } else {
      state.siteCache = null;
      renderSites();
    }
    autoSave(true).then(() => showToast('分组已更新并保存'));
  };
  $('#modalCancel').hidden = false;
  $('#modalCancel').onclick = closeModal;
  $('#modalClose').onclick = closeModal;
}

/* 顶栏「连接状态」总览：版本 / 下载器 / 影视墙 / Docker / 站点缓存统计（不触发抓站） */
async function openConnPanel() {
  $('#modalTitle').textContent = '连接状态';
  $('#modalMsg').textContent = '';
  $('#modalMsg').style.color = '';
  $('#modalDelete').hidden = true;
  $('#modalTest').hidden = true;
  const body = $('#modalBody');
  body.innerHTML = '<div class="conn-loading">正在检测各服务状态…</div>';
  $('#modalMask').classList.remove('hidden');
  $('#modalSave').textContent = '刷新';
  $('#modalSave').onclick = openConnPanel;
  $('#modalCancel').hidden = false;
  $('#modalCancel').onclick = closeModal;
  $('#modalClose').onclick = closeModal;
  try {
    const r = await API.getOverviewStatus();
    renderConnPanel(body, r);
  } catch (e) {
    body.innerHTML = '<div class="empty-tip">检测失败：' + esc(e.message) + '</div>';
  }
}

function renderConnPanel(body, r) {
  const fmtTime = t => t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新' : '尚无数据';
  const dl = r.downloaders || { total: 0, online: 0, items: [] };
  const dlState = dl.total === 0 ? 'muted' : (dl.online === dl.total ? 'ok' : (dl.online > 0 ? 'warn' : 'bad'));
  const dlDetail = (dl.items || []).map(d =>
    `<div class="conn-dl"><span class="dot-mini ${d.online ? 'ok' : 'bad'}"></span>${esc(d.name)} <span class="conn-sub">${d.online ? '在线' : esc(d.error || '离线')}</span></div>`).join('');
  const media = r.media || {};
  const docker = r.docker || {};
  const mp = r.mp || {};
  const sites = r.sites || {};
  const rows = [
    ['面板版本', `<span class="pill ok">v${esc(r.version || '')}</span>`],
    ['下载器', `<span class="pill ${dlState}">${dl.online} / ${dl.total} 在线</span>${dlDetail ? '<div class="conn-sub" style="margin-top:4px">' + dlDetail + '</div>' : ''}`],
    ['影视墙', media.configured
      ? `<span class="pill ${media.connected ? 'ok' : 'bad'}">${media.connected ? '已连接' : '未连接'}</span>${media.error ? '<div class="conn-err">' + esc(media.error) + '</div>' : ''}`
      : '<span class="pill muted">未配置</span>'],
    ['Docker 监控', !docker.enabled
      ? '<span class="pill muted">未启用</span>'
      : `<span class="pill ${docker.connected ? 'ok' : 'bad'}">${docker.connected ? docker.containers + ' 个容器' : '连接失败'}</span>`],
    ['MoviePilot', !mp.enabled
      ? '<span class="pill muted">未启用</span>'
      : `<span class="pill ${mp.connected ? 'ok' : 'bad'}">${mp.connected ? '已连接' + (mp.version ? ' · v' + esc(mp.version) : '') : '连接失败'}</span>${mp.error ? '<div class="conn-err">' + esc(mp.error) + '</div>' : ''}`],
    ['站点状态', `<span class="pill ${sites.failed > 0 ? 'warn' : 'ok'}">${sites.online || 0} / ${sites.enabled} 在线 · ${sites.cached} 有缓存</span>
      ${sites.failed > 0 ? '<div class="conn-err">' + (sites.failList || []).map(f => esc(f.name) + '：' + esc(f.error)).join('；') + '</div>' : ''}
      <div class="conn-sub" style="margin-top:4px">每 ${sites.refreshSec || 60}s 自动刷新 · 上次抓取 ${fmtTime(sites.lastFetchAt)} · 缓存期内刷新页面/切页不会访问站点</div>`]
  ];
  body.innerHTML = '<div class="conn-panel">' + rows.map(([k, v]) =>
    `<div class="conn-row"><div class="conn-key">${k}</div><div class="conn-val">${v}</div></div>`).join('') + '</div>';
}

/* 站点图标 HTML：自定义 URL/data 优先，留空自动获取 favicon；加载失败回退徽标文字 */
function siteIconHtml(it, badgeCls) {
  const s = (state.config.sites || []).find(x => x.id === it.id);
  const icon = s && s.icon;
  const badge = `<div class="badge ${badgeCls}">${esc(it.badge || 'NP')}</div>`;
  const src = (icon && (icon.startsWith('http') || icon.startsWith('data:')))
    ? icon
    : '/api/site/favicon/' + encodeURIComponent(it.id); // 空 = 自动获取站点 favicon
  // onerror 里先抓住父节点再移除自己：this.remove() 之后 this.parentNode 已经是 null，
  // 旧写法会在查询 .badge 时抛异常，导致回退徽标永远不显示
  return `<div class="site-icon-box">
    <img class="site-icon" src="${esc(src)}" alt="" loading="lazy" onerror="var p=this.parentNode;this.remove();if(p){var b=p.querySelector('.badge');if(b)b.style.display='inline-flex';}">
    <div class="badge ${badgeCls}" style="display:none">${esc(it.badge || 'NP')}</div>
  </div>`;
}

function siteCard(it) {
  const badgeCls = (it.badge || '').toLowerCase() === 'api' ? 'api' : 'np';
  const card = el('div', 'monitor-card' + (it.online ? '' : ' offline'));
  card.setAttribute('data-site-id', it.id);
  if (state.sortMode) card.setAttribute('draggable', 'true');
  const visitLink = it.visitUrl
    ? `<a class="card-link" href="${esc(it.visitUrl)}" target="_blank" rel="noopener" title="打开站点">↗ 打开</a>`
    : '';
  const dot = it.online
    ? `<span class="dot-online clickable" title="点击手动刷新" onclick="refreshSite('${esc(it.id)}', this)"></span>`
    : `<span class="dot-offline clickable" title="点击重试刷新" onclick="refreshSite('${esc(it.id)}', this)"></span>`;
  const grip = state.sortMode ? '<span class="card-grip" title="拖动排序">⠿</span>' : '';
  card.innerHTML = `
    <div class="card-head">
      ${grip}
      ${siteIconHtml(it, badgeCls)}
      <div>
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub">${esc(it.account || '未识别账号')}</div>
      </div>
      ${visitLink}
      <button class="card-edit" title="设置" onclick="editItem('sites','${esc(it.id)}')">⚙</button>
      ${dot}
    </div>
    <div class="metric-row">
      <div class="metric"><div class="metric-label">分享率</div><div class="site-ratio">${it.ratio != null ? it.ratio.toFixed(2) : '--'}</div></div>
      <div class="metric"><div class="metric-label">积分</div><div class="metric-value orange">${fmtNum(it.bonus)}</div></div>
    </div>
    <div class="task-stats">
      <div class="ts">累计上传<b>${fmtSize(it.uploaded)}</b></div>
      <div class="ts">累计下载<b>${fmtSize(it.downloaded)}</b></div>
      <div class="ts">做种<b>${it.seeding}</b></div>
      <div class="ts">下载<b>${it.leeching}</b></div>
      <div class="ts">状态<b>${it.online ? '在线' : '离线'}</b></div>
    </div>
    ${it.error ? `<div class="card-error">${esc(it.error)}</div>` : ''}`;
  return card;
}

/* 站点骨架卡片：先出框架，数据返回后替换为真实卡片 */
function siteSkeleton(it) {
  const card = el('div', 'monitor-card skeleton');
  card.innerHTML = `
    <div class="card-head">
      ${siteIconHtml(it, 'np')}
      <div>
        <div class="card-title">${esc(it.name)}</div>
        <div class="card-sub"><span class="sk-line w50"></span></div>
      </div>
      <span class="dot-loading" title="获取中"></span>
    </div>
    <div class="metric-row">
      <div class="metric"><div class="metric-label">分享率</div><div class="sk-line w40"></div></div>
      <div class="metric"><div class="metric-label">积分</div><div class="sk-line w50"></div></div>
    </div>
    <div class="task-stats">
      <div class="ts">累计上传<div class="sk-line w60"></div></div>
      <div class="ts">累计下载<div class="sk-line w60"></div></div>
      <div class="ts">做种<div class="sk-line w30"></div></div>
      <div class="ts">下载<div class="sk-line w30"></div></div>
      <div class="ts">状态<div class="sk-line w40"></div></div>
    </div>`;
  return card;
}

/* 绿点点击：手动刷新单个站点（与自动刷新并存，不互相干扰） */
async function refreshSite(id, dotEl) {
  if (dotEl && dotEl.classList.contains('loading')) return; // 防连点
  if (dotEl) dotEl.classList.add('loading');
  try {
    const data = await API.getSiteStatusOne(id);
    if (!data.ok) throw new Error(data.error || '刷新失败');
    const it = data.item;
    const cache = state.siteCache;
    if (!cache) { renderSites(); return; }
    // 更新缓存中的站点数据
    const idx = cache.items.findIndex(x => x.id === id);
    if (idx >= 0) cache.items[idx] = it; else cache.items.push(it);
    // 重算汇总统计
    const online = cache.items.filter(x => x.online);
    cache.stats = `
      <div class="stat-card"><div class="stat-label">总计上传</div><div class="stat-value green">${fmtSize(online.reduce((s, x) => s + (x.uploaded || 0), 0))}</div></div>
      <div class="stat-card"><div class="stat-label">总计下载</div><div class="stat-value blue">${fmtSize(online.reduce((s, x) => s + (x.downloaded || 0), 0))}</div></div>
      <div class="stat-card"><div class="stat-label">在线 / 离线</div><div class="stat-value small">在线 <span class="stat-value green">${online.length}</span> · 离线 <span class="stat-value orange">${cache.items.length - online.length}</span></div></div>
      <div class="stat-card"><div class="stat-label">站点总数</div><div class="stat-value small">${cache.items.length}</div></div>`;
    // 只替换这一张卡片，其余卡片不动
    const cardsEl = $('#siteCards');
    const old = cardsEl && cardsEl.querySelector('[data-site-id="' + CSS.escape(id) + '"]');
    const newCard = siteCard(it);
    if (old && old.parentNode) old.replaceWith(newCard);
    else if (cardsEl && (state.siteGroup === '全部' || (it.group || '常用') === state.siteGroup)) cardsEl.appendChild(newCard);
    cache.cards = cardsEl ? cardsEl.innerHTML : '';
    const statsEl = $('#siteStats');
    if (statsEl) statsEl.innerHTML = cache.stats;
    showToast('「' + it.name + '」已刷新');
  } catch (e) {
    showToast('刷新失败：' + (e.message || '未知错误'));
  } finally {
    if (dotEl) dotEl.classList.remove('loading');
  }
}

/* ===== 设置页 ===== */
function renderSettings() {
  // 分区面板显示同步（默认 system）
  const tab = state.activeTab || 'system';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['system', 'theme', 'backup'].forEach(t => {
    const pane = $('#pane-' + t);
    if (pane) pane.classList.toggle('hidden', t !== tab);
  });
  // 全局刷新间隔回填
  const ui = state.config.ui || {};
  const dl = $('#f_dlRefresh');
  const st = $('#f_siteRefresh');
  if (dl) dl.value = ui.downloaderRefreshSec || 15;
  if (st) st.value = ui.siteRefreshSec || 60;
  // 飞牛影视配置回填
  const ms = state.config.mediaServer || {};
  const me = $('#f_mediaEnabled');
  if (me) me.checked = !!ms.enabled;
  const mu = $('#f_mediaUrl');
  if (mu) mu.value = ms.baseUrl || '';
  const mus = $('#f_mediaUser');
  if (mus) mus.value = ms.username || '';
  const mp = $('#f_mediaPass');
  if (mp) mp.value = '';
  // 主题回填
  renderThemeUI();
  // Docker 配置回填
  const dc = state.config.docker || {};
  const de = $('#f_dockerEnabled');
  if (de) de.checked = !!dc.enabled;
  const du = $('#f_dockerUrl');
  if (du) du.value = dc.baseUrl || '';
  const da = $('#f_dockerAllowActions');
  if (da) da.checked = !!dc.allowActions;
  const sc = $('#f_siteCacheSec');
  if (sc) sc.value = (state.config.ui && state.config.ui.siteCacheSec) || 300;
  // MoviePilot 配置回填
  const mpc = state.config.moviePilot || {};
  const mpe = $('#f_mpEnabled');
  if (mpe) mpe.checked = !!mpc.enabled;
  const mpur = $('#f_mpUrl');
  if (mpur) mpur.value = mpc.baseUrl || '';
  const mpt = $('#f_mpToken');
  if (mpt) mpt.value = '';
  const mpr = $('#mpTestResult');
  if (mpr) mpr.textContent = '';
  // 标记：设置页表单已按真实配置回填，此后 autoSave 才能安全读取这些 DOM 值
  state.settingsReady = true;
  // Docker 首页组件配置（异步加载，不阻塞设置页）
  loadDockerCompList();
}

/* Docker 首页组件配置（设置页）：开关 + 拖拽排序，改完自动保存 */
let _dragCompId = null;
async function loadDockerCompList() {
  const box = $('#dockerCompList');
  if (!box) return;
  const dc = state.config.docker || {};
  if (!dc.enabled) {
    box.innerHTML = `<div class="docker-note">启用 Docker 容器监控后，这里可配置首页显示哪些 Docker 组件及其顺序。</div>`;
    return;
  }
  const order = dockerCompOrder();
  const onRows = order.map((id, i) => {
    const c = DOCKER_COMPS.find(x => x.id === id);
    if (!c) return '';
    return `<div class="docker-comp-row" draggable="true" data-id="${c.id}"
        ondragstart="dragCompStart(event)" ondragover="dragCompOver(event)"
        ondrop="dragCompDrop(event)" ondragend="dragCompEnd(event)">
      <span class="docker-comp-rank">${i + 1}</span>
      <span class="docker-comp-handle">⋮⋮</span>
      <label class="switch"><input type="checkbox" checked onchange="toggleDockerComp('${c.id}', this.checked)"><span class="slider"></span></label>
      <div class="docker-comp-info">
        <div class="docker-comp-name">${esc(c.label)}</div>
        <div class="docker-comp-desc">${esc(c.desc)}</div>
      </div>
    </div>`;
  }).join('');
  const offComps = DOCKER_COMPS.filter(c => !order.includes(c.id));
  const offRows = offComps.map(c =>
    `<div class="docker-comp-row off">
      <span class="docker-comp-rank">–</span>
      <span class="docker-comp-handle">⋮⋮</span>
      <label class="switch"><input type="checkbox" onchange="toggleDockerComp('${c.id}', this.checked)"><span class="slider"></span></label>
      <div class="docker-comp-info">
        <div class="docker-comp-name">${esc(c.label)}</div>
        <div class="docker-comp-desc">${esc(c.desc)}（首页不显示）</div>
      </div>
    </div>`).join('');
  box.innerHTML = onRows
    + (offRows ? `<div class="docker-note">已关闭的组件（首页不显示，勾选即重新启用并排到末尾）：</div>` + offRows : '')
    + `<div class="docker-comp-ops-foot"><button class="btn btn-sm" onclick="resetDockerComps()">恢复默认顺序</button></div>`;
}

/* 开关组件：勾选 = 追加到列表末尾，取消 = 从列表移除 */
function toggleDockerComp(id, on) {
  if (!state.config.docker) state.config.docker = {};
  const cur = dockerCompOrder();
  const idx = cur.indexOf(id);
  if (on && idx === -1) cur.push(id);
  if (!on && idx !== -1) cur.splice(idx, 1);
  state.config.docker.homeComps = cur;
  autoSave(true);
  loadDockerCompList();
}

/* 拖拽排序 */
function dragCompStart(e) {
  const row = e.target.closest('.docker-comp-row');
  if (!row) return;
  _dragCompId = row.dataset.id;
  row.classList.add('dragging');
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragCompId); } catch (err) { /* Firefox 必需 setData */ }
}
function dragCompOver(e) {
  if (!_dragCompId) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
  document.querySelectorAll('#dockerCompList .docker-comp-row').forEach(r =>
    r.classList.remove('drop-before', 'drop-after'));
  const row = e.target.closest('.docker-comp-row');
  if (!row || row.dataset.id === _dragCompId) return;
  const rect = row.getBoundingClientRect();
  row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
}
function dragCompDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.docker-comp-row');
  if (!target || !_dragCompId || target.dataset.id === _dragCompId) return;
  const cur = dockerCompOrder();
  const from = cur.indexOf(_dragCompId);
  if (from === -1) return;
  cur.splice(from, 1);
  const rect = target.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  const insertAt = cur.indexOf(target.dataset.id);
  cur.splice(insertAt === -1 ? cur.length : (before ? insertAt : insertAt + 1), 0, _dragCompId);
  state.config.docker.homeComps = cur;
  autoSave(true);
  loadDockerCompList();
}
function dragCompEnd(e) {
  document.querySelectorAll('#dockerCompList .docker-comp-row').forEach(r =>
    r.classList.remove('dragging', 'drop-before', 'drop-after'));
  _dragCompId = null;
}

/* 恢复默认组件顺序 */
function resetDockerComps() {
  state.config.docker.homeComps = DOCKER_COMPS.map(c => c.id);
  autoSave(true);
  loadDockerCompList();
  showToast('已恢复默认组件顺序');
}

/* 主题 UI 同步（模式 + 强调色 + 密度 + 圆角 + 背景 + 动效） */
function renderThemeUI() {
  const t = (state.config.ui && state.config.ui.theme) || {};
  const mode = t.mode === 'light' ? 'light' : 'dark';
  document.querySelectorAll('#themeModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  const accent = t.accent || '#4ea1ff';
  document.querySelectorAll('#themeSwatches .swatch').forEach(w =>
    w.classList.toggle('active', w.dataset.color === accent));
  const cu = $('#themeAccentCustom');
  if (cu) {
    cu.value = accent;
    cu.classList.toggle('active', !['#4ea1ff', '#a855f7', '#f59e0b', '#34d399', '#ec4899'].includes(accent));
  }
  const density = t.density || 'normal';
  document.querySelectorAll('#themeDensitySeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.density === density));
  const radius = t.radius || 'medium';
  document.querySelectorAll('#themeRadiusSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.radius === radius));
  const bg = t.bg || 'gradient';
  document.querySelectorAll('#themeBgSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.bg === bg));
  const anim = t.anim === false ? 'off' : 'on';
  document.querySelectorAll('#themeAnimSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.anim === anim));
  // 输入框只回填外链；本地上传的图片由独立接口提供，输入框留空并给出提示
  const bi = $('#f_themeBgImage');
  if (bi) bi.value = (t.bgImage && /^https?:\/\//i.test(t.bgImage)) ? t.bgImage : '';
  const hint = $('#themeBgUploadedHint');
  if (hint) hint.hidden = !(t.hasBgImage && !(t.bgImage && /^https?:\/\//i.test(t.bgImage)));
}

/* 应用主题到界面（body 属性 + CSS 变量 + 自定义背景图），页面加载与切换时调用 */
function applyTheme() {
  const t = (state.config.ui && state.config.ui.theme) || {};
  const mode = t.mode === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = mode;
  document.documentElement.style.setProperty('--accent', t.accent || '#4ea1ff');
  document.body.dataset.density = t.density || 'normal';
  document.body.dataset.radius = t.radius || 'medium';
  document.body.dataset.bg = t.bg || 'gradient';
  document.body.dataset.anim = t.anim === false ? 'off' : 'on';
  // 背景图来源：http(s) 外链直接用；本地上传的图存服务端独立文件，走 /api/theme/bg
  const bgUrl = themeBgUrl();
  if (bgUrl) {
    // 叠加半透明遮罩（深色/浅色自适应）保证文字可读
    const overlay = mode === 'light' ? 'rgba(242,244,248,.72)' : 'rgba(14,17,22,.78)';
    document.body.style.backgroundImage = `linear-gradient(${overlay}, ${overlay}), url("${bgUrl.replace(/"/g, '\\"')}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else {
    document.body.style.backgroundImage = '';
    document.body.style.backgroundSize = '';
    document.body.style.backgroundPosition = '';
    document.body.style.backgroundAttachment = '';
    document.body.style.backgroundRepeat = '';
  }
}

/* 当前生效的背景图地址：外链优先，其次服务端上传的图片（带版本号防缓存） */
function themeBgUrl() {
  const t = (state.config.ui && state.config.ui.theme) || {};
  if (t.bgImage && /^https?:\/\//i.test(t.bgImage)) return t.bgImage;
  if (t.hasBgImage) return '/api/theme/bg?v=' + (state.bgVersion || '1');
  return '';
}

/* 设置页只保留系统设置 / 主题 / 备份恢复（服务管理已移至「服务」页） */

function bindSettingsEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      state.activeTab = btn.dataset.tab;
      try { localStorage.setItem('nas-nav-settings-tab', state.activeTab); } catch (e) { /* ignore */ }
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      // 分区面板切换显示
      ['system', 'theme', 'backup'].forEach(t => {
        const pane = $('#pane-' + t);
        if (pane) pane.classList.toggle('hidden', t !== state.activeTab);
      });
    };
  });
  // 下载器页 / 站点页：配置入口移入各自页面
  const dlAdd = $('#dlAddBtn');
  if (dlAdd) dlAdd.onclick = () => openEditor(null, 'downloaders');
  const siteAdd = $('#siteAddBtn');
  if (siteAdd) siteAdd.onclick = () => openEditor(null, 'sites');
  const siteImport = $('#siteImportBtn');
  if (siteImport) siteImport.onclick = openImportModal;
  const siteSort = $('#siteSortBtn');
  if (siteSort) siteSort.onclick = toggleSortMode;
  // 刷新间隔 / 缓存时长输入：防抖自动保存
  ['f_dlRefresh', 'f_siteRefresh', 'f_siteCacheSec'].forEach(id => {
    const inp = $('#' + id);
    if (!inp) return;
    inp.addEventListener('input', () => {
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 500);
    });
  });
  // 飞牛影视配置：防抖自动保存（改完即生效，无需点保存）
  ['f_mediaEnabled', 'f_mediaUrl', 'f_mediaUser', 'f_mediaPass'].forEach(id => {
    const inp = $('#' + id);
    if (!inp) return;
    const evt = inp.type === 'checkbox' ? 'change' : 'input';
    inp.addEventListener(evt, () => {
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 600);
    });
  });
  // 主题模式分段按钮
  document.querySelectorAll('#themeModeSeg .seg-btn').forEach(btn => {
    btn.onclick = () => {
      state.config.ui = state.config.ui || {};
      state.config.ui.theme = state.config.ui.theme || {};
      state.config.ui.theme.mode = btn.dataset.mode;
      applyTheme();
      renderThemeUI();
      autoSave(true);
    };
  });
  // 强调色色板
  document.querySelectorAll('#themeSwatches .swatch').forEach(w => {
    w.onclick = () => {
      state.config.ui = state.config.ui || {};
      state.config.ui.theme = state.config.ui.theme || {};
      state.config.ui.theme.accent = w.dataset.color;
      applyTheme();
      renderThemeUI();
      autoSave(true);
    };
  });
  // 自定义强调色（取色器）
  const customAccent = $('#themeAccentCustom');
  if (customAccent) {
    customAccent.addEventListener('input', () => {
      state.config.ui = state.config.ui || {};
      state.config.ui.theme = state.config.ui.theme || {};
      state.config.ui.theme.accent = customAccent.value;
      applyTheme();
      renderThemeUI();
      autoSave(true);
    });
  }
  // 主题扩展分段：密度 / 圆角 / 背景 / 动效
  const bindSeg = (segSel, attr, storeKey, apply) => {
    const seg = $(segSel);
    if (!seg) return;
    seg.querySelectorAll('.seg-btn').forEach(b => {
      b.onclick = () => {
        state.config.ui = state.config.ui || {};
        state.config.ui.theme = state.config.ui.theme || {};
        state.config.ui.theme[storeKey] = b.dataset[attr];
        applyTheme();
        renderThemeUI();
        autoSave(true);
      };
    });
  };
  bindSeg('#themeDensitySeg', 'density', 'density');
  bindSeg('#themeRadiusSeg', 'radius', 'radius');
  bindSeg('#themeBgSeg', 'bg', 'bg');
  // 动效：存布尔值（应用与后端归一均按 false 判断）
  const animSeg = $('#themeAnimSeg');
  if (animSeg) {
    animSeg.querySelectorAll('.seg-btn').forEach(b => {
      b.onclick = () => {
        state.config.ui = state.config.ui || {};
        state.config.ui.theme = state.config.ui.theme || {};
        state.config.ui.theme.anim = b.dataset.anim !== 'off';
        applyTheme();
        renderThemeUI();
        autoSave(true);
      };
    });
  }
  // Docker 监控配置：防抖自动保存
  ['f_dockerEnabled', 'f_dockerUrl'].forEach(id => {
    const inp = $('#' + id);
    if (!inp) return;
    const evt = inp.type === 'checkbox' ? 'change' : 'input';
    inp.addEventListener(evt, () => {
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 600);
    });
  });
  // 允许容器启停：二次确认，避免误触后把 NAS 上的服务停掉
  const allowAct = $('#f_dockerAllowActions');
  if (allowAct) {
    allowAct.addEventListener('change', () => {
      if (allowAct.checked) {
        const ok = window.confirm(
          '开启后，首页的 Docker 容器卡片会出现「启动 / 停止 / 重启 / 暂停」按钮。\n\n' +
          '停止容器会立即中断该服务（如 qBittorrent、MoviePilot、甚至本面板自身）的所有连接。\n\n确定要开启吗？'
        );
        if (!ok) { allowAct.checked = false; return; }
      }
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 200);
    });
  }
  // MoviePilot 配置：防抖自动保存
  ['f_mpEnabled', 'f_mpUrl', 'f_mpToken'].forEach(id => {
    const inp = $('#' + id);
    if (!inp) return;
    const evt = inp.type === 'checkbox' ? 'change' : 'input';
    inp.addEventListener(evt, () => {
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 600);
    });
  });
  // MoviePilot 连接测试
  const btnMpTest = $('#btnMpTest');
  if (btnMpTest) {
    btnMpTest.onclick = async () => {
      const r = $('#mpTestResult');
      if (r) r.textContent = '测试中…';
      btnMpTest.disabled = true;
      try {
        const res = await API.getMpStatus();
        if (res && res.connected) {
          const ver = res.version ? 'v' + res.version : '';
          if (r) r.textContent = `✓ 连接成功${ver ? '（' + ver + '）' : ''}${res.hostname ? ' · ' + res.hostname : ''}`;
          r && r.classList.add('ok');
        } else {
          if (r) r.textContent = '✗ ' + ((res && res.error) || '连接失败');
          r && r.classList.remove('ok');
        }
      } catch (e) {
        if (r) r.textContent = '✗ ' + e.message;
        r && r.classList.remove('ok');
      } finally {
        btnMpTest.disabled = false;
      }
    };
  }
  // 背景图片：URL 输入（防抖保存）+ 本地上传（canvas 压缩转 dataURL）+ 清除
  const bgInput = $('#f_themeBgImage');
  if (bgInput) {
    bgInput.addEventListener('input', () => {
      state.config.ui = state.config.ui || {};
      state.config.ui.theme = state.config.ui.theme || {};
      state.config.ui.theme.bgImage = bgInput.value.trim();
      applyTheme(); // 即时预览
      clearTimeout(autoSave._t);
      autoSave._t = setTimeout(() => autoSave(true), 600);
    });
  }
  const btnUp = $('#btnBgUpload');
  const bgFile = $('#bgFileInput');
  if (btnUp && bgFile) {
    btnUp.onclick = () => bgFile.click();
    bgFile.onchange = () => {
      const f = bgFile.files && bgFile.files[0];
      if (!f) return;
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = async () => {
        URL.revokeObjectURL(url);
        try {
          // 压缩：最长边 2560，JPEG 0.82；超过 3MB 再降一档画质
          const MAX = 2560;
          let w = img.width, h = img.height;
          if (Math.max(w, h) > MAX) {
            const k = MAX / Math.max(w, h);
            w = Math.round(w * k); h = Math.round(h * k);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          let dataUrl = cv.toDataURL('image/jpeg', 0.82);
          if (dataUrl.length > 3000000) dataUrl = cv.toDataURL('image/jpeg', 0.6);
          // 走独立接口上传：不再把 base64 塞进 config.json（那会超过 JSON 体积上限并拖慢每次保存）
          await API.uploadThemeBg(dataUrl);
          state.config.ui = state.config.ui || {};
          state.config.ui.theme = state.config.ui.theme || {};
          state.config.ui.theme.bgImage = '';      // 上传的图不带外链
          state.config.ui.theme.hasBgImage = true;
          state.bgVersion = String(Date.now());    // 换图后 URL 变，绕过浏览器长缓存
          const bi = $('#f_themeBgImage');
          if (bi) bi.value = '';
          applyTheme();
          renderThemeUI();
          await autoSave(true);                     // 把"外链置空"同步到配置，避免旧外链盖住新图
          showToast('背景已更新');
        } catch (e) {
          showToast('背景设置失败：' + e.message);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); showToast('无法读取该图片'); };
      img.src = url;
      bgFile.value = '';
    };
  }
  const btnClr = $('#btnBgClear');
  if (btnClr) {
    btnClr.onclick = async () => {
      try {
        await API.clearThemeBg();
      } catch (e) { /* 文件本来就不存在也继续清理前端状态 */ }
      state.config.ui = state.config.ui || {};
      state.config.ui.theme = state.config.ui.theme || {};
      state.config.ui.theme.bgImage = '';
      state.config.ui.theme.hasBgImage = false;
      state.bgVersion = null;
      state._bgClear = true;   // 告诉后端"显式清空"，否则空串会被当成"未修改"
      const bi = $('#f_themeBgImage');
      if (bi) bi.value = '';
      applyTheme();
      renderThemeUI();
      await autoSave(true);
      showToast('背景已清除');
    };
  }
  // 备份导出
  const btnBak = $('#btnBackup');
  if (btnBak) btnBak.onclick = async () => {
    try {
      const blob = await API.exportConfig();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = 'nas-nav-backup-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      showToast('备份已导出');
    } catch (e) {
      showToast('导出失败：' + e.message);
    }
  };
  // 恢复：选择文件 → 读取 → 预览确认 → 提交
  const btnRes = $('#btnRestore');
  const fileInput = $('#restoreFile');
  if (btnRes && fileInput) {
    btnRes.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object' || !Array.isArray(obj.services)) {
          throw new Error('不是有效的备份文件（缺少 services 列表）');
        }
        const msg = `确认恢复该备份？\n\n服务 ${(obj.services || []).length} 个 · 下载器 ${(obj.downloaders || []).length} 个 · 站点 ${(obj.sites || []).length} 个\n\n恢复将覆盖当前全部配置；恢复前会自动备份当前配置到 config.restore-时间戳.json，可手动找回。`;
        if (!window.confirm(msg)) { fileInput.value = ''; return; }
        const r = await API.restoreConfig(obj);
        showToast('恢复成功：' + r.services + ' 服务 / ' + r.sites + ' 站点 / ' + r.downloaders + ' 下载器');
        state.config = await API.getConfig();
        applyTheme();
        renderSettings();
        if (state.view === 'home') renderHome();
      } catch (e) {
        showToast('恢复失败：' + e.message);
      }
      fileInput.value = '';
    };
  }
  // 服务管理已移至「服务」页（新增/发现/搜索/编辑/删除），设置页不再绑定服务列表事件
}

/* ===== 站点页拖拽整理 ===== */
let dragSiteId = null;

function toggleSortMode() {
  state.sortMode = !state.sortMode;
  const btn = $('#siteSortBtn');
  const hint = $('#siteSortHint');
  if (btn) {
    btn.classList.toggle('btn-primary', state.sortMode);
    btn.textContent = state.sortMode ? '✓ 完成整理' : '整理排序';
  }
  if (hint) hint.textContent = state.sortMode
    ? '拖动卡片调整顺序，松手自动保存'
    : '点「整理排序」后拖动卡片调整顺序，自动保存';
  // 用缓存的站点数据重建卡片（不能直接用旧 innerHTML：旧卡片没有拖拽手柄，会等不到手柄出现）
  const cache = state.siteCache;
  if (cache && cache.items) {
    const cardsEl = $('#siteCards');
    if (cardsEl) {
      cardsEl.innerHTML = '';
      const shown = state.siteGroup === '全部' ? cache.items : cache.items.filter(x => (x.group || '常用') === state.siteGroup);
      for (const it of shown) cardsEl.appendChild(siteCard(it));
      cache.cards = cardsEl.innerHTML;
    }
  } else {
    renderSites();
  }
}

function bindSiteDrag() {
  const cardsEl = $('#siteCards');
  if (!cardsEl) return;
  cardsEl.addEventListener('dragstart', (e) => {
    if (!state.sortMode) { e.preventDefault(); return; }
    const card = e.target.closest('.monitor-card[data-site-id]');
    if (!card) { e.preventDefault(); return; }
    dragSiteId = card.dataset.siteId;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragSiteId); } catch (err) { /* ignore */ }
  });
  cardsEl.addEventListener('dragend', (e) => {
    const card = e.target.closest('.monitor-card');
    if (card) card.classList.remove('dragging');
  });
  cardsEl.addEventListener('dragover', (e) => {
    if (!state.sortMode || !dragSiteId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.monitor-card[data-site-id]');
    if (!target || target.dataset.siteId === dragSiteId) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const dragged = cardsEl.querySelector('.dragging');
    if (!dragged) return;
    // 已在目标位置则跳过，避免高频 dragover 反复移动 DOM 造成拖拽卡顿
    const sibling = after ? target.nextElementSibling : target.previousElementSibling;
    if (sibling === dragged || target === dragged) return;
    if (after) target.after(dragged);
    else target.before(dragged);
  });
  cardsEl.addEventListener('drop', async (e) => {
    if (!state.sortMode) return;
    e.preventDefault();
    const ids = Array.from(cardsEl.querySelectorAll('.monitor-card[data-site-id]')).map(c => c.dataset.siteId);
    if (!ids.length) return;
    // 本地 config 顺序同步
    const map = new Map(state.config.sites.map(s => [s.id, s]));
    state.config.sites = ids.map(id => map.get(id)).filter(Boolean)
      .concat(state.config.sites.filter(s => !ids.includes(s.id)));
    if (state.siteCache) state.siteCache.cards = cardsEl.innerHTML;
    try {
      await API.reorderSites(ids);
      showToast('站点顺序已保存');
    } catch (err) {
      showToast('保存顺序失败：' + (err.message || '未知错误'));
    }
  });
}

/* 站点分组候选：预置 常用/不常用 + 配置中已存在的所有自定义分组 */
function siteGroupOptions() {
  const set = ['常用', '不常用'];
  for (const s of state.config.sites || []) {
    const g = (s.group || '').trim();
    if (g && !set.includes(g)) set.push(g);
  }
  return set;
}

/* 卡片右上角 ⚙：编辑该下载器/站点（设置入口移入各自页面） */
function editItem(type, id) {
  const item = (state.config[type] || []).find(x => x.id === id);
  openEditor(item, type);
}

/* ===== 编辑弹窗 ===== */
const CATEGORIES = ['下载管理', '媒体影音', '文件管理', '工具服务', '其他'];

function openEditor(item, type) {
  const tab = type || state.activeTab || 'services';
  state.editing = item ? JSON.parse(JSON.stringify(item)) : null;
  state.editingType = tab;
  $('#modalTitle').textContent = (item ? '编辑' : '新增') + (tab === 'downloaders' ? '下载器' : tab === 'sites' ? '站点' : '服务');
  $('#modalMsg').textContent = '';
  $('#modalTest').hidden = true;

  const body = $('#modalBody');
  body.innerHTML = '';
  let fields = '';

  if (tab === 'downloaders') {
    fields = `
      <div class="form-field"><label>名称</label><input id="f_name" placeholder="如：NC盒子" value="${esc(item ? item.name : '')}"></div>
      <div class="form-field"><label>类型</label>
        <select id="f_type">
          <option value="qbittorrent" ${item && item.type === 'transmission' ? '' : 'selected'}>qBittorrent</option>
          <option value="transmission" ${item && item.type === 'transmission' ? 'selected' : ''}>Transmission</option>
        </select></div>
      <div class="form-field full"><label>WebUI 地址</label><input id="f_host" placeholder="http://192.168.1.100:8080" value="${esc(item ? item.host : '')}">
        <span class="hint">下载器 WebUI 的完整地址，NAS 内网地址即可</span></div>
      <div class="form-field full"><label>认证方式</label>
        <select id="f_authMode">
          <option value="password" ${item && item.authMode === 'apikey' ? '' : 'selected'}>用户名 / 密码</option>
          <option value="apikey" ${item && item.authMode === 'apikey' ? 'selected' : ''}>API 密钥（qB v5.2 及以上）</option>
        </select>
        <span class="hint">qBittorrent v5.2+ 可在 WebUI 设置中生成 API 密钥；登录失败时可改用此方式</span></div>
      <div class="form-field hidden" id="apiKeyWrap"><label>API 密钥</label><input id="f_apiKey" placeholder="qbt_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" value="${esc(item ? item.apiKey : '')}"></div>
      <div class="form-field" id="userWrap"><label>用户名</label><input id="f_user" value="${esc(item ? item.username : '')}"></div>
      <div class="form-field" id="passWrap"><label>密码</label><input id="f_pass" type="password" value="${esc(item ? item.password : '')}" placeholder="${item && item.password ? '留空保持不变' : ''}"></div>
      <div class="form-field full"><label>启用</label><label class="switch"><input type="checkbox" id="f_enabled" ${!item || item.enabled ? 'checked' : ''}><span class="slider"></span></label></div>`;
  } else if (tab === 'sites') {
    fields = `
      <div class="form-field"><label>站点名称</label><input id="f_name" placeholder="如：馒头" value="${esc(item ? item.name : '')}"></div>
      <div class="form-field"><label>接入方式</label>
        <select id="f_mode">
          <option value="api" ${item && (item.mode === 'cookie' || item.mode === 'mteam') ? '' : 'selected'}>API / passkey 接口</option>
          <option value="cookie" ${item && item.mode === 'cookie' ? 'selected' : ''}>Cookie 抓取个人页</option>
          <option value="mteam" ${item && item.mode === 'mteam' ? 'selected' : ''}>M-Team（馒头）API Key</option>
        </select></div>
      <div class="form-field"><label>徽标</label><input id="f_badge" placeholder="API / NP / MT" value="${esc(item ? item.badge : '')}"></div>
      <div class="form-field full"><label>站点图标</label>
        <div class="site-icon-edit-row">
          <input id="f_icon" placeholder="留空自动获取站点 favicon；或填图片 URL" value="${esc(item ? item.icon : '')}">
          <button class="btn" id="btnFetchIcon" type="button" onclick="fetchSiteIcon()" ${item && item.id ? '' : 'disabled'} title="${item && item.id ? '重新抓取该站点图标（清除 24 小时缓存）' : '保存站点后可获取'}">获取图标</button>
        </div>
        <img id="f_iconPreview" class="site-icon-preview" alt="图标预览" hidden>
        <span class="hint">留空 = 自动获取站点图标（favicon）；点「获取图标」重新抓取当前站点图标；填 http(s) 图片地址或 data: 数据 = 自定义图标；无图标时显示徽标文字</span></div>
      <div class="form-field full" id="apiWrap"><label>API 接口地址</label><input id="f_apiUrl" placeholder="https://站点/getuserinfo.php?passkey={passkey}" value="${esc(item ? item.apiUrl : '')}">
        <span class="hint">支持 {passkey} 占位符，返回 XML 或 JSON；M-Team 填 https://api.m-team.cc</span></div>
      <div class="form-field" id="passWrap"><label>passkey</label><input id="f_passkey" type="password" value="${esc(item ? item.passkey : '')}" placeholder="${item && item.passkey ? '留空保持不变' : ''}"></div>
      <div class="form-field full hidden" id="siteApiKeyWrap"><label>API Key（x-api-key 认证）</label><input id="f_siteApiKey" type="password" placeholder="M-Team 存取令牌" value="${esc(item ? item.apiKey : '')}">
        <span class="hint">M-Team：控制台 → 实验室 → 存取令牌；其他站如要求 x-api-key 也可用</span></div>
      <div class="form-field full hidden" id="urlWrap"><label>个人资料页地址</label><input id="f_profileUrl" placeholder="https://站点/userdetails.php?id=123" value="${esc(item ? item.profileUrl : '')}"></div>
      <div class="form-field full hidden" id="ckWrap"><label>站点 Cookie</label><textarea id="f_cookie" placeholder="粘贴浏览器登录后的完整 Cookie">${esc(item ? item.cookie : '')}</textarea>
        <span class="hint">浏览器登录站点后，从开发者工具复制 Cookie 请求头</span></div>
      <div class="form-field full"><label>账号标识（可选，用于识别）</label><input id="f_account" placeholder="z***1" value="${esc(item ? item.account : '')}"></div>
      <div class="form-field full"><label>分组</label>
        <select id="f_group">
          ${siteGroupOptions().map(g => `<option value="${esc(g)}" ${item && item.group === g ? 'selected' : (!item && g === '常用' ? 'selected' : '')}>${esc(g)}</option>`).join('')}
          <option value="__custom__" ${item && item.group && !siteGroupOptions().includes(item.group) ? 'selected' : ''}>＋ 自定义分组…</option>
        </select>
        <input id="f_groupCustom" placeholder="输入新分组名（如：影视、音乐、PT 主力）" value="${esc(item && item.group && !siteGroupOptions().includes(item.group) ? item.group : '')}" class="${item && item.group && !siteGroupOptions().includes(item.group) ? '' : 'hidden'}">
        <span class="hint">选择已有分组，或选「自定义分组…」输入新分组名；站点页顶部按分组筛选</span></div>
      <div class="form-field full"><label>启用</label><label class="switch"><input type="checkbox" id="f_enabled" ${!item || item.enabled ? 'checked' : ''}><span class="slider"></span></label></div>`;
  } else {
    // 服务：内网地址 + 外网域名地址两行固定（Docker 内地址不再单独配置，由内网地址承担）
    fields = `
      <div class="form-field"><label>名称</label><input id="f_name" placeholder="如：Jellyfin" value="${esc(item ? item.name : '')}"></div>
      <div class="form-field"><label>分类</label>
        <select id="f_category">${CATEGORIES.map(c => `<option value="${c}" ${item && item.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="form-field full"><label>内网访问地址</label><input id="f_svcLan" placeholder="http://192.168.50.20:3100" value="${esc(item ? item.url : '')}" spellcheck="false">
        <span class="hint">NAS 局域网内可直接访问的地址，浏览器打开用它；内网状态点会按此地址检测连通性</span></div>
      <div class="form-field full"><label>外网域名地址（可选）</label><input id="f_svcWan" placeholder="https://home.example.com" value="${esc(item ? item.wanUrl || '' : '')}" spellcheck="false">
        <span class="hint">公网域名地址；配合右上角内外网切换，切到「外网」时自动打开此地址。留空则始终用内网地址</span></div>
      <div class="form-field"><label>图标标识</label><input id="f_icon" placeholder="qb/tr/jf/al/pp/nav" value="${esc(item ? item.icon : '')}">
        <span class="hint">qb=深蓝 qB · tr=橙色 TR · jf=蓝 Jellyfin · al=蓝 Alist · pp=蓝 PhotoPrism · nav=导航</span></div>
      <div class="form-field"><label>启用</label><label class="switch"><input type="checkbox" id="f_enabled" ${!item || item.enabled ? 'checked' : ''}><span class="slider"></span></label></div>`;
  }

  body.innerHTML = `<div class="form-grid">${fields}</div>`;
  // 服务没有可测试的连接，隐藏测试按钮；下载器/站点显示
  $('#modalTest').hidden = (tab === 'services');

  // 下载器认证方式联动
  if (tab === 'downloaders') {
    const authSel = $('#f_authMode');
    const syncAuth = () => {
      const isApiKey = authSel.value === 'apikey';
      $('#apiKeyWrap').classList.toggle('hidden', !isApiKey);
      $('#userWrap').classList.toggle('hidden', isApiKey);
      $('#passWrap').classList.toggle('hidden', isApiKey);
    };
    authSel.onchange = syncAuth;
    syncAuth();
  }

  // 站点模式联动
  if (tab === 'sites') {
    const modeSel = $('#f_mode');
    const syncMode = () => {
      const m = modeSel.value;
      const isApi = m === 'api';
      const isMteam = m === 'mteam';
      $('#apiWrap').classList.toggle('hidden', !isApi);
      $('#passWrap').classList.toggle('hidden', !isApi);
      $('#siteApiKeyWrap').classList.toggle('hidden', !(isApi || isMteam));
      $('#urlWrap').classList.toggle('hidden', isApi || isMteam);
      $('#ckWrap').classList.toggle('hidden', isApi || isMteam);
    };
    modeSel.onchange = syncMode;
    syncMode();
    // 分组下拉：选「自定义分组…」时显示输入框
    const gSel = $('#f_group');
    const gCus = $('#f_groupCustom');
    const syncGroup = () => {
      const isCustom = gSel.value === '__custom__';
      gCus.classList.toggle('hidden', !isCustom);
      if (!isCustom) gCus.value = '';
    };
    gSel.onchange = syncGroup;
    syncGroup();
  }

  $('#modalMask').classList.remove('hidden');
  $('#modalTest').onclick = testCurrent;
  $('#modalSave').onclick = saveCurrent;
  $('#modalSave').textContent = '保存';
  $('#modalCancel').hidden = false;
  $('#modalCancel').onclick = closeModal;
  $('#modalClose').onclick = closeModal;
  // 删除：仅编辑已有对象时显示（新增时隐藏）
  const delBtn = $('#modalDelete');
  if (delBtn) {
    delBtn.hidden = !item;
    delBtn.onclick = () => deleteCurrent(item, tab);
  }
}

/* 删除当前对象（下载器/站点/服务通用）：确认后移除并自动保存 */
async function deleteCurrent(item, tab) {
  if (!item || !item.id) return;
  if (!window.confirm(`确定删除「${item.name || item.id}」？此操作会写入配置，不可撤销。`)) return;
  const arr = state.config[tab] || [];
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx < 0) return;
  arr.splice(idx, 1);
  closeModal();
  if (tab === 'services') {
    renderApps();
  } else if (tab === 'sites') {
    state.siteCache = null;
    renderSites();
  } else if (tab === 'downloaders') {
    state.serversCache = null;
    renderServers();
  }
  await autoSave(true); // 静默保存，删除提示由本函数 toast 表达
  showToast('已删除并保存');
}

function collectForm() {
  const tab = state.editingType;
  const item = state.editing || { id: uid(tab === 'downloaders' ? 'dl' : tab === 'sites' ? 'st' : 'svc') };
  if (tab === 'downloaders') {
    item.name = $('#f_name').value.trim();
    item.type = $('#f_type').value;
    item.host = $('#f_host').value.trim().replace(/\/+$/, '');
    item.authMode = $('#f_authMode').value;
    const ak = $('#f_apiKey').value;
    if (ak) item.apiKey = ak;
    item.username = $('#f_user').value.trim();
    const p = $('#f_pass').value;
    if (p) item.password = p;
    item.enabled = $('#f_enabled').checked;
  } else if (tab === 'sites') {
    item.name = $('#f_name').value.trim();
    item.mode = $('#f_mode').value;
    item.badge = $('#f_badge').value.trim() || (item.mode === 'api' ? 'API' : item.mode === 'mteam' ? 'MT' : 'NP');
    item.icon = $('#f_icon').value.trim();
    item.apiUrl = $('#f_apiUrl').value.trim();
    const pk = $('#f_passkey').value;
    if (pk) item.passkey = pk;
    const ak = $('#f_siteApiKey').value;
    if (ak) item.apiKey = ak;
    item.profileUrl = $('#f_profileUrl').value.trim();
    const ck = $('#f_cookie').value;
    if (ck) item.cookie = ck.trim();
    item.account = $('#f_account').value.trim();
    const gSel = $('#f_group');
    let group = gSel ? gSel.value : '';
    if (group === '__custom__' || !group) {
      group = ($('#f_groupCustom') ? $('#f_groupCustom').value : '').trim();
    }
    item.group = group || '常用';
    item.enabled = $('#f_enabled').checked;
  } else {
    item.name = $('#f_name').value.trim();
    item.category = $('#f_category').value;
    item.url = ($('#f_svcLan') ? $('#f_svcLan').value : '').trim();
    item.wanUrl = ($('#f_svcWan') ? $('#f_svcWan').value : '').trim();
    item.icon = $('#f_icon').value.trim();
    item.enabled = $('#f_enabled').checked;
  }
  return item;
}

/* 站点图标手动获取：?refresh=1 强制后端重抓（清 24h 缓存）并预览 */
async function fetchSiteIcon() {
  const item = state.editing;
  if (!item || !item.id) { showToast('新增站点请先保存，再回来获取图标'); return; }
  const btn = $('#btnFetchIcon');
  if (!btn) return;
  const prev = $('#f_iconPreview');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '获取中…';
  try {
    const url = '/api/site/favicon/' + encodeURIComponent(item.id) + '?refresh=1&t=' + Date.now();
    const res = await fetch(url);
    if (!res.ok) {
      let msg = '未找到该站点图标';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    prev.src = url;
    prev.hidden = false;
    const iconIn = $('#f_icon');
    if (iconIn) iconIn.value = ''; // 回到自动获取模式，让卡片直接使用新抓取的 favicon
    showToast('已获取站点图标');
  } catch (e) {
    showToast('获取失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* URL 协议校验：导航/下载器/站点地址只允许 http(s)，防 javascript: 等可执行协议 */
function validHttpUrl(v) {
  if (!v) return true; // 空值允许（下载器 host 必填在保存时另查）
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

async function testCurrent() {
  const item = collectForm();
  $('#modalMsg').textContent = '';
  $('#modalMsg').style.color = '';
  try {
    const isSite = state.editingType === 'sites';
    const r = isSite ? await API.testSite(item) : await API.testDownloader(item);
    if (r.ok) {
      $('#modalMsg').textContent = isSite
        ? '✓ 连接成功：' + (r.status.ratio != null ? '分享率 ' + r.status.ratio.toFixed(2) + ' · 做种 ' + r.status.seeding : '数据解析成功')
        : '✓ 连接成功，版本 ' + (r.version || '');
      $('#modalMsg').style.color = '#34d399';
    } else {
      $('#modalMsg').textContent = '✗ ' + (r.error || '连接失败');
      $('#modalMsg').style.color = '#ef4444';
    }
  } catch (e) {
    $('#modalMsg').textContent = '✗ ' + e.message;
    $('#modalMsg').style.color = '#ef4444';
  }
}

function saveCurrent() {
  const item = collectForm();
  if (!item.name) { showToast('请填写名称'); return; }
  if (state.editingType === 'downloaders' && !item.host) { showToast('请填写 WebUI 地址'); return; }
  if (!validHttpUrl(item.host) || !validHttpUrl(item.url) || !validHttpUrl(item.apiUrl) || !validHttpUrl(item.profileUrl)) {
    showToast('地址必须以 http:// 或 https:// 开头'); return;
  }
  if (state.editingType === 'sites') {
    const key = item.mode === 'api' ? item.apiUrl : (item.mode === 'mteam' ? item.apiKey : item.profileUrl);
    if (!key) { showToast('请填写' + (item.mode === 'api' ? 'API 接口地址' : item.mode === 'mteam' ? 'API Key' : '个人资料页地址')); return; }
  }
  const arr = state.config[state.editingType];
  const idx = arr.findIndex(x => x.id === item.id);
  const prev = idx >= 0 ? arr[idx] : null; // 保存旧值用于判断是否改了连接凭证
  if (idx >= 0) arr[idx] = item; else arr.push(item);
  closeModal();
  // 配置入口在各自页面：保存后只刷新被编辑的那一项，不整页重抓
  if (state.editingType === 'services') {
    renderApps(); // 服务配置入口在服务页，保存后重绘卡片（不整页刷新站点/下载器）
  } else if (state.editingType === 'sites') {
    const cache = state.siteCache;
    const idx = cache && cache.items ? cache.items.findIndex(x => x.id === item.id) : -1;
    if (idx >= 0) {
      // 展示属性（名称/分组/徽标）立即生效到卡片
      cache.items[idx].name = item.name;
      cache.items[idx].group = item.group || '常用';
      cache.items[idx].badge = item.badge || (item.mode === 'api' ? 'API' : (item.mode === 'mteam' ? 'MT' : 'NP'));
      const cardsEl = $('#siteCards');
      const old = cardsEl && cardsEl.querySelector('[data-site-id="' + CSS.escape(item.id) + '"]');
      if (old && old.parentNode) {
        old.replaceWith(siteCard(cache.items[idx]));
        cache.cards = cardsEl.innerHTML;
      }
      renderSiteGroups(cache.items);
      // 仅改分组/名称/徽标等展示字段时不重抓站点数据；改了连接凭证（cookie/接口/Key）才后台刷新
      const dataFieldsChanged = !prev || (
        prev.mode !== item.mode ||
        prev.apiUrl !== item.apiUrl ||
        prev.profileUrl !== item.profileUrl ||
        prev.passkey !== item.passkey ||
        prev.apiKey !== item.apiKey ||
        prev.cookie !== item.cookie ||
        prev.enabled !== item.enabled
      );
      if (dataFieldsChanged) refreshSite(item.id, null); // 后台重新抓取（改凭证后立即生效）
    } else {
      state.siteCache = null;
      renderSites();
    }
  } else if (state.editingType === 'downloaders') {
    state.serversCache = null;
    renderServers();
  }
  autoSave(false); // 修改即自动保存，无需手动点「保存配置」
  showToast('已保存并自动写入配置');
}

function closeModal() {
  $('#modalMask').classList.add('hidden');
  state.editing = null;
}

/* ===== 批量导入站点（配合油猴脚本 PT Cookie Collector 导出）===== */
function openImportModal() {
  state.editing = null;
  state.editingType = 'sites';
  $('#modalTitle').textContent = '批量导入站点（Cookie）';
  $('#modalMsg').textContent = '';
  $('#modalMsg').style.color = '';
  $('#modalDelete').hidden = true; // 导入弹窗无删除
  $('#modalTest').hidden = true;
  $('#modalCancel').hidden = false;
  const saveBtn = $('#modalSave');
  saveBtn.textContent = '导入';
  saveBtn.onclick = importSites;
  $('#modalBody').innerHTML = `
    <div class="form-field full">
      <label>粘贴导出的 JSON（扩展或油猴脚本导出）</label>
      <textarea id="f_importJson" rows="10" placeholder='[{"name":"pandapt","baseUrl":"https://pandapt.net","profileUrl":"https://pandapt.net/torrents.php","account":"grand0616","cookie":"uid=102820; pass=xxx; ..."}]'></textarea>
      <span class="hint">扩展：已登录的 PT 站页面点工具栏「PT Cookie Collector」图标 → 逐个「收集当前站点」→ 全部收集后「导出全部 JSON」→ 在此粘贴。<br>同域名站点自动覆盖更新，不会重复。导入结果会逐条说明。</span>
    </div>`;
  $('#modalMask').classList.remove('hidden');
  $('#modalCancel').onclick = closeModal;
  $('#modalClose').onclick = closeModal;
}

function importSites() {
  const raw = $('#f_importJson').value.trim();
  if (!raw) { showToast('请先粘贴 JSON'); return; }
  let arr = [];
  try {
    arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('不是数组');
  } catch (e) {
    $('#modalMsg').textContent = '✗ JSON 格式错误：' + e.message;
    $('#modalMsg').style.color = '#ef4444';
    return;
  }
  const hostOf = (url) => {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
  };
  const list = state.config.sites || [];
  const reasons = [];
  let ok = 0, merged = 0;
  arr.forEach((it, i) => {
    const tag = (it && (it.name || it.profileUrl || it.baseUrl)) ? `「${it.name || hostOf(it.profileUrl || it.baseUrl) || '#' + (i + 1)}」` : `#${i + 1}`;
    if (!it || typeof it !== 'object') { reasons.push(`${tag}: 不是有效对象，跳过`); return; }
    const name = (it.name || '').trim();
    const cookie = (it.cookie || '').trim();
    if (!name) { reasons.push(`${tag}: 缺少站点名，跳过`); return; }
    if (!cookie) { reasons.push(`${tag}: Cookie 为空（可能未收集到登录态），跳过`); return; }
    const profileUrl = (it.profileUrl || it.baseUrl || '').trim().replace(/\/+$/, '');
    if (!profileUrl) { reasons.push(`${tag}: 缺少站点地址，跳过`); return; }
    if (!validHttpUrl(profileUrl)) { reasons.push(`${tag}: 站点地址协议非法（需 http/https），跳过`); return; }
    const item = {
      id: uid('st'),
      name,
      badge: it.badge || 'NP',
      mode: 'cookie',
      apiUrl: '',
      passkey: '',
      profileUrl,
      cookie,
      account: (it.account || '').trim(),
      group: '常用',
      enabled: true
    };
    // 去重：同名 或 同域名（host 非空时）都视为同一站点，覆盖更新，避免重复
    const h2 = hostOf(profileUrl);
    const idx = list.findIndex(x => {
      if (x.name === name) return true;
      if (h2) {
        const h1 = hostOf(x.profileUrl || '');
        if (h1 && h1 === h2) return true;
      }
      return false;
    });
    if (idx >= 0) {
      item.id = list[idx].id; // 保留原 id，避免引用失效
      list[idx] = item;
      merged++;
    } else {
      list.push(item);
    }
    ok++;
  });
  state.config.sites = list;
  state.siteCache = null;
  renderSites();
  autoSave(true); // 导入后自动保存
  // 明细展示：不关闭弹窗，直接显示每条结果
  let msg = `✓ 成功导入 ${ok} 个站点（其中更新 ${merged} 个）`;
  if (reasons.length) {
    msg += `，跳过 ${reasons.length} 条：\n` + reasons.slice(0, 12).map(r => '· ' + r).join('\n');
    if (reasons.length > 12) msg += `\n· …共 ${reasons.length} 条`;
  }
  msg += '\n\n点「完成」关闭。';
  $('#modalTitle').textContent = '导入结果';
  $('#modalMsg').textContent = msg;
  $('#modalMsg').style.color = reasons.length ? '#f59e0b' : '#34d399';
  $('#modalSave').textContent = '完成';
  $('#modalSave').onclick = closeModal;
  $('#modalCancel').hidden = true;
}

async function saveConfig() {
  await autoSave(false);
}

/* 自动保存：收集刷新间隔 + 飞牛影视配置并写入 NAS 本地文件 */
async function autoSave(quiet) {
  const ui = state.config.ui || {};
  // 只有在设置页真正回填过之后，DOM 里的值才代表用户输入。
  // 否则（例如用户直接在「站点」页加站点）DOM 还是浏览器默认值，
  // 读进来会把影视墙 / Docker / MP 全部写成 false、刷新间隔重置成默认值。
  const ready = !!state.settingsReady;
  const readNum = (sel, min, max) => {
    if (!ready) return null;
    const inp = $(sel);
    if (!inp) return null;
    const v = parseInt(inp.value, 10);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const dl = readNum('#f_dlRefresh', 5, 300);
  const st = readNum('#f_siteRefresh', 10, 600);
  const sc = readNum('#f_siteCacheSec', 30, 3600);
  if (dl != null) ui.downloaderRefreshSec = dl;   // 非法/未读到时保留原值，不再回落硬编码默认
  if (st != null) ui.siteRefreshSec = st;
  if (sc != null) ui.siteCacheSec = sc;
  state.config.ui = ui;
  // 自定义背景：外链存配置，本地上传的图存服务端独立文件（/api/theme/bg）
  // 优先级：有上传图 → 外链置空（图片优先）；否则用输入框里的 http(s) 地址
  if (ready) {
    const bgInp = $('#f_themeBgImage');
    if (bgInp) {
      ui.theme = ui.theme || {};
      const v = (bgInp.value || '').trim();
      if (ui.theme.hasBgImage) ui.theme.bgImage = '';
      else ui.theme.bgImage = /^https?:\/\//i.test(v) ? v : '';
    }
  }
  // 清除背景图时给后端一个显式标记（空串不能表达"清空"，见 PUT /api/config 注释）
  if (state._bgClear && ui.theme) {
    ui.theme.bgClear = true;
    state._bgClear = false;
  }
  // 飞牛影视配置
  const ms = state.config.mediaServer || {};
  if (ready) {
    const me = $('#f_mediaEnabled');
    const mu = $('#f_mediaUrl');
    const mus = $('#f_mediaUser');
    const mp = $('#f_mediaPass');
    if (me) ms.enabled = me.checked;
    if (mu) ms.baseUrl = (mu.value || '').trim().replace(/\/+$/, '');
    if (mus) ms.username = (mus.value || '').trim();
    if (mp && mp.value.trim()) ms.password = mp.value.trim();
  }
  state.config.mediaServer = ms;
  // Docker 监控配置
  const dc = state.config.docker || {};
  if (ready) {
    const de = $('#f_dockerEnabled');
    const du = $('#f_dockerUrl');
    const da = $('#f_dockerAllowActions');
    if (de) dc.enabled = de.checked;
    if (du) dc.baseUrl = (du.value || '').trim().replace(/\/+$/, '');
    if (da) dc.allowActions = da.checked;
  }
  state.config.docker = dc;
  // MoviePilot 配置
  const mpc = state.config.moviePilot || {};
  if (ready) {
    const mpe = $('#f_mpEnabled');
    const mpur = $('#f_mpUrl');
    const mpt = $('#f_mpToken');
    if (mpe) mpc.enabled = mpe.checked;
    if (mpur) mpc.baseUrl = (mpur.value || '').trim().replace(/\/+$/, '');
    if (mpt && mpt.value.trim()) mpc.apiToken = mpt.value.trim();
  }
  state.config.moviePilot = mpc;
  try {
    const resp = await API.saveConfig(state.config);
    // bgClear 是一次性指令：保存成功后清掉，避免后续保存重复删文件
    if (ui.theme && ui.theme.bgClear) delete ui.theme.bgClear;
    // 以服务端返回的真实状态为准（上传/清除后 hasBgImage 由后端说了算）
    if (resp && typeof resp.hasBgImage === 'boolean' && ui.theme) ui.theme.hasBgImage = resp.hasBgImage;
    if (!quiet) showToast('配置已保存到 NAS 本地文件');
    // 媒体配置变化后刷新首页影视墙
    if (state.view === 'home' && ms.enabled) renderHomeMedia(true);
    if (state.view === 'home' && dc.enabled) renderHomeDocker();
    if (state.view === 'moviepilot' && mpc.enabled) renderMoviePilot();
  } catch (e) {
    showToast('保存失败：' + e.message);
  }
}

/* ===== 初始化 ===== */
async function init() {
  // 先过认证：服务端设置了 ACCESS_TOKEN 时，未登录会在这里拦住
  const authed = await ensureAuth();
  if (!authed) return; // 登录成功后由登录流程重新调用 init
  await bootApp();
}

/* 认证：返回 true 表示可以继续启动；false 表示已弹出登录层 */
async function ensureAuth() {
  let st = null;
  try { st = await API.authStatus(); } catch (e) { /* 老版本后端没有该接口，当作无需认证 */ }
  if (!st || !st.required || st.authed) return true;
  showAuthLayer();
  return false;
}

function showAuthLayer() {
  const mask = $('#authMask');
  if (!mask) return;
  mask.classList.remove('hidden');
  const inp = $('#authToken');
  const btn = $('#authSubmit');
  const msg = $('#authMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('ok'); }
  setTimeout(() => { if (inp) inp.focus(); }, 100);
  const submit = async () => {
    const token = (inp && inp.value || '').trim();
    if (!token) { if (msg) msg.textContent = '请输入访问令牌'; return; }
    btn.disabled = true;
    if (msg) { msg.textContent = '验证中…'; msg.classList.remove('ok'); }
    try {
      const r = await API.login(token);
      if (r && r.ok) {
        if (msg) { msg.textContent = '验证成功，正在进入…'; msg.classList.add('ok'); }
        mask.classList.add('hidden');
        bootApp(); // 认证通过后正常启动
        return;
      }
      if (msg) msg.textContent = (r && r.error) || '访问令牌不正确';
    } catch (e) {
      if (msg) msg.textContent = e.message || '验证失败';
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* 真正的启动流程（认证通过后执行） */
async function bootApp() {
  // 恢复上次浏览的页面（不直接回首页）：URL hash 优先（用户明确意图），其次 localStorage
  let savedView = 'home';
  const hashView = location.hash.replace('#', '');
  if (['home', 'apps', 'servers', 'sites', 'moviepilot', 'settings'].includes(hashView)) savedView = hashView;
  else {
    try {
      const v = localStorage.getItem('nas-nav-view');
      if (v && ['home', 'apps', 'servers', 'sites', 'moviepilot', 'settings'].includes(v)) savedView = v;
      const t = localStorage.getItem('nas-nav-settings-tab');
      if (t && ['system', 'theme', 'backup'].includes(t)) state.activeTab = t;
    } catch (e) { /* ignore */ }
  }
  try {
    state.config = await API.getConfig();
  } catch (e) {
    showToast('无法加载配置：' + e.message);
  }
  applyTheme(); // 加载配置后应用主题（模式 + 强调色）
  document.querySelectorAll('.side-item, .bottom-item').forEach(it => {
    it.onclick = () => switchView(it.dataset.view);
  });
  bindSettingsEvents();
  bindSiteDrag();
  bindSvcSearch();
  bindDiscoverClose();
  $('#svcDiscoverBtn').onclick = openDiscover;
  $('#svcAddBtn').onclick = () => openEditor(null, 'services');
  // 预取宿主机局域网 IP（服务添加表单「局域网 IP」模式自动填充；轻量接口，不打端口扫描）
  API.getLanIp().then(r => { if (r && r.lanIp) state.lanIp = r.lanIp; }).catch(() => {});
  // URL hash 变化（手动改地址 / 浏览器前进后退）同步到视图
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (['home', 'apps', 'servers', 'sites', 'moviepilot', 'settings'].includes(h)) switchView(h);
  });
  initNetMode();          // 恢复内外网访问模式
  updateConnPill();       // 顶栏「本地」状态点颜色
  setInterval(updateConnPill, 30 * 1000);
  switchView(savedView);
}

/* ===== 顶栏：内外网切换 + 「本地」状态点 ===== */
// 恢复/初始化内外网访问模式（localStorage 持久化，不影响后端配置）
function initNetMode() {
  let m = 'lan';
  try { m = localStorage.getItem('nas-nav-netmode') === 'wan' ? 'wan' : 'lan'; } catch (e) { /* ignore */ }
  state.netMode = m;
  syncNetBtn();
}
function toggleNetMode() {
  state.netMode = state.netMode === 'wan' ? 'lan' : 'wan';
  try { localStorage.setItem('nas-nav-netmode', state.netMode); } catch (e) { /* ignore */ }
  syncNetBtn();
  if (state.view === 'apps') renderApps(); // 服务卡片 href 随内外网模式变化
  showToast(state.netMode === 'wan' ? '已切换：服务将优先打开外网地址' : '已切换：服务将打开内网地址');
}
function syncNetBtn() {
  const b = $('#netToggle');
  if (!b) return;
  b.textContent = state.netMode === 'wan' ? '外网' : '内网';
  b.title = state.netMode === 'wan' ? '当前外网模式：服务打开外网域名地址，点击切换回内网' : '当前内网模式：服务打开内网地址，点击切换到外网';
  b.classList.toggle('ok', state.netMode === 'wan');
}
// 顶栏「● 本地」状态点颜色：绿 = 已配置组件全部正常；红 = 有离线/异常；灰 = 未配置或未知
async function updateConnPill() {
  const pill = $('#connPill');
  if (!pill) return;
  pill.classList.remove('ok', 'bad');
  try {
    const r = await API.getOverviewStatus();
    const dl = r.downloaders || {};
    const media = r.media || {};
    const docker = r.docker || {};
    const mp = r.mp || {};
    const sites = r.sites || {};
    const hasAny = dl.total > 0 || media.configured || docker.enabled || mp.enabled || sites.enabled > 0;
    if (!hasAny) return; // 灰：未配置任何组件
    const allOk =
      (dl.total === 0 || dl.online === dl.total) &&
      (!media.configured || !!media.connected) &&
      (!docker.enabled || !!docker.connected) &&
      (!mp.enabled || !!mp.connected) &&
      (sites.enabled === 0 || (sites.online || 0) === sites.enabled);
    pill.classList.add(allOk ? 'ok' : 'bad');
    const failDesc = (sites.failList || []).map(f => f.name + '：' + (f.error || '抓取失败')).join('；');
    pill.title = allOk
      ? '本地运行正常：下载器 ' + dl.online + '/' + dl.total + ' · 影视墙 ' + (media.configured ? (media.connected ? '已连接' : '未连接') : '未配置') + ' · Docker ' + (docker.enabled ? (docker.connected ? '正常' : '异常') : '未启用') + ' · MP ' + (mp.enabled ? (mp.connected ? '正常' : '异常') : '未启用') + ' · 站点 ' + (sites.online || 0) + '/' + sites.enabled
      : '存在异常：' + [
          (dl.total > 0 && dl.online < dl.total) ? ('下载器 ' + dl.online + '/' + dl.total + ' 离线') : '',
          (media.configured && !media.connected) ? '影视墙未连接' : '',
          (docker.enabled && !docker.connected) ? 'Docker 异常' : '',
          (mp.enabled && !mp.connected) ? 'MoviePilot 异常' : '',
          (sites.failed > 0) ? ('站点 ' + (sites.online || 0) + '/' + sites.enabled + '（' + failDesc + '）') : ''
        ].filter(Boolean).join('；') || '存在异常';
  } catch (e) { /* 请求失败保持灰色 */ }
}

document.addEventListener('DOMContentLoaded', init);
