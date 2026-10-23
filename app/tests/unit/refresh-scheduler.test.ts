/**
 * The reload scheduler: bursts merge into one set of panes, one reload runs at a time, and a
 * case change drops what was asked. The clock is a list of timers the test fires by hand.
 */

import { describe, expect, it } from '@gjsify/unit';
import {
    type Pane,
    PANES,
    panesAfterRun,
    PEOPLE_PANES,
    RefreshScheduler,
    VERDICT_PANES,
} from '../../src/lib/refresh-scheduler.ts';

function make(run?: (panes: ReadonlySet<Pane>) => Promise<readonly Pane[]>) {
    const timers = new Map<number, () => void>();
    let next = 1;
    const runs: Pane[][] = [];
    const scheduler = new RefreshScheduler({
        delayMs: 100,
        run: async (panes) => {
            runs.push([...panes].sort());
            return run ? run(panes) : [];
        },
        setTimer: (callback) => {
            timers.set(next, callback);
            return next++;
        },
        clearTimer: (timer) => {
            timers.delete(timer as number);
        },
    });
    const fire = async () => {
        for (const [id, callback] of timers) {
            timers.delete(id);
            callback();
        }
        await Promise.resolve();
        await Promise.resolve();
    };
    return { scheduler, timers, runs, fire };
}

export default async () => {
    await describe('RefreshScheduler', async () => {
        await it('runs nothing until the quiet time is over', async () => {
            const { scheduler, runs, timers } = make();
            scheduler.request(['list']);
            expect(runs.length).toBe(0);
            expect(timers.size).toBe(1);
        });

        await it('merges a burst into one reload of the union', async () => {
            const { scheduler, runs, fire, timers } = make();
            scheduler.request(['list', 'keys']);
            scheduler.request(['keys', 'overview']);
            scheduler.request(['list']);
            expect(timers.size).toBe(1);
            await fire();
            expect(runs).toStrictEqual([['keys', 'list', 'overview']]);
            expect(scheduler.pending.size).toBe(0);
        });

        await it('ignores a request for no pane', async () => {
            const { scheduler, timers } = make();
            scheduler.request([]);
            expect(timers.size).toBe(0);
        });

        await it('queues a request that arrives during a reload behind it', async () => {
            let release: () => void = () => {};
            const { scheduler, runs, fire, timers } = make(
                () => new Promise<readonly Pane[]>((resolve) => (release = () => resolve([]))),
            );
            scheduler.request(['list']);
            await fire();
            expect(runs.length).toBe(1);
            scheduler.request(['keys']);
            expect(timers.size).toBe(0);
            release();
            await Promise.resolve();
            await Promise.resolve();
            expect(timers.size).toBe(1);
            await fire();
            expect(runs).toStrictEqual([['list'], ['keys']]);
        });

        await it('asks again for the panes a reload did not reach', async () => {
            let first = true;
            const { scheduler, runs, fire } = make(async () => {
                const left: Pane[] = first ? ['people'] : [];
                first = false;
                return left;
            });
            scheduler.request(['list', 'people']);
            await fire();
            await fire();
            expect(runs).toStrictEqual([['list', 'people'], ['people']]);
        });

        await it('drops what was asked when the case changes', async () => {
            const { scheduler, runs, fire, timers } = make();
            scheduler.request(['list']);
            scheduler.cancel();
            expect(timers.size).toBe(0);
            await fire();
            expect(runs.length).toBe(0);
            expect(scheduler.pending.size).toBe(0);
        });

        await it('does not carry the leftovers of a cancelled reload into the next case', async () => {
            let release: (left: readonly Pane[]) => void = () => {};
            const { scheduler, timers, fire } = make(
                () => new Promise<readonly Pane[]>((resolve) => (release = resolve)),
            );
            scheduler.request(['list']);
            await fire();
            scheduler.cancel();
            release(['list']);
            await Promise.resolve();
            await Promise.resolve();
            expect(scheduler.pending.size).toBe(0);
            expect(timers.size).toBe(0);
        });

        await it('survives a reload that throws', async () => {
            let fail = true;
            const { scheduler, runs, fire } = make(async () => {
                if (fail) {
                    fail = false;
                    throw new Error('worker gone');
                }
                return [];
            });
            scheduler.request(['list']);
            await fire();
            scheduler.request(['keys']);
            await fire();
            expect(runs).toStrictEqual([['list'], ['keys']]);
        });
    });

    await describe('panesAfterRun', async () => {
        await it('leaves the address panes alone after a key lookup or re-verification', async () => {
            expect(panesAfterRun('keys')).toStrictEqual(VERDICT_PANES);
            expect(panesAfterRun('reverify')).toStrictEqual(VERDICT_PANES);
            expect(VERDICT_PANES.includes('people')).toBe(false);
        });

        await it('reloads only the address panes after the people backfill', async () => {
            expect(panesAfterRun('people')).toStrictEqual(PEOPLE_PANES);
        });

        await it('reloads everything after an import or an unknown run', async () => {
            expect(panesAfterRun('import')).toStrictEqual(PANES);
            expect(panesAfterRun('something-new')).toStrictEqual(PANES);
        });
    });
};
