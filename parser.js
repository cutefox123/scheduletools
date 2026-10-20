// 排班解析 —— 纯浏览器 ES 模块，零依赖（不引用任何 node / 浏览器专属 API）
//
// 由 Android 版 Java 源逐条移植，规则一一对应：
//   * ScheduleParser.java  —— 表头定位、年份推断、单元格归类、上班时间、
//                             中班 12:00-13:30、病房 +30 分钟、冬夏令时
//   * ReporterParser.java  —— 报告员表解析、“//”归一化、中班配对、跨表别名
//
// 约定：
//   - 时间一律用“分钟数”表示（7:30 -> 450），输出时格式化为 HH:mm / H:mm；
//   - Java 的 String.trim() 只裁 <= U+0020，这里用 jtrim() 保持同一语义；
//   - Java 的 \\s 默认只含 ASCII 空白，这里用 [ \t\n\x0B\f\r] 保持同一语义。

// ---------------- 常量（对齐 ScheduleParser） ----------------

/** 门诊白班上班：07:30 */
const DAY_START_MIN = 7 * 60 + 30;
/** 夜班接班（夏令）：17:30 */
const NIGHT_START_MIN = 17 * 60 + 30;
/** 夜班交班：次日 07:30 */
const NIGHT_END_MIN = 7 * 60 + 30;
/** 中班接班：午间连班 12:00 */
const MID_START_MIN = 12 * 60;

const DATE_MD = /^(\d{1,2})[.．、\-\/](\d{1,2})$/;
const YEAR_IN_TITLE = /(20\d{2})\s*年/;
const WEEK_CELL = /^.*(星期[一二三四五六日天]).*$/;
const TITLE_RE = /^.*(医师|主任|护士|医生|技师|药师|护长|组长|专家|教授).*$/;
const DIGITS = /\d/;
/** 纯标点 / 空白：Java ^[/\\|\-—~．.、，,。\s]+$ */
const PUNCT_ONLY = /^[/\\|\-—~．.、，,。\s]+$/;
/** 高端查体N -> 高端N（两表写法不同，互为等价） */
const HIGH_END = /^高端查体(\d+)$/;

// 跨表别名：医生排班表写法（规范化后）→ 报告员排班表写法
const CROSS_ALIAS = new Map([
  ['东介入门诊', '东6'],   // 东院门诊介入
  ['2期介入1', '东介入1'], // 东院病房介入1（医生表写“二期介入1”）
  ['介入门诊', '内1'],     // 总院门诊介入
  ['西介入门诊', '西2'],   // 西院门诊介入
  ['介入', '总介入'],      // 下午“介入”即总院介入
]);

// ---------------- 字符串 / 时间工具 ----------------

/** Java String.trim()：只去掉首尾 <= U+0020 的字符。 */
export function jtrim(s) {
  if (s == null) return '';
  return String(s).replace(/^[\x00-\x20]+/, '').replace(/[\x00-\x20]+$/, '');
}

/** Java String.replaceAll("\\s+", "")：Java \\s 默认只有 ASCII 空白。 */
export function stripWs(s) {
  if (s == null) return '';
  return String(s).replace(/[ \t\n\x0B\f\r]+/g, '');
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 分钟数 -> HH:mm（Java DateTimeFormatter.ofPattern("HH:mm")）。 */
function fmtTime(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** 分钟数 -> H:mm（Java fmtShort：小时不补零，分钟补零）。 */
function fmtShort(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return Math.floor(m / 60) + ':' + pad2(m % 60);
}

// ---------------- 日期工具（等价 java.time.LocalDate） ----------------

/** 今天（本地时区），返回 {y,m,d,epochDay}。 */
function localToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return { y, m, d, epochDay: Math.floor(Date.UTC(y, m - 1, d) / 86400000) };
}

/** 合法日期 -> {y,m,d,epochDay}；与 new LocalDate 一样对非法日期返回 null。 */
export function safeDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const dt = new Date(utc);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) {
    return null;
  }
  return { y: year, m: month, d: day, epochDay: Math.floor(utc / 86400000) };
}

/** epochDay -> {y,m,d,epochDay}。 */
function dateOfEpochDay(epochDay) {
  const dt = new Date(epochDay * 86400000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    epochDay,
  };
}

/** 与 Java weekOf 一致：星期一…星期六、星期天。 */
export function weekOf(d) {
  if (d == null) return '';
  const dow = new Date(d.epochDay * 86400000).getUTCDay(); // 0=周日
  switch (dow) {
    case 1: return '星期一';
    case 2: return '星期二';
    case 3: return '星期三';
    case 4: return '星期四';
    case 5: return '星期五';
    case 6: return '星期六';
    default: return '星期天';
  }
}

/** yyyy-MM-dd */
export function isoDate(d) {
  return d.y + '-' + pad2(d.m) + '-' + pad2(d.d);
}

function normalizeWeek(s) {
  if (s == null) return '';
  return s.split('周日').join('星期天').split('周天').join('星期天');
}

/**
 * .xls 表头序列号 → 日期（1900 日期系统，纪元 1899-12-30，范围约 1954~2119 年）。
 */
export function serialToDate(cell) {
  if (cell == null || cell === '' || cell.length > 7) return null;
  // 与 Double.parseDouble 的十进制写法保持一致
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(cell)) return null;
  const v = Number(cell);
  if (!Number.isFinite(v)) return null;
  if (v < 20000 || v > 80000 || v !== Math.round(v)) return null;
  const epochDay = Math.floor(Date.UTC(1899, 11, 30) / 86400000) + v;
  return dateOfEpochDay(epochDay);
}

function hasChinese(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

// ---------------- 表头识别（ScheduleParser.findHeader） ----------------

export class DateColumn {
  constructor(col, month, day, weekLabel, fullDate) {
    this.col = col;
    this.month = month;
    this.day = day;
    this.weekLabel = weekLabel != null ? weekLabel : null;
    this.fullDate = fullDate != null ? fullDate : null;
  }
}

/**
 * 找日期表头：整行 M.d 形态（9.28）或 .xls 序列号单元格最多的那一行；
 * 同时找“星期X”行并校验年份。医生表 / 报告员表共用。
 */
export function findHeader(matrix) {
  const h = {
    dateCols: [],
    resolvedYear: localToday().y,
    firstDateCol: Number.MAX_SAFE_INTEGER,
    error: null,
  };
  if (!matrix || matrix.length === 0) {
    h.error = '表格是空的';
    return h;
  }

  let bestHeader = null;
  let bestCount = 0;
  for (const rowCells of matrix) {
    const found = [];
    for (let c = 0; c < rowCells.length; c++) {
      const cell = jtrim(rowCells[c]);
      const m = DATE_MD.exec(cell);
      if (m) {
        found.push(new DateColumn(c, parseInt(m[1], 10), parseInt(m[2], 10), null, null));
        continue;
      }
      const serial = serialToDate(cell);
      if (serial != null) {
        found.push(new DateColumn(c, serial.m, serial.d, null, serial));
      }
    }
    if (found.length > bestCount) {
      bestCount = found.length;
      bestHeader = found;
    }
  }
  if (bestHeader == null || bestCount < 3) {
    h.error = '没找到日期表头（形如 9.28、10.1 的那一行），请确认是科室排班表';
    return h;
  }

  // “星期X”行 → 列→星期标签
  let weekByCol = new Map();
  let weekHits = 0;
  for (const rowCells of matrix) {
    const one = new Map();
    for (let c = 0; c < rowCells.length; c++) {
      const m = WEEK_CELL.exec(jtrim(rowCells[c]));
      if (m) one.set(c, normalizeWeek(m[1]));
    }
    if (one.size > weekHits) {
      weekHits = one.size;
      weekByCol = one;
    }
  }

  // 表名年份（可能过期，仅作候选）
  let titleYear = -1;
  outer:
  for (const rowCells of matrix) {
    for (const cell of rowCells) {
      const m = YEAR_IN_TITLE.exec(cell == null ? '' : String(cell));
      if (m) {
        titleYear = parseInt(m[1], 10);
        break outer;
      }
    }
  }

  const year = resolveYear(bestHeader, titleYear);
  h.resolvedYear = year;
  for (const dc of bestHeader) {
    dc.weekLabel = weekByCol.has(dc.col) ? weekByCol.get(dc.col) : null;
    h.dateCols.push(dc);
    if (dc.col < h.firstDateCol) h.firstDateCol = dc.col;
  }
  return h;
}

/**
 * 候选年份打分：日期合法 +1，星期与表头一致 +10。
 * 候选顺序 今年→明年→去年→表名年；同分时取离今天更近的。
 */
function resolveYear(dateCols, titleYear) {
  const today = localToday();
  const nowYear = today.y;
  const candidates = [];
  for (const y of [nowYear, nowYear + 1, nowYear - 1, titleYear]) {
    if (y >= 2000 && !candidates.includes(y)) candidates.push(y);
  }
  let bestYear = nowYear;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const y of candidates) {
    let score = 0;
    let firstValid = null;
    for (const dc of dateCols) {
      const d = safeDate(y, dc.month, dc.day);
      if (d == null) continue;
      score++;
      if (firstValid == null) firstValid = d;
      if (dc.weekLabel != null && dc.weekLabel === weekOf(d)) score += 10;
    }
    const dist = firstValid == null ? Number.MAX_VALUE : Math.abs(firstValid.epochDay - today.epochDay);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      bestScore = score;
      bestDist = dist;
      bestYear = y;
    }
  }
  return bestYear;
}

/** 是否职称（主治医师 / 副主任医师 等），用于区分人员行与说明行。 */
export function isTitle(s) {
  return s != null && TITLE_RE.test(jtrim(s));
}

/** 全中文（每个字符都 > 127）。 */
export function isChinese(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 127) return false;
  }
  return true;
}

/**
 * 人员行识别：日期列前有一个短中文名，且紧跟着职称列。
 * 返回姓名列下标，不是人员行返回 -1。对应 RoomDirectory.doctorNameCol。
 */
export function doctorNameCol(row, firstDateCol) {
  if (!row) return -1;
  const limit = Math.min(firstDateCol, row.length);
  // 主路径：姓名 + 职称（最可靠）
  for (let i = 0; i < limit - 1; i++) {
    if (row[i] == null) continue;
    const name = jtrim(row[i]);
    if (name.length >= 2 && name.length <= 5 && isChinese(name) && isTitle(row[i + 1])) {
      return i;
    }
  }
  // 兜底：不看职称名单，看结构（2~5 字中文名 + 紧跟短标签 + 这行至少 3 天有内容）
  if (filledDayCells(row, firstDateCol) >= 3) {
    for (let i = 0; i < limit - 1; i++) {
      if (row[i] == null) continue;
      const name = jtrim(row[i]);
      if (name.length < 2 || name.length > 5 || !isChinese(name)) continue;
      const tag = row[i + 1] == null ? '' : jtrim(row[i + 1]);
      if (tag === '' || tag.length > 8 || /\d/.test(tag)) continue;
      if (ROOM_CELL_RE.test(tag)) continue;   // 后面紧跟的其实是排班内容
      return i;
    }
  }
  return -1;
}

/** 看起来像排班内容的标记，用来排除“这列不是职称列”。 */
const ROOM_CELL_RE = /.*(诊|床旁|夜|休|中|假|听|培训|手术|门诊|病房|急诊|介入).*/;

/** 这一行在日期列里填了几天内容（去掉纯符号）。 */
function filledDayCells(row, firstDateCol) {
  let n = 0;
  for (let i = firstDateCol; i < row.length; i++) {
    const c = row[i];
    if (c == null) continue;
    const t = stripWs(c);
    if (t === '' || /^[/\\|\-—~．.、，,。:：]+$/.test(t)) continue;
    n++;
  }
  return n;
}

/** 收集医生表里所有人员姓名（按表格顺序），给「选人」用。 */
export function doctorNames(doctorMatrix) {
  const out = [];
  if (!doctorMatrix || doctorMatrix.length === 0) return out;
  const h = findHeader(doctorMatrix);
  if (h.error != null) return out;
  for (const row of doctorMatrix) {
    const nameCol = doctorNameCol(row, h.firstDateCol);
    if (nameCol < 0) continue;
    const name = row[nameCol] == null ? '' : jtrim(row[nameCol]);
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 按表头生成 7 天的 weekLabel / dateLabel（诊室明细与报告员一周排班共用）。
 * 对应 RoomDirectory.detail / reporterWeek 里构造 DayDetail / AssignDay 的那段。
 */
export function dayLabelsOf(h) {
  return h.dateCols.map((dc) => {
    const d = dc.fullDate != null ? dc.fullDate : safeDate(h.resolvedYear, dc.month, dc.day);
    return {
      weekLabel: dc.weekLabel != null ? dc.weekLabel : weekOf(d),
      dateLabel: d == null ? dc.month + '月' + dc.day + '日' : d.m + '月' + d.d + '日',
    };
  });
}

// ---------------- 班次识别（ScheduleParser.fillShift / classify） ----------------

/**
 * 班次识别（按本院真实用词）：
 *  - “下”开头且含“夜”：下夜 / 下东夜 / 下西夜 / 下东夜辅 → 下夜班
 *  - 其他含“夜”：产4/夜、男1查/夜、东夜辅 → 夜班
 *  - 纯标点、空 → 休息
 *  - 带“中”字的半天/整格：中 / 中班 / 东中 / 西3/中 → 中班（午间连班 12:00 接班）
 *  - 含“假”字、公休/病休、帮扶、进修 → 休息
 *  - 含“休”字：去掉“休”后无工作内容 → 休息；还有班 → 白班
 *  - 查/诊/病/房/术/门诊/床旁/介入/行政/科研/东院记号 → 白班
 *  - 非空无法识别：保守按白班，避免漏提醒
 */
export function classify(t) {
  if (t == null || t === '') return 'REST';
  if (PUNCT_ONLY.test(t)) return 'REST';
  if (t.startsWith('下') && t.includes('夜')) return 'OFF_NIGHT';
  if (t.includes('夜')) return 'NIGHT';
  // 中班：格子里带“中”字的（中 / 中班 / 东中 / 西3/中），午间连班 12:00 接班
  if (containsMidShift(t)) return 'MID';
  // 整格休假：含“假”字（年假/事假/病假/婚假/产假…）、公休/病休、帮扶、进修 → 休息
  if (t.includes('假') || t.includes('公休') || t.includes('病休')
      || t.includes('帮扶') || t.includes('进修')) {
    return 'REST';
  }
  // 带“休”字：去掉“休”后没有工作内容才算休息
  // （“休”“休/”“调休”=休；“病3/休”“休/急2”去掉“休”还有班，按白班）
  if (t.includes('休')) {
    const remain = t.split('休').join('');
    if (PUNCT_ONLY.test(remain) || !hasWorkWord(remain)) return 'REST';
  }
  if (hasWorkWord(t)) return 'DAY';
  return 'DAY';
}

/** 是否含任何工作字样（与 DAY 判定同一套关键词）。 */
function hasWorkWord(t) {
  return t.includes('查') || t.includes('诊') || t.includes('病') || t.includes('房')
      || t.includes('术') || t.includes('门诊') || t.includes('/') || t.includes('\\')
      || t.includes('床旁') || t.includes('介入') || t.includes('行政') || t.includes('科研')
      || t.includes('东') || t.includes('西') || t.includes('产') || t.includes('妇')
      || t.includes('乳') || t.includes('急') || t.includes('麻醉')
      || DIGITS.test(t);
}

/**
 * 通知基准的上班时间：
 *  - 上午有班 → 上午上班时间（病房 8:00 / 门诊 7:30）；
 *  - 上午休但有中班 → 12:00 接班；
 *  - 上午休、下午上班 → 下午上班时间（夏令 14:00 / 冬令 13:30）。
 */
function dayStartOf(t, ymd) {
  const halves = splitHalves(t);
  const am = halves[0];
  if (isWorkHalf(am) && !isMidHalf(am)) {
    return isWardHalf(am) ? DAY_START_MIN + 30 : DAY_START_MIN;
  }
  if (isMidHalf(am) || isMidHalf(halves[1])) return MID_START_MIN;
  return pmStart(isSummerSeason(ymd));
}

/** 半天里是否有班（非空、且不是“休”）。 */
function isWorkHalf(h) {
  return h != null && h !== '' && h !== '休';
}

/** 上午半天时段文案（门诊 7:30-12:00 / 病房 8:00-12:00）；不是上班半天返回空串。 */
function morningHalf(am) {
  if (!isWorkHalf(am) || isMidHalf(am)) return '';
  const start = isWardHalf(am) ? DAY_START_MIN + 30 : DAY_START_MIN;
  return fmtShort(start) + '-12:00';
}

/** 下午半天时段文案；不是上班半天返回空串。 */
function afternoonHalf(pm, summer) {
  if (!isWorkHalf(pm) || isMidHalf(pm)) return '';
  return fmtShort(pmStart(summer)) + '-' + fmtShort(pmEnd(pm, summer));
}

/** 下午上班时间：夏令 14:00，冬令 13:30。 */
function pmStart(summer) {
  return summer ? 14 * 60 : 13 * 60 + 30;
}

/** 下午下班时间：病房比门诊晚半小时。 */
function pmEnd(pmHalf, summer) {
  const ward = isWardHalf(pmHalf);
  if (summer) return ward ? 18 * 60 : 17 * 60 + 30;
  return ward ? 17 * 60 + 30 : 17 * 60;
}

/**
 * 中班结束时间：门诊 13:30（夏令 14:00），病房按“晚半小时”再顺延 30 分钟
 * （冬令 14:00 / 夏令 14:30）。
 */
function midEnd(ward, summer) {
  const base = pmStart(summer);
  return ward ? base + 30 : base;
}

/** 中班时段文案：12:00-13:30（病房 12:00-14:00；夏令各顺延半小时）。 */
export function midRange(cell, ymd) {
  const summer = isSummerSeason(ymd);
  return fmtShort(MID_START_MIN) + '-' + fmtShort(midEnd(isWardHalf(cell), summer));
}

/**
 * 某个半天是不是中班：格子里带“中”字（中 / 中班 / 东中 / 西中 / 值中）。
 * 只认“中”加上院区前缀（东/西/南/北/总/院）、“班”字和“值”（分诊台中午班），
 * 避免把“中医门诊”“中午急诊床旁”这类说明文字当成中班。
 */
export function isMidHalf(half) {
  return midKey(half) !== '';
}

/**
 * 中班的规范写法：“中”“中班”→“中”，“东中”“西中”“值中”原样返回；
 * 不是中班返回空串。两表把中午班写在不同半天时，就靠这个键对上。
 */
export function midKey(half) {
  if (half == null) return '';
  const t = stripWs(half).split('中班').join('中');
  if (!t.includes('中')) return '';
  // 中班可能写在整格的一半（“西3/中”“东3/中”）：先找到含“中”的那一段，
  // 再结合整格里的院区前缀判断。带西=西中，带东=东中，都不带=总院中。
  for (const seg of t.split(/[/\\|\-—~．.、，,。]/)) {
    if (!seg.includes('中')) continue;
    let rest = seg.split('中').join('');
    for (const ch of ['东', '西', '南', '北', '总', '院', '值']) rest = rest.split(ch).join('');
    if (rest !== '') continue;
    if (seg.includes('西')) return '西中';
    if (seg.includes('东')) return '东中';
    if (seg.includes('南')) return '南中';
    if (seg.includes('北')) return '北中';
    if (seg.includes('值')) return '值中';
    if (t.includes('西')) return '西中';
    if (t.includes('东')) return '东中';
    return '中';
  }
  return '';
}

function collectMidReporters(data, di, mid, out) {
  for (const e of data.entries) {
    if (di >= e.cells.length) continue;
    const cell = e.cells[di];
    if (mid !== midKey(cell)) continue;
    const am = halfOf(cell, 0);
    const pm = halfOf(cell, 1);
    const place = mid === midKey(am) ? am : (mid === midKey(pm) ? pm : am);
    const tagged = markRoom(e.name, place);
    if (!out.includes(tagged)) out.push(tagged);
  }
}

/** 整行带“西”时，裸“中”按西中处理。 */
export function effectiveMid(cell, rowHasWest) {
  const k = midKey(cell);
  return k === '中' && rowHasWest ? '西中' : k;
}

/** 中班配对键：中/东中/西中/南中/北中 都按“中”配对，值中单独一类。 */
export function midPairKey(half) {
  const k = midKey(half);
  if (k === '') return '';
  return k === '值中' ? k : '中';
}

/** 整格（可能带“/”）里是否有半天是中班。 */
export function containsMidShift(cell) {
  const t = stripWs(cell);
  const halves = splitHalves(t);
  return isMidHalf(halves[0]) || isMidHalf(halves[1]);
}

/** 排班格上午半天是否有班（中班本身不算上午班）。 */
export function morningHasShift(cell) {
  const t = stripWs(cell);
  const halves = splitHalves(t);
  return isWorkHalf(halves[0]) && !isMidHalf(halves[0]);
}

/**
 * 上班时间段文案，按“/”拆成上午、下午两个半天，统一直接打时间段：
 *  - 门诊半天：夏令（5.1~9.30）7:30-12:00 / 14:00-17:30，
 *              冬令（10.1~次年4.30）7:30-12:00 / 13:30-17:00；
 *  - 病房半天：早上与傍晚下班都比门诊晚半小时，12:00 与下午上班时间固定；
 *  - 中班半天：12:00-13:30（冬令；夏令顺延到 14:00），病房按“晚半小时”规则；
 *  - 有“/”时空的一半=那半天休息；无“/”整格=全天；“休”显式表示那半天休。
 */
export function dayWorkTimes(cell, ymd) {
  const t = stripWs(cell);
  const summer = isSummerSeason(ymd);
  const halves = splitHalves(t);
  const am = halves[0];
  const pm = halves[1];

  // 整格都是中班（“中”“东中”“中班”）：只有一段中班时段
  if (!t.includes('/') && isMidHalf(t)) return midRange(t, ymd);

  let sb = '';
  const amText = morningHalf(am);
  if (amText !== '') sb += amText;
  if (isMidHalf(am) || isMidHalf(pm)) {
    if (sb !== '') sb += ' / ';
    sb += midRange(t, ymd);
  }
  const pmText = afternoonHalf(pm, summer);
  if (pmText !== '') {
    if (sb !== '') sb += ' / ';
    sb += pmText;
  }
  return sb;
}

/**
 * 夜班文案：“/”前若带上午半天班（男1查/夜、产4/夜、病3/夜、介入/夜 等），
 * 先按半天规则写上午上班时间段，再接夜班时段；纯夜班仍只显示夜班时段。
 */
export function nightWorkInfo(cell, ymd) {
  const t = stripWs(cell);
  let prefix = '';
  if (nightHasDaytimeHalf(t)) {
    const am = jtrim(t.substring(0, t.indexOf('/')));
    const amText = morningHalf(am);
    prefix = amText === '' ? '' : amText + ' / ';
  }
  const start = isSummerSeason(ymd) ? '17:30' : '17:00';
  return prefix + '夜班：' + start + '-次日07:30（07:30交完班下班）';
}

/** 夜班格“/”前是否带上午半天班（男1查/夜 有；东夜、/夜、休/夜 没有）。 */
export function nightHasDaytimeHalf(cell) {
  const t = stripWs(cell);
  if (!t.includes('/')) return false;
  const am = jtrim(t.substring(0, t.indexOf('/')));
  return am !== '' && am !== '休';
}

/**
 * 某个半天是否病房班：含“病”或“二期”算病房；
 * 含“介入”也算病房，但“介入门诊”例外——它按门诊半天算。
 */
function isWardHalf(h) {
  if (h == null || h === '' || h === '休') return false;
  if (h.includes('介入')) return !h.includes('门诊');
  return h.includes('病') || h.includes('二期');
}

/**
 * 把排班格拆成上午/下午两半：“/”前为上午、“/”后为下午。
 * 有“/”时，空的一半=那半天休息；无“/”时整格一个班=全天。
 */
export function splitHalves(t) {
  const slash = t.indexOf('/');
  if (slash >= 0) return [t.substring(0, slash), t.substring(slash + 1)];
  return [t, t];
}

/** 5月~9月为夏令门诊时间（5.1~9.30），其余月份为冬令（10.1~次年4.30）。 */
function isSummerSeason(ymd) {
  let month = null;
  if (typeof ymd === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (m) {
      const d = safeDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
      if (d != null) month = d.m;
    }
  }
  if (month == null) month = new Date().getMonth() + 1;
  return month >= 5 && month <= 9;
}

/**
 * 根据单元格文本识别班次，并计算上班前通知时间与上班时间点。
 * 结果字段与 Java DayShift.toJson() 完全一致。
 */
export function fillShift(d, cell, leadMinutes) {
  d.raw = cell == null ? '' : cell;
  const t = stripWs(cell);
  const type = classify(t);
  d.type = type;

  switch (type) {
    case 'DAY': {
      // 白班按半天拆分：上午、下午可分别是门诊或病房。
      d.workInfo = dayWorkTimes(t, d.ymd);
      const start = dayStartOf(t, d.ymd);
      d.startTime = fmtTime(start);
      d.preTime = fmtTime(start - leadMinutes);
      break;
    }
    case 'MID': {
      // 中班（格子里带“中”）：午间连班 12:00 接班，门诊 13:30 结束、病房顺延到 14:00。
      // 上午还有半天班（“西3/中”）时，上班前提醒仍按上午上班时间算。
      d.workInfo = dayWorkTimes(t, d.ymd);
      const start = dayStartOf(t, d.ymd);
      d.startTime = fmtTime(start);
      d.preTime = fmtTime(start - leadMinutes);
      break;
    }
    case 'NIGHT': {
      // 夜班接班：夏令 17:30，冬令（10.1~次年4.30）17:00
      const nightStart = isSummerSeason(d.ymd) ? NIGHT_START_MIN : 17 * 60;
      d.startTime = fmtTime(nightStart);
      d.preTime = fmtTime(nightStart - leadMinutes);
      d.workInfo = nightWorkInfo(t, d.ymd);
      break;
    }
    case 'OFF_NIGHT':
      d.startTime = fmtTime(NIGHT_END_MIN);
      d.preTime = null;
      d.workInfo = '下夜班：凌晨仍在值班，07:30交班后下班休息，不用早起提醒';
      break;
    case 'REST':
    default:
      d.startTime = null;
      d.preTime = null;
      d.workInfo = '休息，好好睡觉';
      break;
  }
}

// ---------------- 医生表解析（ScheduleParser.parse） ----------------

function makeDay() {
  return {
    ymd: null,
    weekLabel: '',
    dateLabel: '',
    raw: '',
    type: 'REST',
    rowHasWest: false,
    workInfo: '',
    startTime: null,
    preTime: null,
    enabled: false,
    weather: '',
    tips: '',
  };
}

/**
 * 解析指定姓名的一周排班。对应 ScheduleParser.parse(matrix, name, leadMinutes)。
 *
 * 返回 { ok, error?, title, weekStart, days }；
 * days 每天字段与顺序语义完全对齐 Java DayShift.toJson()：
 *   ymd, weekLabel, dateLabel, raw, type, workInfo, startTime, preTime, enabled, weather, tips
 */
export function parseDoctor(matrix, name, leadMinutes) {
  const result = { ok: false, title: '', weekStart: null, days: [] };
  if (!matrix || matrix.length === 0) {
    result.error = '表格是空的';
    return result;
  }
  const key = name == null ? '' : jtrim(name);
  if (key === '') {
    result.error = '请输入姓名';
    return result;
  }

  // 1. 日期表头 + 星期行 + 年份校验
  const h = findHeader(matrix);
  if (h.error != null) {
    result.error = h.error;
    return result;
  }
  const resolvedYear = h.resolvedYear;

  const dates = h.dateCols.map((dc) =>
    dc.fullDate != null ? dc.fullDate : safeDate(resolvedYear, dc.month, dc.day));

  // 5. 找姓名所在行：整格精确优先，避免匹配到“东院二线听班（夜班）”等说明行。
  let row = null;
  let nameCol = -1;
  outerExact:
  for (const candidate of matrix) {
    for (let i = 0; i < candidate.length; i++) {
      if (key === jtrim(candidate[i])) {
        row = candidate;
        nameCol = i;
        break outerExact;
      }
    }
  }
  if (row == null) {
    outerLoose:
    for (const candidate of matrix) {
      for (let i = 0; i < candidate.length; i++) {
        const cell = candidate[i] == null ? '' : String(candidate[i]);
        if (cell.includes(key)) {
          row = candidate;
          nameCol = i;
          break outerLoose;
        }
      }
    }
  }
  if (row == null) {
    result.error = '表里没找到「' + key + '」这一行';
    return result;
  }
  if (nameCol + 1 < row.length && TITLE_RE.test(jtrim(row[nameCol + 1]))) {
    result.title = jtrim(row[nameCol + 1]);
  }

  // 6. 严格按日期表头的列取排班内容（D列休息天数 1.5 等自然被跳过）。
  const limit = Math.min(h.dateCols.length, 7);
  const rowHasWest = row.some((c) => String(c).includes('西'));
  for (let i = 0; i < limit; i++) {
    const dc = h.dateCols[i];
    const date = dates[i];
    const d = makeDay();
    d.weekLabel = dc.weekLabel != null ? dc.weekLabel : weekOf(date);
    if (date != null) {
      d.ymd = isoDate(date);
      d.dateLabel = date.m + '月' + date.d + '日';
      if (dc.weekLabel == null) d.weekLabel = weekOf(date);
    } else {
      d.ymd = null;
      d.dateLabel = dc.month + '月' + dc.day + '日';
    }
    const cell = dc.col < row.length ? jtrim(row[dc.col]) : '';
    fillShift(d, cell, leadMinutes == null ? 0 : leadMinutes);
    d.rowHasWest = rowHasWest;
    result.days.push(d);
  }
  const first = dates.length === 0 ? null : dates[0];
  result.weekStart = first == null ? null : isoDate(first);
  result.ok = true;
  return result;
}

// ---------------- 报告员表解析（ReporterParser） ----------------

/** “郑莹2”→“郑莹”，“王艳婕1.5”→“王艳婕”：只保留非 ASCII 字符。 */
export function cleanName(raw) {
  if (raw == null) return '';
  let sb = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch > 127) sb += raw.charAt(i);
  }
  return jtrim(sb);
}

/** 姓名是否像个人名（排除说明行/表头等长文本）。 */
function plausibleName(n) {
  if (n.length < 2 || n.length > 6) return false;
  for (let i = 0; i < n.length; i++) {
    if ('、，。：:；;（）()【】[]/\\'.includes(n.charAt(i))) return false;
  }
  return true;
}

/** 单元格规范化：去空白、“//”统一成“/”（报告员表用双斜线分隔半天）。 */
export function normalizeCell(cell) {
  if (cell == null) return '';
  let t = stripWs(cell).replace(/\/{2,}/g, '/');
  // 数字格（如 3.0）按整数显示，便于与“3诊”配对
  if (/^\d+\.0$/.test(t)) t = t.substring(0, t.length - 2);
  return t;
}

/** 上午=0、下午=1；整格无“/”时两半相同。 */
export function halfOf(normCell, halfIdx) {
  if (normCell == null || normCell === '') return '';
  const parts = normCell.split('/');
  if (parts.length === 1) return parts[0];
  return halfIdx < parts.length ? parts[halfIdx] : '';
}

/**
 * 诊室名规范化：“6诊”→“6”，“乳甲2诊”→“乳甲2”，“二期5诊”→“2期5”；
 * “介入门诊”“急诊”等不改动。空/“休”返回空串。
 * （Java 的 (?<=\d)诊$ 改写为等价的末尾两字符判断，避免依赖正则 lookbehind。）
 */
export function canonicalRoom(token) {
  if (token == null) return '';
  let t = stripWs(token);
  if (t === '' || t === '休') return '';
  // 先去掉末尾的（听）/（听诊）/（培训）：东床旁（听）→东床旁、3诊（培训）→3诊
  t = t.replace(/[（(](听|听诊|培训)[）)]$/, '');
  t = t.split('二期').join('2期');
  if (t.length > 1 && t.charAt(t.length - 1) === '诊' && /\d/.test(t.charAt(t.length - 2))) {
    t = t.substring(0, t.length - 1);
  }
  return t;
}

/** 诊室词末尾的标记：听 / 听诊 / 培训（如 东床旁（听）、3诊（培训））。 */
export function roomMark(token) {
  if (token == null) return '';
  const m = stripWs(token).match(/[（(](听诊|听|培训)[）)]$/);
  if (!m) return '';
  return m[1] === '听诊' ? '听' : m[1];
}

/** 带标记的人名：张三（听）/ 李四（培训）；其他人原样返回。 */
export function markRoom(name, token) {
  const mark = roomMark(token);
  if (name == null || name === '' || mark === '') return name;
  const suffix = '（' + mark + '）';
  if (name.endsWith(suffix) || name.endsWith('(' + mark + ')')) return name;
  return name + suffix;
}

/** 兼容旧调用：是否听班。 */
export function isListen(token) {
  return roomMark(token) === '听';
}

/** 兼容旧调用：给听班的人名加后缀。 */
export function markListen(name, token) {
  return markRoom(name, token);
}

/** 合并关键字的诊室主键：别名源归并到别名目标（诊室目录按此归组）。 */
export function primaryKey(token) {
  const key = canonicalRoom(token);
  if (key === '') return '';
  if (CROSS_ALIAS.has(key)) return CROSS_ALIAS.get(key);
  const m = HIGH_END.exec(key);
  return m ? '高端' + m[1] : key;
}

/** 该诊室词的全部等价键（自身 + 跨表别名），配对时互为等价。 */
export function roomKeys(token) {
  const out = [];
  const key = canonicalRoom(token);
  if (key === '') return out;
  out.push(key);
  if (CROSS_ALIAS.has(key)) {
    const alias = CROSS_ALIAS.get(key);
    if (!out.includes(alias)) out.push(alias);
  }
  const m = HIGH_END.exec(key);
  if (m) {
    const he = '高端' + m[1];
    if (!out.includes(he)) out.push(he);
  }
  return out;
}

/** 两个诊室词是否指同一位置（考虑跨表别名，双向等价）。 */
export function sameRoom(a, b) {
  const ka = roomKeys(a);
  if (ka.length === 0) return false;
  const kb = roomKeys(b);
  if (kb.length === 0) return false;
  for (const k of ka) {
    if (kb.includes(k)) return true;
  }
  return false;
}

/** 是否位置词（诊室、检查室、床旁等；排除夜班/中班/休假/值班/行政等）。 */
export function isRoomToken(token) {
  const t = stripWs(token);
  if (t === '') return false;
  // 末尾带（听）/（听诊）/（培训）的，按去掉标记后的位置判断：
  // 东床旁（听）→东床旁、3诊（培训）→3诊、东12（培训）→东12
  const bare = t.replace(/[（(](听诊|听|培训)[）)]$/, '');
  if (bare !== t) return bare !== '' && isRoomToken(bare);
  // 只要带“床旁”二字就当位置，一律可查询
  if (t.includes('床旁')) return true;
  // “中”“东中”“值中”=中班（午间连班），不是位置，不参与诊室目录与配对
  if (midKey(t) !== '') return false;
  // “听”=听班/备班；“开会/培训”也不是位置
  const badWords = ['夜', '假', '休', '值', '听', '麻醉', '行政', '科研',
    '帮扶', '进修', '转科', '会诊', '请', '维', '开会', '培训'];
  for (const w of badWords) {
    if (t.includes(w)) return false;
  }
  return t !== '下';
}

/**
 * 解析报告员表矩阵。对应 ReporterParser.parse(matrix)。
 *
 * 返回 { ok, weekStart, error?, ymds, entries:[{name, cells}] }。
 * entries 顺序 = 表格行顺序（Java 一致）；reporterNames() 即 entries 的 name 序列。
 */
export function parseReporter(matrix) {
  const r = { ok: false, weekStart: null, ymds: [], entries: [] };
  const h = findHeader(matrix);
  if (h.error != null) {
    r.error = h.error;
    return r;
  }
  for (const dc of h.dateCols) {
    const d = dc.fullDate != null ? dc.fullDate : safeDate(h.resolvedYear, dc.month, dc.day);
    r.ymds.push(d == null ? null : isoDate(d));
  }
  r.weekStart = r.ymds.length === 0 ? null : r.ymds[0];

  const firstDateCol = h.firstDateCol;
  for (const row of matrix) {
    // 姓名：日期列之前的第一个含中文的格子（工时列 1.5 等纯 ASCII 会被跳过）
    let nameRaw = null;
    for (let i = 0; i < firstDateCol && i < row.length; i++) {
      const c = row[i] == null ? '' : String(row[i]);
      if (jtrim(c) !== '' && hasChinese(c)) {
        nameRaw = c;
        break;
      }
    }
    if (nameRaw == null) continue;
    const name = cleanName(nameRaw);
    if (!plausibleName(name)) continue;
    const cells = [];
    for (let i = 0; i < h.dateCols.length; i++) {
      const col = h.dateCols[i].col;
      const c = col < row.length ? row[col] : '';
      cells.push(normalizeCell(c));
    }
    // 名单人数含本周未排班者（如新入职未排班），故不做“必须有排班”过滤
    r.entries.push({ name, cells });
  }
  r.ok = true;
  return r;
}

/** 报告员姓名，顺序与 Java 的 entries 一致（即表格行顺序）。 */
export function reporterNames(repResult) {
  if (repResult == null || !Array.isArray(repResult.entries)) return [];
  return repResult.entries.map((e) => e.name);
}

/** 按清洗后的姓名找报告员条目。 */
export function findReporter(repResult, name) {
  if (repResult == null || name == null) return null;
  for (const e of repResult.entries) {
    if (name === e.name) return e;
  }
  return null;
}

/**
 * 某天某半天里，和上机医生位置相同的报告员名单。
 * 中班特殊处理：两表把中午班写在不同的半天里
 * （医生“4诊/中”是上午诊室+中午中班，报告员“中//4诊”是中午中班+下午诊室），
 * 所以中班不看半天位置，两个半天里写着同一个中班就算对上。
 */
export function reportersFor(data, ymd, halfIdx, doctorToken) {
  const out = [];
  if (data == null || ymd == null) return out;
  const di = Array.isArray(data.ymds) ? data.ymds.indexOf(ymd) : -1;
  if (di < 0) return out;
  const mid = midKey(doctorToken);
  if (mid !== '') {
    // 先精确匹配院区（东中/西中/中/值中）；西中/东中找不到时再退回裸“中”，
    // 兼容报告员表里只写“中”的写法。值中不退回。
    collectMidReporters(data, di, mid, out);
    if (out.length === 0 && mid !== '中' && mid !== '值中') {
      collectMidReporters(data, di, '中', out);
    }
    return out;
  }
  if (!isRoomToken(doctorToken)) return out;
  const keys = roomKeys(doctorToken);
  if (keys.length === 0) return out;
  for (const e of data.entries) {
    if (di >= e.cells.length) continue;
    const half = halfOf(e.cells[di], halfIdx);
    // 值/东值/西值（分诊台主管）、科研、请假等非位置行不参与位置配对
    if (half === '' || half === '休' || !isRoomToken(half)) continue;
    const hk = canonicalRoom(half);
    const tagged = markRoom(e.name, half);
    if (hk !== '' && (keys.includes(hk) || sameRoom(half, doctorToken)) && !out.includes(tagged)) {
      out.push(tagged);
    }
  }
  return out;
}

function validHalf(h) {
  return h != null && h !== '' && h !== '休' && !h.includes('夜');
}

/**
 * 医生一天卡片上的搭档文案：
 *  - 上午、下午都配到同一名报告员 → “搭档：郑莹”
 *  - 只配到一半 → “搭档：任旭旭（上午）”
 *  - 两半都配到 → “搭档：任旭旭（上午） / 王玉凤（下午）”
 *  - 有中班 → 单独标“（中班）”
 *  - 没有配到 → null（隐藏该行）
 */
export function pairLabel(data, raw, ymd, rowHasWest = false) {
  if (data == null || raw == null || jtrim(raw) === '' || ymd == null) return null;
  const t = stripWs(raw);
  if (t === '') return null;
  const slash = t.indexOf('/');
  const am = slash >= 0 ? t.substring(0, slash) : t;
  const pm = slash >= 0 ? t.substring(slash + 1) : t;

  const amMid = midKey(am);
  const pmMid = midKey(pm);
  // 中班按整格判断：西3/中、东3/中 要分别归到西中、东中
  const cellMid = effectiveMid(t, rowHasWest);
  // 中班单独算一类（上午/下午两表写法相反），其余按对应半天找位置
  const amN = (validHalf(am) && amMid === '') ? reportersFor(data, ymd, 0, am) : [];
  const pmN = (validHalf(pm) && pmMid === '') ? reportersFor(data, ymd, 1, pm) : [];
  const midN = cellMid === '' ? [] : reportersFor(data, ymd, 0, cellMid);

  if (amN.length === 0 && pmN.length === 0 && midN.length === 0) return null;
  // 上午、下午是同一个人（整格一个诊室）→ 只写一次
  if (amN.length > 0 && amN.join('|') === pmN.join('|')) {
    const base = '搭档：' + amN.join('、');
    return midN.length === 0 ? base : base + '（中班：' + midN.join('、') + '）';
  }
  let sb = '搭档：';
  let first = true;
  if (amN.length > 0) {
    sb += amN.join('、') + '（上午）';
    first = false;
  }
  if (midN.length > 0) {
    if (!first) sb += ' / ';
    sb += midN.join('、') + '（中班）';
    first = false;
  }
  if (pmN.length > 0) {
    if (!first) sb += ' / ';
    sb += pmN.join('、') + '（下午）';
  }
  return sb;
}

// ---------------- 报告员一周排班（RoomDirectory.reporterWeek） ----------------

function addPartner(half, doctor, doctorToken) {
  if (half.place === '' || !isRoomToken(half.place) || !isRoomToken(doctorToken)) return;
  if (sameRoom(doctorToken, half.place) && !half.partners.includes(doctor)) {
    half.partners.push(doctor);
  }
}

/** 报告员这半天是中班、医生同一天也有同一个中班 → 是搭档（中班不分上午/下午槽位）。 */
function addMidPartner(half, doctor, doctorCell, repCell, doctorRowWest, repRowWest) {
  if (midKey(half.place) === '') return;
  const repMid = effectiveMid(repCell, repRowWest);
  const docMid = effectiveMid(doctorCell, doctorRowWest);
  if (repMid === '' || repMid !== docMid) return;
  if (!half.partners.includes(doctor)) {
    half.partners.push(doctor);
  }
}

/**
 * 报告员一周排班：每天上下午的位置 + 配套上机医生（与医生卡片的“搭档”同一配对规则）。
 * 对应 RoomDirectory.reporterWeek(doctorMatrix, rep)。
 *
 * 返回 { ok, name, error?, days: [{ weekLabel, dateLabel, am:{place,partners}, pm:{...} }] }
 */
export function reporterWeek(doctorMatrix, repResult, name) {
  const key = name == null ? '' : jtrim(name);
  const result = { ok: false, name: key, days: [] };
  const h = findHeader(doctorMatrix);
  if (h.error != null) {
    result.error = h.error;
    return result;
  }

  const labels = dayLabelsOf(h);
  const out = labels.map((l) => ({
    weekLabel: l.weekLabel,
    dateLabel: l.dateLabel,
    am: { place: '', partners: [] },
    pm: { place: '', partners: [] },
  }));
  result.days = out;

  let entry = null;
  if (repResult != null && Array.isArray(repResult.entries)) {
    for (const e of repResult.entries) {
      if (e.name === key) {
        entry = e;
        break;
      }
    }
  }
  if (entry == null) {
    result.error = '报告员表里没找到「' + key + '」';
    return result;
  }

  if (entry.cells != null) {
    const n = Math.min(h.dateCols.length, out.length, entry.cells.length);
    for (let i = 0; i < n; i++) {
      out[i].am.place = halfOf(entry.cells[i], 0);
      out[i].pm.place = halfOf(entry.cells[i], 1);
    }
  }

  const repRowWest = Array.isArray(entry.cells)
    && entry.cells.some((c) => String(c).includes('西'));
  for (const row of doctorMatrix) {
    const nameCol = doctorNameCol(row, h.firstDateCol);
    if (nameCol < 0) continue;
    const doctor = jtrim(row[nameCol]);
    const doctorRowWest = row.some((c) => String(c).includes('西'));
    const n = Math.min(h.dateCols.length, out.length);
    for (let i = 0; i < n; i++) {
      const dc = h.dateCols[i];
      const cell = dc.col < row.length ? jtrim(row[dc.col]) : '';
      const t = stripWs(cell);
      if (t === '') continue;
      const slash = t.indexOf('/');
      const am = slash >= 0 ? t.substring(0, slash) : t;
      const pm = slash >= 0 ? t.substring(slash + 1) : t;
      addPartner(out[i].am, doctor, am);
      addPartner(out[i].pm, doctor, pm);
      // 中班：两表写在不同半天（医生“4诊/中”、报告员“中//4诊”），按中班本身配对
      addMidPartner(out[i].am, doctor, t, entry.cells[i], doctorRowWest, repRowWest);
      addMidPartner(out[i].pm, doctor, t, entry.cells[i], doctorRowWest, repRowWest);
    }
  }

  result.ok = true;
  return result;
}
