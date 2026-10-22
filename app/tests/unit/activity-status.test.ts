/**
 * The activity status files: one per kind of background run, numbers only, never trusted when
 * the process is gone or silent. Every clock here is a fake one; the case folders are temporary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    ACTIVITY_KINDS,
    type ActivityStatus,
    activityStatusFile,
    beginActivityStatus,
    type CasePaths,
    liveActivity,
    openCase,
    orphanedActivity,
    readActivityStatus,
    readActivityStatuses,
    STATUS_STALE_SECONDS,
    writeActivityStatus,
} from '@stamped/store';

import { statusCommand } from '../../src/commands/status.ts';
import { activityJson, activityLine } from '../../src/lib/status.ts';

async function withCase(body: (paths: CasePaths) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-activity-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const T0 = Date.parse('2026-10-21T10:00:00Z');

function sample(over: Partial<ActivityStatus> = {}): ActivityStatus {
    return {
        version: 1,
        kind: 'people',
        state: 'running',
        pid: process.pid,
        startedAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
        done: 40,
        total: 100,
        ...over,
    };
}

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
    await describe('activity status file', async () => {
        await it('is written at once, throttled to a second, and the end state is always written', async () => {
            await withCase((paths) => {
                let now = T0;
                const handle = beginActivityStatus(paths, 'reverify', { now: () => now, pid: 4242 });
                expect(readActivityStatus(paths, 'reverify')?.state).toBe('running');
                expect(readActivityStatus(paths, 'reverify')?.pid).toBe(4242);
                expect(existsSync(`${activityStatusFile(paths, 'reverify')}.tmp`)).toBe(false);

                now += 400;
                handle.update(3, 10);
                expect(readActivityStatus(paths, 'reverify')?.done).toBe(0);

                now += 700;
                handle.update(5, 10);
                expect(readActivityStatus(paths, 'reverify')?.done).toBe(5);

                now += 100;
                handle.update(10, 10);
                expect(readActivityStatus(paths, 'reverify')?.done).toBe(5);
                handle.finish();
                const end = readActivityStatus(paths, 'reverify');
                expect(end?.state).toBe('finished');
                expect(end?.done).toBe(10);
                expect(end?.total).toBe(10);
            });
        });

        await it('keeps one file per kind and holds numbers only', async () => {
            await withCase((paths) => {
                beginActivityStatus(paths, 'people', { pid: 1 }).update(1, 2);
                beginActivityStatus(paths, 'keys', { pid: 2 }).fail();
                expect(readActivityStatuses(paths).map((s) => s.kind)).toStrictEqual(['people', 'keys']);
                expect(readActivityStatus(paths, 'keys')?.state).toBe('failed');
                const text = readFileSync(activityStatusFile(paths, 'people'), 'utf8');
                expect(Object.keys(JSON.parse(text)).sort()).toStrictEqual([
                    'done',
                    'kind',
                    'pid',
                    'startedAt',
                    'state',
                    'total',
                    'updatedAt',
                    'version',
                ]);
                expect(ACTIVITY_KINDS.length).toBe(3);
            });
        });

        await it('refuses a file of another kind, a newer version or garbage', async () => {
            await withCase((paths) => {
                writeActivityStatus(paths, sample({ kind: 'people' }));
                expect(readActivityStatus(paths, 'keys')).toBeUndefined();
                writeActivityStatus(paths, sample({ version: 99 }));
                expect(readActivityStatus(paths, 'people')).toBeUndefined();
            });
        });

        await it('reads a stale or dead running file as interrupted, never as running', async () => {
            const fresh = sample({ updatedAt: new Date(T0).toISOString() });
            const edge = T0 + STATUS_STALE_SECONDS * 1000;
            expect(orphanedActivity(fresh, T0 + 5000)).toBe(false);
            expect(orphanedActivity(fresh, edge)).toBe(false);
            expect(orphanedActivity(fresh, edge + 1)).toBe(true);
            expect(orphanedActivity(sample({ pid: 2 ** 22 + 12345 }), T0)).toBe(true);
            expect(orphanedActivity(sample({ updatedAt: 'nonsense' }), T0)).toBe(true);
            expect(orphanedActivity(sample({ state: 'finished' }), edge * 10)).toBe(false);
            await withCase((paths) => {
                writeActivityStatus(paths, fresh);
                expect(liveActivity(paths, 'people', T0 + 1000)).toBe(true);
                expect(liveActivity(paths, 'people', edge + 1)).toBe(false);
                expect(liveActivity(paths, 'keys', T0)).toBe(false);
            });
        });

        await it('is formatted as a sentence and as JSON', async () => {
            expect(activityLine(sample(), T0 + 1000)).toBe('Listing addresses: 40 of 100 messages.');
            expect(activityLine(sample(), T0 + 120_000)).toBe('The address listing was interrupted.');
            expect(activityLine(sample({ kind: 'keys', state: 'finished' }))).toBe(
                'The last key lookup finished.',
            );
            const json = activityJson(sample(), T0 + 120_000);
            expect(json.orphaned).toBe(true);
            expect(json.percent).toBe(40);
        });

        await it('shows in `stamped status`, which exits cleanly with nothing running', async () => {
            await withCase(async (paths) => {
                const empty = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(empty.activities).toStrictEqual([]);
                writeActivityStatus(paths, sample({ updatedAt: new Date().toISOString() }));
                const json = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(json.activities.length).toBe(1);
                expect(json.activities[0].kind).toBe('people');
                expect(json.activities[0].orphaned).toBe(false);
                const text = await runStatus({ case: paths.root });
                expect(text.some((l) => l.startsWith('Listing addresses'))).toBe(true);
            });
        });
    });
};
