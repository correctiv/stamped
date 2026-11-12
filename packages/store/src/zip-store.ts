/**
 * A ZIP writer and reader for ONE job: a case file, whose members are stored, never compressed.
 *
 * It is not a general ZIP library. It writes with the "stored" method only, streams every member
 * (a case holds gigabytes, so nothing is held in memory but a 1 MiB block and the central
 * directory records), and uses ZIP64 per entry when a value does not fit. The reader refuses what
 * the writer never produces: other methods, encrypted entries, directories, anything that is not
 * a regular file, an entry whose local header disagrees with its central record. With the
 * "stored" method a member cannot be larger than the file it sits in, so there is no
 * decompression bomb to defend against; what is left to defend is the path, and `checkName`
 * does that for every name the reader returns.
 *
 * The files stay ordinary ZIPs: `unzip -t` and `python3 -m zipfile -t` read them.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import * as zlib from 'node:zlib';

import { fmt, _ } from '@stamped/core';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_RECORD = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;

const MARK32 = 0xffffffff;
const MARK16 = 0xffff;
const ZIP64_FIELD = 0x0001;

/** Bit 3: sizes follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const ENCRYPTED_FLAGS = 0x0001 | 0x0040 | 0x2000;
/** 1980-01-01 00:00: a fixed stamp, so the same members make the same bytes. */
const DOS_DATE = 0x0021;
/** Regular file, rw-r--r--, in the upper half of the external attributes (host: Unix). */
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX_ZIP64 = (3 << 8) | 45;

const BLOCK = 1024 * 1024;
const DIRECTORY_FLUSH = 4 * 1024 * 1024;
/** The end record is at most 22 bytes plus a 16-bit comment from the end of the file. */
const END_SEARCH = 0xffff + 22;
const TWO_32 = 2 ** 32;

/** The largest value (and entry count) the classic fields carry; tests lower them. */
export interface ZipLimits {
    readonly size: number;
    readonly count: number;
}

export const CLASSIC_LIMITS: ZipLimits = { size: MARK32, count: MARK16 };

export const MANIFEST_MEMBER = 'manifest.jsonl';

/** CRC-32 without the runtime's help, for a runtime that has none. */
export function crc32Fallback(bytes: Uint8Array, previous = 0): number {
    let crc = ~previous >>> 0;
    for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return ~crc >>> 0;
}

const TABLE = ((): Uint32Array => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const native = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** `zlib.crc32` where it exists (Node 22+), the table otherwise. */
export const crc32: (bytes: Uint8Array, previous?: number) => number =
    typeof native === 'function' ? (bytes, previous = 0) => native(bytes, previous) : crc32Fallback;

/** A 64-bit little-endian value as a number, refusing one JavaScript cannot hold exactly. */
function u64(view: DataView, at: number): number {
    const low = view.getUint32(at, true);
    const high = view.getUint32(at + 4, true);
    if (high >= 2 ** 21) throw new Error(_('The file holds a size or offset too large to read.'));
    return low + high * TWO_32;
}

function put64(view: DataView, at: number, value: number): void {
    view.setUint32(at, value % TWO_32, true);
    view.setUint32(at + 4, Math.floor(value / TWO_32), true);
}

/** Read exactly `length` bytes at `position`, or fail: a short read means the file ends too soon. */
function readExactly(fd: number, length: number, position: number, buffer?: Uint8Array): Uint8Array {
    const into = buffer ?? new Uint8Array(length);
    let got = 0;
    while (got < length) {
        const n = readSync(fd, into, got, length - got, position + got);
        if (n === 0) throw new Error(_('The file ends before it should: it is truncated.'));
        got += n;
    }
    return into.subarray(0, length);
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** What `addFile` and `addBytes` report back, for the manifest. */
export interface WrittenMember {
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
}

interface Placed {
    readonly name: Uint8Array;
    readonly crc: number;
    readonly size: number;
    readonly offset: number;
}

export interface ZipWriterOptions {
    readonly limits?: ZipLimits;
}

/**
 * Writes members one after another, then the central directory, then the end record.
 *
 * The caller decides the order of the members and the writer keeps it: the case file sorts them.
 * Central records go to a side file (`<path>.cd`) every ~4 MiB, so a million members do not have
 * to wait in memory for the end of the file.
 */
export class ZipWriter {
    private readonly fd: number;
    private readonly path: string;
    private readonly limits: ZipLimits;
    private readonly directoryPath: string;
    private pending: Uint8Array[] = [];
    private pendingBytes = 0;
    private offset = 0;
    private count = 0;
    private directoryBytes = 0;
    private done = false;

    constructor(path: string, options: ZipWriterOptions = {}) {
        this.path = path;
        this.limits = options.limits ?? CLASSIC_LIMITS;
        this.directoryPath = `${path}.cd`;
        rmSync(this.directoryPath, { force: true });
        this.fd = openSync(path, 'wx');
    }

    /** Stream the file at `source` in as the member `name`. */
    addFile(name: string, source: string): WrittenMember {
        const input = openSync(source, 'r');
        try {
            const size = fstatSync(input).size;
            const block = new Uint8Array(Math.min(BLOCK, size + 1));
            return this.member(name, size, (emit) => {
                let total = 0;
                for (;;) {
                    // One byte more than the size asks for, so a file that grew is noticed.
                    const n = readSync(input, block, 0, Math.min(block.length, size - total + 1), null);
                    if (n === 0) break;
                    total += n;
                    if (total > size) break;
                    emit(block.subarray(0, n));
                }
                // A source that grew or shrank while it was read would be stored under a size and a
                // checksum that describe a file that never existed.
                if (total !== size) {
                    throw new Error(fmt(_('{path} changed while it was being read.'), { path: source }));
                }
            });
        } finally {
            closeSync(input);
        }
    }

    /** Store `bytes` as the member `name`. */
    addBytes(name: string, bytes: Uint8Array): WrittenMember {
        return this.member(name, bytes.length, (emit) => emit(bytes));
    }

    private member(
        name: string,
        size: number,
        feed: (emit: (bytes: Uint8Array) => void) => void,
    ): WrittenMember {
        if (this.done) throw new Error(_('The archive is already finished.'));
        const nameBytes = new TextEncoder().encode(name);
        const big = size >= this.limits.size;
        const start = this.offset;

        const local = new Uint8Array(30 + nameBytes.length + (big ? 20 : 0));
        const head = view(local);
        head.setUint32(0, LOCAL_HEADER, true);
        head.setUint16(4, big ? 45 : 20, true);
        head.setUint16(6, FLAGS, true);
        head.setUint16(10, 0, true);
        head.setUint16(12, DOS_DATE, true);
        if (big) {
            head.setUint32(18, MARK32, true);
            head.setUint32(22, MARK32, true);
        }
        head.setUint16(26, nameBytes.length, true);
        head.setUint16(28, big ? 20 : 0, true);
        local.set(nameBytes, 30);
        if (big) {
            head.setUint16(30 + nameBytes.length, ZIP64_FIELD, true);
            head.setUint16(32 + nameBytes.length, 16, true);
        }
        this.write(local);

        const hash = createHash('sha256');
        let crc = 0;
        let written = 0;
        const emit = (bytes: Uint8Array): void => {
            crc = crc32(bytes, crc);
            hash.update(bytes);
            written += bytes.length;
            this.write(bytes);
        };
        feed(emit);
        if (written !== size) throw new Error(_('A member changed size while it was being written.'));

        const descriptor = new Uint8Array(big ? 24 : 16);
        const tail = view(descriptor);
        tail.setUint32(0, DATA_DESCRIPTOR, true);
        tail.setUint32(4, crc, true);
        if (big) {
            put64(tail, 8, size);
            put64(tail, 16, size);
        } else {
            tail.setUint32(8, size, true);
            tail.setUint32(12, size, true);
        }
        this.write(descriptor);

        this.record({ name: nameBytes, crc, size, offset: start });
        return { name, size, sha256: hash.digest('hex') };
    }

    /** Write the central directory and the end record; `comment` is stored in the end record. */
    finish(comment: string): void {
        if (this.done) throw new Error(_('The archive is already finished.'));
        this.done = true;
        this.flushDirectory();

        const directoryStart = this.offset;
        const side = openSync(this.directoryPath, 'a+');
        try {
            const block = new Uint8Array(BLOCK);
            for (let at = 0; at < this.directoryBytes; ) {
                const n = Math.min(BLOCK, this.directoryBytes - at);
                this.write(readExactly(side, n, at, block));
                at += n;
            }
        } finally {
            closeSync(side);
            rmSync(this.directoryPath, { force: true });
        }

        const needs64 =
            this.count >= this.limits.count ||
            this.directoryBytes >= this.limits.size ||
            directoryStart >= this.limits.size;
        if (needs64) {
            const end = new Uint8Array(56 + 20);
            const v = view(end);
            v.setUint32(0, ZIP64_END, true);
            put64(v, 4, 44);
            v.setUint16(12, MADE_BY_UNIX_ZIP64, true);
            v.setUint16(14, 45, true);
            put64(v, 24, this.count);
            put64(v, 32, this.count);
            put64(v, 40, this.directoryBytes);
            put64(v, 48, directoryStart);
            v.setUint32(56, ZIP64_LOCATOR, true);
            put64(v, 64, this.offset);
            v.setUint32(72, 1, true);
            this.write(end);
        }

        const text = new TextEncoder().encode(comment);
        if (text.length > MARK16) throw new Error(_('The archive comment is too long.'));
        const end = new Uint8Array(22 + text.length);
        const v = view(end);
        v.setUint32(0, END_RECORD, true);
        v.setUint16(8, needs64 ? MARK16 : this.count, true);
        v.setUint16(10, needs64 ? MARK16 : this.count, true);
        v.setUint32(12, needs64 ? MARK32 : this.directoryBytes, true);
        v.setUint32(16, needs64 ? MARK32 : directoryStart, true);
        v.setUint16(20, text.length, true);
        end.set(text, 22);
        this.write(end);
        closeSync(this.fd);
    }

    /** Give up: close and delete what was written, including the side file. */
    abort(): void {
        this.done = true;
        try {
            closeSync(this.fd);
        } catch {
            // already closed
        }
        rmSync(this.path, { force: true });
        rmSync(this.directoryPath, { force: true });
    }

    private write(bytes: Uint8Array): void {
        let at = 0;
        while (at < bytes.length) at += writeSync(this.fd, bytes, at, bytes.length - at);
        this.offset += bytes.length;
    }

    private record(entry: Placed): void {
        const bigSize = entry.size >= this.limits.size;
        const bigOffset = entry.offset >= this.limits.size;
        const extra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
        const out = new Uint8Array(46 + entry.name.length + (extra > 0 ? extra + 4 : 0));
        const v = view(out);
        v.setUint32(0, CENTRAL_ENTRY, true);
        v.setUint16(4, MADE_BY_UNIX_ZIP64, true);
        v.setUint16(6, extra > 0 ? 45 : 20, true);
        v.setUint16(8, FLAGS, true);
        v.setUint16(12, 0, true);
        v.setUint16(14, DOS_DATE, true);
        v.setUint32(16, entry.crc, true);
        v.setUint32(20, bigSize ? MARK32 : entry.size, true);
        v.setUint32(24, bigSize ? MARK32 : entry.size, true);
        v.setUint16(28, entry.name.length, true);
        v.setUint16(30, extra > 0 ? extra + 4 : 0, true);
        v.setUint32(38, UNIX_FILE_ATTRIBUTES, true);
        v.setUint32(42, bigOffset ? MARK32 : entry.offset, true);
        out.set(entry.name, 46);
        if (extra > 0) {
            let at = 46 + entry.name.length;
            v.setUint16(at, ZIP64_FIELD, true);
            v.setUint16(at + 2, extra, true);
            at += 4;
            if (bigSize) {
                put64(v, at, entry.size);
                put64(v, at + 8, entry.size);
                at += 16;
            }
            if (bigOffset) put64(v, at, entry.offset);
        }
        this.pending.push(out);
        this.pendingBytes += out.length;
        this.count++;
        if (this.pendingBytes >= DIRECTORY_FLUSH) this.flushDirectory();
    }

    private flushDirectory(): void {
        if (this.pending.length === 0) return;
        const joined = new Uint8Array(this.pendingBytes);
        let at = 0;
        for (const chunk of this.pending) {
            joined.set(chunk, at);
            at += chunk.length;
        }
        appendFileSync(this.directoryPath, joined);
        this.directoryBytes += joined.length;
        this.pending = [];
        this.pendingBytes = 0;
    }
}

/** One member as the central directory describes it. */
export interface ZipEntry {
    readonly name: string;
    readonly size: number;
    /** Where its local header starts. */
    readonly offset: number;
}

/**
 * A name that cannot escape the folder it is unpacked into, or `undefined` when it can.
 * Strict on purpose: relative, forward slashes, no empty or dot segments, no drive letters, no
 * control characters, no trailing slash. A reader that forgives any of these is the zip-slip bug.
 */
export function checkName(name: string): string | undefined {
    if (name === '') return _('an empty name');
    if (name.startsWith('/')) return _('an absolute path');
    if (name.includes('\\')) return _('a backslash in the path');
    if (/^[A-Za-z]:/.test(name)) return _('a drive letter');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return _('a control character in the path');
    if (name.endsWith('/')) return _('a directory entry');
    for (const part of name.split('/')) {
        if (part === '' || part === '.' || part === '..') return _('a path that leaves the case folder');
    }
    return undefined;
}

/** A ZIP written by {@link ZipWriter}, read without ever holding more than a block of it. */
export class ZipReader {
    readonly comment: string;
    /** How many members the central directory lists. */
    readonly count: number;
    private readonly fd: number;
    private readonly directoryStart: number;
    private readonly directoryBytes: number;

    private constructor(
        fd: number,
        comment: string,
        count: number,
        directoryStart: number,
        directoryBytes: number,
    ) {
        this.fd = fd;
        this.comment = comment;
        this.count = count;
        this.directoryStart = directoryStart;
        this.directoryBytes = directoryBytes;
    }

    /** Open `path` and read the end record. Throws when this is not a case-file ZIP. */
    static open(path: string): ZipReader {
        const fd = openSync(path, 'r');
        try {
            const length = fstatSync(fd).size;
            const tailLength = Math.min(length, END_SEARCH);
            const tail = readExactly(fd, tailLength, length - tailLength);
            const t = view(tail);

            let end = -1;
            for (let at = tail.length - 22; at >= 0; at--) {
                if (t.getUint32(at, true) !== END_RECORD) continue;
                // The comment must run exactly to the end of the file: a record in the middle of
                // trailing bytes is something else (or someone's append).
                if (at + 22 + t.getUint16(at + 20, true) === tail.length) {
                    end = at;
                    break;
                }
            }
            if (end < 0) throw new Error(_('This is not a case file: no ZIP end record was found.'));

            const comment = new TextDecoder().decode(tail.subarray(end + 22));
            let count = t.getUint16(end + 10, true);
            let directoryBytes = t.getUint32(end + 12, true);
            let directoryStart = t.getUint32(end + 16, true);
            const endAt = length - tail.length + end;
            let directoryEnd = endAt;

            if (count === MARK16 || directoryBytes === MARK32 || directoryStart === MARK32) {
                const locatorAt = endAt - 20;
                if (locatorAt < 56) throw new Error(_('The ZIP64 end record is missing.'));
                const locator = view(readExactly(fd, 20, locatorAt));
                if (locator.getUint32(0, true) !== ZIP64_LOCATOR) {
                    throw new Error(_('The ZIP64 end record is missing.'));
                }
                const recordAt = u64(locator, 8);
                const record = view(readExactly(fd, 56, recordAt));
                if (record.getUint32(0, true) !== ZIP64_END || recordAt + 56 !== locatorAt) {
                    throw new Error(_('The ZIP64 end record is damaged.'));
                }
                count = u64(record, 32);
                directoryBytes = u64(record, 40);
                directoryStart = u64(record, 48);
                directoryEnd = recordAt;
            }
            if (directoryStart + directoryBytes !== directoryEnd) {
                throw new Error(_('The central directory does not end where the end record says.'));
            }
            return new ZipReader(fd, comment, count, directoryStart, directoryBytes);
        } catch (error) {
            closeSync(fd);
            throw error;
        }
    }

    close(): void {
        closeSync(this.fd);
    }

    /** The members in the order the directory lists them. Two reads per member. */
    *entries(): Generator<ZipEntry> {
        let at = this.directoryStart;
        const stop = this.directoryStart + this.directoryBytes;
        for (let index = 0; index < this.count; index++) {
            if (at + 46 > stop) throw new Error(_('The central directory is shorter than it says.'));
            const head = view(readExactly(this.fd, 46, at));
            if (head.getUint32(0, true) !== CENTRAL_ENTRY) {
                throw new Error(_('The central directory is damaged.'));
            }
            const flags = head.getUint16(8, true);
            const method = head.getUint16(10, true);
            const nameLength = head.getUint16(28, true);
            const extraLength = head.getUint16(30, true);
            const commentLength = head.getUint16(32, true);
            const rest = nameLength + extraLength + commentLength;
            if (at + 46 + rest > stop) throw new Error(_('The central directory is shorter than it says.'));
            const tail = readExactly(this.fd, rest, at + 46);
            const name = new TextDecoder('utf-8', { fatal: true }).decode(tail.subarray(0, nameLength));
            at += 46 + rest;

            if (flags & ENCRYPTED_FLAGS) throw new Error(fmt(_('{name} is encrypted.'), { name }));
            if (method !== 0)
                throw new Error(fmt(_('{name} is compressed; a case file is only ever stored.'), { name }));
            if (head.getUint16(34, true) !== 0)
                throw new Error(fmt(_('{name} sits on another disk.'), { name }));
            if (head.getUint16(4, true) >> 8 === 3) {
                const type = (head.getUint32(38, true) >>> 16) & 0o170000;
                if (type !== 0 && type !== 0o100000) {
                    throw new Error(fmt(_('{name} is not a regular file.'), { name }));
                }
            }

            let size = head.getUint32(24, true);
            let packed = head.getUint32(20, true);
            let offset = head.getUint32(42, true);
            if (size === MARK32 || packed === MARK32 || offset === MARK32) {
                const extra = view(tail.subarray(nameLength, nameLength + extraLength));
                const found = zip64Field(extra, extraLength);
                if (found === undefined) throw new Error(fmt(_('{name} lacks its ZIP64 sizes.'), { name }));
                let cursor = 0;
                const next = (): number => {
                    if (cursor + 8 > found.byteLength) {
                        throw new Error(fmt(_('{name} lacks its ZIP64 sizes.'), { name }));
                    }
                    const value = u64(found, cursor);
                    cursor += 8;
                    return value;
                };
                if (size === MARK32) size = next();
                if (packed === MARK32) packed = next();
                if (offset === MARK32) offset = next();
            }
            if (packed !== size)
                throw new Error(fmt(_('{name} is compressed; a case file is only ever stored.'), { name }));
            yield { name, size, offset };
        }
        if (at !== stop) throw new Error(_('The central directory has bytes no member accounts for.'));
    }

    /**
     * The member's bytes in blocks. The block is reused: use or copy it before pulling the next.
     * Checks the local header against the directory first, so a record pointing elsewhere fails.
     */
    *chunks(entry: ZipEntry): Generator<Uint8Array> {
        const header = view(readExactly(this.fd, 30, entry.offset));
        if (header.getUint32(0, true) !== LOCAL_HEADER) {
            throw new Error(fmt(_('The local header of {name} is missing.'), { name: entry.name }));
        }
        const nameLength = header.getUint16(26, true);
        const extraLength = header.getUint16(28, true);
        const local = new TextDecoder().decode(readExactly(this.fd, nameLength, entry.offset + 30));
        if (header.getUint16(8, true) !== 0 || local !== entry.name) {
            throw new Error(
                fmt(_('The local header of {name} disagrees with the directory.'), { name: entry.name }),
            );
        }
        const start = entry.offset + 30 + nameLength + extraLength;
        if (start + entry.size > this.directoryStart) {
            throw new Error(fmt(_('{name} runs into the central directory.'), { name: entry.name }));
        }
        const block = new Uint8Array(Math.min(BLOCK, Math.max(entry.size, 1)));
        for (let done = 0; done < entry.size; ) {
            const n = Math.min(block.length, entry.size - done);
            yield readExactly(this.fd, n, start + done, block);
            done += n;
        }
    }

    /**
     * The member as lines of text. A line longer than 64 KiB is not a manifest.
     * Split on the newline BYTE, which never occurs inside a multi-byte UTF-8 sequence, so no
     * streaming decoder is needed and every line is decoded whole.
     */
    *lines(entry: ZipEntry): Generator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let carry: Uint8Array = new Uint8Array(0);
        for (const block of this.chunks(entry)) {
            let start = 0;
            for (let at = block.indexOf(10, start); at >= 0; at = block.indexOf(10, start)) {
                const piece = block.subarray(start, at);
                if (carry.length === 0) {
                    yield decoder.decode(piece);
                } else {
                    yield decoder.decode(concat(carry, piece));
                    carry = new Uint8Array(0);
                }
                start = at + 1;
            }
            const rest = block.subarray(start);
            if (rest.length > 0) carry = carry.length === 0 ? rest.slice() : concat(carry, rest);
            if (carry.length > 65536) throw new Error(_('A line of the manifest is far too long.'));
        }
        if (carry.length > 0) yield decoder.decode(carry);
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

/** The data of the ZIP64 extra field (id 0x0001) in `extra`, if there is one. */
function zip64Field(extra: DataView, length: number): DataView | undefined {
    for (let at = 0; at + 4 <= length; ) {
        const id = extra.getUint16(at, true);
        const size = extra.getUint16(at + 2, true);
        if (at + 4 + size > length) return undefined;
        if (id === ZIP64_FIELD) return new DataView(extra.buffer, extra.byteOffset + at + 4, size);
        at += 4 + size;
    }
    return undefined;
}
