/**
 * 零依赖 xlsx 读取（浏览器 ES 模块）。
 *
 * 目标：与 Java 版 XlsxReader.java 的输出逐格一致。
 *
 * 对外 API：
 *   parseXlsx(uint8array) -> string[][]          （同步；使用内置纯 JS inflate）
 *   parseXlsxAsync(uint8array) -> Promise<string[][]>（优先使用 DecompressionStream）
 *
 * 说明：DecompressionStream 只有异步接口，而题目要求的 parseXlsx 是同步函数，
 * 二者在单线程浏览器里无法同时成立。因此同步入口固定使用内置 inflate；
 * 异步入口在环境支持时优先使用 DecompressionStream('deflate-raw')。
 * 两个入口的 ZIP/XML 解析逻辑完全相同。
 */

const UTF8 = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 同步解析第一个工作表；缺格补 ""，返回行 × 列字符串矩阵。 */
export function parseXlsx(uint8array) {
    const entries = readZipDirectory(uint8array);
    const datas = entries.map((e) => extractEntrySync(uint8array, e));
    return parseFiles(entries, datas);
}

/** 异步解析；存在 DecompressionStream 时优先使用它，否则回退纯 JS inflate。 */
export async function parseXlsxAsync(uint8array) {
    const entries = readZipDirectory(uint8array);
    const datas = [];
    for (const e of entries) {
        datas.push(await extractEntryAsync(uint8array, e));
    }
    return parseFiles(entries, datas);
}

/** 同步解压 ZIP 条目（method=0 / 8）。 */
function extractEntrySync(bytes, entry) {
    const comp = localData(bytes, entry);
    if (entry.method === 0) {
        return comp;
    }
    if (entry.method === 8) {
        // 可选注入仅用于交叉验证（例如 Node 的 zlib.inflateRawSync）；
        // 不注入时完全使用本文件的纯 JS inflate。
        const injected = globalThis.__inflateRaw;
        if (typeof injected === 'function') {
            return injected(comp);
        }
        return inflateRaw(comp);
    }
    throw new Error('不支持的 zip 压缩方式: ' + entry.method);
}

/** 异步解压 ZIP 条目；deflate 优先走原生 DecompressionStream。 */
async function extractEntryAsync(bytes, entry) {
    const comp = localData(bytes, entry);
    if (entry.method === 0) {
        return comp;
    }
    if (entry.method !== 8) {
        throw new Error('不支持的 zip 压缩方式: ' + entry.method);
    }
    if (typeof DecompressionStream === 'function') {
        try {
            return await inflateRawWithDecompressionStream(comp);
        } catch (e) {
            // 少数环境虽然暴露了构造函数，却只支持 'deflate'/'gzip'。
            return inflateRaw(comp);
        }
    }
    return inflateRaw(comp);
}

async function inflateRawWithDecompressionStream(data) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// ZIP（中央目录 + 本地文件头）
// ---------------------------------------------------------------------------

function readZipDirectory(bytes) {
    if (!bytes || bytes.length < 22) {
        throw new Error('不是有效的 xlsx（zip 太短）');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= min; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('不是有效的 xlsx（找不到 zip 中央目录）');
    }

    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (off + 46 > bytes.length || view.getUint32(off, true) !== 0x02014b50) {
            throw new Error('xlsx 的 zip 中央目录损坏');
        }
        const flags = view.getUint16(off + 8, true);
        const method = view.getUint16(off + 10, true);
        const csize = view.getUint32(off + 20, true);
        const nameLen = view.getUint16(off + 28, true);
        const extraLen = view.getUint16(off + 30, true);
        const commentLen = view.getUint16(off + 32, true);
        const localOff = view.getUint32(off + 42, true);
        if (off + 46 + nameLen > bytes.length) {
            throw new Error('xlsx 的 zip 文件名越界');
        }
        const name = UTF8.decode(bytes.subarray(off + 46, off + 46 + nameLen));
        entries.push({ name, flags, method, csize, localOff });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function localData(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = entry.localOff;
    if (off + 30 > bytes.length || view.getUint32(off, true) !== 0x04034b50) {
        throw new Error('xlsx 的 zip 本地文件头损坏: ' + entry.name);
    }
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const start = off + 30 + nameLen + extraLen;
    const end = start + entry.csize;
    if (end > bytes.length) {
        throw new Error('xlsx 的 zip 数据越界: ' + entry.name);
    }
    return bytes.subarray(start, end);
}

// ---------------------------------------------------------------------------
// 与 Java 版相同的“取第一个共享字符串表 + 第一个工作表”规则
// ---------------------------------------------------------------------------

function parseFiles(entries, datas) {
    const shared = [];
    let sheetBytes = null;

    for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        const data = datas[i];
        if (name === 'xl/sharedStrings.xml') {
            parseSharedStrings(data, shared);
        } else if (
            sheetBytes === null &&
            name.startsWith('xl/worksheets/') &&
            name.endsWith('.xml') &&
            name.indexOf('sheet') >= 0
        ) {
            sheetBytes = data;
        }
    }

    if (sheetBytes === null) {
        throw new Error('文件里没有找到工作表（xl/worksheets/sheet1.xml）');
    }
    return parseSheet(sheetBytes, shared);
}

// ---------------------------------------------------------------------------
// 极简 XML pull 事件（只覆盖 OOXML 需要的子集，行为对齐 XmlPullParser）
// ---------------------------------------------------------------------------

function tokenizeXml(bytes) {
    // XML 规范：解析前把字面 CRLF / CR 规范化为 LF；字符引用（&#13;）不受影响。
    const xml = UTF8.decode(bytes).replace(/\r\n?/g, '\n');
    const events = [];

    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

    function localName(name) {
        const i = name.indexOf(':');
        return i >= 0 ? name.slice(i + 1) : name;
    }

    function appendText(start, end) {
        if (end <= start) {
            return;
        }
        events.push({ type: 'text', text: decodeXmlEntities(xml.slice(start, end)) });
    }

    function findTagEnd(from) {
        let quote = '';
        for (let i = from; i < xml.length; i++) {
            const c = xml[i];
            if (quote) {
                if (c === quote) {
                    quote = '';
                }
            } else if (c === '"' || c === "'") {
                quote = c;
            } else if (c === '>') {
                return i;
            }
        }
        return xml.length - 1;
    }

    function parseStartTag(raw) {
        let i = 0;
        while (i < raw.length && isSpace(raw[i])) {
            i++;
        }
        const nameStart = i;
        while (i < raw.length && !isSpace(raw[i]) && raw[i] !== '/' && raw[i] !== '>') {
            i++;
        }
        const name = raw.slice(nameStart, i);
        const attrs = Object.create(null);
        while (i < raw.length) {
            while (i < raw.length && isSpace(raw[i])) {
                i++;
            }
            if (i >= raw.length) {
                break;
            }
            const attrStart = i;
            while (i < raw.length && !isSpace(raw[i]) && raw[i] !== '=') {
                i++;
            }
            const attrName = raw.slice(attrStart, i);
            while (i < raw.length && isSpace(raw[i])) {
                i++;
            }
            if (raw[i] !== '=') {
                if (attrName) {
                    attrs[localName(attrName)] = '';
                }
                continue;
            }
            i++;
            while (i < raw.length && isSpace(raw[i])) {
                i++;
            }
            let value = '';
            if (raw[i] === '"' || raw[i] === "'") {
                const quote = raw[i++];
                const start = i;
                while (i < raw.length && raw[i] !== quote) {
                    i++;
                }
                value = raw.slice(start, i);
                if (i < raw.length) {
                    i++;
                }
            } else {
                const start = i;
                while (i < raw.length && !isSpace(raw[i])) {
                    i++;
                }
                value = raw.slice(start, i);
            }
            if (attrName) {
                attrs[localName(attrName)] = decodeXmlEntities(value);
            }
        }
        return { name: localName(name), attrs };
    }

    let i = 0;
    while (i < xml.length) {
        const lt = xml.indexOf('<', i);
        if (lt < 0) {
            appendText(i, xml.length);
            break;
        }
        if (lt > i) {
            appendText(i, lt);
        }

        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt + 9);
            const text = xml.slice(lt + 9, end < 0 ? xml.length : end);
            events.push({ type: 'text', text });
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        if (xml.startsWith('<?', lt)) {
            const end = xml.indexOf('?>', lt + 2);
            i = end < 0 ? xml.length : end + 2;
            continue;
        }
        if (xml.startsWith('<!', lt)) {
            i = findTagEnd(lt + 2) + 1;
            continue;
        }
        if (xml[lt + 1] === '/') {
            const end = findTagEnd(lt + 2);
            const name = localName(xml.slice(lt + 2, end).trim());
            events.push({ type: 'end', name });
            i = end + 1;
            continue;
        }

        const end = findTagEnd(lt + 1);
        let raw = xml.slice(lt + 1, end);
        let selfClosing = false;
        if (raw.endsWith('/')) {
            selfClosing = true;
            raw = raw.slice(0, -1);
        }
        const tag = parseStartTag(raw);
        events.push({ type: 'start', name: tag.name, attrs: tag.attrs });
        if (selfClosing) {
            events.push({ type: 'end', name: tag.name });
        }
        i = end + 1;
    }

    return events;
}

const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
};

function decodeXmlEntities(s) {
    if (s.indexOf('&') < 0) {
        return s;
    }
    return s.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9._-]*);/g, (all, body) => {
        if (body[0] === '#') {
            const cp =
                body[1] === 'x' || body[1] === 'X'
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
            if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
                return all;
            }
            try {
                return String.fromCodePoint(cp);
            } catch (e) {
                return all;
            }
        }
        const v = NAMED_ENTITIES[body];
        return v === undefined ? all : v;
    });
}

// ---------------------------------------------------------------------------
// sharedStrings.xml：<si> 内所有 <t> 文本拼接（含富文本 r/t）
// ---------------------------------------------------------------------------

function parseSharedStrings(bytes, out) {
    const p = new XmlEvents(tokenizeXml(bytes));

    while (p.has()) {
        const ev = p.next();
        if (ev.type === 'start') {
            if (ev.name === 'si') {
                p.inSi = true;
                p.sb = '';
            } else if (p.inSi && ev.name === 't') {
                // 等价于 XmlPullParser.nextText()：一直读到 </t>。
                let text = '';
                while (p.has()) {
                    const e = p.next();
                    if (e.type === 'text') {
                        text += e.text;
                    } else if (e.type === 'end' && e.name === 't') {
                        break;
                    }
                }
                p.sb += text;
            }
        } else if (ev.type === 'end' && ev.name === 'si') {
            out.push(p.sb);
            p.inSi = false;
        }
    }
}

class XmlEvents {
    constructor(events) {
        this.events = events;
        this.i = 0;
        this.inSi = false;
        this.sb = '';
    }

    has() {
        return this.i < this.events.length;
    }

    next() {
        return this.events[this.i++];
    }
}

// ---------------------------------------------------------------------------
// sheetN.xml：与 Java 的 parseSheet / readCellValue / columnIndex 对齐
// ---------------------------------------------------------------------------

function parseSheet(bytes, shared) {
    const events = tokenizeXml(bytes);
    const rows = [];
    let cur = null;
    let i = 0;

    while (i < events.length) {
        const ev = events[i++];
        if (ev.type === 'start') {
            if (ev.name === 'row') {
                cur = [];
            } else if (ev.name === 'c' && cur !== null) {
                const ref = ev.attrs.r === undefined ? null : ev.attrs.r;
                const type = ev.attrs.t === undefined ? null : ev.attrs.t;
                const col = columnIndex(ref);
                const result = readCellValue(events, i, type, shared);
                i = result.next;
                while (cur.length <= col) {
                    cur.push('');
                }
                cur[col] = result.value;
            }
        } else if (ev.type === 'end' && ev.name === 'row') {
            if (cur !== null) {
                rows.push(cur);
                cur = null;
            }
        }
    }

    return rows;
}

function readCellValue(events, start, type, shared) {
    let v = '';
    let inline = '';
    let inV = false;
    let inInlineT = false;
    let depth = 1;
    let i = start;

    while (i < events.length) {
        const ev = events[i++];
        if (ev.type === 'start') {
            depth++;
            if (ev.name === 'v') {
                inV = true;
            } else if (type === 'inlineStr' && ev.name === 't') {
                inInlineT = true;
            }
        } else if (ev.type === 'text') {
            if (inV) {
                v += ev.text;
            } else if (inInlineT) {
                inline += ev.text;
            }
        } else if (ev.type === 'end') {
            if (ev.name === 'v') {
                inV = false;
            } else if (ev.name === 't') {
                inInlineT = false;
            }
            if (ev.name === 'c') {
                depth--;
                break;
            }
            depth--;
        }
    }

    const raw = javaTrim(v);

    if (type === 's') {
        if (!/^[+-]?[0-9]+$/.test(raw)) {
            return { value: '', next: i };
        }
        const idx = Number(raw);
        if (!Number.isSafeInteger(idx) || idx < -2147483648 || idx > 2147483647) {
            return { value: '', next: i };
        }
        return { value: idx >= 0 && idx < shared.length ? shared[idx] : '', next: i };
    }
    if (type === 'inlineStr') {
        return { value: inline, next: i };
    }
    return { value: raw, next: i };
}

/** A1、BC12 → 从 0 开始的列号；解析失败返回 0（与 Java 完全一致）。 */
function columnIndex(ref) {
    if (ref === null) {
        return 0;
    }
    let col = 0;
    for (let i = 0; i < ref.length; i++) {
        const ch = ref.charCodeAt(i);
        if (ch >= 65 && ch <= 90) {
            col = col * 26 + (ch - 65 + 1);
        } else if (ch >= 97 && ch <= 122) {
            col = col * 26 + (ch - 97 + 1);
        } else {
            break;
        }
    }
    return Math.max(col - 1, 0);
}

/** Java String.trim() 只去掉 <= U+0020 的首尾字符。 */
function javaTrim(s) {
    return s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
}

// ---------------------------------------------------------------------------
// 纯 JS raw DEFLATE 解压（RFC 1951）。
// 参考 zlib/puff 的 canonical Huffman 解码思路，零依赖、同步、可运行于 iOS Safari。
// ---------------------------------------------------------------------------

const LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
    131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLitTree = null;
let fixedDistTree = null;

function fixedTrees() {
    if (fixedLitTree === null) {
        const lit = new Array(288);
        for (let i = 0; i < 144; i++) lit[i] = 8;
        for (let i = 144; i < 256; i++) lit[i] = 9;
        for (let i = 256; i < 280; i++) lit[i] = 7;
        for (let i = 280; i < 288; i++) lit[i] = 8;
        fixedLitTree = buildHuffman(lit);
        fixedDistTree = buildHuffman(new Array(32).fill(5));
    }
    return { lit: fixedLitTree, dist: fixedDistTree };
}

function buildHuffman(lengths) {
    let maxLen = 0;
    for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > maxLen) {
            maxLen = lengths[i];
        }
    }
    if (maxLen > 15) {
        throw new Error('inflate: Huffman 码长超过 15');
    }

    const count = new Uint16Array(maxLen + 1);
    for (let i = 0; i < lengths.length; i++) {
        if (lengths[i]) {
            count[lengths[i]]++;
        }
    }

    const nextCode = new Uint16Array(maxLen + 1);
    let code = 0;
    for (let len = 1; len <= maxLen; len++) {
        code = (code + count[len - 1]) << 1;
        nextCode[len] = code;
    }

    const tables = new Array(maxLen + 1);
    for (let len = 1; len <= maxLen; len++) {
        tables[len] = new Map();
    }
    for (let sym = 0; sym < lengths.length; sym++) {
        const len = lengths[sym];
        if (!len) {
            continue;
        }
        const c = nextCode[len]++;
        let rev = 0;
        for (let i = 0; i < len; i++) {
            rev = (rev << 1) | ((c >> i) & 1);
        }
        tables[len].set(rev, sym);
    }
    return { maxLen, tables };
}

function inflateRaw(src) {
    if (!(src instanceof Uint8Array)) {
        src = new Uint8Array(src);
    }

    let bitPos = 0;
    const totalBits = src.length * 8;
    let out = new Uint8Array(Math.max(1024, src.length * 4));
    let outLen = 0;

    function ensure(n) {
        if (outLen + n <= out.length) {
            return;
        }
        let cap = out.length;
        while (cap < outLen + n) {
            cap *= 2;
        }
        const grown = new Uint8Array(cap);
        grown.set(out.subarray(0, outLen));
        out = grown;
    }

    function bit() {
        if (bitPos >= totalBits) {
            throw new Error('inflate: 数据意外结束');
        }
        const b = (src[bitPos >> 3] >> (bitPos & 7)) & 1;
        bitPos++;
        return b;
    }

    function bits(n) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            v |= bit() << i;
        }
        return v;
    }

    function alignToByte() {
        bitPos = (bitPos + 7) & ~7;
    }

    function decodeSymbol(tree) {
        if (tree.maxLen === 0) {
            throw new Error('inflate: 空的 Huffman 树');
        }
        let code = 0;
        for (let len = 1; len <= tree.maxLen; len++) {
            code |= bit() << (len - 1);
            const sym = tree.tables[len].get(code);
            if (sym !== undefined) {
                return sym;
            }
        }
        throw new Error('inflate: 非法的 Huffman 编码');
    }

    function readDynamicTables() {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;

        const clLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) {
            clLengths[CODE_LENGTH_ORDER[i]] = bits(3);
        }
        const clTree = buildHuffman(clLengths);

        const total = hlit + hdist;
        const lens = new Array(total).fill(0);
        let idx = 0;
        while (idx < total) {
            const sym = decodeSymbol(clTree);
            if (sym <= 15) {
                lens[idx++] = sym;
            } else if (sym === 16) {
                if (idx === 0) {
                    throw new Error('inflate: repeat 前没有码长');
                }
                const prev = lens[idx - 1];
                const rep = bits(2) + 3;
                if (idx + rep > total) {
                    throw new Error('inflate: 码长重复越界');
                }
                for (let i = 0; i < rep; i++) {
                    lens[idx++] = prev;
                }
            } else if (sym === 17) {
                const rep = bits(3) + 3;
                if (idx + rep > total) {
                    throw new Error('inflate: 零码长重复越界');
                }
                idx += rep;
            } else if (sym === 18) {
                const rep = bits(7) + 11;
                if (idx + rep > total) {
                    throw new Error('inflate: 长零码长重复越界');
                }
                idx += rep;
            } else {
                throw new Error('inflate: 非法码长符号');
            }
        }

        return {
            lit: buildHuffman(lens.slice(0, hlit)),
            dist: buildHuffman(lens.slice(hlit)),
        };
    }

    let last = false;
    while (!last) {
        last = bit() === 1;
        const type = bits(2);

        if (type === 0) {
            alignToByte();
            const len = bits(16);
            const nlen = bits(16);
            if ((len ^ 0xffff) !== nlen) {
                throw new Error('inflate: stored 块长度校验失败');
            }
            ensure(len);
            for (let i = 0; i < len; i++) {
                out[outLen++] = bits(8);
            }
        } else if (type === 1 || type === 2) {
            const trees = type === 1 ? fixedTrees() : readDynamicTables();

            for (;;) {
                const sym = decodeSymbol(trees.lit);
                if (sym < 256) {
                    ensure(1);
                    out[outLen++] = sym;
                } else if (sym === 256) {
                    break;
                } else if (sym >= 257 && sym <= 285) {
                    const li = sym - 257;
                    const len = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);

                    const dsym = decodeSymbol(trees.dist);
                    if (dsym > 29) {
                        throw new Error('inflate: 非法距离码');
                    }
                    const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
                    if (dist > outLen) {
                        throw new Error('inflate: 距离超出已输出数据');
                    }

                    ensure(len);
                    let from = outLen - dist;
                    for (let i = 0; i < len; i++) {
                        out[outLen++] = out[from++];
                    }
                } else {
                    throw new Error('inflate: 非法长度码');
                }
            }
        } else {
            throw new Error('inflate: 非法块类型');
        }
    }

    return out.slice(0, outLen);
}
