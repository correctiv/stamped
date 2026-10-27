/**
 * The guard that turns a process killed by a GPU hang into a CPU pin on the next start.
 *
 * A "dead process" is a guard that entered and never left, looked at by a second guard whose
 * `alive` says the first is gone — the same thing the filesystem shows after an `abort()`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { createGpuGuard } from '@stamped/semantic/gpu-guard';

const never = (): Promise<never> => new Promise(() => undefined);

function withDir(work: (dir: string) => Promise<void>): () => Promise<void> {
    return async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stamped-gpu-guard-'));
        try {
            await work(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
}

const markers = (dir: string): string => {
    try {
        return readdirSync(join(dir, 'gpu-sessions')).join(',');
    } catch {
        return '';
    }
};

export default async () => {
    await describe('gpuGuard', async () => {
        await it(
            'pins nothing when no process ever used the GPU',
            withDir(async (dir) => {
                expect(createGpuGuard({ dir, pid: 2 }).pin()).toBe(undefined);
            }),
        );

        await it(
            'marks the process while it works and unmarks it afterwards',
            withDir(async (dir) => {
                const guard = createGpuGuard({ dir, pid: 11 });
                await guard.during(async () => {
                    expect(markers(dir)).toBe('11.json');
                });
                expect(markers(dir)).toBe('');
                expect(guard.pin()).toBe(undefined);
            }),
        );

        await it(
            'unmarks the process when the work throws',
            withDir(async (dir) => {
                const guard = createGpuGuard({ dir, pid: 11 });
                await guard.during(() => Promise.reject(new Error('boom'))).catch(() => undefined);
                expect(markers(dir)).toBe('');
            }),
        );

        await it(
            'lets overlapping calls share one marker until the last one ends',
            withDir(async (dir) => {
                const guard = createGpuGuard({ dir, pid: 11 });
                let release!: () => void;
                const long = guard.during(() => new Promise<void>((resolve) => (release = resolve)));
                await guard.during(async () => undefined);
                expect(markers(dir)).toBe('11.json');
                release();
                await long;
                expect(markers(dir)).toBe('');
            }),
        );

        await it(
            'pins the CPU when the marker of a dead process is found',
            withDir(async (dir) => {
                void createGpuGuard({ dir, pid: 11 }).during(never);
                const next = createGpuGuard({
                    dir,
                    pid: 22,
                    alive: () => false,
                    now: () => new Date('2026-10-27T15:00:00Z'),
                });
                expect(next.pin()?.at).toBe('2026-10-27T15:00:00.000Z');
                expect(markers(dir)).toBe('');
                // The pin outlives the sweep: the next start has no marker left to find.
                expect(createGpuGuard({ dir, pid: 33, alive: () => true }).pin()?.pid).toBe(11);
            }),
        );

        await it(
            'does not pin for a process that is still running',
            withDir(async (dir) => {
                void createGpuGuard({ dir, pid: 11 }).during(never);
                expect(createGpuGuard({ dir, pid: 22, alive: () => true }).pin()).toBe(undefined);
                expect(markers(dir)).toBe('11.json');
            }),
        );

        await it(
            'never pins for its own marker',
            withDir(async (dir) => {
                const guard = createGpuGuard({ dir, pid: 11, alive: () => false });
                await guard.during(async () => {
                    expect(guard.pin()).toBe(undefined);
                });
            }),
        );

        await it(
            'lifts the pin on clear',
            withDir(async (dir) => {
                void createGpuGuard({ dir, pid: 11 }).during(never);
                const guard = createGpuGuard({ dir, pid: 22, alive: () => false });
                expect(guard.pin()?.pid).toBe(11);
                guard.clear();
                expect(guard.pin()).toBe(undefined);
            }),
        );

        await it(
            'drops its marker on release, which is what the exit hook calls',
            withDir(async (dir) => {
                const guard = createGpuGuard({ dir, pid: 11 });
                void guard.during(never);
                expect(markers(dir)).toBe('11.json');
                guard.release();
                expect(markers(dir)).toBe('');
            }),
        );

        await it(
            'keeps embedding when the state directory cannot be written',
            withDir(async (dir) => {
                const blocker = join(dir, 'blocker');
                writeFileSync(blocker, 'a file where a directory should be');
                const guard = createGpuGuard({ dir: join(blocker, 'state'), pid: 11 });
                expect(await guard.during(async () => 42)).toBe(42);
                expect(guard.pin()).toBe(undefined);
                expect(existsSync(join(blocker, 'state'))).toBe(false);
            }),
        );
    });
};
