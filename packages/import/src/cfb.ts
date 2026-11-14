/**
 * Reading ONE named stream out of a Compound File Binary (the OLE container of `.doc`, `.xls`,
 * `.ppt`), and the `\u0005SummaryInformation` property set inside it — enough for the author,
 * the two dates and the program, and deliberately nothing more.
 *
 * Every number in the file is untrusted. A sector id is checked against the sectors the file
 * really holds, a chain is followed for at most as many sectors as the stream needs and stops on
 * the first revisit, and a stream bigger than `limit` is refused, so a crafted attachment cannot
 * loop or make the reader allocate more than the file's own size. Anything unreadable gives
 * `undefined`; nothing here throws on bad input.
 */

import { decodeLatin1 } from './bytes.ts';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE = 512;
const END_OF_CHAIN = 0xfffffffe;
const BYTE_ORDER = 0xfffe;
const MINI_SECTOR = 64;
const DIRECTORY_ENTRY = 128;
const HEADER_DIFAT = 109;

const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

/** A directory of 4096 entries is far more than any Office file has. */
const MAX_DIRECTORY_ENTRIES = 4096;

/** Properties read from the property set: the standard ones are a dozen. */
const MAX_PROPERTIES = 256;

/** The property sets of a document are a few hundred bytes; a megabyte is odd. */
const MAX_SUMMARY = 1024 * 1024;

const SUMMARY_NAME = '\u0005SummaryInformation';

const PID_CODEPAGE = 1;
const PID_AUTHOR = 4;
const PID_LAST_AUTHOR = 8;
const PID_CREATED = 12;
const PID_SAVED = 13;
const PID_APPLICATION = 18;

const VT_I2 = 0x02;
const VT_LPSTR = 0x1e;
const VT_LPWSTR = 0x1f;
const VT_FILETIME = 0x40;

/** A FILETIME before this is a placeholder (0 is "never set"), not a date anyone saved a file on. */
const EARLIEST = Date.UTC(1980, 0, 1);
/** Beyond this `Date` cannot print the value. */
const LATEST = Date.UTC(9999, 11, 31);

/** 1601-01-01 to 1970-01-01, in milliseconds. */
const FILETIME_EPOCH_MS = 11644473600000;

/** Does this buffer start like a compound file? */
export function looksLikeCfb(bytes: Uint8Array): boolean {
    return bytes.length >= HEADER_SIZE && SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * The sector ids from `start`, at most `max` of them. `undefined` for a chain that revisits a
 * sector or points outside `next`, which is how a cycle shows.
 */
function chain(start: number, next: Uint32Array, max: number): number[] | undefined {
    const out: number[] = [];
    const seen = new Set<number>();
    let at = start;
    while (at !== END_OF_CHAIN && out.length < max) {
        if (at >= next.length || seen.has(at)) return undefined;
        seen.add(at);
        out.push(at);
        at = next[at] ?? END_OF_CHAIN;
    }
    return out;
}

interface Container {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    readonly sectorSize: number;
    /** Sectors the file really holds after the header. */
    readonly sectorCount: number;
    readonly fat: Uint32Array;
}

/** The sectors' bytes, joined. Every id is checked against the file, so a short file gives `undefined`. */
function readSectors(container: Container, ids: readonly number[]): Uint8Array | undefined {
    const { bytes, sectorSize, sectorCount } = container;
    const out = new Uint8Array(ids.length * sectorSize);
    for (const [index, id] of ids.entries()) {
        if (id >= sectorCount) return undefined;
        const from = (id + 1) * sectorSize;
        out.set(bytes.subarray(from, from + sectorSize), index * sectorSize);
    }
    return out;
}

function readWords(data: Uint8Array): Uint32Array {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Uint32Array(Math.floor(data.length / 4));
    for (let at = 0; at < out.length; at++) out[at] = view.getUint32(at * 4, true);
    return out;
}

/** The sector allocation table: the header's first 109 sectors, then the DIFAT chain. */
function readFat(
    bytes: Uint8Array,
    view: DataView,
    sectorSize: number,
    sectorCount: number,
): Uint32Array | undefined {
    const fatCount = view.getUint32(44, true);
    if (fatCount === 0 || fatCount > sectorCount) return undefined;
    const ids: number[] = [];
    for (let at = 0; at < HEADER_DIFAT && ids.length < fatCount; at++) {
        const id = view.getUint32(76 + at * 4, true);
        if (id >= sectorCount) return undefined;
        ids.push(id);
    }
    let difat = view.getUint32(68, true);
    let difatLeft = view.getUint32(72, true);
    const seen = new Set<number>();
    while (ids.length < fatCount) {
        if (difatLeft-- <= 0 || difat >= sectorCount || seen.has(difat)) return undefined;
        seen.add(difat);
        const base = (difat + 1) * sectorSize;
        for (let at = 0; at < sectorSize / 4 - 1 && ids.length < fatCount; at++) {
            const id = view.getUint32(base + at * 4, true);
            if (id >= sectorCount) return undefined;
            ids.push(id);
        }
        difat = view.getUint32(base + sectorSize - 4, true);
    }
    const data = new Uint8Array(ids.length * sectorSize);
    for (const [index, id] of ids.entries()) {
        const from = (id + 1) * sectorSize;
        data.set(bytes.subarray(from, from + sectorSize), index * sectorSize);
    }
    return readWords(data);
}

function utf16(bytes: Uint8Array, from: number, length: number): string {
    let out = '';
    for (let at = 0; at + 1 < length; at += 2) {
        const unit = (bytes[from + at] as number) | ((bytes[from + at + 1] as number) << 8);
        if (unit === 0) break;
        out += String.fromCharCode(unit);
    }
    return out;
}

/** The decoded bytes of the stream called `name`, or `undefined` for anything unreadable. */
export function cfbStream(bytes: Uint8Array, name: string, limit: number): Uint8Array | undefined {
    if (!looksLikeCfb(bytes)) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const shift = view.getUint16(30, true);
    if (view.getUint16(28, true) !== BYTE_ORDER || (shift !== 9 && shift !== 12)) return undefined;
    if (view.getUint16(32, true) !== 6) return undefined;
    const sectorSize = 1 << shift;
    const sectorCount = Math.floor(bytes.length / sectorSize) - 1;
    if (sectorCount < 1) return undefined;

    const fat = readFat(bytes, view, sectorSize, sectorCount);
    if (!fat) return undefined;
    const container: Container = { bytes, view, sectorSize, sectorCount, fat };

    const directoryIds = chain(
        view.getUint32(48, true),
        fat,
        Math.min(sectorCount, Math.ceil((MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY) / sectorSize)),
    );
    const directory = directoryIds && readSectors(container, directoryIds);
    if (!directory) return undefined;
    const entries = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

    let rootStart = END_OF_CHAIN;
    let start: number | undefined;
    let size = 0;
    for (let at = 0; at + DIRECTORY_ENTRY <= directory.length; at += DIRECTORY_ENTRY) {
        const type = directory[at + 66];
        const nameLength = entries.getUint16(at + 64, true);
        if (type === TYPE_ROOT && rootStart === END_OF_CHAIN) rootStart = entries.getUint32(at + 116, true);
        if (type !== TYPE_STREAM || nameLength < 2 || nameLength > 64 || start !== undefined) continue;
        if (utf16(directory, at, nameLength) !== name) continue;
        // a 4096-byte-sector file may state sizes over 4 GiB; none of ours is
        if (shift === 12 && entries.getUint32(at + 124, true) !== 0) return undefined;
        start = entries.getUint32(at + 116, true);
        size = entries.getUint32(at + 120, true);
    }
    if (start === undefined || size > limit) return undefined;
    if (size === 0) return new Uint8Array(0);

    if (size >= view.getUint32(56, true)) {
        const need = Math.ceil(size / sectorSize);
        const ids = chain(start, fat, need);
        if (!ids || ids.length < need) return undefined;
        return readSectors(container, ids)?.subarray(0, size);
    }

    // a small stream lives in the mini stream: 64-byte pieces of the root entry's own stream
    const miniFatIds = chain(view.getUint32(60, true), fat, Math.min(sectorCount, view.getUint32(64, true)));
    const miniFatData = miniFatIds && readSectors(container, miniFatIds);
    if (!miniFatData) return undefined;
    const miniFat = readWords(miniFatData);
    const need = Math.ceil(size / MINI_SECTOR);
    const miniIds = chain(start, miniFat, need);
    if (!miniIds || miniIds.length < need) return undefined;
    const lastPiece = miniIds.reduce((most, id) => Math.max(most, id), 0);
    const rootIds = chain(rootStart, fat, Math.floor((lastPiece * MINI_SECTOR) / sectorSize) + 1);
    if (!rootIds) return undefined;
    const out = new Uint8Array(need * MINI_SECTOR);
    for (const [index, id] of miniIds.entries()) {
        const offset = id * MINI_SECTOR;
        const sector = rootIds[Math.floor(offset / sectorSize)];
        if (sector === undefined || sector >= sectorCount) return undefined;
        const from = (sector + 1) * sectorSize + (offset % sectorSize);
        out.set(bytes.subarray(from, from + MINI_SECTOR), index * MINI_SECTOR);
    }
    return out.subarray(0, size);
}

/** What the `SummaryInformation` property set says. Dates are epoch milliseconds, UTC. */
export interface SummaryInformation {
    readonly author?: string;
    readonly lastAuthor?: string;
    readonly createdAt?: number;
    readonly savedAt?: number;
    readonly application?: string;
}

/** A FILETIME (100 ns since 1601) as epoch ms; 0 and implausible values mean "no date". */
function fileTime(low: number, high: number): number | undefined {
    const ms = Math.floor((high * 4294967296 + low) / 10000 - FILETIME_EPOCH_MS);
    return ms >= EARLIEST && ms <= LATEST ? ms : undefined;
}

/**
 * The author, last author, creation and save dates and program of an OLE file, or `undefined`
 * when the file is not one or has no such stream. Strings in a code page other than UTF-8 and
 * UTF-16 are read as Latin-1, which is right for the ASCII names these fields hold.
 */
export function summaryInformation(bytes: Uint8Array): SummaryInformation | undefined {
    const stream = cfbStream(bytes, SUMMARY_NAME, MAX_SUMMARY);
    if (!stream || stream.length < 48) return undefined;
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    if (view.getUint16(0, true) !== BYTE_ORDER || view.getUint32(24, true) < 1) return undefined;
    const set = view.getUint32(44, true);
    if (set + 8 > stream.length) return undefined;
    const count = view.getUint32(set + 4, true);
    if (count > MAX_PROPERTIES || set + 8 + count * 8 > stream.length) return undefined;

    const properties = new Map<number, number>();
    for (let index = 0; index < count; index++) {
        const id = view.getUint32(set + 8 + index * 8, true);
        const offset = set + view.getUint32(set + 12 + index * 8, true);
        if (offset + 4 <= stream.length && !properties.has(id)) properties.set(id, offset);
    }

    const codepage = (() => {
        const at = properties.get(PID_CODEPAGE);
        return at !== undefined && view.getUint16(at, true) === VT_I2 && at + 6 <= stream.length
            ? view.getUint16(at + 4, true)
            : 0;
    })();
    const text = (id: number): string | undefined => {
        const at = properties.get(id);
        if (at === undefined || at + 8 > stream.length) return undefined;
        const type = view.getUint16(at, true);
        const length = view.getUint32(at + 4, true);
        if (type === VT_LPSTR && length <= 4096 && at + 8 + length <= stream.length) {
            const raw = stream.subarray(at + 8, at + 8 + length);
            const end = raw.indexOf(0);
            const body = end < 0 ? raw : raw.subarray(0, end);
            return codepage === 65001 ? new TextDecoder().decode(body) : decodeLatin1(body);
        }
        if (type === VT_LPWSTR && length <= 4096 && at + 8 + length * 2 <= stream.length) {
            return utf16(stream, at + 8, length * 2);
        }
        return undefined;
    };
    const date = (id: number): number | undefined => {
        const at = properties.get(id);
        if (at === undefined || at + 12 > stream.length || view.getUint16(at, true) !== VT_FILETIME) {
            return undefined;
        }
        return fileTime(view.getUint32(at + 4, true), view.getUint32(at + 8, true));
    };

    const author = text(PID_AUTHOR);
    const lastAuthor = text(PID_LAST_AUTHOR);
    const createdAt = date(PID_CREATED);
    const savedAt = date(PID_SAVED);
    const application = text(PID_APPLICATION);
    return {
        ...(author !== undefined ? { author } : {}),
        ...(lastAuthor !== undefined ? { lastAuthor } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(savedAt !== undefined ? { savedAt } : {}),
        ...(application !== undefined ? { application } : {}),
    };
}
