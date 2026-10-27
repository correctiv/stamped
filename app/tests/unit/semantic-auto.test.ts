/**
 * Switching semantic search on by itself for a case nobody has decided about. The controller is a
 * fake that records what was asked of it; no model, no case folder.
 */

import { describe, expect, it } from '@gjsify/unit';
import type { SemanticSetting } from '@stamped/store';

import { autoEnableSemantic, markingDecisions } from '../../src/lib/semantic-auto.ts';
import type { SemanticController } from '../../src/lib/semantic.ts';
import type { SemanticState } from '../../src/lib/semantic-state.ts';

function measured(recommendation: 'on' | 'off', enabled = false): SemanticSetting {
    return {
        version: 1,
        enabled,
        modelId: 'fake/model',
        dimensions: 4,
        probe: {
            modelId: 'fake/model',
            tokensPerSecond: 1000,
            estimatedHours: recommendation === 'on' ? 1 : 100,
            recommendation,
            measuredAt: '2026-10-27T10:00:00Z',
        },
    };
}

function fake(initial: SemanticSetting | undefined, afterProbe: SemanticSetting | undefined) {
    const calls: string[] = [];
    let current = initial;
    const off = { kind: 'off' } as unknown as SemanticState;
    const controller = {
        setting: () => current,
        async probeOnly() {
            calls.push('probe');
            current = afterProbe;
            return current;
        },
        async enable() {
            calls.push('enable');
            return off;
        },
        async disable() {
            calls.push('disable');
            return off;
        },
    };
    return { calls, controller };
}

const always = (): boolean => true;
const never = (): boolean => false;

export default async () => {
    await describe('autoEnableSemantic', async () => {
        await it('probes a never-decided case and switches it on when the probe says on', async () => {
            const { calls, controller } = fake(undefined, measured('on'));
            const outcome = await autoEnableSemantic(controller, { ready: always, decided: never });
            expect(outcome).toBe('enabled');
            expect(calls).toStrictEqual(['probe', 'enable']);
        });

        await it('leaves it off when the archive would take too long, keeping the estimate', async () => {
            const { calls, controller } = fake(undefined, measured('off'));
            expect(await autoEnableSemantic(controller, { ready: always, decided: never })).toBe(
                'not-recommended',
            );
            expect(calls).toStrictEqual(['probe']);
        });

        await it('never touches a case that has a setting, on or off', async () => {
            for (const setting of [measured('on', false), measured('on', true)]) {
                const { calls, controller } = fake(setting, setting);
                expect(await autoEnableSemantic(controller, { ready: always, decided: never })).toBe(
                    'decided',
                );
                expect(calls).toStrictEqual([]);
            }
        });

        await it('does not probe without a runtime or a model', async () => {
            const { calls, controller } = fake(undefined, measured('on'));
            expect(await autoEnableSemantic(controller, { ready: never, decided: never })).toBe(
                'unavailable',
            );
            expect(calls).toStrictEqual([]);
        });

        await it('does not probe on the battery', async () => {
            const { calls, controller } = fake(undefined, measured('on'));
            const outcome = await autoEnableSemantic(controller, {
                ready: always,
                onBattery: always,
                decided: never,
            });
            expect(outcome).toBe('battery');
            expect(calls).toStrictEqual([]);
        });

        await it('lets a switch flipped during the probe win', async () => {
            const { calls, controller } = fake(undefined, measured('on'));
            let flipped = false;
            const probeOnly = controller.probeOnly;
            controller.probeOnly = async () => {
                const result = await probeOnly();
                flipped = true;
                return result;
            };
            expect(await autoEnableSemantic(controller, { ready: always, decided: () => flipped })).toBe(
                'decided',
            );
            expect(calls).toStrictEqual(['probe']);
        });

        await it('treats a probe that measured nothing as not available', async () => {
            const { calls, controller } = fake(undefined, undefined);
            expect(await autoEnableSemantic(controller, { ready: always, decided: never })).toBe(
                'unavailable',
            );
            expect(calls).toStrictEqual(['probe']);
        });
    });

    await describe('markingDecisions', async () => {
        await it('marks enable and disable as the person deciding, and passes them on', async () => {
            const { calls, controller } = fake(undefined, undefined);
            let marks = 0;
            const marked = markingDecisions(controller as unknown as SemanticController, () => marks++);
            await marked.enable();
            await marked.disable();
            expect(marks).toBe(2);
            expect(calls).toStrictEqual(['enable', 'disable']);
        });

        await it('does not mark a probe', async () => {
            const { controller } = fake(undefined, measured('on'));
            let marks = 0;
            const marked = markingDecisions(controller as unknown as SemanticController, () => marks++);
            await marked.probeOnly();
            expect(marks).toBe(0);
        });
    });
};
