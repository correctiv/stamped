/**
 * `case reindex`: the index put back from `raw/`.
 *
 * What is asserted is the promise of the design: the rebuilt index answers like the old one, what
 * only the old index remembered (`first_verdict`) survives, and nothing is ever lost on the way —
 * not the raw store, not the log, and not the old index when the run does not complete.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { KeyStore, type MessageFinding, type Verdict } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    type CasePaths,
    indexMessage,
    listRawHashes,
    messageCount,
    openCase,
    openIndex,
    rawPath,
    rebuildPath,
    reindexCase,
    store,
} from '@stamped/store';

import { initI18n } from '../../src/lib/i18n.ts';

function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

function mail(id: string): Uint8Array {
    return encodeLatin1(
        `From: a@example.com\nTo: b@example.org\nSubject: ${id}\nMessage-ID: <${id}@example.com>\n\nbody ${id}\n`,
    );
}

/** A case with these messages stored, indexed with the verdict `confirmed` and logged. */
function makeCase(root: string, ids: readonly string[]): { paths: CasePaths; hashes: string[] } {
    const paths = openCase(join(root, 'case'));
    const db = openIndex(paths);
    const hashes: string[] = [];
    try {
        for (const id of ids) {
            const raw = mail(id);
            const { hash } = store(paths, raw);
            hashes.push(hash);
            indexMessage(
                db,
                { hash, bytes: raw.length, summary: summarise(raw), finding: finding('confirmed') },
                { fresh: true },
            );
        }
    } finally {
        db.close();
    }
    writeFileSync(
        paths.log,
        hashes
            .map((hash) =>
                JSON.stringify({ hash, source: '/somewhere/archive.mbox', mailbox: 'ada@example.org' }),
            )
            .join('\n') + '\n',
    );
    return { paths, hashes };
}

function withDir(run: (dir: string) => void | Promise<void>): Promise<void> | void {
    const dir = mkdtempSync(join(tmpdir(), 'stamped-reindex-'));
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

function rows(paths: CasePaths): { hash: string; verdict: string; first_verdict: string | null }[] {
    const db = openIndex(paths);
    try {
        return JSON.parse(
            JSON.stringify(
                db.prepare('SELECT hash, verdict, first_verdict FROM messages ORDER BY hash').all(),
            ),
        );
    } finally {
        db.close();
    }
}

function count(paths: CasePaths): number {
    const db = openIndex(paths);
    try {
        return messageCount(db);
    } finally {
        db.close();
    }
}

const keys = new KeyStore();

export default async () => {
    initI18n();
    await describe('case reindex', async () => {
        await it('lists the stored messages in order and ignores what is not one', async () => {
            await withDir((dir) => {
                const { paths, hashes } = makeCase(dir, ['one', 'two', 'three']);
                writeFileSync(`${rawPath(paths, hashes[0]!)}.part`, 'half');
                writeFileSync(join(paths.raw, hashes[0]!.slice(0, 2), 'notes.txt'), 'x');
                expect(listRawHashes(paths)).toStrictEqual([...hashes].sort());
                expect(listRawHashes(openCase(join(dir, 'empty')))).toStrictEqual([]);
            });
        });

        await it('puts the index back when it was deleted', async () => {
            await withDir(async (dir) => {
                const { paths, hashes } = makeCase(dir, ['one', 'two', 'three']);
                rmSync(paths.database);
                const result = await reindexCase(paths, { keys });
                expect(result.indexed).toBe(3);
                expect(result.before).toBe(undefined);
                expect(result.failures).toStrictEqual([]);
                expect(result.replaced).toBe(true);
                expect(rows(paths).map((row) => row.hash)).toStrictEqual([...hashes].sort());
                expect(existsSync(rebuildPath(paths))).toBe(false);
            });
        });

        await it('verifies again, so the verdict is the current one', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one']);
                await reindexCase(paths, { keys });
                expect(rows(paths)[0]!.verdict).toBe('unsigned');
            });
        });

        await it('carries first_verdict over, including a legacy NULL', async () => {
            await withDir(async (dir) => {
                const { paths, hashes } = makeCase(dir, ['one', 'two']);
                const db = openIndex(paths);
                try {
                    db.prepare('UPDATE messages SET first_verdict = NULL WHERE hash = ?').run(hashes[1]!);
                } finally {
                    db.close();
                }
                // A third message the old index never had.
                store(paths, mail('three'));
                const result = await reindexCase(paths, { keys });
                expect(result.before).toBe(2);
                expect(result.carried).toBe(2);
                const byHash = new Map(rows(paths).map((row) => [row.hash, row]));
                expect(byHash.get(hashes[0]!)!.first_verdict).toBe('confirmed');
                expect(byHash.get(hashes[1]!)!.first_verdict).toBe(null);
                const added = [...byHash.values()].filter((row) => !hashes.includes(row.hash));
                expect(added.length).toBe(1);
                expect(added[0]!.first_verdict).toBe('unsigned');
            });
        });

        await it('leaves the raw store and the import log as they were', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one', 'two']);
                const log = readFileSync(paths.log, 'utf8');
                const before = listRawHashes(paths);
                await reindexCase(paths, { keys });
                expect(readFileSync(paths.log, 'utf8')).toBe(log);
                expect(listRawHashes(paths)).toStrictEqual(before);
            });
        });

        await it('replaces an index that cannot be read', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one', 'two']);
                writeFileSync(paths.database, 'this is not a database');
                const result = await reindexCase(paths, { keys });
                expect(result.before).toBe(undefined);
                expect(result.indexed).toBe(2);
                expect(count(paths)).toBe(2);
            });
        });

        await it('removes a leftover of an earlier run and the old index log', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one']);
                writeFileSync(rebuildPath(paths), 'half a file');
                writeFileSync(`${rebuildPath(paths)}-wal`, 'half a log');
                writeFileSync(`${paths.database}-wal`, 'stale');
                await reindexCase(paths, { keys });
                expect(existsSync(rebuildPath(paths))).toBe(false);
                expect(existsSync(`${rebuildPath(paths)}-wal`)).toBe(false);
                expect(existsSync(`${paths.database}-wal`)).toBe(false);
                expect(count(paths)).toBe(1);
            });
        });

        await it('keeps the old index when a message file does not match its name', async () => {
            await withDir(async (dir) => {
                const { paths, hashes } = makeCase(dir, ['one', 'two']);
                writeFileSync(rawPath(paths, hashes[1]!), mail('tampered'));
                const result = await reindexCase(paths, { keys });
                expect(result.replaced).toBe(false);
                expect(result.failures.length).toBe(1);
                expect(result.failures[0]!.hash).toBe(hashes[1]);
                expect(count(paths)).toBe(2);
                expect(rows(paths)[0]!.verdict).toBe('confirmed');
                expect(existsSync(rebuildPath(paths))).toBe(false);
            });
        });

        await it('replaces the index without the failed message when told to', async () => {
            await withDir(async (dir) => {
                const { paths, hashes } = makeCase(dir, ['one', 'two']);
                writeFileSync(rawPath(paths, hashes[1]!), mail('tampered'));
                const result = await reindexCase(paths, { keys, acceptFailures: true });
                expect(result.replaced).toBe(true);
                expect(result.indexed).toBe(1);
                expect(count(paths)).toBe(1);
                expect(existsSync(rebuildPath(paths))).toBe(false);
            });
        });

        await it('keeps the old index when the run is interrupted', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one', 'two', 'three']);
                let failed = false;
                try {
                    await reindexCase(paths, {
                        keys,
                        onProgress: (done) => {
                            if (done === 2) throw new Error('stop here');
                        },
                    });
                } catch (error) {
                    failed = (error as Error).message === 'stop here';
                }
                expect(failed).toBe(true);
                expect(count(paths)).toBe(3);
                expect(rows(paths)[0]!.verdict).toBe('confirmed');
                expect(existsSync(rebuildPath(paths))).toBe(false);
            });
        });

        await it('opens as an ordinary index afterwards, and a second run is the same', async () => {
            await withDir(async (dir) => {
                const { paths } = makeCase(dir, ['one', 'two']);
                await reindexCase(paths, { keys });
                const first = rows(paths);
                const again = await reindexCase(paths, { keys });
                expect(again.before).toBe(2);
                expect(again.carried).toBe(2);
                expect(rows(paths)).toStrictEqual(first);
            });
        });
    });
};
