/**
 * The import status file: written during a run, kept after it, and read by `stamped status` and
 * the window's banner.
 *
 * The file is process and progress data only, so the suite also checks it holds no mail content.
 * Every source is a synthetic fixture; the case folders are temporary and removed afterwards.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    beginImportStatus,
    cancelImportStatus,
    type CasePaths,
    IMPORT_STATUS_NAME,
    type ImportStatus,
    importSources,
    openCase,
    orphanedImport,
    plannedImportBytes,
    readImportStatus,
    STATUS_STALE_SECONDS,
    statusFile,
} from '@stamped/store';

import { statusCommand } from '../../src/commands/status.ts';
import { importOutcome } from '../../src/gui/view/import.ts';
import { noStatusLine, percent, statusHeadline, statusJson, statusLines } from '../../src/lib/status.ts';
import { archive, fixtureKeys } from './fixtures.ts';

async function withCase(body: (paths: CasePaths) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-status-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const T0 = Date.parse('2026-10-21T10:00:00Z');

/** A status as the file would hold it, overridable per test. */
function sample(over: Partial<ImportStatus> = {}): ImportStatus {
    return {
        version: 1,
        state: 'running',
        pid: process.pid,
        startedAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
        sources: ['/leak'],
        mailbox: 'ada@example.com',
        mailsDone: 250,
        mailsTotal: 1000,
        bytesRead: 250,
        bytesTotal: 1000,
        rate: 25,
        bytesRate: 25,
        eta: 30,
        errors: 0,
        ...over,
    };
}

/** A status whose last update is now, for the code that reads the real clock. */
function live(over: Partial<ImportStatus> = {}): ImportStatus {
    return sample({ updatedAt: new Date().toISOString(), ...over });
}

/** Run `stamped status` and capture what it printed. */
async function runStatus(args: { case?: string; json?: boolean }): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(' '));
    try {
        const command = statusCommand();
        await (command.handler as (a: unknown) => unknown)({ ...args, _: [], $0: 'stamped' });
    } finally {
        console.log = original;
    }
    return lines;
}

export default async () => {
    await describe('import status file', async () => {
        await it('is written when a run begins, and atomically replaced', async () => {
            await withCase((paths) => {
                let now = T0;
                const handle = beginImportStatus(paths, [archive('leak')], { now: () => now, pid: 4242 });
                const first = readImportStatus(paths);
                expect(first?.state).toBe('running');
                expect(first?.pid).toBe(4242);
                expect(first?.bytesTotal).toBe(plannedImportBytes([archive('leak')]));
                expect(existsSync(`${statusFile(paths)}.tmp`)).toBe(false);

                // Inside one second: no rewrite.
                now += 400;
                handle.update({
                    read: 3,
                    stored: 3,
                    duplicates: 0,
                    indexed: 0,
                    failed: 0,
                    total: 10,
                    done: 1,
                    bytesRead: 300,
                });
                expect(readImportStatus(paths)?.mailsDone).toBe(0);

                now += 1000;
                handle.update({
                    read: 6,
                    stored: 6,
                    duplicates: 0,
                    indexed: 0,
                    failed: 1,
                    total: 10,
                    done: 4,
                    bytesRead: 600,
                    mailbox: 'ada@example.com',
                });
                const mid = readImportStatus(paths);
                expect(mid?.mailsDone).toBe(6);
                expect(mid?.mailsTotal).toBe(10);
                expect(mid?.bytesRead).toBe(600);
                expect(mid?.errors).toBe(1);
                expect(mid?.mailbox).toBe('ada@example.com');
            });
        });

        await it('keeps the final state after a real import, with no mail content', async () => {
            await withCase(async (paths) => {
                const source = archive('leak');
                const handle = beginImportStatus(paths, [source], { mode: 'folders' });
                const result = await importSources(paths, [source], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                    onProgress: (progress) => handle.update(progress),
                });
                handle.finish(result);

                const status = readImportStatus(paths);
                expect(status?.state).toBe('finished');
                expect(status?.mailsDone).toBe(result.read);
                expect(status?.bytesRead).toBe(status?.bytesTotal);
                expect(status?.bytesTotal).toBeGreaterThan(0);
                expect(status?.eta).toBe(0);
                expect(orphanedImport(status as ImportStatus)).toBe(false);

                const text = readFileSync(statusFile(paths), 'utf8');
                expect(text.includes('harbour')).toBe(false);
                expect(text.includes('Subject')).toBe(false);
                expect(IMPORT_STATUS_NAME).toBe('import-status.json');
            });
        });

        await it('records failed and cancelled runs', async () => {
            await withCase((paths) => {
                beginImportStatus(paths, []).fail();
                expect(readImportStatus(paths)?.state).toBe('failed');
                beginImportStatus(paths, []).cancel();
                expect(readImportStatus(paths)?.state).toBe('cancelled');
                // A record is not rewritten.
                expect(cancelImportStatus(paths)).toBe(undefined);
                beginImportStatus(paths, []);
                expect(cancelImportStatus(paths)?.state).toBe('cancelled');
                expect(readImportStatus(paths)?.state).toBe('cancelled');
            });
        });

        await it('measures the bytes of every source, files and folders', () => {
            const folder = plannedImportBytes([archive('leak')]);
            const part = statSync(archive('leak', 'ada@example.com', 'part-01.mbox')).size;
            expect(folder).toBeGreaterThan(part);
            expect(plannedImportBytes([archive('leak', 'ada@example.com', 'part-01.mbox')])).toBe(part);
            expect(plannedImportBytes(['/nonexistent/stamped-status'])).toBe(0);
        });

        await it('refuses a file it cannot trust', async () => {
            await withCase((paths) => {
                expect(readImportStatus(paths)).toBe(undefined);
                writeFileSync(statusFile(paths), '{ not json');
                expect(readImportStatus(paths)).toBe(undefined);
                writeFileSync(statusFile(paths), JSON.stringify({ ...sample(), version: 99 }));
                expect(readImportStatus(paths)).toBe(undefined);
                writeFileSync(statusFile(paths), JSON.stringify({ ...sample(), state: 'weird' }));
                expect(readImportStatus(paths)).toBe(undefined);
            });
        });
    });

    await describe('orphan detection', async () => {
        await it('is false for a live process with a fresh update', () => {
            expect(orphanedImport(sample(), T0 + 5000)).toBe(false);
        });
        await it('is true when the process is gone', () => {
            expect(orphanedImport(sample({ pid: 2 ** 22 + 12345 }), T0 + 1000)).toBe(true);
        });
        await it('is true when the last update is too old', () => {
            const late = T0 + (STATUS_STALE_SECONDS + 1) * 1000;
            expect(orphanedImport(sample(), late)).toBe(true);
        });
        await it('is never true for an end state', () => {
            for (const state of ['finished', 'failed', 'cancelled'] as const) {
                expect(orphanedImport(sample({ state, pid: 2 ** 22 + 12345 }), T0 + 10 ** 9)).toBe(false);
            }
        });
    });

    await describe('status output', async () => {
        await it('computes the percent by bytes', () => {
            expect(percent(250, 1000)).toBe(25);
            expect(percent(1, 3)).toBe(33.3);
            expect(percent(5, 0)).toBe(0);
            expect(percent(2000, 1000)).toBe(100);
        });

        await it('prints human lines with mailbox, percent, mails, rate, time left', () => {
            const text = statusLines(live()).join('\n');
            expect(text.includes('An import is running')).toBe(true);
            expect(text.includes('250 messages read (25% of 1.0 kB)')).toBe(true);
            expect(text.includes('Mailbox: ada@example.com')).toBe(true);
            expect(text.includes('25 messages/s')).toBe(true);
            expect(text.includes('About 30.0 s left.')).toBe(true);
            expect(text.includes('verification failed')).toBe(false);
        });

        await it('mentions errors, and says interrupted for an orphan', () => {
            expect(
                statusLines(sample({ errors: 2 }))
                    .join('\n')
                    .includes('2 messages have no verdict'),
            ).toBe(true);
            const orphan = sample({ pid: 2 ** 22 + 12345 });
            expect(statusHeadline(orphan).includes('interrupted')).toBe(true);
            expect(
                statusLines(sample({ state: 'finished', eta: 0 }))
                    .join('\n')
                    .includes('left'),
            ).toBe(false);
        });

        await it('shapes the --json object', () => {
            const json = statusJson(sample({ pid: 2 ** 22 + 12345 }));
            expect(json.orphaned).toBe(true);
            expect(json.percent).toBe(25);
            expect(json.state).toBe('running');
            expect(json.sources).toStrictEqual(['/leak']);
        });

        await it('stamped status exits cleanly with no import, as text and as JSON', async () => {
            await withCase(async (paths) => {
                const text = await runStatus({ case: paths.root });
                expect(text).toStrictEqual([noStatusLine(paths.root)]);
                const json = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(json).toStrictEqual({ state: 'none', orphaned: false, activities: [] });
            });
        });

        await it('stamped status --json reports a finished import', async () => {
            await withCase(async (paths) => {
                const source = archive('leak');
                const handle = beginImportStatus(paths, [source]);
                const result = await importSources(paths, [source], {
                    keys: fixtureKeys(),
                    mode: 'folders',
                    onProgress: (progress) => handle.update(progress),
                });
                handle.finish(result);
                const json = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(json.state).toBe('finished');
                expect(json.orphaned).toBe(false);
                expect(json.percent).toBe(100);
                expect(json.mailsDone).toBe(result.read);
            });
        });
    });

    await describe('import outcome', async () => {
        await it('names every outcome', () => {
            expect(importOutcome(live({ state: 'finished' }), false)).toBe('Import finished.');
            expect(importOutcome(live({ state: 'failed' }), false)).toBe('The import failed.');
            expect(importOutcome(live({ state: 'cancelled' }), false).startsWith('Import cancelled')).toBe(
                true,
            );
            expect(importOutcome(live(), true).startsWith('The import stopped')).toBe(true);
        });
    });
};
