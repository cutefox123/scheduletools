// 诊室目录 + 诊室一周明细 —— 纯浏览器 ES 模块，零依赖
//
// 由 Android 版 Java 源 RoomDirectory.java 逐条移植（诊室目录、床旁规则、
// findRoom、detail、reporterWeek），复用 parser.js 里已经移植好的表头/诊室词工具。
//
//   buildRooms(doctorMatrix, repResult) -> [{ key, display, forms: [] }]
//   roomDetail(doctorMatrix, repResult, key) -> { ok, display, days: [...] }

import {
  roomMark,
  markRoom,
  markListen,
  isListen,
  findHeader,
  jtrim,
  stripWs,
  doctorNameCol,
  halfOf,
  isRoomToken,
  primaryKey,
  canonicalRoom,
  dayLabelsOf,
} from './parser.js?v=2026-10-19T00%3A07%3A28';

// ---------------- 诊室目录 ----------------

/** 收集全部诊室：先医生表（展示名优先医生写法），再补报告员表独有的。 */
function collectRooms(doctorMatrix, repResult) {
  const h = findHeader(doctorMatrix);
  const map = new Map();
  if (h.error != null) return { h, rooms: [] };

  for (const row of doctorMatrix) {
    if (doctorNameCol(row, h.firstDateCol) < 0) continue;
    for (const dc of h.dateCols) {
      const cell = dc.col < row.length ? row[dc.col] : '';
      addRoomTokens(map, cell);
    }
  }
  if (repResult != null && Array.isArray(repResult.entries)) {
    for (const e of repResult.entries) {
      for (const cell of e.cells) addRoomTokens(map, cell);
    }
  }
  return { h, rooms: [...map.values()] };
}

function addRoomTokens(map, cell) {
  const t = stripWs(cell);
  if (t === '') return;
  const slash = t.indexOf('/');
  const am = slash >= 0 ? t.substring(0, slash) : t;
  const pm = slash >= 0 ? t.substring(slash + 1) : t;
  putRoom(map, am);
  putRoom(map, pm);
}

function putRoom(map, token) {
  if (!isRoomToken(token)) return;
  const key = primaryKey(token);
  if (key === '') return;
  // 写法本身已等于主键（如 东6、高端1、6诊）→ 优先当展示名；
  // 别名源写法（东介入门诊、高端查体1、介入门诊）次之。
  const isTarget = canonicalRoom(token) === key && roomMark(token) === '';
  const r = map.get(key);
  if (r == null) {
    map.set(key, { key, display: token, forms: [token], displayIsTarget: isTarget });
  } else {
    if (isTarget && !r.displayIsTarget) {
      r.display = token;
      r.displayIsTarget = true;
    }
    if (!r.forms.includes(token)) r.forms.push(token);
  }
}

/**
 * 收集全部诊室。对应 RoomDirectory.buildRooms 的 JSON 形态：
 * [{ key, display, forms: [写法…] }]，顺序 = 首次出现顺序。
 */
export function buildRooms(doctorMatrix, repResult) {
  const { rooms } = collectRooms(doctorMatrix, repResult);
  return rooms.map((r) => ({ key: r.key, display: r.display, forms: r.forms.slice() }));
}

/** 按规范化键找诊室（如“2期5”“东6”“6”）。 */
export function findRoom(rooms, key) {
  if (key == null || !Array.isArray(rooms)) return null;
  for (const r of rooms) {
    if (key === r.key) return r;
  }
  return null;
}

/** 模糊搜索：诊室任一写法或规范化键包含关键词（关键词同样做规范化）。 */
export function searchRooms(rooms, query) {
  const q = query == null ? '' : jtrim(query);
  if (q === '') return rooms.slice();
  const qk = canonicalRoom(q);
  const out = [];
  for (const r of rooms) {
    if (r.display.includes(q) || r.key.includes(q) || (qk !== '' && r.key.includes(qk))) {
      out.push(r);
      continue;
    }
    for (const f of r.forms) {
      if (f.includes(q)) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}

/** Java 原名 search（诊室模糊搜索），保留同名导出。 */
export { searchRooms as search };

// ---------------- 一周明细 ----------------

function addIfRoom(list, person, token, roomKey) {
  if (!isRoomToken(token)) return;
  if (primaryKey(token) !== roomKey) return;
  const tagged = markRoom(person, token);
  if (!list.includes(tagged)) list.push(tagged);
}

/** 某诊室一周明细：每天上午/下午的上机医生与配套报告员。 */
function detail(doctorMatrix, repResult, room, h) {
  const labels = dayLabelsOf(h);
  const out = labels.map((l) => ({
    weekLabel: l.weekLabel,
    dateLabel: l.dateLabel,
    am: { doctors: [], reporters: [] },
    pm: { doctors: [], reporters: [] },
  }));

  // 医生：姓名列 + 职称列可识别的人员行
  for (const row of doctorMatrix) {
    const nameCol = doctorNameCol(row, h.firstDateCol);
    if (nameCol < 0) continue;
    const doctor = jtrim(row[nameCol]);
    const n = Math.min(h.dateCols.length, out.length);
    for (let i = 0; i < n; i++) {
      const dc = h.dateCols[i];
      const cell = dc.col < row.length ? jtrim(row[dc.col]) : '';
      const t = stripWs(cell);
      if (t === '') continue;
      const slash = t.indexOf('/');
      const am = slash >= 0 ? t.substring(0, slash) : t;
      const pm = slash >= 0 ? t.substring(slash + 1) : t;
      addIfRoom(out[i].am.doctors, doctor, am, room.key);
      addIfRoom(out[i].pm.doctors, doctor, pm, room.key);
    }
  }

  // 报告员
  if (repResult != null && Array.isArray(repResult.entries)) {
    for (const e of repResult.entries) {
      const n = Math.min(h.dateCols.length, out.length, e.cells.length);
      for (let i = 0; i < n; i++) {
        const am = halfOf(e.cells[i], 0);
        const pm = halfOf(e.cells[i], 1);
        addIfRoom(out[i].am.reporters, e.name, am, room.key);
        addIfRoom(out[i].pm.reporters, e.name, pm, room.key);
      }
    }
  }
  return out;
}

/**
 * 某诊室一周明细。对应 RoomDirectory.detail(doctorMatrix, rep, room)，
 * 返回 { ok, display, days: [{ weekLabel, dateLabel, am:{doctors,reporters}, pm:{doctors,reporters} }] }。
 */
export function roomDetail(doctorMatrix, repResult, key) {
  const { h, rooms } = collectRooms(doctorMatrix, repResult);
  if (h.error != null) {
    return { ok: false, display: '', error: h.error, days: [] };
  }
  const room = findRoom(rooms, key);
  if (room == null) {
    return { ok: false, display: '', error: '没找到诊室「' + key + '」', days: [] };
  }
  return { ok: true, display: room.display, days: detail(doctorMatrix, repResult, room, h) };
}


// 报告员一周排班与 Java 的 RoomDirectory.reporterWeek 对应，按 API 归属放在 parser.js；
// 这里再导出一份，方便 import { reporterWeek } from './rooms.js?v=2026-10-19T00%3A07%3A28' 的用法。
export { reporterWeek } from './parser.js?v=2026-10-19T00%3A07%3A28';
