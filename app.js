// 查班小助手 PWA —— 主逻辑
// 解析全部在本地完成（js/xlsx.js、js/xls.js、js/parser.js、js/rooms.js），数据只存 localStorage。

import { fetchWeather } from './weather.js';

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
};

const TYPE_STYLE = {
  DAY: { bg: '#EAF0FF', fg: '#3D5AF1', label: '白班' },
  MID: { bg: '#E3F6F3', fg: '#0E8C7F', label: '中班' },
  NIGHT: { bg: '#F0EAFF', fg: '#6A45F5', label: '夜班' },
  OFF_NIGHT: { bg: '#FFF0E2', fg: '#F07B2E', label: '下夜' },
  REST: { bg: '#EDF1F6', fg: '#74829B', label: '休息' },
};

const $ = (id) => document.getElementById(id);
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

function getReporterResult() {
  if (repCache !== null) return repCache;
  const rows = store.json(K.reporterRows, null);
  if (!rows || !mod.parser?.parseReporter) return null;
  const r = mod.parser.parseReporter(rows);
  repCache = r.ok ? r : null;
  return repCache;
}

function invalidateReporter() { repCache = null; }
let state = {
  days: [],
  reporterDays: null,   // 报告员查询结果
  kind: store.get(K.kind, 'doctor'),
  weather: store.json(K.weather, {}),
  weatherAt: Number(store.get(K.weatherAt, '0')),
};

// ---------- 工具 ----------
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
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
  await load('xlsx', './xlsx.js');
  await load('xls', './xls.js');
  await load('parser', './parser.js');
  await load('rooms', './rooms.js');
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
    toast(`报告员表导入成功：${rep.entries.length} 人`);
    refreshFileStatus();
    await renderWeek({ keepName: true });
    return;
  }

  store.setJson(K.doctorRows, rows);
  store.set(K.doctorFile, fileName);
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
  const rows = store.json(K.doctorRows, null);
  const name = store.get(K.name, '');
  if (!rows) { renderList([]); return; }
  if (!name) { renderList([]); return; }
  if (!mod.parser?.parseDoctor) { renderList([]); return; }

  const res = mod.parser.parseDoctor(rows, name, Number(store.get(K.lead, '30')));
  if (!res.ok) {
    renderList([]);
    if (res.error) toast(res.error);
    return;
  }
  state.days = res.days;
  store.setJson(K.days, res.days);
  renderList(res.days);
  ensureWeather(res.days);
}

function renderList(days) {
  const list = $('weekList');
  list.innerHTML = '';
  $('empty').style.display = days.length ? 'none' : 'block';
  if (!days.length) return;

  const today = todayYmd();
  const reporterDays = state.reporterDays;

  for (const d of days) {
    const style = TYPE_STYLE[d.type] || TYPE_STYLE.REST;
    const el = document.createElement('section');
    el.className = 'day';

    const weatherText = state.weather[d.ymd] || '';
    const past = d.ymd && d.ymd < today;
    const isToday = d.ymd === today;
    let pair = null;
    if (d.type !== 'REST' && mod.parser?.pairLabel) {
      try { pair = mod.parser.pairLabel(getReporterResult(), d.raw, d.ymd); } catch { pair = null; }
    }

    el.innerHTML = `
      <div class="day-head">
        <div class="dateblock" style="background:${style.bg};color:${style.fg}">
          <span class="w">${d.weekLabel || weekOf(d.ymd)}</span>
          <span class="d">${d.ymd ? Number(d.ymd.slice(5, 7)) + '.' + Number(d.ymd.slice(8, 10)) : ''}</span>
        </div>
        <span class="badge" style="background:${style.bg};color:${style.fg}">${style.label}</span>
      </div>
      <p class="day-raw">${escapeHtml(d.raw || '（单元格为空）')}</p>
      ${d.workInfo ? `<p class="day-line">${escapeHtml(d.workInfo)}</p>` : ''}
      ${d.startTime ? `<p class="day-line">上班 ${d.startTime}${d.preTime ? ` · 提醒 ${d.preTime}` : ''}${isToday ? '<span class="today-flag">今天</span>' : ''}</p>` : ''}
      ${pair ? `<p class="day-line">搭档：${escapeHtml(pair)}</p>` : ''}
      <p class="day-weather">☁️ ${escapeHtml(weatherText || (past ? '已过' : (state.weatherAt ? '暂无预报' : '天气加载中…')))}</p>
      ${d.tips ? `<div class="day-tips">${escapeHtml(d.tips)}</div>` : ''}
    `;
    list.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 天气 ----------
let weatherBusy = false;
async function ensureWeather(days) {
  if (weatherBusy) return;
  const today = todayYmd();
  const need = days
    .filter((d) => d.ymd && d.ymd >= today && !state.weather[d.ymd])
    .map((d) => d.ymd);
  const stale = Date.now() - state.weatherAt > 6 * 3600 * 1000;
  if (!need.length && !stale) return;
  weatherBusy = true;
  try {
    const ymds = need.length ? need : days.map((d) => d.ymd).filter(Boolean);
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

// ---------- 查询 / 换人 ----------
async function pickPerson(names, onPick, title) {
  const dlg = $('dlgPerson');
  $('personTitle').textContent = title || '查谁的班';
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
  const rows = store.json(K.reporterRows, null);
  if (!rows) { toast('还没导入报告员表'); return; }
  if (!mod.parser?.parseReporter) { toast('解析模块未就绪'); return; }
  const rep = mod.parser.parseReporter(rows);
  if (!rep.ok) { toast(rep.error || '报告员表读不出来'); return; }
  const names = mod.parser.reporterNames(rep);
  const hit = names.find((n) => n === name) || names.find((n) => n.includes(name));
  if (!hit) { toast('报告员表里没找到「' + name + '」'); return; }
  const doctorRows = store.json(K.doctorRows, null);
  if (!doctorRows) { toast('还没导入医生排班表'); return; }
  const res = mod.parser.reporterWeek(doctorRows, rep, hit);
  if (!res.ok) { toast(res.error || '查不到'); return; }
  showReporterWeek(hit, res.days);
}

function showReporterWeek(name, days) {
  const dlg = $('dlgPerson');
  $('personTitle').textContent = name + ' · 本周';
  $('personSearch').style.display = 'none';
  const listEl = $('personList');
  listEl.innerHTML = '';
  for (const d of days) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px 6px;border-bottom:1px solid var(--border)';
    div.innerHTML = `<b>${escapeHtml(d.weekLabel)}　${escapeHtml(d.dateLabel)}</b><br>`
      + `<span class="day-line">上午：${escapeHtml(placeText(d.am))}</span><br>`
      + `<span class="day-line">下午：${escapeHtml(placeText(d.pm))}</span>`;
    listEl.appendChild(div);
  }
  dlg.showModal();
}

function placeText(half) {
  if (!half || !half.place || half.place === '休') return '休息';
  const partners = (half.partners || []).join('、');
  return half.place + (partners ? `　·　搭档：${partners}` : '');
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

async function exportCalendar() {
  if (!state.days.length) { toast('先导入排班表'); return; }
  const ics = buildIcs(state.days);
  if (!ics.includes('BEGIN:VEVENT')) { toast('这一周没有需要提醒的班次'); return; }
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `查班-${state.days[0].ymd}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已生成日历文件，在“文件”里点它会导入日历');
}

// ---------- 杂项 UI ----------
function refreshFileStatus() {
  const doc = store.get(K.doctorFile, '');
  const rep = store.get(K.reporterFile, '');
  $('fileStatus').textContent = doc ? `医生表：${doc}` : '医生表：尚未导入';
  let repText = rep ? `报告员表：${rep}` : '报告员表：尚未导入';
  const repRows = store.json(K.reporterRows, null);
  if (rep && repRows && mod.parser?.parseReporter) {
    const r = mod.parser.parseReporter(repRows);
    if (r.ok) repText += `（${r.entries.length} 人）`;
  }
  $('fileStatusRep').textContent = repText;
  $('setDoctor').textContent = doc || '—';
  $('setReporter').textContent = rep || '—';
  $('setLead').textContent = store.get(K.lead, '30');
}

function setKind(kind) {
  state.kind = kind;
  store.set(K.kind, kind);
  document.querySelectorAll('#seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === kind);
  });
  $('nameInput').placeholder = kind === 'reporter' ? '报告员姓名' : '医生姓名';
  // 报告员模式下恢复输入框（可能被“报告员一周”复用）
  $('personSearch').style.display = '';
}

// ---------- 初始化 ----------
async function init() {
  await loadModules();
  loadCachedWeek();
  refreshFileStatus();
  setKind(state.kind);
  $('nameInput').value = store.get(K.name, '');
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
  $('btnCalendar').onclick = exportCalendar;
  $('btnWeather').onclick = () => ensureWeather(state.days).then(() => {
    if (state.days.length) toast('天气已刷新');
  });
  $('btnSaveLead').onclick = async () => {
    const lead = Math.max(0, Math.min(240, Number($('leadInput').value) || 30));
    store.set(K.lead, String(lead));
    $('leadInput').value = lead;
    refreshFileStatus();
    toast('已保存：上班前 ' + lead + ' 分钟提醒');
    await renderWeek();
  };
  $('btnSettings').onclick = () => {
    refreshFileStatus();
    $('setVersion').textContent = 'PWA ' + (self.__APP_VERSION__ || '1.0');
    $('dlgSettings').showModal();
  };
  $('btnCloseSettings').onclick = () => $('dlgSettings').close();
  $('btnClear').onclick = () => {
    if (!confirm('清空本机的表、姓名和天气缓存？')) return;
    Object.values(K).forEach((k) => store.del(k));
    invalidateReporter();
    state.weather = {};
    state.weatherAt = 0;
    state.days = [];
    $('nameInput').value = '';
    renderList([]);
    refreshFileStatus();
    $('dlgSettings').close();
    toast('已清空');
  };
  document.querySelectorAll('#seg button').forEach((b) => {
    b.onclick = () => setKind(b.dataset.kind);
  });

  // 有缓存就先显示，再后台补天气
  if (state.days.length) {
    renderList(state.days);
    ensureWeather(state.days);
  } else if (store.json(K.doctorRows, null) && store.get(K.name, '')) {
    await renderWeek();
  }

  $('btnClosePerson').onclick = () => $('dlgPerson').close();
  $('btnRooms').onclick = openRooms;
  $('btnCloseRooms').onclick = () => $('dlgRooms').close();

  // 注册 service worker（断网也能打开）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function openRooms() {
  const doctorRows = store.json(K.doctorRows, null);
  if (!doctorRows) { toast('先导入医生排班表'); return; }
  if (!mod.rooms?.buildRooms) { toast('诊室模块未就绪'); return; }
  const rep = getReporterResult();
  let all = [];
  try {
    all = mod.rooms.buildRooms(doctorRows, rep);
  } catch (e) {
    toast('诊室读取失败：' + e.message);
    return;
  }
  const listEl = $('roomList');
  const draw = (q) => {
    const shown = mod.rooms.searchRooms ? mod.rooms.searchRooms(all, q || '') : all;
    listEl.innerHTML = '';
    if (!shown.length) {
      listEl.innerHTML = '<p class="hint" style="padding:12px 6px">没有匹配的诊室</p>';
      return;
    }
    for (const r of shown.slice(0, 120)) {
      const b = document.createElement('button');
      const forms = (r.forms || []).filter((f) => f && f !== r.display);
      b.innerHTML = escapeHtml(r.display)
        + (forms.length ? `<span class="hint" style="display:block;font-size:11.5px">表内写法：${escapeHtml(forms.join('、'))}</span>` : '');
      b.onclick = () => showRoomDetail(doctorRows, rep, r);
      listEl.appendChild(b);
    }
  };
  $('roomSearch').value = '';
  $('roomSearch').oninput = (e) => draw(e.target.value);
  draw('');
  $('dlgRooms').showModal();
}

function showRoomDetail(doctorRows, rep, room) {
  const detail = mod.rooms.roomDetail(doctorRows, rep, room.key);
  const listEl = $('roomList');
  if (!detail.ok) { toast(detail.error || '查不到'); return; }
  listEl.innerHTML = '';
  const back = document.createElement('button');
  back.textContent = '‹ 返回诊室列表';
  back.style.color = 'var(--brand)';
  back.onclick = openRooms;
  listEl.appendChild(back);
  const title = document.createElement('p');
  title.style.cssText = 'font-weight:700;margin:8px 6px';
  title.textContent = detail.display + ' · 本周';
  listEl.appendChild(title);
  for (const d of detail.days) {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px 6px;border-bottom:1px solid var(--border)';
    div.innerHTML = `<b>${escapeHtml(d.weekLabel)}　${escapeHtml(d.dateLabel)}</b><br>`
      + `<span class="day-line">上午：${escapeHtml(detailHalf(d.am))}</span><br>`
      + `<span class="day-line">下午：${escapeHtml(detailHalf(d.pm))}</span>`;
    listEl.appendChild(div);
  }
}

function detailHalf(half) {
  if (!half) return '—';
  const docs = (half.doctors || []).filter(Boolean);
  const reps = (half.reporters || []).filter(Boolean);
  if (!docs.length && !reps.length) return '—';
  let s = docs.length ? docs.join('、') : '—';
  if (reps.length) s += `　·　搭档：${reps.join('、')}`;
  return s;
}

function loadCachedWeek() {
  const days = store.json(K.days, []);
  if (Array.isArray(days) && days.length) {
    state.days = days;
  }
}

self.__APP_VERSION__ = '1.0';
document.addEventListener('DOMContentLoaded', init);
