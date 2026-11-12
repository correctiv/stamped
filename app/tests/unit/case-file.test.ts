/**
 * The case file: sealing a case, and refusing what does not match the seal.
 *
 * The tamper tests edit the packed bytes in place at a member's data. Nothing but the manifest's
 * hashes can notice that (the ZIP's own CRC is not read), which is exactly what is asserted.
 */

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { type MessageFinding, type Verdict } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    beginImportStatus,
    CASE_FILE_FORMAT,
    CASE_FILE_VERSION,
    CASE_VERSION,
    type CasePaths,
    checkCaseFile,
    digest,
    indexMessage,
    MANIFEST_MEMBER,
    openCase,
    openIndex,
    packCase,
    SCHEMA_VERSION,
    setBookmark,
    store,
    unpackCaseFile,
    verifyCaseFile,
    ZipReader,
    ZipWriter,
} from '@stamped/store';

import { refuseBusyCase } from '../../src/lib/case-busy.ts';
import { initI18n } from '../../src/lib/i18n.ts';

function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

function mail(id: string): Uint8Array {
    return encodeLatin1(
        `From: a@example.com\nTo: b@example.org\nSubject: ${id}\nMessage-ID: <${id}@example.com>\n\nbody ${id}\n`,
    );
}

/** A small case with every kind of file a case folder holds, and some it does not pack. */
function makeCase(root: string): { paths: CasePaths; hashes: string[] } {
    const paths = openCase(join(root, 'case'));
    const db = openIndex(paths);
    const hashes: string[] = [];
    try {
        for (const id of ['one', 'two', 'three']) {
            const raw = mail(id);
            const { hash } = store(paths, raw);
            hashes.push(hash);
            indexMessage(
                db,
                { hash, bytes: raw.length, summary: summarise(raw), finding: finding('unverifiable') },
                { fresh: true },
            );
        }
        // Re-indexed with another verdict: the first one must survive the trip.
        const again = mail('one');
        indexMessage(db, {
            hash: hashes[0]!,
            bytes: again.length,
            summary: summarise(again),
            finding: finding('confirmed'),
        });
    } finally {
        db.close();
    }
    writeFileSync(
        paths.log,
        hashes.map((hash) => JSON.stringify({ hash, source: '/somewhere/archive.mbox' })).join('\n') + '\n',
    );
    writeFileSync(join(paths.root, 'keys.json'), '{"version":1}\n');
    writeFileSync(join(paths.root, 'perimeter.json'), '["example.org"]\n');
    writeFileSync(join(paths.root, 'semantic.json'), '{"enabled":false}\n');
    setBookmark(paths, hashes[1]!, true);
    // Not packed: derived, about this machine, or half-written.
    writeFileSync(join(paths.root, 'vectors.db'), 'vectors');
    writeFileSync(join(paths.root, 'import-status.json'), '{}');
    writeFileSync(join(paths.root, 'index.db-wal'), 'wal');
    return { paths, hashes };
}

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> | void {
    const dir = mkdtempSync(join(tmpdir(), 'stamped-casefile-'));
    const done = (): void => rmSync(dir, { recursive: true, force: true });
    try {
        const result = run(dir);
        if (result instanceof Promise) return result.finally(done);
    } catch (error) {
        done();
        throw error;
    }
    done();
}

function rows(paths: CasePaths): unknown {
    const db = openIndex(paths);
    try {
        return JSON.parse(
            JSON.stringify(
                db.prepare('SELECT hash, verdict, first_verdict, bytes FROM messages ORDER BY hash').all(),
            ),
        );
    } finally {
        db.close();
    }
}

/** Where a member's data starts in a classic archive written by this module. */
function dataAt(file: string, name: string): number {
    const reader = ZipReader.open(file);
    try {
        for (const entry of reader.entries()) {
            if (entry.name === name) return entry.offset + 30 + new TextEncoder().encode(name).length;
        }
    } finally {
        reader.close();
    }
    throw new Error(`no member ${name}`);
}

function flip(file: string, at: number): void {
    const bytes = readFileSync(file);
    bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(file, bytes);
}

/** A case file built by hand, with an honest manifest, for the shapes pack would never produce. */
function craft(
    file: string,
    members: [string, string][],
    options: { version?: number; caseVersion?: number; extraLine?: string } = {},
): void {
    const writer = new ZipWriter(file);
    const lines = [
        JSON.stringify({
            format: CASE_FILE_FORMAT,
            version: options.version ?? CASE_FILE_VERSION,
            caseVersion: options.caseVersion ?? CASE_VERSION,
            schemaVersion: SCHEMA_VERSION,
        }),
    ];
    for (const [name, text] of members) {
        const written = writer.addBytes(name, new TextEncoder().encode(text));
        lines.push(JSON.stringify({ path: name, size: written.size, sha256: written.sha256 }));
    }
    if (options.extraLine !== undefined) lines.push(options.extraLine);
    const manifest = writer.addBytes(MANIFEST_MEMBER, new TextEncoder().encode(`${lines.join('\n')}\n`));
    writer.finish(manifest.sha256);
}

const MARKER = ['case.json', '{"kind":"stamped-case","version":1}'] as [string, string];

export default async () => {
    initI18n();
    await describe('case file', async () => {
        await it('seals a case, verifies it and unpacks the same case', async () => {
            await withDir((dir) => {
                const { paths, hashes } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                const packed = packCase(paths, file);
                // case.json, import-log, index.db, keys, marks, perimeter, semantic + 3 messages
                expect(packed.members).toBe(10);
                expect(packed.skipped.slice().sort()).toStrictEqual([
                    'import-status.json',
                    'index.db-wal',
                    'vectors.db',
                ]);

                const checked = verifyCaseFile(file);
                expect(checked.ok).toBe(true);
                expect(checked.members).toBe(10);
                expect(checked.sha256).toBe(packed.sha256);

                const target = join(dir, 'unpacked');
                unpackCaseFile(file, target);
                for (const name of [
                    'case.json',
                    'import-log.jsonl',
                    'keys.json',
                    'marks.json',
                    'perimeter.json',
                    'semantic.json',
                ]) {
                    expect(Array.from(readFileSync(join(target, name)))).toStrictEqual(
                        Array.from(readFileSync(join(paths.root, name))),
                    );
                }
                for (const hash of hashes) {
                    const at = join('raw', hash.slice(0, 2), `${hash}.eml`);
                    expect(Array.from(readFileSync(join(target, at)))).toStrictEqual(
                        Array.from(readFileSync(join(paths.root, at))),
                    );
                }
                expect(readdirSync(target).sort()).toStrictEqual([
                    'case.json',
                    'import-log.jsonl',
                    'index.db',
                    'keys.json',
                    'marks.json',
                    'perimeter.json',
                    'raw',
                    'semantic.json',
                ]);

                const unpacked = rows(openCase(target));
                expect(unpacked).toStrictEqual(rows(paths));
                const one = (unpacked as { hash: string; verdict: string; first_verdict: string }[]).find(
                    (row) => row.hash === hashes[0],
                );
                expect(one?.verdict).toBe('confirmed');
                expect(one?.first_verdict).toBe('unverifiable');
                expect(existsSync(`${target}.unpacking`)).toBe(false);
            });
        });

        await it('makes the same bytes from the same case', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                packCase(paths, join(dir, '1.stamped'));
                packCase(paths, join(dir, '2.stamped'));
                expect(Array.from(readFileSync(join(dir, '1.stamped')))).toStrictEqual(
                    Array.from(readFileSync(join(dir, '2.stamped'))),
                );
            });
        });

        await it('round-trips with ZIP64 forced by tiny limits', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                const file = join(dir, 'z.stamped');
                packCase(paths, file, { limits: { size: 150, count: 3 } });
                expect(verifyCaseFile(file).ok).toBe(true);
                const target = join(dir, 'z');
                unpackCaseFile(file, target);
                expect(rows(openCase(target))).toStrictEqual(rows(paths));
            });
        });

        await it('packs a case that has no index', async () => {
            await withDir((dir) => {
                const paths = openCase(join(dir, 'case'));
                const { hash } = store(paths, mail('solo'));
                const file = join(dir, 'a.stamped');
                expect(packCase(paths, file).members).toBe(2);
                expect(verifyCaseFile(file).ok).toBe(true);
                unpackCaseFile(file, join(dir, 'out'));
                expect(existsSync(join(dir, 'out', 'raw', hash.slice(0, 2), `${hash}.eml`))).toBe(true);
                expect(existsSync(join(dir, 'out', 'index.db'))).toBe(false);
            });
        });

        await it('refuses a changed message and leaves nothing behind', async () => {
            await withDir((dir) => {
                const { paths, hashes } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                packCase(paths, file);
                flip(file, dataAt(file, `raw/${hashes[2]!.slice(0, 2)}/${hashes[2]}.eml`) + 4);

                const checked = verifyCaseFile(file);
                expect(checked.ok).toBe(false);
                expect(checked.problems.some((problem) => problem.includes(hashes[2]!))).toBe(true);

                const target = join(dir, 'out');
                expect(() => unpackCaseFile(file, target)).toThrow();
                expect(existsSync(target)).toBe(false);
                expect(existsSync(`${target}.unpacking`)).toBe(false);
            });
        });

        await it('refuses a changed manifest', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                packCase(paths, file);
                flip(file, dataAt(file, MANIFEST_MEMBER) + 70);
                const checked = verifyCaseFile(file);
                expect(checked.ok).toBe(false);
                expect(checked.problems[0]!.includes('manifest')).toBe(true);
            });
        });

        await it('refuses a file from a newer version', async () => {
            await withDir((dir) => {
                craft(join(dir, 'v.stamped'), [MARKER], { version: CASE_FILE_VERSION + 1 });
                expect(verifyCaseFile(join(dir, 'v.stamped')).ok).toBe(false);
                craft(join(dir, 'c.stamped'), [MARKER], { caseVersion: CASE_VERSION + 1 });
                expect(verifyCaseFile(join(dir, 'c.stamped')).ok).toBe(false);
                craft(join(dir, 'ok.stamped'), [MARKER]);
                expect(verifyCaseFile(join(dir, 'ok.stamped')).ok).toBe(true);
            });
        });

        await it('refuses names that would leave the case folder, and writes nothing outside', async () => {
            await withDir((dir) => {
                const hash = 'a'.repeat(64);
                const names = [
                    '../evil',
                    '/abs',
                    'a\\b',
                    'C:x',
                    `raw/zz/${hash}.eml`,
                    'evil.txt',
                    'raw/aa/../evil',
                ];
                for (const [index, name] of names.entries()) {
                    const file = join(dir, `n${index}.stamped`);
                    craft(file, [MARKER, [name, 'x']]);
                    expect(verifyCaseFile(file).ok).toBe(false);
                    const target = join(dir, `out${index}`);
                    expect(() => unpackCaseFile(file, target)).toThrow();
                    expect(existsSync(target)).toBe(false);
                }
                expect(existsSync(join(dir, 'evil'))).toBe(false);
                expect(existsSync(join(dir, '..', 'evil'))).toBe(false);
            });
        });

        await it('refuses duplicates, a wrong order and a member the manifest does not list', async () => {
            await withDir((dir) => {
                craft(join(dir, 'd.stamped'), [MARKER, MARKER]);
                expect(verifyCaseFile(join(dir, 'd.stamped')).ok).toBe(false);
                craft(join(dir, 'o.stamped'), [['keys.json', '{}'], MARKER]);
                expect(verifyCaseFile(join(dir, 'o.stamped')).ok).toBe(false);
                craft(join(dir, 'm.stamped'), [MARKER], {
                    extraLine: JSON.stringify({ path: 'keys.json', size: 2, sha256: 'b'.repeat(64) }),
                });
                const missing = verifyCaseFile(join(dir, 'm.stamped'));
                expect(missing.ok).toBe(false);
                expect(missing.problems.some((problem) => problem.includes('keys.json'))).toBe(true);
            });
        });

        await it('refuses a raw member whose name is not its hash, even with an honest manifest', async () => {
            await withDir((dir) => {
                const name = `raw/aa/${'a'.repeat(62)}aa.eml`;
                craft(join(dir, 'r.stamped'), [MARKER, [name, 'not that hash']]);
                const checked = verifyCaseFile(join(dir, 'r.stamped'));
                expect(checked.ok).toBe(false);
                expect(checked.problems.some((problem) => problem.includes('its own hash'))).toBe(true);
            });
        });

        await it('says what is wrong with a file that is no case file at all', async () => {
            await withDir((dir) => {
                writeFileSync(join(dir, 'x.stamped'), 'plain text');
                const checked = checkCaseFile(join(dir, 'x.stamped'));
                expect(checked.ok).toBe(false);
                expect(checked.problems.length).toBe(1);
            });
        });

        await it('keeps hands off an existing or leftover target', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                packCase(paths, file);

                mkdirSync(join(dir, 'full'));
                writeFileSync(join(dir, 'full', 'mine.txt'), 'mine');
                expect(() => unpackCaseFile(file, join(dir, 'full'))).toThrow();
                expect(readFileSync(join(dir, 'full', 'mine.txt'), 'utf8')).toBe('mine');

                mkdirSync(join(dir, 'stale.unpacking'));
                expect(() => unpackCaseFile(file, join(dir, 'stale'))).toThrow(/stale\.unpacking/);
                expect(existsSync(join(dir, 'stale'))).toBe(false);

                mkdirSync(join(dir, 'empty'));
                unpackCaseFile(file, join(dir, 'empty'));
                expect(existsSync(join(dir, 'empty', 'case.json'))).toBe(true);
            });
        });

        await it('refuses to overwrite a case file, or to write inside the case', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                packCase(paths, file);
                expect(() => packCase(paths, file)).toThrow();
                packCase(paths, file, { force: true });
                expect(verifyCaseFile(file).ok).toBe(true);
                expect(() => packCase(paths, join(paths.root, 'inside.stamped'))).toThrow();
                expect(existsSync(`${file}.part`)).toBe(false);
                expect(existsSync(`${file}.index.part`)).toBe(false);
            });
        });

        await it('refuses a case whose message does not match its own hash', async () => {
            await withDir((dir) => {
                const { paths, hashes } = makeCase(dir);
                writeFileSync(join(paths.raw, hashes[0]!.slice(0, 2), `${hashes[0]}.eml`), 'damaged');
                const file = join(dir, 'case.stamped');
                expect(() => packCase(paths, file)).toThrow(hashes[0]!);
                expect(existsSync(file)).toBe(false);
                expect(existsSync(`${file}.part`)).toBe(false);
            });
        });

        await it('checks the free space before it starts', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                const file = join(dir, 'case.stamped');
                expect(() => packCase(paths, file, { freeBytes: 0 })).toThrow();
                expect(existsSync(file)).toBe(false);
                packCase(paths, file);
                expect(() => unpackCaseFile(file, join(dir, 'out'), { freeBytes: 0 })).toThrow();
                expect(existsSync(join(dir, 'out'))).toBe(false);
            });
        });

        await it('does not pack while an import is running', async () => {
            await withDir((dir) => {
                const { paths } = makeCase(dir);
                refuseBusyCase(paths);
                const handle = beginImportStatus(paths, [], { bytesTotal: 0 });
                expect(() => refuseBusyCase(paths)).toThrow();
                handle.cancel();
                refuseBusyCase(paths);
                expect(digest(new Uint8Array(0)).length).toBe(64);
            });
        });
    });
};
