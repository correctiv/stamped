/**
 * The list of recently opened cases behind the start screen.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    forgetCase,
    offeredCases,
    RECENT_CASES_KEPT,
    RECENT_CASES_NAME,
    RECENT_CASES_SHOWN,
    readRecentCases,
    recentCasesDir,
    rememberCase,
} from '../../src/lib/recent-cases.ts';

function withDir(run: (dir: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-recent-'));
    try {
        run(join(root, 'state'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const paths = (dir: string): string[] => readRecentCases(dir).map((entry) => entry.path);

export default async () => {
    await describe('recent cases', async () => {
        await it('is empty when nothing was ever opened', async () => {
            withDir((dir) => {
                expect(readRecentCases(dir)).toStrictEqual([]);
            });
        });

        await it('puts the case opened last first', async () => {
            withDir((dir) => {
                rememberCase(dir, '/cases/a', 1);
                rememberCase(dir, '/cases/b', 2);
                rememberCase(dir, '/cases/c', 3);
                expect(paths(dir)).toStrictEqual(['/cases/c', '/cases/b', '/cases/a']);
            });
        });

        await it('moves a case opened again to the head instead of listing it twice', async () => {
            withDir((dir) => {
                rememberCase(dir, '/cases/a', 1);
                rememberCase(dir, '/cases/b', 2);
                rememberCase(dir, '/cases/./a/', 3);
                expect(readRecentCases(dir)).toStrictEqual([
                    { path: '/cases/a', openedAt: 3 },
                    { path: '/cases/b', openedAt: 2 },
                ]);
            });
        });

        await it('keeps only the newest entries', async () => {
            withDir((dir) => {
                for (let i = 0; i < RECENT_CASES_KEPT + 5; i++) rememberCase(dir, `/cases/${i}`, i);
                const kept = paths(dir);
                expect(kept.length).toBe(RECENT_CASES_KEPT);
                expect(kept[0]).toBe(`/cases/${RECENT_CASES_KEPT + 4}`);
                expect(kept.includes('/cases/0')).toBe(false);
            });
        });

        await it('forgets one case and leaves the others', async () => {
            withDir((dir) => {
                rememberCase(dir, '/cases/a', 1);
                rememberCase(dir, '/cases/b', 2);
                forgetCase(dir, '/cases/a');
                expect(paths(dir)).toStrictEqual(['/cases/b']);
                forgetCase(dir, '/cases/never-listed');
                expect(paths(dir)).toStrictEqual(['/cases/b']);
            });
        });

        await it('reads a corrupt, foreign or newer file as an empty list and replaces it', async () => {
            withDir((dir) => {
                mkdirSync(dir, { recursive: true });
                const file = join(dir, RECENT_CASES_NAME);
                for (const body of [
                    'not json',
                    '[]',
                    '{"version":99,"cases":[]}',
                    '{"version":1,"cases":5}',
                ]) {
                    writeFileSync(file, body);
                    expect(readRecentCases(dir)).toStrictEqual([]);
                }
                writeFileSync(file, 'not json');
                rememberCase(dir, '/cases/a', 1);
                expect(paths(dir)).toStrictEqual(['/cases/a']);
            });
        });

        await it('drops malformed entries and keeps the good ones', async () => {
            withDir((dir) => {
                mkdirSync(dir, { recursive: true });
                writeFileSync(
                    join(dir, RECENT_CASES_NAME),
                    JSON.stringify({
                        version: 1,
                        cases: [
                            { path: '/cases/a', openedAt: 1 },
                            { path: 7, openedAt: 2 },
                            null,
                            { path: '', openedAt: 3 },
                        ],
                    }),
                );
                expect(paths(dir)).toStrictEqual(['/cases/a']);
            });
        });

        await it('offers only what still exists, newest first, up to the limit', async () => {
            withDir((dir) => {
                for (let i = 0; i < 10; i++) rememberCase(dir, `/cases/${i}`, i);
                const gone = new Set(['/cases/9', '/cases/7']);
                const offered = offeredCases(dir, (path) => !gone.has(path)).map((entry) => entry.path);
                expect(offered.length).toBe(RECENT_CASES_SHOWN);
                expect(offered).toStrictEqual([
                    '/cases/8',
                    '/cases/6',
                    '/cases/5',
                    '/cases/4',
                    '/cases/3',
                    '/cases/2',
                ]);
                expect(offeredCases(dir, () => true, 2).length).toBe(2);
            });
        });

        await it('keeps a folder that is gone in the file, so it returns with the drive', async () => {
            withDir((dir) => {
                rememberCase(dir, '/cases/a', 1);
                expect(offeredCases(dir, () => false)).toStrictEqual([]);
                expect(paths(dir)).toStrictEqual(['/cases/a']);
            });
        });

        await it('stores nothing but paths and times', async () => {
            withDir((dir) => {
                rememberCase(dir, '/cases/a', 1);
                const body = JSON.parse(readFileSync(join(dir, RECENT_CASES_NAME), 'utf8')) as {
                    version: number;
                    cases: Record<string, unknown>[];
                };
                expect(body.version).toBe(1);
                expect(Object.keys(body.cases[0] ?? {}).sort()).toStrictEqual(['openedAt', 'path']);
            });
        });

        await it('swallows a write that fails instead of stopping the open', async () => {
            withDir((dir) => {
                // The state "directory" is a file: creating it fails on every platform and as root.
                mkdirSync(join(dir, '..'), { recursive: true });
                writeFileSync(dir, 'in the way');
                rememberCase(dir, '/cases/a', 1);
                forgetCase(dir, '/cases/a');
                expect(readRecentCases(dir)).toStrictEqual([]);
            });
        });

        await it('puts the file under XDG_STATE_HOME, then ~/.local/state, and LOCALAPPDATA on Windows', async () => {
            expect(recentCasesDir({ XDG_STATE_HOME: '/x/state' }, 'linux')).toBe('/x/state/stamped');
            expect(recentCasesDir({ XDG_STATE_HOME: '' }, 'linux').endsWith('/.local/state/stamped')).toBe(
                true,
            );
            expect(recentCasesDir({}, 'linux').endsWith('/.local/state/stamped')).toBe(true);
            expect(recentCasesDir({ LOCALAPPDATA: '/w/Local' }, 'win32')).toBe(join('/w/Local', 'stamped'));
        });
    });
};
