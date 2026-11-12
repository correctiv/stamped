/**
 * The ZIP layer under the case file: what it writes, what it reads back, and what it refuses.
 *
 * ZIP64 is reached by LOWERING the limits instead of writing 4 GiB, which exercises the same
 * code: a value at or above the limit goes through the extended fields, one below it does not.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { checkName, crc32, crc32Fallback, ZipReader, ZipWriter, type ZipLimits } from '@stamped/store';

function withDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'stamped-zip-'));
    try {
        run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Deterministic bytes that are not all the same, so a swapped block shows. */
function bytesOf(length: number, seed: number): Uint8Array {
    const out = new Uint8Array(length);
    let x = seed;
    for (let i = 0; i < length; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        out[i] = x >> 16;
    }
    return out;
}

function write(path: string, members: [string, Uint8Array][], limits?: ZipLimits): void {
    const writer = new ZipWriter(path, { limits });
    for (const [name, bytes] of members) writer.addBytes(name, bytes);
    writer.finish('a comment');
}

function readAll(path: string): { name: string; bytes: Uint8Array }[] {
    const reader = ZipReader.open(path);
    try {
        const found: { name: string; bytes: Uint8Array }[] = [];
        for (const entry of reader.entries()) {
            const parts: Uint8Array[] = [];
            for (const block of reader.chunks(entry)) parts.push(block.slice());
            const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let at = 0;
            for (const part of parts) {
                bytes.set(part, at);
                at += part.length;
            }
            found.push({ name: entry.name, bytes });
        }
        return found;
    } finally {
        reader.close();
    }
}

function opens(path: string): boolean {
    try {
        const reader = ZipReader.open(path);
        for (const entry of reader.entries()) for (const _block of reader.chunks(entry)) void _block;
        reader.close();
        return true;
    } catch {
        return false;
    }
}

/** Where in the file the central directory's first record starts. */
function firstRecord(file: Uint8Array): number {
    for (let at = 0; at + 4 <= file.length; at++) {
        if (file[at] === 0x50 && file[at + 1] === 0x4b && file[at + 2] === 0x01 && file[at + 3] === 0x02)
            return at;
    }
    throw new Error('no central record');
}

const MEMBERS: [string, Uint8Array][] = [
    ['a.txt', bytesOf(10, 1)],
    ['empty', new Uint8Array(0)],
    ['b.bin', bytesOf(1024 * 1024 + 123, 2)],
    ['c.txt', bytesOf(40, 3)],
];

export default async () => {
    await describe('zip-store', async () => {
        await it('has the standard CRC-32, with and without the runtime', async () => {
            const check = new TextEncoder().encode('123456789');
            expect(crc32Fallback(check)).toBe(0xcbf43926);
            expect(crc32(check)).toBe(0xcbf43926);
            const big = bytesOf(100000, 9);
            expect(crc32Fallback(big)).toBe(crc32(big));
            expect(crc32Fallback(big.subarray(50000), crc32Fallback(big.subarray(0, 50000)))).toBe(
                crc32Fallback(big),
            );
        });

        await it('round-trips members through a classic archive', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const back = readAll(path);
                expect(back.map((m) => m.name)).toStrictEqual(MEMBERS.map(([name]) => name));
                back.forEach((member, i) => {
                    expect(Array.from(member.bytes)).toStrictEqual(Array.from(MEMBERS[i]![1]));
                });
                const reader = ZipReader.open(path);
                expect(reader.comment).toBe('a comment');
                expect(reader.count).toBe(4);
                reader.close();
            });
        });

        await it('round-trips through ZIP64 when the limits are lowered', async () => {
            withDir((dir) => {
                const path = join(dir, 'z.zip');
                // 10 bytes and 2 members: the second member's size, every offset after the first,
                // the count and the directory all land on the extended side.
                write(path, MEMBERS, { size: 10, count: 2 });
                const back = readAll(path);
                back.forEach((member, i) => {
                    expect(Array.from(member.bytes)).toStrictEqual(Array.from(MEMBERS[i]![1]));
                });
            });
        });

        await it('writes files from disk and notices none of the members being the wrong size', async () => {
            withDir((dir) => {
                const source = join(dir, 'source');
                writeFileSync(source, bytesOf(2500000, 5));
                const path = join(dir, 'f.zip');
                const writer = new ZipWriter(path);
                const written = writer.addFile('source', source);
                writer.finish('');
                expect(written.size).toBe(2500000);
                expect(readAll(path)[0]!.bytes.length).toBe(2500000);
            });
        });

        await it('writes the same bytes for the same members', async () => {
            withDir((dir) => {
                write(join(dir, '1.zip'), MEMBERS);
                write(join(dir, '2.zip'), MEMBERS);
                expect(Array.from(readFileSync(join(dir, '1.zip')))).toStrictEqual(
                    Array.from(readFileSync(join(dir, '2.zip'))),
                );
            });
        });

        await it('refuses a compressed member', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const file = readFileSync(path);
                file[firstRecord(file) + 10] = 8;
                writeFileSync(path, file);
                expect(opens(path)).toBe(false);
            });
        });

        await it('refuses an encrypted member', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const file = readFileSync(path);
                file[firstRecord(file) + 8] |= 1;
                writeFileSync(path, file);
                expect(opens(path)).toBe(false);
            });
        });

        await it('refuses a member that is not a regular file', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const file = readFileSync(path);
                new DataView(file.buffer, file.byteOffset, file.byteLength).setUint32(
                    firstRecord(file) + 38,
                    (0o120777 << 16) >>> 0,
                    true,
                );
                writeFileSync(path, file);
                expect(opens(path)).toBe(false);
            });
        });

        await it('refuses a truncated file, and one with bytes appended', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const file = readFileSync(path);
                writeFileSync(join(dir, 'cut.zip'), file.subarray(0, file.length - 10));
                expect(opens(join(dir, 'cut.zip'))).toBe(false);
                const longer = new Uint8Array(file.length + 5);
                longer.set(file);
                writeFileSync(join(dir, 'long.zip'), longer);
                expect(opens(join(dir, 'long.zip'))).toBe(false);
            });
        });

        await it('refuses a record whose offset points elsewhere', async () => {
            withDir((dir) => {
                const path = join(dir, 'a.zip');
                write(path, MEMBERS);
                const file = readFileSync(path);
                const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
                const record = firstRecord(file);
                view.setUint32(record + 42, view.getUint32(record + 42, true) + 3, true);
                writeFileSync(path, file);
                expect(opens(path)).toBe(false);
            });
        });

        await it('names what leaves the folder, and accepts what stays inside', async () => {
            for (const bad of [
                '',
                '/etc/passwd',
                '../evil',
                'a/../b',
                'a//b',
                './a',
                'a\\b',
                'C:x',
                'dir/',
                'a\u0000b',
            ]) {
                expect(checkName(bad) === undefined).toBe(false);
            }
            for (const good of ['case.json', 'raw/ab/' + 'a'.repeat(64) + '.eml']) {
                expect(checkName(good)).toBe(undefined);
            }
        });
    });
};
