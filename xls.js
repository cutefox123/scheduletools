/**
 * 零依赖 .xls（Excel 97-2003 BIFF8）读取（浏览器 ES 模块）。
 *
 * 逐行移植 Java 版 XlsReader.java：
 *   - 手写 OLE2 / CFB（FAT、MiniFAT、目录项、Workbook 流）
 *   - BIFF8 记录：BOUNDSHEET、SST/CONTINUE、LABELSST、LABEL、NUMBER、RK、
 *     MULRK、FORMULA（缓存值）、STRING
 *   - 输出与 XlsxReader 相同的行 × 列字符串矩阵
 */

const FREE_SECT = -1; // 0xFFFFFFFF（Java int）
const END_OF_CHAIN = -2; // 0xFFFFFFFE（Java int）

export function parseXls(uint8array) {
    const data = uint8array instanceof Uint8Array ? uint8array : new Uint8Array(uint8array);
    if (data.length < 512 || data[0] !== 0xd0) {
        throw new Error('不是有效的 .xls 文件');
    }
    const cfb = new Cfb(data);
    let wb = cfb.getStream('Workbook');
    if (wb === null) {
        wb = cfb.getStream('Book');
    }
    if (wb === null) {
        throw new Error('.xls 里没有 Workbook 流');
    }
    return parseWorkbook(wb);
}

// ================= OLE2 复合文档 =================

class Cfb {
    constructor(data) {
        this.data = data;
        this.sectorSize = 1 << u16(data, 30);
        this.miniSectorSize = 1 << u16(data, 32);
        this.miniCutoff = u32(data, 56);
        const firstDir = i32(data, 48);
        const firstMiniFat = i32(data, 60);
        const firstDifat = i32(data, 68);
        const cDifat = u32(data, 72);

        this.fat = [];
        this.miniFat = [];
        this.miniStream = new Uint8Array(0);
        this.names = [];
        this.entryTypes = [];
        this.entryStarts = [];
        this.entrySizes = [];

        // DIFAT：头部 109 个扇区号 + 链式 DIFAT 扇区
        const fatSectors = [];
        for (let i = 0; i < 109; i++) {
            const v = i32(data, 76 + i * 4);
            if (v !== FREE_SECT && v !== END_OF_CHAIN) {
                fatSectors.push(v);
            }
        }
        let cur = firstDifat;
        let guard = 0;
        while (
            cur !== END_OF_CHAIN &&
            cur !== FREE_SECT &&
            cDifat > 0 &&
            guard++ < 100000
        ) {
            const base = this.sectorOffset(cur);
            if (base < 0 || base + this.sectorSize > data.length) {
                break;
            }
            const per = this.sectorSize / 4 - 1;
            for (let i = 0; i < per; i++) {
                const v = i32(data, base + i * 4);
                if (v !== FREE_SECT && v !== END_OF_CHAIN) {
                    fatSectors.push(v);
                }
            }
            cur = i32(data, base + per * 4);
        }

        // FAT
        const fatBytes = new ByteBuilder();
        for (let i = 0; i < fatSectors.length; i++) {
            const base = this.sectorOffset(fatSectors[i]);
            if (base < 0 || base + this.sectorSize > data.length) {
                throw new Error('.xls 文件损坏（FAT 扇区越界）');
            }
            fatBytes.write(data, base, this.sectorSize);
        }
        const fb = fatBytes.toBytes();
        this.fat = new Array(fb.length >> 2);
        for (let i = 0; i < this.fat.length; i++) {
            this.fat[i] = i32(fb, i * 4);
        }

        // 目录：每个槽 128 字节，type 5=根 2=流
        const dir = this.readChain(firstDir, -1);
        let rootStart = -2;
        let rootSize = 0;
        for (let off = 0; off + 128 <= dir.length; off += 128) {
            const type = dir[off + 66];
            if (type === 0) {
                continue;
            }
            const nameLen = Math.floor(u16(dir, off + 64) / 2);
            if (nameLen < 1) {
                continue;
            }
            let name = '';
            for (let i = 0; i < nameLen - 1 && i < 32; i++) {
                name += String.fromCharCode(u16(dir, off + i * 2));
            }
            this.names.push(name);
            this.entryTypes.push(type);
            this.entryStarts.push(i32(dir, off + 116));
            this.entrySizes.push(u32(dir, off + 120));
            if (type === 5) {
                rootStart = i32(dir, off + 116);
                rootSize = u32(dir, off + 120);
            }
        }

        // 小流（根目录流内容）：存放 < 4096 字节的小流
        if (rootStart >= 0) {
            this.miniStream = this.readChain(rootStart, rootSize);
        }

        // MiniFAT
        if (firstMiniFat !== END_OF_CHAIN && firstMiniFat !== FREE_SECT) {
            const mfBytes = new ByteBuilder();
            let s = firstMiniFat;
            let g2 = 0;
            while (s !== END_OF_CHAIN && s !== FREE_SECT && g2++ < 100000) {
                if (s < 0 || s >= this.fat.length) {
                    break;
                }
                const base = this.sectorOffset(s);
                if (base < 0 || base + this.sectorSize > data.length) {
                    break;
                }
                mfBytes.write(data, base, this.sectorSize);
                s = this.fat[s];
            }
            const mb = mfBytes.toBytes();
            this.miniFat = new Array(mb.length >> 2);
            for (let i = 0; i < this.miniFat.length; i++) {
                this.miniFat[i] = i32(mb, i * 4);
            }
        }
    }

    sectorOffset(sector) {
        return 512 + sector * this.sectorSize;
    }

    readChain(start, size) {
        const bos = new ByteBuilder();
        let s = start;
        let guard = 0;
        while (
            s !== END_OF_CHAIN &&
            s !== FREE_SECT &&
            s >= 0 &&
            guard++ < 1000000
        ) {
            if (s >= this.fat.length) {
                break;
            }
            const base = this.sectorOffset(s);
            if (base < 0 || base + this.sectorSize > this.data.length) {
                break;
            }
            bos.write(this.data, base, this.sectorSize);
            s = this.fat[s];
        }
        const all = bos.toBytes();
        if (size >= 0 && size <= all.length) {
            return all.slice(0, size);
        }
        return all;
    }

    /** 按 MiniFAT 链读取小流。 */
    readMiniChain(start, size) {
        const bos = new ByteBuilder();
        let s = start;
        let guard = 0;
        while (
            s !== END_OF_CHAIN &&
            s !== FREE_SECT &&
            s >= 0 &&
            guard++ < 1000000
        ) {
            if (s >= this.miniFat.length) {
                break;
            }
            const base = s * this.miniSectorSize;
            if (base + this.miniSectorSize > this.miniStream.length) {
                break;
            }
            bos.write(this.miniStream, base, this.miniSectorSize);
            s = this.miniFat[s];
        }
        const all = bos.toBytes();
        if (size >= 0 && size <= all.length) {
            return all.slice(0, size);
        }
        return all;
    }

    getStream(want) {
        for (let i = 0; i < this.names.length; i++) {
            if (this.entryTypes[i] !== 2) {
                continue;
            }
            if (this.names[i].toLowerCase() !== want.toLowerCase()) {
                continue;
            }
            const start = this.entryStarts[i];
            const size = this.entrySizes[i];
            if (size < this.miniCutoff) {
                return this.readMiniChain(start, size);
            }
            return this.readChain(start, size);
        }
        return null;
    }
}

class ByteBuilder {
    constructor() {
        this.chunks = [];
        this.length = 0;
    }

    write(src, start, len) {
        this.chunks.push(src.subarray(start, start + len));
        this.length += len;
    }

    toBytes() {
        const out = new Uint8Array(this.length);
        let p = 0;
        for (let i = 0; i < this.chunks.length; i++) {
            out.set(this.chunks[i], p);
            p += this.chunks[i].length;
        }
        return out;
    }
}

// ================= BIFF 记录解析 =================

function parseWorkbook(wb) {
    // 校验 BIFF8（Excel 97+）：记录头 id=0x0809，数据区头两字节 vers=0x0600
    if (wb.length < 8 || u16(wb, 0) !== 0x0809 || u16(wb, 4) < 0x0600) {
        throw new Error('暂不支持此老版本 .xls，请用 Excel 另存为 .xlsx');
    }

    const sheets = []; // {lbPlyPos, hidden, dt}
    let sst = new Map();
    let pos = 0;
    let guard = 0;
    while (pos + 4 <= wb.length && guard++ < 1000000) {
        const id = u16(wb, pos);
        const len = u16(wb, pos + 2);
        if (pos + 4 + len > wb.length) {
            break;
        }
        const d = wb.subarray(pos + 4, pos + 4 + len);
        pos += 4 + len;
        if (id === 0x000a) {
            break; // 工作簿全局区的 EOF
        }
        if (id === 0x0085 && d.length >= 8) {
            // BOUNDSHEET
            const lbPlyPos = i32(d, 0);
            const grbit = u16(d, 4);
            sheets.push({ lbPlyPos, hidden: grbit & 0x03, dt: (grbit >> 2) & 0x0f });
        } else if (id === 0x00fc) {
            // SST（后跟 CONTINUE）
            const segs = [d];
            while (pos + 4 <= wb.length) {
                const nid = u16(wb, pos);
                const nlen = u16(wb, pos + 2);
                if (nid !== 0x003c || pos + 4 + nlen > wb.length) {
                    break;
                }
                segs.push(wb.subarray(pos + 4, pos + 4 + nlen));
                pos += 4 + nlen;
            }
            sst = parseSst(segs);
        }
    }

    let target = -1;
    for (let i = 0; i < sheets.length; i++) {
        if (sheets[i].dt === 0 && sheets[i].hidden === 0) {
            // 第一个可见工作表
            target = sheets[i].lbPlyPos;
            break;
        }
    }
    if (target < 0 && sheets.length > 0) {
        target = sheets[0].lbPlyPos;
    }
    if (target < 0) {
        throw new Error('.xls 里没有工作表');
    }
    return parseSheet(wb, target, sst);
}

function parseSheet(wb, start, sst) {
    const rows = [];
    let pos = start;
    let bofSeen = false;
    let pendingRow = -1;
    let pendingCol = -1;
    let guard = 0;

    while (pos + 4 <= wb.length && guard++ < 2000000) {
        const id = u16(wb, pos);
        const len = u16(wb, pos + 2);
        if (pos + 4 + len > wb.length) {
            break;
        }
        const d = wb.subarray(pos + 4, pos + 4 + len);
        pos += 4 + len;

        if (id === 0x0809) {
            // BOF
            if (bofSeen) {
                break; // 进入下一个子流（图表等）
            }
            bofSeen = true;
            continue;
        }
        if (id === 0x000a) {
            break; // 工作表 EOF
        }

        switch (id) {
            case 0x00fd: // LABELSST
                if (d.length >= 10) {
                    setCell(rows, u16(d, 0), u16(d, 2), sst.get(i32(d, 6)));
                }
                break;
            case 0x0204: // LABEL
                if (d.length >= 7) {
                    setCell(rows, u16(d, 0), u16(d, 2), readXlUnicodeStr(d, 6));
                }
                break;
            case 0x0203: // NUMBER
                if (d.length >= 14) {
                    setCell(rows, u16(d, 0), u16(d, 2), fmtDouble(doubleAt(d, 6)));
                }
                break;
            case 0x027e: // RK
                if (d.length >= 10) {
                    setCell(rows, u16(d, 0), u16(d, 2), fmtDouble(decodeRk(i32(d, 6))));
                }
                break;
            case 0x00bd: {
                // MULRK
                if (d.length < 6) {
                    break;
                }
                const row = u16(d, 0);
                const col = u16(d, 2);
                const count = Math.floor((d.length - 6) / 6);
                for (let i = 0; i < count; i++) {
                    const rk = i32(d, 4 + i * 6 + 2);
                    setCell(rows, row, col + i, fmtDouble(decodeRk(rk)));
                }
                break;
            }
            case 0x0006: {
                // FORMULA（只取缓存值）
                if (d.length >= 22) {
                    const row = u16(d, 0);
                    const col = u16(d, 2);
                    const strResult =
                        d[6] === 0xff && d[7] === 0xff && d[8] === 0xff && d[9] === 0xff;
                    if (strResult) {
                        pendingRow = row;
                        pendingCol = col;
                    } else {
                        setCell(rows, row, col, fmtDouble(doubleAt(d, 6)));
                    }
                }
                break;
            }
            case 0x0207: // STRING（公式字符串结果）
                if (pendingRow >= 0 && d.length >= 3) {
                    setCell(rows, pendingRow, pendingCol, readXlUnicodeStr(d, 2));
                }
                pendingRow = -1;
                break;
            default:
                break;
        }
    }
    return rows;
}

function setCell(rows, row, col, value) {
    if (value === null || value === undefined) {
        value = '';
    }
    while (rows.length <= row) {
        rows.push([]);
    }
    const r = rows[row];
    while (r.length <= col) {
        r.push('');
    }
    r[col] = value;
}

// ================= SST（共享字符串表，含 CONTINUE 分段） =================

function parseSst(segs) {
    const map = new Map();
    if (segs.length === 0 || segs[0].length < 8) {
        return map;
    }
    const s = new SstStream(segs);
    s.skip(4); // cstTotal
    const unique = s.u32();
    for (let i = 0; i < unique && !s.eof(); i++) {
        try {
            map.set(i, s.readString());
        } catch (e) {
            break;
        }
    }
    return map;
}

/** SST 专用字节流：跨 CONTINUE 段时，若正处于某字符串的字符区，段首是新选项标志字节。 */
class SstStream {
    constructor(segs) {
        this.segs = segs;
        this.si = 0;
        this.off = 0;
    }

    eof() {
        return this.si >= this.segs.length;
    }

    u8() {
        for (;;) {
            if (this.si >= this.segs.length) {
                throw new Error('SST 越界');
            }
            const seg = this.segs[this.si];
            if (this.off >= seg.length) {
                this.si++;
                this.off = 0;
                continue;
            }
            return seg[this.off++] & 0xff;
        }
    }

    u16() {
        return this.u8() | (this.u8() << 8);
    }

    u32() {
        return this.u16() | (this.u16() << 16);
    }

    skip(n) {
        while (n-- > 0) {
            this.u8();
        }
    }

    readString() {
        const cch = this.u16();
        const flags = this.u8();
        let high = (flags & 0x01) !== 0;
        const rich = (flags & 0x08) !== 0;
        const ext = (flags & 0x04) !== 0;
        const cRun = rich ? this.u16() : 0;
        const cceExt = ext ? this.u32() : 0;
        let sb = '';
        let remaining = cch;

        while (remaining > 0) {
            // 段边界：字符还没读完且当前段耗尽 → CONTINUE 段首是新的选项标志
            if (this.si >= this.segs.length) {
                break;
            }
            if (this.off >= this.segs[this.si].length) {
                this.si++;
                this.off = 0;
                if (this.si >= this.segs.length) {
                    break;
                }
                high = (this.u8() & 0x01) !== 0;
            }
            if (high) {
                sb += String.fromCharCode(this.u8() | (this.u8() << 8));
            } else {
                sb += String.fromCharCode(this.u8());
            }
            remaining--;
        }

        if (rich) {
            this.skip(cRun * 4);
        }
        if (ext) {
            this.skip(cceExt);
        }
        return sb;
    }
}

/** 读 XLUnicodeString：cch(2) + flags(1) + 字符（flags bit0=1 时每字符 2 字节）。 */
function readXlUnicodeStr(d, off) {
    if (off + 3 > d.length) {
        return '';
    }
    const cch = u16(d, off);
    const high = (d[off + 2] & 0x01) !== 0;
    let p = off + 3;
    let sb = '';
    for (let i = 0; i < cch; i++) {
        if (high) {
            if (p + 1 >= d.length) {
                break;
            }
            sb += String.fromCharCode((d[p] & 0xff) | ((d[p + 1] & 0xff) << 8));
            p += 2;
        } else {
            if (p >= d.length) {
                break;
            }
            sb += String.fromCharCode(d[p] & 0xff);
            p++;
        }
    }
    return sb;
}

/** RK：bit1=整数，bit0=实值已除以 100。 */
function decodeRk(rk) {
    let v;
    if ((rk & 0x02) !== 0) {
        v = rk >> 2;
    } else {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint32(0, 0, true);
        dv.setUint32(4, rk & 0xfffffffc, true);
        v = dv.getFloat64(0, true);
    }
    if ((rk & 0x01) !== 0) {
        v /= 100;
    }
    return v;
}

function fmtDouble(v) {
    if (!Number.isFinite(v)) {
        return String(v);
    }
    if (Number.isInteger(v) && Math.abs(v) < 9e15) {
        return String(v);
    }
    return plainDecimal(v);
}

/**
 * 把 double 转成不带指数、不丢精度的十进制文本。
 *
 * 旧实现用 BigInt 复刻 Java 的 BigDecimal.stripTrailingZeros().toPlainString()，
 * 但微信小程序（以及 iOS 13 及以下的 Safari）没有可靠的 BigInt：
 * 一进 .xls 的数值单元格就抛 “Cannot convert a BigInt value to a number”。
 *
 * 现在改成纯 number + 字符串搬移。整数、1.5 这类二进制能精确表示的数值，
 * 输出与原来逐字符相同；只有 0.1 那种无限循环小数不再展开成几十位
 * （排班表里只有日期序列号和 .5 天数，不受影响）。
 */
function plainDecimal(v) {
    const s = String(v);
    if (s.indexOf('e') < 0 && s.indexOf('E') < 0) {
        return s;
    }
    const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
    if (m == null) {
        return s;
    }
    const sign = m[1] || '';
    const intPart = m[2];
    const fracPart = m[3] || '';
    const exp = parseInt(m[4], 10);
    const digits = intPart + fracPart;
    const point = intPart.length + exp;

    let out;
    if (point <= 0) {
        out = '0.' + '0'.repeat(-point) + digits;
    } else if (point >= digits.length) {
        out = digits + '0'.repeat(point - digits.length);
    } else {
        out = digits.slice(0, point) + '.' + digits.slice(point);
    }

    // stripTrailingZeros().toPlainString()：只裁小数尾巴，整数末尾的 0 不能动
    if (out.indexOf('.') >= 0) {
        out = out.replace(/0+$/, '');
        if (out.endsWith('.')) {
            out = out.slice(0, -1);
        }
    }
    if (out === '' || out === '0') {
        return '0';
    }
    return sign === '-' ? '-' + out : out;
}

// ================= 小工具 =================

function u16(b, off) {
    if (off + 2 > b.length) {
        throw new Error('读取越界');
    }
    return (b[off] & 0xff) | ((b[off + 1] & 0xff) << 8);
}

function i32(b, off) {
    if (off + 4 > b.length) {
        throw new Error('读取越界');
    }
    return (b[off] & 0xff) | ((b[off + 1] & 0xff) << 8) | ((b[off + 2] & 0xff) << 16) | ((b[off + 3] & 0xff) << 24);
}

/** 无符号 32 位读取（与 Java 版一致，按 int 返回）。 */
function u32(b, off) {
    return i32(b, off);
}

function doubleAt(b, off) {
    if (off + 8 > b.length) {
        throw new Error('读取越界');
    }
    const dv = new DataView(b.buffer, b.byteOffset + off, 8);
    return dv.getFloat64(0, true);
}
