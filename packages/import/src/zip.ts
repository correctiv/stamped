/**
 * Reading ONE named entry out of a ZIP file — enough for the properties part of an Office
 * document, and deliberately nothing more.
 *
 * The central directory is what a ZIP reader trusts, so this one does too: it finds the end
 * record, walks the directory and follows the offset of the entry it wants. It never extracts
 * anything to disk and never inflates more than `limit` bytes, so a crafted attachment cannot
 * make the reader allocate without bound.
 */

import { inflateRawSync } from 'node:zlib';

const END_RECORD = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** The end record sits in the last 64 KiB (the comment field is 16 bits) plus its own 22 bytes. */
const END_SEARCH = 0xffff + 22;

const STORED = 0;
const DEFLATED = 8;

/** Does this buffer start like a ZIP file? */
export function looksLikeZip(bytes: Uint8Array): boolean {
    return (
        bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    );
}

/** The decoded bytes of the entry called `name`, or `undefined` for anything unreadable. */
export function zipEntry(bytes: Uint8Array, name: string, limit: number): Uint8Array | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - END_SEARCH); at--) {
        if (view.getUint32(at, true) === END_RECORD) {
            end = at;
            break;
        }
    }
    if (end < 0) return undefined;

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const wanted = new TextEncoder().encode(name);

    for (let index = 0; index < count; index++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) return undefined;
        const method = view.getUint16(at + 10, true);
        const packed = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        const entryName = bytes.subarray(at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;

        if (entryName.length !== wanted.length || !wanted.every((byte, i) => byte === entryName[i])) continue;
        if (size > limit) return undefined;
        if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_HEADER) return undefined;
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + packed);
        if (data.length !== packed) return undefined;
        try {
            if (method === STORED) return data;
            if (method === DEFLATED) return inflateRawSync(data, { maxOutputLength: limit });
        } catch {
            return undefined;
        }
        return undefined;
    }
    return undefined;
}
