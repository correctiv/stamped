/**
 * A case opened for reading only: nothing in the folder is created, changed or removed.
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    activityStatusFile,
    appendLog,
    assertWritable,
    casePaths,
    digest,
    indexMessage,
    isWritable,
    openCase,
    openIndex,
    setBookmark,
    setTags,
    store,
    writeActivityStatus,
    writePerimeter,
    writeSemanticSetting,
} from '@stamped/store';
import { KeyVault } from '@stamped/core';

import { caseAccess, setReadOnly } from '../../src/lib/case.ts';
import { initI18n } from '../../src/lib/i18n.ts';
import { saveVault } from '../../src/lib/vault.ts';

/** A case with one indexed message, closed again, so that what is on disk is what a copy holds. */
function withIndexedCase(body: (root: string, hash: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-readonly-'));
    try {
        const paths = openCase(root);
        const raw = encodeLatin1(
            [
                'From: a@example.com',
                'To: b@example.org',
                'Subject: hello',
                'Message-ID: <1@example.com>',
                '',
                'x',
                '',
            ].join('\n'),
        );
        const hash = digest(raw);
        const db = openIndex(paths);
        indexMessage(
            db,
            {
                hash,
                bytes: raw.length,
                summary: summarise(raw),
                finding: { verdict: 'confirmed', caveats: [], signatures: [] },
            },
            { fresh: true },
        );
        db.close();
        body(root, hash);
    } finally {
        try {
            chmodSync(root, 0o755);
        } catch {
            // already gone
        }
        rmSync(root, { recursive: true, force: true });
    }
}

/** The names in a folder, sorted, so that two listings can be compared. */
function listing(root: string): string[] {
    return readdirSync(root).sort();
}

const refused = /open read-only/;

export default async () => {
    initI18n();

    await describe('a read-only case', async () => {
        await it('refuses every write into the case folder, and says why', async () => {
            await Promise.resolve();
            withIndexedCase((root, hash) => {
                const paths = casePaths(root, true);
                const before = listing(root);
                expect(() => assertWritable(paths)).toThrow(refused);
                expect(() => setTags(paths, hash, ['a'])).toThrow(refused);
                expect(() => setBookmark(paths, hash, true)).toThrow(refused);
                expect(() => writePerimeter(paths, ['example.com'])).toThrow(refused);
                expect(() => store(paths, encodeLatin1('x'))).toThrow(refused);
                expect(() =>
                    appendLog(paths, [{ hash, source: 's', mailbox: 'm', offset: 0 } as never]),
                ).toThrow(refused);
                expect(() => writeSemanticSetting(paths, { enabled: true } as never)).toThrow(refused);
                expect(() => saveVault(paths, new KeyVault())).toThrow(refused);
                expect(listing(root)).toStrictEqual(before);
            });
        });

        await it('lets a writable case write as before', async () => {
            await Promise.resolve();
            withIndexedCase((root, hash) => {
                const paths = casePaths(root);
                expect(() => assertWritable(paths)).not.toThrow();
                expect(setBookmark(paths, hash, true).bookmark).toBe(true);
            });
        });

        await it('skips the status files, which describe a process rather than the case', async () => {
            await Promise.resolve();
            withIndexedCase((root) => {
                const paths = casePaths(root, true);
                writeActivityStatus(paths, { kind: 'keys', state: 'running' } as never);
                expect(existsSync(activityStatusFile(paths, 'keys'))).toBe(false);
            });
        });

        await it('reads the index and leaves no log or shared-memory file behind', async () => {
            await Promise.resolve();
            withIndexedCase((root) => {
                const before = listing(root);
                const db = openIndex(casePaths(root, true));
                try {
                    const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n?: number };
                    expect(Number(row.n)).toBe(1);
                    expect(() => db.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')")).toThrow();
                } finally {
                    db.close();
                }
                expect(listing(root)).toStrictEqual(before);
            });
        });

        await it('refuses a case with no index instead of creating one', async () => {
            await Promise.resolve();
            const root = mkdtempSync(join(tmpdir(), 'stamped-readonly-'));
            try {
                const paths = openCase(root);
                const before = listing(root);
                expect(() => openIndex({ ...paths, readOnly: true })).toThrow(/no index/);
                expect(listing(root)).toStrictEqual(before);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('refuses an index of another version instead of migrating it', async () => {
            await Promise.resolve();
            withIndexedCase((root) => {
                const writable = openIndex(casePaths(root));
                writable.exec("UPDATE meta SET value = '999' WHERE key = 'schema'");
                writable.close();
                expect(() => openIndex(casePaths(root, true))).toThrow(/another version/);
            });
        });

        await it('opens a folder that cannot be written to, which a WAL index otherwise refuses', async () => {
            await Promise.resolve();
            if (typeof process.getuid === 'function' && process.getuid() === 0) return;
            withIndexedCase((root) => {
                chmodSync(root, 0o555);
                expect(isWritable(root)).toBe(false);
                const paths = caseAccess(root);
                expect(paths.readOnly).toBe(true);
                const db = openIndex(paths);
                try {
                    const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n?: number };
                    expect(Number(row.n)).toBe(1);
                } finally {
                    db.close();
                }
            });
        });

        await it('is asked for with --read-only, and a folder that is not there yet is writable', async () => {
            await Promise.resolve();
            expect(isWritable('/nowhere/at/all')).toBe(true);
            setReadOnly(true);
            try {
                expect(caseAccess(tmpdir()).readOnly).toBe(true);
            } finally {
                setReadOnly(false);
            }
        });
    });
};
