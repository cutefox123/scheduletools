// 查班小助手 PWA —— 主逻辑
// 解析全部在本地完成（js/xlsx.js、js/xls.js、js/parser.js、js/rooms.js），数据只存 localStorage。

import { fetchWeather } from './weather.js?v=2026-10-26T21%3A50%3A43';
import { buildTips } from './tips.js?v=2026-10-26T21%3A50%3A43';

const K = {
  doctorRows: 'sa.doctorRows',
  doctorFile: 'sa.doctorFile',
  reporterRows: 'sa.reporterRows',
  reporterFile: 'sa.reporterFile',
  name: 'sa.name',
  lead: 'sa.lead',
  kind: 'sa.kind',
  days: 'sa.days',
  weather: 'sa.weather',
  weatherAt: 'sa.weatherAt',
  theme: 'sa.theme',
  calOn: 'sa.calOn', // 首页「医生日历提醒」开关：记本周（周一日期），换周自动算关闭
  repCalKey: 'sa.repCalKey', // 报告员开关：记「姓名|首日」，换人/换周自动关闭
  hist: 'sa.hist',       // 历史周索引：[{key,last,doctor,reporter,savedAt}]
  histD: 'sa.histD.',    // + 首日 → 那一周的医生表 rows
  histR: 'sa.histR.',    // + 首日 → 那一周的报告员表 rows
  week: 'sa.week',       // 正在看哪一周（'' = 本周），刷新后保持
  roomQuery: 'sa.roomQuery', // 诊室查询上次的关键字，退出再进来还留着
};

const TYPE_STYLE = {
  DAY: { bg: '#EAF0FF', fg: '#3D5AF1', label: '白班' },
  MID: { bg: '#E3F6F3', fg: '#0E8C7F', label: '中班' },
  NIGHT: { bg: '#F0EAFF', fg: '#6A45F5', label: '夜班' },
  OFF_NIGHT: { bg: '#FFF0E2', fg: '#F07B2E', label: '下夜' },
  REST: { bg: '#EDF1F6', fg: '#74829B', label: '休息' },
};

// 深色下用低亮度底 + 浅色字，夜里不刺眼；分享海报仍用上面的浅色。
const TYPE_STYLE_DARK = {
  DAY: { bg: '#1B2742', fg: '#A8BCFF', label: '白班' },
  MID: { bg: '#12302E', fg: '#7FE0D2', label: '中班' },
  NIGHT: { bg: '#241C3E', fg: '#B9A6FF', label: '夜班' },
  OFF_NIGHT: { bg: '#32241A', fg: '#FFC08A', label: '下夜' },
  REST: { bg: '#1E2635', fg: '#9AA6BE', label: '休息' },
};

const $ = (id) => document.getElementById(id);

// 版本跟进：网页版与安卓正式版保持同一个版本号，构建戳只用于判断“网页有没有更新”。
const APP_VERSION = '3.29';
const ANDROID_VERSION = '3.29';
// 安卓安装包直链：COS 不允许 .apk 后缀，.bin 就是 APK 本体，Content-Disposition 会还原文件名。
const ANDROID_APK_URL =
  'https://lovenest-1500804548.cos.ap-guangzhou.myqcloud.com/schedule/scheduleassistant-latest.bin';
const APP_NOTES = [
  '🔄 网页版不需要下载安装包；点「强制刷新」就能拿到最新页面',
  '📱 安卓旧版本（低于 v3.14）请复制安装包直链，在浏览器里手动下载安装包',
  '🔗 链接可以直接发给用安卓的同事，覆盖安装后姓名、提醒和两张表都会保留',
];
const LEGACY_NOTICE =
  '低于 v3.14 的安卓版：应用内检测更新可能失效或安装失败。请复制下面的链接，在手机浏览器打开，'
  + '下载 v3.14 安装包后直接覆盖安装。网页版用户不用下载，点上面的「强制刷新」即可。';

const store = {
  get(k, fallback = '') {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { toast('本机存储写入失败：' + e.message); }
  },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  json(k, fallback) {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  setJson(k, v) { store.set(k, JSON.stringify(v)); },
};

let mod = {};          // 动态加载的解析模块
let repCache = null;   // 报告员表解析结果缓存（导入时失效）
let reporterShare = null; // 报告员周视图当前分享的数据

function getReporterResult() {
  if (repCache !== null) return repCache;
  const rows = store.json(K.reporterRows, null);
  if (!rows || !mod.parser?.parseReporter) return null;
  const r = mod.parser.parseReporter(rows);
  repCache = r.ok ? r : null;
  return repCache;
}

function invalidateReporter() { repCache = null; }

// ---------- 历史周（v3.29） ----------
// 每次导入的表按「日期表头算出的首日」归档一份，最多留 8 周。
// 规则与安卓侧的 WeekArchive / Store.History 一致：医生表和报告员表首日
// 一般相同，自然落到同一条；差 3 天以内也合并，避免出现两条半空的记录。
const HIST_KEEP = 8;

/** 这张表属于哪一周（首末日）。规则在 parser.js 里，和安卓 WeekArchive 对齐。 */
function weekSpanOf(matrix) {
  if (!mod.parser?.weekSpanOf) return null;
  try {
    return mod.parser.weekSpanOf(matrix);
  } catch {
    return null;
  }
}

/** 周范围文案：10.19-10.25；跨年才带年份。与安卓 WeekArchive.label 一致。 */
function weekRangeOf(first, last) {
  if (!first) return '';
  if (!last || last === first) return mdOf(first);
  if (first.slice(0, 4) === last.slice(0, 4)) return mdOf(first) + '-' + mdOf(last);
  const fmt = (ymd) => Number(ymd.slice(0, 4)) + '.' + mdOf(ymd);
  return fmt(first) + '-' + fmt(last);
}

function histIndex() {
  const list = store.json(K.hist, []);
  return Array.isArray(list) ? list : [];
}

/** 把刚导入的表归档到它自己那一周（同一周重复导入＝覆盖旧的）。 */
function archiveWeek(kind, rows) {
  const span = weekSpanOf(rows);
  if (!span) return;
  const list = histIndex();
  let hit = null;
  for (const e of list) {
    if (e.key === span.key) { hit = e; break; }
    const diff = Math.abs((Date.parse(span.key) - Date.parse(e.key)) / 86400000);
    if (Number.isFinite(diff) && diff <= 3) { hit = e; break; }
  }
  if (!hit) {
    hit = { key: span.key, last: span.last, doctor: false, reporter: false, savedAt: 0 };
    list.push(hit);
  }
  if (!hit.last || span.last > hit.last) hit.last = span.last;
  hit.savedAt = Date.now();
  if (kind === 'reporter') hit.reporter = true; else hit.doctor = true;
  store.setJson((kind === 'reporter' ? K.histR : K.histD) + hit.key, rows);
  list.sort((a, b) => b.key.localeCompare(a.key));
  while (list.length > HIST_KEEP) {
    const old = list.pop();
    store.del(K.histD + old.key);
    store.del(K.histR + old.key);
  }
  store.setJson(K.hist, list);
}

/** 当前这份医生表属于哪一周（列表第一项「本周」用它）。 */
function currentWeekKey() {
  const span = weekSpanOf(store.json(K.doctorRows, null));
  return span ? span.key : '';
}

/** 可选周列表：第一项永远本周（key=''），后面是归档周，最近的在前。 */
function historyOptions() {
  const out = [];
  const cur = currentWeekKey();
  if (cur) {
    const span = weekSpanOf(store.json(K.doctorRows, null));
    out.push({
      key: '',
      label: weekRangeOf(span.key, span.last),
      current: true,
      doctor: true,
      reporter: !!store.json(K.reporterRows, null),
    });
  }
  for (const e of histIndex()) {
    if (e.key === cur) continue;
    out.push({
      key: e.key,
      label: weekRangeOf(e.key, e.last),
      current: false,
      doctor: !!e.doctor,
      reporter: !!e.reporter,
    });
  }
  return out;
}

/** 某一周的医生表 rows（'' = 当前这份）。 */
function doctorRowsOf(weekKey) {
  return weekKey ? store.json(K.histD + weekKey, null) : store.json(K.doctorRows, null);
}

/** 某一周的报告员表 rows（'' = 当前这份）。 */
function reporterRowsOf(weekKey) {
  return weekKey ? store.json(K.histR + weekKey, null) : store.json(K.reporterRows, null);
}

/** 周标签文案：本周 / 10.19-10.25。 */
function weekTitleOf(weekKey) {
  if (!weekKey) return '本周';
  const hit = histIndex().find((e) => e.key === weekKey);
  return hit ? weekRangeOf(hit.key, hit.last) : weekKey;
}

let state = {
  days: [],
  reporterDays: null,   // 报告员查询结果
  reporterName: '',     // 最近一次查询的报告员姓名（日历导出用）
  reporterShiftDays: [],// 最近一次查询的报告员班次（写入日历用）
  kind: store.get(K.kind, 'doctor'),
  weather: store.json(K.weather, {}),
  weatherAt: Number(store.get(K.weatherAt, '0')),
  weekKey: store.get(K.week, ''), // '' = 本周；其余是历史周首日 yyyy-MM-dd
};

// ---------- 工具 ----------
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------- 外观 ----------
function isDarkTheme() {
  const mode = store.get(K.theme, 'system');
  return mode === 'dark'
    || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** system / light / dark；system 时交给系统（含系统的定时深色模式）。 */
function applyTheme(mode, persist = true) {
  const next = (mode === 'light' || mode === 'dark') ? mode : 'system';
  const root = document.documentElement;
  if (next === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.dataset.theme = next;
  }
  if (persist) {
    store.set(K.theme, next);
  }
  document.querySelectorAll('#setThemeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === next);
  });
  const dark = next === 'dark'
    || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', dark ? '#0D1220' : '#4B6BF5');
  }
  // 日卡上的班次色块也要跟着换深浅。
  if (state.days && state.days.length) {
    renderList(state.days);
  }
}

const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
function onSystemThemeChange() {
  if (store.get(K.theme, 'system') === 'system') {
    applyTheme('system', false);
  }
}
if (themeMedia.addEventListener) {
  themeMedia.addEventListener('change', onSystemThemeChange);
} else if (themeMedia.addListener) {
  themeMedia.addListener(onSystemThemeChange);
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtDateLabel(ymd) {
  if (!ymd) return '';
  const [, m, d] = ymd.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function weekOf(ymd) {
  const names = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const dt = new Date(ymd + 'T00:00:00');
  return names[dt.getDay()];
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------- 模块加载 ----------
async function loadModules() {
  const load = async (name, path) => {
    try {
      const m = await import(path);
      mod[name] = m;
      return true;
    } catch (e) {
      console.warn('模块缺失', path, e);
      return false;
    }
  };
  await load('xlsx', './xlsx.js?v=2026-10-26T21%3A50%3A43');
  await load('xls', './xls.js?v=2026-10-26T21%3A50%3A43');
  await load('parser', './parser.js?v=2026-10-26T21%3A50%3A43');
  await load('rooms', './rooms.js?v=2026-10-26T21%3A50%3A43');
  if (!mod.parser) {
    toast('解析模块未就绪，页面仍可打开');
  }
}

// ---------- 导入 ----------
async function handleFile(file) {
  const name = file.name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  let rows = null;
  try {
    if (name.endsWith('.xlsx') || (buf[0] === 0x50 && buf[1] === 0x4b)) {
      if (!mod.xlsx) throw new Error('xlsx 解析模块未就绪');
      rows = mod.xlsx.parseXlsx(buf);
    } else {
      if (!mod.xls) throw new Error('xls 解析模块未就绪');
      rows = mod.xls.parseXls(buf);
    }
  } catch (e) {
    toast('读取失败：' + e.message);
    return;
  }
  if (!rows || !rows.length) {
    toast('没读出内容，确认是排班表本身');
    return;
  }
  pendingRows = { rows, fileName: file.name };
  $('pickedFileName').textContent = '已选择：' + file.name;
  $('dlgKind').showModal();
}

let pendingRows = null;

async function importAs(kind) {
  if (!pendingRows) return;
  const { rows, fileName } = pendingRows;
  pendingRows = null;
  $('dlgKind').close();

  if (kind === 'reporter') {
    if (!mod.parser?.parseReporter) { toast('解析模块未就绪'); return; }
    const rep = mod.parser.parseReporter(rows);
    if (!rep.ok) { toast(rep.error || '报告员表读不出来'); return; }
    store.setJson(K.reporterRows, rows);
    store.set(K.reporterFile, fileName);
    invalidateReporter();
    archiveWeek('reporter', rows);
    state.weekKey = '';
    store.set(K.week, '');
    paintWeekBar();
    toast(`报告员表导入成功：${rep.entries.length} 人`);
    refreshFileStatus();
    await renderWeek({ keepName: true });
    return;
  }

  store.setJson(K.doctorRows, rows);
  store.set(K.doctorFile, fileName);
  archiveWeek('doctor', rows);
  state.weekKey = '';
  store.set(K.week, '');
  paintWeekBar();
  refreshFileStatus();
  const names = mod.parser?.doctorNames ? mod.parser.doctorNames(rows) : [];
  const saved = store.get(K.name, '');
  if (!saved || (names.length && !names.includes(saved))) {
    await pickPerson(names, async (picked) => {
      store.set(K.name, picked);
      $('nameInput').value = picked;
      await renderWeek({ keepName: true });
    }, '导入成功，选一下你自己的姓名');
    return;
  }
  await renderWeek({ keepName: true });
  toast('导入成功');
}

// ---------- 渲染一周 ----------
async function renderWeek({ keepName = false } = {}) {
  const wk = state.weekKey;
  const rows = doctorRowsOf(wk);
  const name = store.get(K.name, '');
  if (!rows) { renderList([]); return; }
  if (!name) { renderList([]); return; }
  if (!mod.parser?.parseDoctor) { renderList([]); return; }

  const res = mod.parser.parseDoctor(rows, name, Number(store.get(K.lead, '30')));
  if (!res.ok) {
    state.days = [];
    renderList([]);
    if (res.error) toast(res.error);
    return;
  }
  state.days = res.days;
  // 历史周只用来「看」：不写缓存周、不拉天气（那几天早过去了）
  if (!wk) {
    store.setJson(K.days, res.days);
    renderList(res.days);
    ensureWeather(res.days);
    return;
  }
  renderList(res.days);
}

function renderList(days) {
  paintCalSwitch();
  const list = $('weekList');
  list.innerHTML = '';
  $('empty').style.display = days.length ? 'none' : 'block';
  if (!days.length) return;

  const today = todayYmd();
  const reporterDays = state.reporterDays;

  for (const d of days) {
    const styles = isDarkTheme() ? TYPE_STYLE_DARK : TYPE_STYLE;
    const style = styles[d.type] || styles.REST;
    const el = document.createElement('section');
    el.className = 'day';

    const wRaw = state.weather[d.ymd];
    const wObj = (wRaw && typeof wRaw === 'object') ? wRaw : null;
    const weatherText = wObj ? wObj.text : (typeof wRaw === 'string' ? wRaw : '');
    const past = d.ymd && d.ymd < today;
    const tips = buildTips(d, wObj);
    let pair = null;
    if (d.type !== 'REST' && mod.parser?.pairLabel) {
      try { pair = mod.parser.pairLabel(getReporterResult(), d.raw, d.ymd, d.rowHasWest, d.rowHasEast); } catch { pair = null; }
    }

    el.innerHTML = `
      <div class="day-head">
        <div class="dateblock" style="background:${style.bg};color:${style.fg}">
          <span class="w">${d.weekLabel || weekOf(d.ymd)}</span>
          <span class="d">${d.ymd ? Number(d.ymd.slice(5, 7)) + '.' + Number(d.ymd.slice(8, 10)) : ''}</span>
        </div>
        <span class="badge" style="background:${style.bg};color:${style.fg}">${style.label}</span>
      </div>
      <p class="day-raw">${escapeHtml(d.type === 'REST' && (!d.raw || d.raw === '休' || d.raw === '/') ? '休息' : (d.raw || '（单元格为空）'))}</p>
      ${d.workInfo ? `<p class="day-line">${escapeHtml(d.workInfo)}</p>` : ''}
      ${pair ? `<p class="day-line">${escapeHtml(pair)}</p>` : ''}
      ${state.weekKey ? '' : `<p class="day-weather">☁️ ${escapeHtml(weatherText || (past ? '已过' : (state.weatherAt ? '暂无预报' : '天气加载中…')))}</p>`}
      ${tips ? `<div class="day-tips">${escapeHtml(tips)}</div>` : ''}
    `;
    attachLongPress(el, () => copyDay(d));
    list.appendChild(el);
  }
}

// ---------- 周切换条（首页 + 诊室弹窗共用） ----------
function paintWeekBar() {
  const wk = state.weekKey || '';
  const text = wk ? weekTitleOf(wk) : '本周';
  const bars = [
    ['weekBarText', 'weekBar', 'weekBarTag', 'weekBarGo'],
    ['weekBarRoomsText', 'weekBarRooms', 'weekBarRoomsTag', 'weekBarRoomsGo'],
  ];
  for (const [textId, barId, tagId, goId] of bars) {
    const t = $(textId);
    const bar = $(barId);
    const tag = $(tagId);
    const go = $(goId);
    if (t) t.textContent = text;
    if (bar) bar.dataset.history = wk ? 'true' : 'false';
    if (tag) tag.hidden = !wk;
    if (go) go.hidden = !wk;
  }
  // 日历提醒只对本周有意义：翻历史周时先藏起来，免得点了写错周
  const calRow = document.querySelector('.cal-row');
  if (calRow) calRow.style.display = wk ? 'none' : '';
}

function openWeekPicker() {
  const wrap = $('weekPickList');
  wrap.innerHTML = '';
  const list = historyOptions();
  if (!list.length) {
    wrap.innerHTML = '<p class="hint" style="padding:8px 2px">还没有排班表——导入一张，这一周就会被记下来。</p>';
  }
  for (const w of list) {
    const b = document.createElement('button');
    const tags = [w.doctor ? '医生表' : '', w.reporter ? '报告员表' : ''].filter(Boolean).join(' · ');
    b.innerHTML = (w.key
      ? escapeHtml(w.label)
      : '本周<span class="hint" style="margin-left:6px;font-size:11.5px">' + escapeHtml(w.label) + '</span>')
      + (tags ? `<span class="hint" style="display:block;font-size:11.5px">${escapeHtml(tags)}</span>` : '');
    if (w.key === (state.weekKey || '')) b.style.color = 'var(--brand)';
    b.onclick = () => {
      $('dlgWeek').close();
      setWeek(w.key);
    };
    wrap.appendChild(b);
  }
  $('dlgWeek').showModal();
}

async function setWeek(key) {
  const next = key || '';
  if ((state.weekKey || '') === next) return;
  state.weekKey = next;
  store.set(K.week, next);
  paintWeekBar();
  await renderWeek();
  // 诊室弹窗开着的话跟着重画，免得还显示上一周
  if ($('dlgRooms').open) openRooms();
}

function copyDay(d) {
  const style = TYPE_STYLE[d.type] || TYPE_STYLE.REST;
  const head = [d.weekLabel || weekOf(d.ymd), d.dateLabel || fmtDateLabel(d.ymd), style.label,
    d.startTime || ''].filter(Boolean).join(' ');
  const lines = [head];
  if (d.raw) lines.push('表内写法：' + d.raw);
  if (d.workInfo) lines.push('时段：' + d.workInfo);

  // 搭档（pairLabel 已带「搭档：」前缀）
  let pair = '';
  try {
    if (mod.parser && mod.parser.pairLabel) {
      pair = mod.parser.pairLabel(getReporterResult(), d.raw, d.ymd, d.rowHasWest, d.rowHasEast) || '';
    }
  } catch (e) { pair = ''; }
  if (pair) lines.push(pair);

  const text = lines.join('\n');
  const done = () => toast('已复制：' + head);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
  ta.remove();
}

// 触摸长按 550ms 触发；桌面端用 contextmenu 兜底
function attachLongPress(el, handler) {
  let timer = null;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(10);
      handler();
    }, 550);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); handler(); });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 天气 ----------
let weatherBusy = false;
async function ensureWeather(days, force = false) {
  if (weatherBusy) return;
  const today = todayYmd();
  const need = days
    .filter((d) => d.ymd && d.ymd >= today && !state.weather[d.ymd])
    .map((d) => d.ymd);
  const stale = force || Date.now() - state.weatherAt > 6 * 3600 * 1000;
  if (!need.length && !stale) return;
  weatherBusy = true;
  try {
    const ymds = (force || !need.length) ? days.map((d) => d.ymd).filter(Boolean) : need;
    const got = await fetchWeather(ymds);
    Object.assign(state.weather, got);
    state.weatherAt = Date.now();
    store.setJson(K.weather, state.weather);
    store.set(K.weatherAt, String(state.weatherAt));
    renderList(state.days);
  } catch (e) {
    toast('天气没拉到：' + e.message);
  } finally {
    weatherBusy = false;
  }
}

/** 顶部刷新：重新读排班 + 强制重拉天气（对齐安卓下拉刷新）。 */
async function refreshAll() {
  await renderWeek({ keepName: true });
  if (!state.days.length) {
    toast('先导入排班表');
    return;
  }
  await ensureWeather(state.days, true);
  toast('已刷新');
}

// ---------- 查询 / 换人 ----------
async function pickPerson(names, onPick, title) {
  const dlg = $('dlgPerson');
  reporterShare = null;
  $('btnShareReporter').style.display = 'none';
  $('personTitle').textContent = title || '查谁的班';
  setCalStatus('');
  setRepCalVisible(false);
  $('personSearch').value = '';
  $('personSearch').style.display = '';
  const listEl = $('personList');
  const draw = (filter) => {
    const q = (filter || '').trim();
    const shown = q ? names.filter((n) => n.includes(q)) : names;
    listEl.innerHTML = '';
    if (!shown.length) {
      listEl.innerHTML = `<p class="hint" style="padding:12px 6px">${names.length ? '没有匹配的姓名' : '还没导入对应的表'}</p>`;
      return;
    }
    for (const n of shown.slice(0, 300)) {
      const b = document.createElement('button');
      b.textContent = n;
      b.onclick = () => { dlg.close(); onPick(n); };
      listEl.appendChild(b);
    }
  };
  $('personSearch').oninput = (e) => draw(e.target.value);
  draw('');
  dlg.showModal();
}

async function onQuery() {
  const name = $('nameInput').value.trim();
  if (!name) { toast(state.kind === 'reporter' ? '请输入报告员姓名' : '请输入医生姓名'); return; }
  if (state.kind === 'reporter') { await queryReporter(name); return; }
  store.set(K.name, name);
  await renderWeek();
  toast('已切换到「' + name + '」');
}

async function queryReporter(name) {
  const wk = state.weekKey || '';
  const rows = reporterRowsOf(wk);
  if (!rows) { toast(wk ? '这一周没有存档的报告员表' : '还没导入报告员表'); return; }
  if (!mod.parser?.parseReporter) { toast('解析模块未就绪'); return; }
  const rep = mod.parser.parseReporter(rows);
  if (!rep.ok) { toast(rep.error || '报告员表读不出来'); return; }
  const names = mod.parser.reporterNames(rep);
  const hit = names.find((n) => n === name) || names.find((n) => n.includes(name));
  if (!hit) { toast('报告员表里没找到「' + name + '」'); return; }
  const doctorRows = doctorRowsOf(wk);
  if (!doctorRows) { toast(wk ? '这一周没有存档的医生表' : '还没导入医生排班表'); return; }
  const res = mod.parser.reporterWeek(doctorRows, rep, hit);
  if (!res.ok) { toast(res.error || '查不到'); return; }
  // 日历班次直接用弹窗上显示的这一周拼（日期和原始格子文本都来自同一处），
  // 保证「页面看到什么就写什么」。raw 必须是"4诊/6诊"这种格子文本，
  // 用位置名（"东区/西区"）算不出上下班时间，写出来是 0 条。
  const repDays = (res.days || []).map((d) => {
    const raw = d.raw || '';
    const o = { ymd: d.ymd, raw, type: 'REST', startTime: null, preTime: null, workInfo: '' };
    try { mod.parser.fillShift(o, raw, 0); } catch { /* 解析失败按休息 */ }
    return o;
  });
  state.reporterName = hit;
  state.reporterShiftDays = repDays;
  showReporterWeek(hit, res.days);
}

// ---------- 报告员周 → 日历班次（与安卓侧同一套规则） ----------

/** 报告员格转显示文本：纯数字的半天补“诊”（6→6诊），其余原样。 */
function reporterRawText(cell) {
  const t = String(cell || '').replace(/\s+/g, '');
  if (!t) return '';
  return t.split('/').map((h) => (/^\d+$/.test(h) ? h + '诊' : h)).join('/');
}

/** 把报告员一周格子转成和医生周同构的 days（供 ics 导出 / 无感询问共用）。 */
function reporterShiftDays(rep, hit) {
  if (!rep || !Array.isArray(rep.entries)) return [];
  const entry = rep.entries.find((e) => e.name === hit)
    || rep.entries.find((e) => hit.includes(e.name) || e.name.includes(hit));
  if (!entry) return [];
  const days = [];
  for (let i = 0; i < rep.ymds.length && i < entry.cells.length; i++) {
    const raw = reporterRawText(entry.cells[i]);
    const d = { ymd: rep.ymds[i], raw, type: 'REST', startTime: null, preTime: null, workInfo: '' };
    try { mod.parser.fillShift(d, raw, 0); } catch { /* 解析失败按休息 */ }
    days.push(d);
  }
  return days;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function showReporterWeek(name, days) {
  const dlg = $('dlgPerson');
  const wk = state.weekKey || '';
  reporterShare = { name, days: days || [] };
  $('personTitle').textContent = name + ' · ' + weekTitleOf(wk);
  setCalStatus('');
  $('personSearch').style.display = 'none';
  const hasDays = days && days.length;
  // 历史周只看不写日历：日历里现在装的是本周的班，别被旧班表覆盖
  setRepCalVisible(!!hasDays && !wk);
  $('btnShareReporter').style.display = hasDays ? '' : 'none';
  const listEl = $('personList');
  listEl.innerHTML = '';
  const styles = isDarkTheme() ? TYPE_STYLE_DARK : TYPE_STYLE;
  const today = todayYmd();
  for (const d of days || []) {
    // 整格班次 / 时段：和医生卡片同一套 fillShift，版式才完全一致
    const raw = d.raw || '';
    const probe = { ymd: d.ymd, raw, type: 'REST', startTime: null, preTime: null, workInfo: '' };
    try { mod.parser.fillShift(probe, raw, 0); } catch { /* 认不出按休息 */ }
    const style = styles[probe.type] || styles.REST;
    const isToday = !wk && d.ymd === today;
    const partner = reporterPartnerLine(d);
    const ymd = d.ymd || '';
    const dateText = ymd.length >= 10
      ? Number(ymd.slice(5, 7)) + '.' + Number(ymd.slice(8, 10))
      : (d.dateLabel || '');
    const weekText = (d.weekLabel || '').replace('星期天', '周日').replace('星期', '周');
    const section = document.createElement('section');
    section.className = 'day';
    if (isToday) section.style.borderColor = 'rgba(75,107,245,.45)';
    section.innerHTML = `
      <div class="day-head">
        <div class="dateblock" style="background:${style.bg};color:${style.fg}">
          <span class="w">${escapeHtml(weekText)}</span>
          <span class="d">${escapeHtml(dateText)}</span>
        </div>
        <span class="badge" style="background:${style.bg};color:${style.fg}">${style.label}</span>
      </div>
      <p class="day-raw">${escapeHtml(raw || '（单元格为空）')}</p>
      ${probe.workInfo && probe.type !== 'REST' ? `<p class="day-line">${escapeHtml(probe.workInfo)}</p>` : ''}
      ${partner ? `<p class="day-line">${escapeHtml(partner)}</p>` : ''}
    `;
    listEl.appendChild(section);
  }
  dlg.showModal();
}

/** 报告员搭档：上午下午一样就合成一行，不一样分半天写。 */
function reporterPartnerLine(d) {
  const am = (d.am?.partners || []).filter(Boolean);
  const pm = (d.pm?.partners || []).filter(Boolean);
  if (!am.length && !pm.length) return '';
  if (am.join('、') === pm.join('、')) return '搭档：' + am.join('、');
  const parts = [];
  if (am.length) parts.push('上午 ' + am.join('、'));
  if (pm.length) parts.push('下午 ' + pm.join('、'));
  return '搭档：' + parts.join('　·　');
}

function placeText(half, withPartners = true) {
  if (!half || !half.place || half.place === '休') return '休息';
  const mid = { '中': '中班', '东中': '东院中班', '西中': '西院中班', '值中': '值班中班' }[half.place];
  const place = mid || half.place;
  if (!withPartners) return place;
  const partners = (half.partners || []).join('、');
  return place + (partners ? `　·　搭档：${partners}` : '');
}

// ---------- 导出到系统日历 ----------
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date(2026, 0, 1, h, m + minutes);
  return `${pad2(t.getHours())}${pad2(t.getMinutes())}00`;
}

function buildIcs(days) {
  const lead = Number(store.get(K.lead, '30'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ScheduleAssistant PWA//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const d of days) {
    if (!d.ymd || !d.startTime || d.type === 'REST' || d.type === 'OFF_NIGHT') continue;
    const style = TYPE_STYLE[d.type] || TYPE_STYLE.DAY;
    const dtStart = d.ymd.replace(/-/g, '') + 'T' + d.startTime.replace(':', '') + '00';
    const dtEnd = d.ymd.replace(/-/g, '') + 'T' + addMinutes(d.startTime, 8 * 60);
    const summary = `${style.label} ${d.startTime} · ${d.raw || ''}`.trim();
    const desc = [d.workInfo, d.preTime ? `提醒时间 ${d.preTime}` : ''].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${d.ymd}-${d.type}@scheduleassistant`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;TZID=Asia/Shanghai:${dtStart}`);
    lines.push(`DTEND;TZID=Asia/Shanghai:${dtEnd}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push(`TRIGGER:-PT${Math.max(0, lead)}M`);
    lines.push(`DESCRIPTION:${icsEscape(summary)}`);
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * 把一周班次导成 .ics。
 * 返回 { ok, count, msg }；提示由调用方决定——弹窗里必须用「行内结果条」，
 * 因为 toast 会被 <dialog> 的 top layer 盖住，用户点了什么也看不到。
 */
async function exportCalendar(daysOverride = null, opts = {}) {
  const days = daysOverride || state.days;
  const inline = opts.inline === true;
  const say = (text, kind) => {
    if (inline) setCalStatus(text, kind);
    else toast(text);
  };
  if (!days.length) {
    say(daysOverride ? '这个人这一周还没有排班数据' : '先导入排班表', 'none');
    return { ok: false, count: 0 };
  }
  const ics = buildIcs(days);
  const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
  if (!count) {
    say(daysOverride
      ? '这一周没有可写入的班次（休息、下夜都不写），日历没有变化'
      : '这一周没有需要提醒的班次（休息、下夜都不写）', 'none');
    return { ok: false, count: 0 };
  }
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `查班-${days[0].ymd}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  say(`已生成 ${count} 个班次的日历文件，在“文件”里点它会导入日历`, 'ok');
  return { ok: true, count };
}

/** 弹窗里的写入结果条：ok / none / error 三种配色。 */
function setCalStatus(text, kind) {
  const el = $('calStatus');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('data-kind');
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.dataset.kind = kind || 'none';
}

// ---------- 首页「医生日历提醒」开关 ----------
// 网页版写不了系统日历，只能生成 .ics 让用户点开导入，所以开关状态记在本地：
// 开 = 本周已经导出过（再点一次会重新导出最新的），换一周自动回到关闭。
function calWeekKey() {
  const days = (state.days || []).filter((d) => d && d.ymd);
  return days.length ? days[0].ymd : '';
}

function calSwitchOn() {
  const key = calWeekKey();
  return !!key && store.get(K.calOn, '') === key;
}

function paintCalSwitch() {
  const on = calSwitchOn();
  const sw = $('calSw');
  if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
  const hint = $('calRowHint');
  if (hint) hint.textContent = on ? leadText(currentLead()) : '开启时选提前多久';
}

async function toggleCalSwitch() {
  if (!state.days.length) {
    toast('先导入排班表');
    paintCalSwitch();
    return;
  }
  if (calSwitchOn()) {
    store.set(K.calOn, '');
    paintCalSwitch();
    toast('已关闭医生日历提醒（已导入日历的事件请在日历里手动删除）');
    return;
  }
  // 打开之前先问「提前多久」——用户最在意这个数字，不拿默认值糊过去；
  // 用户取消（resolve null）就到此为止，开关保持关闭。
  const lead = await askLead('开启日历提醒前，先定一下提前多久通知你（最长 1 小时）');
  if (lead === null) {
    paintCalSwitch();
    return;
  }
  const r = await exportCalendar();
  store.set(K.calOn, r.ok ? calWeekKey() : '');
  paintCalSwitch();
  if (state.days.length) await renderWeek({ keepName: true });
}

// ---------- 提前多久提醒（首页 / 报告员弹窗 / 设置共用） ----------
const MAX_LEAD = 60; // 上限 1 小时
const LEAD_PRESETS = [0, 5, 10, 15, 20, 30, 45, 60];

function leadText(minutes) {
  return minutes === 0 ? '准时提醒' : `提前 ${minutes} 分钟`;
}

function currentLead() {
  const v = Number(store.get(K.lead, '30'));
  return Math.max(0, Math.min(MAX_LEAD, Number.isFinite(v) ? v : 30));
}

/** 三处的文案一起刷，省得改了首页设置里还是旧数字。 */
function paintLead() {
  const lead = currentLead();
  const text = leadText(lead);
  if ($('leadInput')) $('leadInput').value = String(lead);
  document.querySelectorAll('#leadPresets button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.min) === lead);
  });
  paintCalSwitch();
  const repRow = $('repCalRow');
  if (repRow && !repRow.hidden) paintRepCal();
}

function buildLeadPresets() {
  const box = $('leadPresets');
  if (!box) return;
  box.innerHTML = '';
  for (const m of LEAD_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.min = String(m);
    b.textContent = m === 0 ? '准时' : `${m} 分钟`;
    b.onclick = () => saveLead(m);
    box.appendChild(b);
  }
}

// 开关流程要「等用户选完再继续」，用 pending 记下 resolve；普通打开就是 null。
let _leadResolve = null;

function openLeadDialog(subtitle) {
  paintLead();
  const sub = $('dlgLeadSub');
  if (sub) sub.textContent = subtitle || '对医生和报告员的日历都生效，最长 1 小时';
  $('dlgLead').showModal();
}

/** 弹选择器并等结果：返回分钟数；用户取消返回 null。 */
function askLead(subtitle) {
  const wait = new Promise((res) => {
    _leadResolve = res;
  });
  openLeadDialog(subtitle);
  return wait;
}

function closeLeadDialog(value) {
  if ($('dlgLead').open) $('dlgLead').close();
  const res = _leadResolve;
  _leadResolve = null;
  if (res) res(value);
}

async function saveLead(minutes) {
  const lead = Math.max(0, Math.min(MAX_LEAD, Number(minutes) || 0));
  store.set(K.lead, String(lead));
  const res = _leadResolve;
  _leadResolve = null;
  if ($('dlgLead').open) $('dlgLead').close();
  paintLead();
  if (res) {
    // 开关流程：由调用方接着导出，别抢着弹一句 toast
    res(lead);
    return;
  }
  toast(lead === 0 ? '已改为：上班那一刻提醒' : `已改为：上班前 ${lead} 分钟提醒`);
  // 报告员弹窗开着时，提醒时间要重新导出一次才生效，直接在弹窗里说清楚
  if ($('dlgPerson') && $('dlgPerson').open && (state.reporterShiftDays || []).length) {
    setCalStatus('提醒时间已改，点「写入日历」重新生成一次才会生效', 'none');
  }
  // 提醒时间参与班次解析（preTime），改完重算一次首页
  if (state.days.length) await renderWeek({ keepName: true });
}

// ---------- 报告员弹窗里的日历开关（和首页医生那个同一套逻辑） ----------
function repCalKey() {
  const days = (reporterShare && reporterShare.days) || [];
  const name = (reporterShare && reporterShare.name) || '';
  const first = days.find((d) => d && d.ymd);
  return first && name ? `${name}|${first.ymd}` : '';
}

function repCalOn() {
  const key = repCalKey();
  return !!key && store.get(K.repCalKey, '') === key;
}

function paintRepCal() {
  const row = $('repCalRow');
  if (!row) return;
  const on = repCalOn();
  row.dataset.on = on ? 'true' : 'false';
  const sw = $('repCalSw');
  if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
  const hint = $('repCalHint');
  if (hint) hint.textContent = on ? leadText(currentLead()) : '打开时选提前多久';
}

function setRepCalVisible(v) {
  const row = $('repCalRow');
  if (row) row.hidden = !v;
  if (v) paintRepCal();
}

async function toggleRepCal() {
  const days = (reporterShare && reporterShare.days) || [];
  if (!days.length) {
    setCalStatus('这个人这一周还没有排班数据', 'none');
    return;
  }
  if (repCalOn()) {
    // 网页版删不掉已经导入系统日历的事件，只能清标记并说清楚
    store.set(K.repCalKey, '');
    paintRepCal();
    setCalStatus('已关闭日历提醒（已导入到日历的事件请在日历里手动删除）', 'none');
    return;
  }
  // 打开前先问「提前多久」，取消就不导出
  const lead = await askLead('开启日历提醒前，先定一下提前多久通知你（最长 1 小时）');
  if (lead === null) {
    paintRepCal();
    return;
  }
  const r = await exportCalendar(days, { inline: true });
  store.set(K.repCalKey, r.ok ? repCalKey() : '');
  paintRepCal();
}

// ---------- 杂项 UI ----------
function refreshFileStatus() {
  const doc = store.get(K.doctorFile, '');
  const rep = store.get(K.reporterFile, '');
  $('setDoctor').textContent = doc || '—';
  $('setReporter').textContent = rep || '—';
}

function setKind(kind) {
  const changed = state.kind !== kind;
  state.kind = kind;
  store.set(K.kind, kind);
  document.querySelectorAll('#seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === kind);
  });
  $('nameInput').placeholder = kind === 'reporter' ? '报告员姓名' : '医生姓名';
  // 和安卓 3.14 一样：切换医生/报告员时清空上一种查询的姓名。
  if (changed) {
    $('nameInput').value = '';
  }
  // 报告员模式下恢复输入框（可能被“报告员一周”复用）
  $('personSearch').style.display = '';
  $('btnShareReporter').style.display = 'none';
  setRepCalVisible(false);
  setCalStatus('');
}

// ---------- 整周分享成一张图 ----------
function mdOf(ymd) {
  if (!ymd || ymd.length < 10) return '';
  return Number(ymd.slice(5, 7)) + '.' + Number(ymd.slice(8, 10));
}

function weekRangeLabel(days) {
  const valid = (days || []).filter((d) => d.ymd && d.ymd.length >= 10);
  if (!valid.length) return '';
  const a = mdOf(valid[0].ymd);
  const b = mdOf(valid[valid.length - 1].ymd);
  return a === b ? a : a + '–' + b;
}

function posterPair(d) {
  if (!d || d.type === 'REST') return '';
  try {
    return (mod.parser && mod.parser.pairLabel)
      ? (mod.parser.pairLabel(getReporterResult(), d.raw, d.ymd, d.rowHasWest, d.rowHasEast) || '')
      : '';
  } catch (e) {
    return '';
  }
}

function rr(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const chars = Array.from(String(text == null ? '' : text));
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const consumed = lines.join('').length;
  if (lines.length === maxLines && consumed < chars.length) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + '…';
  }
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

function fitFont(ctx, text, weight, size, maxWidth, family) {
  let s = size;
  while (s > 18) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(String(text || '')).width <= maxWidth) break;
    s -= 2;
  }
  return s;
}

const POSTER_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

function buildWeekPoster() {
  const days = state.days || [];
  const name = store.get(K.name, '') || '我的排班';
  const W = 540;
  const headerH = 170;
  const rowH = 124;
  const footerH = 70;
  const H = headerH + days.length * rowH + footerH;
  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'alphabetic';

  // 底
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  // 顶部渐变
  const grad = ctx.createLinearGradient(0, 0, W, headerH);
  grad.addColorStop(0, '#5B7CFA');
  grad.addColorStop(0.55, '#5A68F4');
  grad.addColorStop(1, '#825CF6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headerH);

  // 小图标
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  rr(ctx, 34, 28, 34, 34, 10);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 18px ${POSTER_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('班', 51, 51);

  // 标题
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 18px ${POSTER_FONT}`;
  ctx.fillText('查班小助手', 80, 52);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#D4DDFF';
  ctx.font = `400 14px ${POSTER_FONT}`;
  ctx.fillText('本周排班', W - 34, 52);
  ctx.textAlign = 'left';

  // 姓名
  const nameSize = fitFont(ctx, name, '800', 40, W - 68, POSTER_FONT);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 ${nameSize}px ${POSTER_FONT}`;
  ctx.fillText(name, 34, 116);

  // 日期范围
  const range = weekRangeLabel(days);
  if (range) {
    ctx.fillStyle = '#D4DDFF';
    ctx.font = `400 15px ${POSTER_FONT}`;
    ctx.fillText(range + ' · 一周班表', 34, 148);
  }

  // 一周
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const s = TYPE_STYLE[d.type] || TYPE_STYLE.REST;
    const rowY = headerH + i * rowH;

    // 日期块
    ctx.fillStyle = s.bg;
    rr(ctx, 30, rowY + 20, 60, 60, 14);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = s.fg;
    ctx.font = `400 12px ${POSTER_FONT}`;
    ctx.fillText(d.weekLabel || weekOf(d.ymd), 60, rowY + 45);
    ctx.font = `700 22px ${POSTER_FONT}`;
    ctx.fillText(mdOf(d.ymd), 60, rowY + 69);

    // 班次徽标
    const label = s.label || d.type || '休息';
    ctx.font = `700 13px ${POSTER_FONT}`;
    const badgeW = Math.max(46, ctx.measureText(label).width + 22);
    const badgeX = W - 30 - badgeW;
    ctx.fillStyle = s.bg;
    rr(ctx, badgeX, rowY + 20, badgeW, 26, 9);
    ctx.fill();
    ctx.fillStyle = s.fg;
    ctx.fillText(label, badgeX + badgeW / 2, rowY + 38);

    // 表内写法
    ctx.textAlign = 'left';
    ctx.fillStyle = '#18213A';
    ctx.font = `700 20px ${POSTER_FONT}`;
    const raw = (d.type === 'REST' && (!d.raw || d.raw === '休' || d.raw === '/')) ? '休息' : (d.raw || '休息');
    const rawMax = W - 30 - badgeW - 16 - 108;
    drawWrapped(ctx, raw, 108, rowY + 44, rawMax, 24, 2);

    // 时段
    ctx.fillStyle = '#7B8499';
    ctx.font = `400 14px ${POSTER_FONT}`;
    if (d.workInfo) {
      drawWrapped(ctx, d.workInfo, 108, rowY + 92, W - 30 - 108, 18, 1);
    }

    // 搭档
    const pair = posterPair(d);
    if (pair) {
      ctx.fillStyle = '#7B8499';
      ctx.font = `400 12.5px ${POSTER_FONT}`;
      drawWrapped(ctx, pair, 108, rowY + 112, W - 30 - 108, 16, 1);
    }

    // 分隔线
    ctx.strokeStyle = '#EDF0F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, rowY + rowH - 0.5);
    ctx.lineTo(W - 30, rowY + rowH - 0.5);
    ctx.stroke();
  }

  // 页脚
  const footY = headerH + days.length * rowH;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7B8499';
  ctx.font = `400 12px ${POSTER_FONT}`;
  ctx.fillText('来自科室排班表 · 只显示班次和搭档', 34, footY + 38);
  ctx.textAlign = 'right';
  ctx.font = `600 11px ${POSTER_FONT}`;
  ctx.fillText('查班小助手', W - 34, footY + 38);

  return canvas;
}

/** 报告员海报里的一行位置：中/东中/西中/值中 用中文全称，休息统一写“休息”。 */
function reporterHalfText(half) {
  if (!half || !half.place || half.place === '休') return '休息';
  const mid = { '中': '中班', '东中': '东院中班', '西中': '西院中班', '值中': '值班中班' }[half.place];
  const place = mid || half.place;
  const partners = (half.partners || []).join('、');
  return place + (partners ? `　·　搭档：${partners}` : '');
}

/** 报告员一周位置海报：对齐安卓 3.14 的「分享报告员排班」。 */
function buildReporterPoster(name, days) {
  const W = 540;
  const headerH = 170;
  const rowH = 132;
  const footerH = 70;
  const H = headerH + days.length * rowH + footerH;
  const dpr = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, W, headerH);
  grad.addColorStop(0, '#0E9F8F');
  grad.addColorStop(0.55, '#0B8C7F');
  grad.addColorStop(1, '#4B6BF5');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headerH);

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  rr(ctx, 34, 28, 34, 34, 10);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 18px ${POSTER_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('报', 51, 51);

  ctx.textAlign = 'left';
  ctx.font = `700 18px ${POSTER_FONT}`;
  ctx.fillText('查班小助手', 80, 52);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#D4F5F0';
  ctx.font = `400 14px ${POSTER_FONT}`;
  ctx.fillText('报告员 · 本周', W - 34, 52);
  ctx.textAlign = 'left';

  const who = name || '报告员';
  const nameSize = fitFont(ctx, who, '800', 40, W - 68, POSTER_FONT);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `800 ${nameSize}px ${POSTER_FONT}`;
  ctx.fillText(who, 34, 116);

  const range = weekRangeLabel(days);
  if (range) {
    ctx.fillStyle = '#D4F5F0';
    ctx.font = `400 15px ${POSTER_FONT}`;
    ctx.fillText(range + ' · 一周位置', 34, 148);
  }

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const rowY = headerH + i * rowH;

    ctx.fillStyle = '#E7F7F4';
    rr(ctx, 30, rowY + 20, 60, 60, 14);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0B8C7F';
    ctx.font = `400 12px ${POSTER_FONT}`;
    ctx.fillText(d.weekLabel || weekOf(d.ymd), 60, rowY + 45);
    ctx.font = `700 20px ${POSTER_FONT}`;
    ctx.fillText(mdOf(d.ymd), 60, rowY + 69);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#18213A';
    ctx.font = `700 15px ${POSTER_FONT}`;
    drawWrapped(ctx, `${d.weekLabel || ''} ${d.dateLabel || ''}`.trim(), 108, rowY + 40,
      W - 30 - 108, 19, 1);

    ctx.fillStyle = '#7B8499';
    ctx.font = `400 13px ${POSTER_FONT}`;
    drawWrapped(ctx, '上午：' + reporterHalfText(d.am), 108, rowY + 70,
      W - 30 - 108, 18, 1);
    drawWrapped(ctx, '下午：' + reporterHalfText(d.pm), 108, rowY + 94,
      W - 30 - 108, 18, 1);

    ctx.strokeStyle = '#EDF0F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, rowY + rowH - 0.5);
    ctx.lineTo(W - 30, rowY + rowH - 0.5);
    ctx.stroke();
  }

  const footY = headerH + days.length * rowH;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7B8499';
  ctx.font = `400 12px ${POSTER_FONT}`;
  ctx.fillText('来自科室排班表 · 只显示位置和搭档', 34, footY + 38);
  ctx.textAlign = 'right';
  ctx.font = `600 11px ${POSTER_FONT}`;
  ctx.fillText('查班小助手', W - 34, footY + 38);

  return canvas;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 把 canvas 交给系统分享面板；不支持文件分享时退回下载。 */
async function shareCanvas(canvas, text, filename) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    toast('生成图片失败');
    return;
  }
  let file = null;
  try {
    if (typeof File !== 'undefined') {
      file = new File([blob], filename, { type: 'image/png' });
    }
  } catch (e) {
    file = null;
  }
  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '查班小助手', text });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  downloadBlob(blob, filename);
  toast('已生成图片，长按可保存或转发');
}

async function shareWeekImage() {
  if (state.kind === 'reporter') {
    toast('报告员的排班请先查询，在结果弹窗里点「分享」');
    return;
  }
  if (!state.days.length) {
    toast('先导入排班表');
    return;
  }
  const canvas = buildWeekPoster();
  const range = weekRangeLabel(state.days);
  const who = store.get(K.name, '');
  const text = (who ? who + ' ' : '') + '本周排班' + (range ? '（' + range + '）' : '');
  const filename = '查班-' + (range || '本周') + '.png';
  await shareCanvas(canvas, text, filename);
}

async function shareReporterImage() {
  if (!reporterShare || !reporterShare.days.length) {
    toast('先查一个报告员');
    return;
  }
  const { name, days } = reporterShare;
  const range = weekRangeLabel(days);
  const text = (name ? name + ' ' : '') + '本周报告员排班' + (range ? '（' + range + '）' : '');
  const filename = '查班-报告员-' + (range || '本周') + '.png';
  await shareCanvas(buildReporterPoster(name, days), text, filename);
}

// ---------- 初始化 ----------
async function init() {
  applyTheme(store.get(K.theme, 'system'), false);
  await loadModules();
  loadCachedWeek();
  refreshFileStatus();
  setKind(state.kind);
  paintCalSwitch();
  paintWeekBar();
  // 周切换（首页 + 诊室弹窗各一条）
  $('weekBar').onclick = openWeekPicker;
  $('weekBarRooms').onclick = openWeekPicker;
  $('btnCloseWeek').onclick = () => $('dlgWeek').close();
  for (const goId of ['weekBarGo', 'weekBarRoomsGo']) {
    $(goId).addEventListener('click', (e) => {
      e.stopPropagation();
      setWeek('');
    });
  }
  // 姓名框默认留空：当前查的人记在 K.name 里（周数据按它渲染），
  // 但不往输入框回填——用户点进来就是要自己输入。
  $('nameInput').value = '';
  $('leadInput').value = store.get(K.lead, '30');

  $('btnImport').onclick = () => $('filePicker').click();
  $('btnImportEmpty').onclick = () => $('filePicker').click();
  $('filePicker').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) handleFile(f);
  };
  $('pickDoctor').onclick = () => importAs('doctor');
  $('pickReporter').onclick = () => importAs('reporter');
  $('btnQuery').onclick = onQuery;
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') onQuery(); });
  // 注意别把 click 事件当参数传进去（会被当成 days），一定要包一层
  $('btnCalendar').onclick = () => exportCalendar();
  // 首页「医生日历提醒」：开关样式，只导出首页这一周的医生班次（报告员在结果弹窗里单独导出）
  $('calSw').onclick = toggleCalSwitch;
  $('repCalSw').onclick = toggleRepCal;
  $('btnShare').onclick = shareWeekImage;
  $('btnShareReporter').onclick = shareReporterImage;
  document.querySelectorAll('#setThemeSeg button').forEach((b) => {
    b.onclick = () => {
      applyTheme(b.dataset.theme);
      toast('外观已切换');
    };
  });
  $('btnWeather').onclick = () => ensureWeather(state.days, true).then(() => {
    if (state.days.length) toast('天气已刷新');
  });
  $('btnSaveLead').onclick = () => saveLead($('leadInput').value);
  $('btnCloseLead').onclick = () => closeLeadDialog(null);
  // 关掉弹窗（含 ESC / 点外部）都当取消，别让开关流程一直等
  $('dlgLead').addEventListener('close', () => closeLeadDialog(null));
  // 报告员弹窗的开关自己处理（会先弹提醒时间）
  buildLeadPresets();
  paintLead();
  $('btnSettings').onclick = () => {
    refreshFileStatus();
    $('setVersion').textContent = appVersionLabel() + ' ›';
    $('dlgSettings').showModal();
  };
  $('btnCloseSettings').onclick = () => $('dlgSettings').close();
  $('rowVersion').onclick = () => {
    $('dlgSettings').close();
    openVersionDialog();
  };
  $('btnCloseVersion').onclick = () => $('dlgVersion').close();
  $('btnForceRefreshVersion').onclick = () => {
    $('dlgVersion').close();
    hardReload();
  };
  $('btnCopyUpdateLink').onclick = copyApkLink;
  $('btnCopyApkFromSettings').onclick = copyApkLink;
  $('btnOpenApkPage').onclick = () => {
    window.open(ANDROID_APK_URL, '_blank', 'noopener');
  };
  $('btnOpenUpdatePage').onclick = () => {
    window.open(ANDROID_APK_URL, '_blank', 'noopener');
  };
  $('btnHardReload').onclick = () => {
    $('dlgSettings').close();
    hardReload();
  };
  $('btnRefresh').onclick = () => {
    const btn = $('btnRefresh');
    if (btn.classList.contains('has-update')) {
      hardReload();
    } else {
      refreshAll();
    }
  };
  $('buildLine').textContent =
    appVersionLabel() + ' · 安卓同步 v' + ANDROID_VERSION + ' · 构建 ' + appBuild();
  $('btnSelfCheck').onclick = runSelfCheck;
  checkForUpdate();

  $('btnGuide').onclick = () => {
    $('dlgSettings').close();
    $('dlgGuide').showModal();
  };
  $('btnCloseGuide').onclick = () => $('dlgGuide').close();
  $('btnClear').onclick = () => {
    if (!confirm('清空本机的表、姓名和天气缓存？')) return;
    // 历史周的矩阵是前缀键（sa.histD.<首日>），K 里只有索引，得单独删
    const hist = histIndex();
    Object.values(K).forEach((k) => store.del(k));
    for (const e of hist) {
      store.del(K.histD + e.key);
      store.del(K.histR + e.key);
    }
    invalidateReporter();
    state.weather = {};
    state.weatherAt = 0;
    state.days = [];
    state.weekKey = '';
    reporterShare = null;
    paintWeekBar();
    $('nameInput').value = '';
    renderList([]);
    refreshFileStatus();
    applyTheme('system', false);
    $('dlgSettings').close();
    toast('已清空');
  };
  document.querySelectorAll('#seg button').forEach((b) => {
    b.onclick = () => setKind(b.dataset.kind);
  });

  // 有缓存就先显示，再后台补天气。
  // 上次停在历史周的话，直接按归档矩阵重算，别拿本周缓存凑数。
  if (state.weekKey) {
    if (doctorRowsOf(state.weekKey) && store.get(K.name, '')) {
      await renderWeek();
    }
  } else if (state.days.length) {
    renderList(state.days);
    ensureWeather(state.days);
  } else if (store.json(K.doctorRows, null) && store.get(K.name, '')) {
    await renderWeek();
  }

  $('btnClosePerson').onclick = () => {
    $('dlgPerson').close();
    reporterShare = null;
    $('btnShareReporter').style.display = 'none';
    setRepCalVisible(false);
    setCalStatus('');
  };
  $('btnRooms').onclick = openRooms;
  $('btnCloseRooms').onclick = () => $('dlgRooms').close();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });

  // 注册 service worker（断网也能打开）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// 自检：把当前导入的表过一遍规则，直接告诉用户在浏览器里到底认出了什么
function runSelfCheck() {
  const lines = [];
  const doctorRows = store.json(K.doctorRows, null);
  const reporterRows = store.json(K.reporterRows, null);
  lines.push('版本：' + appVersionLabel() + ' · 构建 ' + appBuild());
  lines.push('');

  if (!doctorRows) {
    lines.push('还没导入医生排班表');
    alert(lines.join('\n'));
    return;
  }
  if (!mod.parser || !mod.rooms) {
    lines.push('解析模块没加载成功（可能是缓存问题，点「强制刷新」再试）');
    alert(lines.join('\n'));
    return;
  }

  // 扫全表，统计带标记的单元格
  const marks = [];
  for (const row of doctorRows) {
    for (const cell of row) {
      if (!cell) continue;
      const mark = mod.parser.roomMark(cell);
      if (mark) marks.push(cell + ' → ' + mod.parser.canonicalRoom(cell) + '（人名后标：' + mark + '）');
    }
  }
  lines.push('医生表行数：' + doctorRows.length);
  lines.push('检测到带标记的单元格：' + marks.length + ' 个');
  marks.slice(0, 8).forEach((m) => lines.push('  · ' + m));
  if (marks.length > 8) lines.push('  · …还有 ' + (marks.length - 8) + ' 个');
  lines.push('');

  const rep = getReporterResult();
  let rooms = [];
  try {
    rooms = mod.rooms.buildRooms(doctorRows, rep);
  } catch (e) {
    lines.push('诊室读取失败：' + e.message);
    alert(lines.join('\n'));
    return;
  }
  const merged = rooms.filter((r) => r.forms.length > 1);
  lines.push('诊室总数：' + rooms.length + '，其中合并了多种写法的：' + merged.length + ' 个');
  merged.slice(0, 10).forEach((r) => lines.push('  · ' + r.display + ' ← ' + r.forms.join('、')));
  if (merged.length > 10) lines.push('  · …还有 ' + (merged.length - 10) + ' 个');
  lines.push('');

  // 抽查：合并后的「培训」诊室，明细里有没有 （培训）
  const trainRoom = merged.find((r) => r.forms.some((x) => x.includes('培训')));
  if (!trainRoom) {
    lines.push('提示：这张表里没有「（培训）」的写法，所以看不到（培训）标记。');
  } else {
    const detail = mod.rooms.roomDetail(doctorRows, rep, trainRoom.key);
    let tagged = 0;
    const sample = [];
    for (const day of detail.days) {
      for (const half of [day.am, day.pm]) {
        for (const name of (half.doctors || [])) {
          if (name.includes('培训')) {
            tagged++;
            if (sample.length < 5) sample.push(day.weekLabel + ' ' + name);
          }
        }
      }
    }
    lines.push('抽查「' + trainRoom.display + '」：带（培训）的人次 ' + tagged);
    sample.forEach((s) => lines.push('  · ' + s));
  }

  // 报告员表
  if (reporterRows) {
    const rep2 = mod.parser.parseReporter(reporterRows);
    if (rep2.ok) lines.push('', '报告员表：' + rep2.entries.length + ' 人');
  }

  alert(lines.join('\n'));
}

async function hardReload() {
  toast('正在刷新到最新版…');
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (e) {
    // 能清多少清多少
  }
  location.replace(location.pathname + '?fresh=' + Date.now());
}

function appBuild() {
  return self.__APP_BUILD__ || 'dev';
}

function appVersionLabel() {
  return 'v' + (self.__APP_VERSION__ || APP_VERSION) + '（网页版）';
}

/** 复制文本；老浏览器没有 Clipboard API 时退回 textarea + execCommand。 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 继续走下面的兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

async function copyApkLink() {
  const ok = await copyText(ANDROID_APK_URL);
  if (ok) {
    toast('安卓安装包直链已复制，发给用安卓的同事即可');
  } else {
    window.prompt('复制失败，请长按/全选下面的链接手动复制：', ANDROID_APK_URL);
  }
}

function openVersionDialog() {
  $('verSub').textContent = appVersionLabel() + ' · 构建 ' + appBuild();
  $('verPwa').textContent = 'v' + (self.__APP_VERSION__ || APP_VERSION);
  $('verAndroid').textContent = 'v' + ANDROID_VERSION;
  $('verLink').textContent = ANDROID_APK_URL;
  const notesEl = $('verNotes');
  notesEl.textContent = '';
  for (const line of APP_NOTES) {
    const li = document.createElement('li');
    li.textContent = line;
    notesEl.appendChild(li);
  }
  $('verLegacy').textContent = LEGACY_NOTICE;
  $('dlgVersion').showModal();
}

// 拉一次线上 index.html，比对构建戳；不一样就把首页按钮点亮
let updateCheckBusy = false;
async function checkForUpdate() {
  if (updateCheckBusy) return;
  updateCheckBusy = true;
  try {
    const res = await fetch(location.pathname + '?upt=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/<!-- build:([^>]*) -->/);
    if (!m) return;
    const remote = m[1].trim();
    const local = appBuild();
    if (remote && local && remote !== local) {
      const btn = $('btnRefresh');
      if (!btn) return;
      btn.classList.add('has-update');
      btn.setAttribute('title', '有新版本：本地 ' + local + ' → 线上 ' + remote);
    }
  } catch (e) {
    // 离线或网络差：保持原样
  } finally {
    updateCheckBusy = false;
  }
}

// 夜班岗位：和诊室一样是可搜索条目，点开看本周每天是谁
const SHIFT_ENTRIES = [
  { token: '夜', note: '总院夜班' },
  { token: '东夜', note: '东院夜班' },
  { token: '西夜', note: '西院夜班' },
  { token: '东夜辅', note: '东院夜辅' },
];

/** 某一周的报告员解析结果（'' = 当前这份），诊室明细按周配对要用。 */
function reporterResultOf(weekKey) {
  if (!weekKey) return getReporterResult();
  const rows = reporterRowsOf(weekKey);
  if (!rows || !mod.parser?.parseReporter) return null;
  const r = mod.parser.parseReporter(rows);
  return r.ok ? r : null;
}

async function openRooms() {
  const wk = state.weekKey || '';
  const doctorRows = doctorRowsOf(wk);
  if (!doctorRows) { toast(wk ? '这一周没有存档的医生表' : '先导入医生排班表'); return; }
  if (!mod.rooms?.buildRooms) { toast('诊室模块未就绪'); return; }
  const rep = reporterResultOf(wk);
  let rooms = [];
  try {
    rooms = mod.rooms.buildRooms(doctorRows, rep);
  } catch (e) {
    toast('诊室读取失败：' + e.message);
    return;
  }
  // 夜班排在诊室**后面**（v3.29 取消置顶）：靠分类文字和图标区分，搜「夜」照样一次筛出来
  const all = [
    ...rooms.map((r) => ({ ...r, kind: 'room' })),
    ...SHIFT_ENTRIES.map((s) => ({
      kind: 'shift',
      key: 'shift:' + s.token,
      token: s.token,
      display: s.token,
      note: s.note,
      forms: [],
    })),
  ];
  const listEl = $('roomList');
  const draw = (q) => {
    const query = String(q || '').trim();
    const shown = query === '' ? all : all.filter((r) => {
      const hay = [r.display, r.key, r.note || '', ...(r.forms || [])].join(' ');
      return hay.includes(query);
    });
    listEl.innerHTML = '';
    if (!shown.length) {
      listEl.innerHTML = '<p class="hint" style="padding:12px 6px">没有匹配的诊室或夜班</p>';
      return;
    }
    for (const r of shown.slice(0, 140)) {
      const b = document.createElement('button');
      if (r.kind === 'shift') {
        b.innerHTML = `<b>🌙 ${escapeHtml(r.display)}</b>`
          + `<span class="hint" style="display:block;font-size:11.5px">${escapeHtml(r.note)} · 点开看${escapeHtml(weekTitleOf(wk))}</span>`;
        b.onclick = () => showShiftDetail(doctorRows, r.token, r.note);
      } else {
        const forms = (r.forms || []).filter((f) => f && f !== r.display);
        b.innerHTML = escapeHtml(r.display)
          + (forms.length ? `<span class="hint" style="display:block;font-size:11.5px">表内写法：${escapeHtml(forms.join('、'))}</span>` : '');
        b.onclick = () => showRoomDetail(doctorRows, rep, r);
      }
      listEl.appendChild(b);
    }
  };
  // 关键字留在本机（v3.29）：关掉弹窗再打开、切了周都还在
  const lastQuery = store.get(K.roomQuery, '');
  $('roomSearch').value = lastQuery;
  $('roomSearch').oninput = (e) => {
    store.set(K.roomQuery, e.target.value);
    draw(e.target.value);
  };
  paintWeekBar();
  draw(lastQuery);
  $('dlgRooms').showModal();
}

/** 夜班：本周七天每天谁排这个班（没人排写 —）。 */
function showShiftDetail(doctorRows, token, note) {
  if (!mod.rooms?.shiftRoster) { toast('夜班模块未就绪，请强制刷新网页版'); return; }
  let r;
  try {
    r = mod.rooms.shiftRoster(doctorRows, token);
  } catch (e) {
    toast('夜班读取失败：' + e.message);
    return;
  }
  if (!r.ok) { toast(r.error || '读不到排班表'); return; }
  const today = todayYmd();
  const listEl = $('roomList');
  listEl.innerHTML = '';
  const back = document.createElement('button');
  back.textContent = '‹ 返回诊室列表';
  back.style.color = 'var(--brand)';
  back.onclick = openRooms;
  listEl.appendChild(back);
  const title = document.createElement('p');
  title.style.cssText = 'font-weight:700;margin:8px 6px';
  title.textContent = `${note}（${r.token}） · ${weekTitleOf(state.weekKey)}`;
  listEl.appendChild(title);
  for (const d of r.days) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px 6px;border-bottom:1px solid var(--border)';
    const isToday = !state.weekKey && d.ymd === today;
    div.innerHTML = `<b>${escapeHtml(d.week)}　${escapeHtml(d.date)}</b>`
      + (isToday ? '<span class="night-today-tag" style="margin-left:6px">今晚</span>' : '')
      + `<br><span class="day-line">${d.names.length ? namesHtml(d.names) : '<span class="hint">—</span>'}</span>`;
    listEl.appendChild(div);
  }
}

function showRoomDetail(doctorRows, rep, room) {
  const detail = mod.rooms.roomDetail(doctorRows, rep, room.key);
  const listEl = $('roomList');
  if (!detail.ok) { toast(detail.error || '查不到'); return; }
  const isMidRoom = detail.mid === true;
  listEl.innerHTML = '';
  const back = document.createElement('button');
  back.textContent = '‹ 返回诊室列表';
  back.style.color = 'var(--brand)';
  back.onclick = openRooms;
  listEl.appendChild(back);
  const title = document.createElement('p');
  title.style.cssText = 'font-weight:700;margin:8px 6px';
  title.textContent = detail.display + ' · ' + weekTitleOf(state.weekKey);
  listEl.appendChild(title);
  for (const d of detail.days) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px 6px;border-bottom:1px solid var(--border)';
    if (isMidRoom) {
      // 中班类诊室：中午这一班，不按上午/下午拆
      div.innerHTML = `<b>${escapeHtml(d.weekLabel)}　${escapeHtml(d.dateLabel)}</b><br>`
        + `<span class="day-line">${midLine(d.am, d.pm)}</span>`;
    } else {
      div.innerHTML = `<b>${escapeHtml(d.weekLabel)}　${escapeHtml(d.dateLabel)}</b><br>`
        + `<span class="day-line">上午：${detailHalf(d.am)}</span><br>`
        + `<span class="day-line">下午：${detailHalf(d.pm)}</span>`;
    }
    listEl.appendChild(div);
  }
}

function highlightMark(name) {
  const m = String(name).match(/^(.*?)(（(?:培训|听)）)$/);
  if (!m) return escapeHtml(name);
  return escapeHtml(m[1]) + '<b class="name-mark">' + escapeHtml(m[2]) + '</b>';
}

function namesHtml(list) {
  return list.map(highlightMark).join('、');
}

// 中班类诊室：上午/下午合成一行
function midLine(am, pm) {
  const docs = [...new Set([...(am?.doctors || []), ...(pm?.doctors || [])].filter(Boolean))];
  const reps = [...new Set([...(am?.reporters || []), ...(pm?.reporters || [])].filter(Boolean))];
  if (!docs.length && !reps.length) return '—';
  let s = docs.length ? namesHtml(docs) : '—';
  if (reps.length) s += '　·　搭档：' + namesHtml(reps);
  return s;
}

function detailHalf(half) {
  if (!half) return '—';
  const docs = (half.doctors || []).filter(Boolean);
  const reps = (half.reporters || []).filter(Boolean);
  if (!docs.length && !reps.length) return '—';
  let s = docs.length ? namesHtml(docs) : '—';
  if (reps.length) s += '　·　搭档：' + namesHtml(reps);
  return s;
}

function loadCachedWeek() {
  const days = store.json(K.days, []);
  if (Array.isArray(days) && days.length) {
    state.days = days;
  }
}

self.__APP_VERSION__ = APP_VERSION;
self.__APP_BUILD__ = '2026-10-26T21:50:43';
document.addEventListener('DOMContentLoaded', init);
