/**
 * The semantic layer's STATE: the setting in the case folder, the state derived from it, the
 * controller that owns the indexer's life, and what `stamped status` says about all of it.
 *
 * SYNTHETIC DATA ONLY: a fake embedder and made-up messages. No model, no download, no archive.
 *
 * THE CLOCK IS FAKE, and that is the point: the estimate, the staleness rule and the probe are
 * all about time, and a test that cannot move time cannot test any of them.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    countVectors,
    type DocumentSource,
    type EmbedDocument,
    type Embedder,
    openVectorDb,
    type SourceDocument,
    type SourceEntry,
} from '@stamped/semantic';
import {
    type CasePaths,
    openCase,
    readSemanticRunStatus,
    readSemanticSetting,
    semanticSettingFile,
    semanticStatusFile,
    SEMANTIC_SETTING_NAME,
    SEMANTIC_STATUS_NAME,
    writeSemanticSetting,
} from '@stamped/store';

import { statusCommand } from '../../src/commands/status.ts';
import { createSemanticController } from '../../src/lib/semantic.ts';
import {
    probeRemainingSeconds,
    semanticSnapshot,
    semanticState,
    THROUGHPUT_MIN_SAMPLES,
    throughputRate,
} from '../../src/lib/semantic-state.ts';
import { semanticLines, semanticStatusJson } from '../../src/lib/semantic-status.ts';

/** A moment in the past, so a timestamp written from the fake clock is never "now". */
const T0 = Date.parse('2026-10-22T10:00:00Z');

/** The machine the fake embedder runs on: a clock it moves, and the work it did. */
interface Machine {
    readonly clock: { t: number };
    /** Every document the embedder was asked for, in order. */
    readonly embedded: string[];
    /** Milliseconds one document costs. */
    perDoc: number;
    /** Subjects the embedder refuses. */
    refuse?: (subject: string) => boolean;
}

function machine(perDoc = 100): Machine {
    return { clock: { t: T0 }, embedded: [], perDoc };
}

/** An embedder that costs time and never downloads anything. */
function fakeEmbedder(box: Machine, modelId = 'fake/model', dimensions = 4): Embedder {
    return {
        modelId,
        dimensions,
        async embedQuery() {
            return new Float32Array(dimensions).fill(1);
        },
        async embedDocuments(docs: readonly EmbedDocument[]) {
            return docs.map((doc) => {
                const subject = doc.subject ?? '';
                box.clock.t += box.perDoc;
                box.embedded.push(subject);
                if (box.refuse?.(subject)) throw new Error('cannot embed');
                return new Float32Array(dimensions).fill(1);
            });
        },
    };
}

/**
 * A list of made-up messages as a document source.
 *
 * `limit` is how many of them the source hands out: a source that knows fewer messages than it
 * counts is how a run that was cut short looks from the outside.
 */
function listSource(count: number, limit = count): DocumentSource {
    const entries: SourceEntry[] = [];
    for (let i = 0; i < count; i++) entries.push({ hash: `m${i}`, sentAt: 1_000_000 - i });
    return {
        count: () => entries.length,
        next(after: SourceEntry | undefined, size: number) {
            const start = after ? entries.findIndex((entry) => entry.hash === after.hash) + 1 : 0;
            return entries.slice(start, Math.min(start + size, limit));
        },
        read(hashes: readonly string[]): SourceDocument[] {
            return hashes.map((hash) => ({ hash, subject: hash, body: `body of ${hash}` }));
        },
    };
}

/** A temporary case folder, removed afterwards. */
async function withCase(body: (paths: CasePaths) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-semantic-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** How many vectors the case holds. */
function vectorsIn(paths: CasePaths, modelId = 'fake/model', dimensions = 4): number {
    const db = openVectorDb(paths.vectors, { modelId, dimensions });
    try {
        return countVectors(db);
    } finally {
        db.close();
    }
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
    await describe('the semantic setting', async () => {
        await it('is absent until the case decides, and absent means never decided', async () => {
            await withCase(async (paths) => {
                expect(readSemanticSetting(paths)).toBe(undefined);
                // A case that never heard of semantic search has nothing to say about it.
                expect(semanticSnapshot(paths)).toBe(undefined);
                expect(semanticState({})).toStrictEqual({ kind: 'off' });
            });
        });

        await it('is written atomically and read back', async () => {
            await withCase(async (paths) => {
                writeSemanticSetting(paths, {
                    version: 1,
                    enabled: true,
                    modelId: 'fake/model',
                    dimensions: 4,
                });
                expect(semanticSettingFile(paths)).toBe(join(paths.root, 'semantic.json'));
                expect(SEMANTIC_SETTING_NAME).toBe('semantic.json');
                expect(existsSync(`${semanticSettingFile(paths)}.tmp`)).toBe(false);
                expect(readSemanticSetting(paths)?.enabled).toBe(true);
                expect(readSemanticSetting(paths)?.modelId).toBe('fake/model');
            });
        });

        await it('refuses a file it cannot trust', async () => {
            await withCase(async (paths) => {
                expect(readSemanticSetting(paths)).toBe(undefined);
                writeFileSync(semanticSettingFile(paths), '{ not json');
                expect(readSemanticSetting(paths)).toBe(undefined);
                writeFileSync(semanticSettingFile(paths), JSON.stringify({ version: 99, enabled: true }));
                expect(readSemanticSetting(paths)).toBe(undefined);
                writeFileSync(semanticSettingFile(paths), JSON.stringify({ version: 1, enabled: 'yes' }));
                expect(readSemanticSetting(paths)).toBe(undefined);
                // A half-written probe is no probe: the setting decides whether a machine embeds
                // a leak for hours, and a guess is not an answer.
                writeFileSync(
                    semanticSettingFile(paths),
                    JSON.stringify({ version: 1, enabled: true, probe: { modelId: 'fake/model' } }),
                );
                expect(readSemanticSetting(paths)).toBe(undefined);
            });
        });
    });

    await describe('the derived state', async () => {
        await it('is off when the setting says off, whatever the last run did', () => {
            const state = semanticState({
                setting: { version: 1, enabled: false },
                run: {
                    version: 1,
                    state: 'indexing',
                    done: 10,
                    total: 40,
                    updatedAt: new Date(T0).toISOString(),
                    pid: 1,
                },
            });
            expect(state.kind).toBe('off');
        });

        await it('is paused when the feature is on and no run has ever written', () => {
            const state = semanticState({ setting: { version: 1, enabled: true } });
            expect(state).toStrictEqual({ kind: 'paused', reason: 'user', done: 0, total: 0 });
        });

        await it('carries what is done, what is left and how long', () => {
            const state = semanticState(
                {
                    setting: { version: 1, enabled: true },
                    run: {
                        version: 1,
                        state: 'indexing',
                        done: 10,
                        total: 40,
                        remainingSeconds: 600,
                        updatedAt: new Date(T0).toISOString(),
                        pid: 1,
                    },
                },
                T0 + 1000,
            );
            expect(state).toStrictEqual({
                kind: 'indexing',
                done: 10,
                total: 40,
                remainingSeconds: 600,
            });
        });

        await it('names why a run is on hold', () => {
            const paused = (reason: 'battery' | 'user') =>
                semanticState({
                    setting: { version: 1, enabled: true },
                    run: {
                        version: 1,
                        state: 'paused',
                        done: 3,
                        total: 40,
                        pausedReason: reason,
                        updatedAt: new Date(T0).toISOString(),
                        pid: 1,
                    },
                });
            expect(paused('battery')).toStrictEqual({
                kind: 'paused',
                reason: 'battery',
                done: 3,
                total: 40,
            });
            expect(paused('user').kind).toBe('paused');
        });

        await it('keeps the message of a failure', () => {
            const state = semanticState({
                setting: { version: 1, enabled: true },
                run: {
                    version: 1,
                    state: 'failed',
                    done: 0,
                    total: 0,
                    error: 'the disk is full',
                    updatedAt: new Date(T0).toISOString(),
                    pid: 1,
                },
            });
            expect(state).toStrictEqual({ kind: 'failed', message: 'the disk is full' });
        });

        await it('says unavailable when the runtime cannot embed at all', () => {
            const state = semanticState({
                setting: { version: 1, enabled: true },
                run: {
                    version: 1,
                    state: 'unavailable',
                    done: 0,
                    total: 0,
                    updatedAt: new Date(T0).toISOString(),
                    pid: 1,
                },
            });
            expect(state).toStrictEqual({ kind: 'unavailable' });
        });

        await it('reads a stale running file as interrupted', () => {
            const run = {
                version: 1,
                state: 'indexing' as const,
                done: 3,
                total: 40,
                updatedAt: new Date(T0).toISOString(),
                pid: 1,
            };
            // Fresh: the run is still going.
            expect(semanticState({ setting: { version: 1, enabled: true }, run }, T0).kind).toBe('indexing');
            // An hour later: nothing is running any more, and the file must not say otherwise.
            const late = semanticState({ setting: { version: 1, enabled: true }, run }, T0 + 3600_000);
            expect(late.kind).toBe('failed');
            expect(late.kind === 'failed' && late.message.includes('interrupted')).toBe(true);
        });

        await it('never calls a paused run stale', () => {
            const run = {
                version: 1,
                state: 'paused' as const,
                done: 3,
                total: 40,
                pausedReason: 'battery' as const,
                updatedAt: new Date(T0).toISOString(),
                pid: 1,
            };
            expect(semanticState({ setting: { version: 1, enabled: true }, run }, T0 + 3600_000).kind).toBe(
                'paused',
            );
        });
    });

    await describe('the estimate', async () => {
        await it('needs three samples before it measures anything', () => {
            const samples = [
                { at: T0, done: 0 },
                { at: T0 + 1000, done: 10 },
                { at: T0 + 2000, done: 20 },
            ];
            expect(throughputRate(samples.slice(0, 2), T0 + 2000)).toBe(undefined);
            expect(THROUGHPUT_MIN_SAMPLES).toBe(3);
            expect(throughputRate(samples, T0 + 2000)).toBe(10);
        });

        await it('measures over a moving window, not over the whole run', () => {
            const samples = [
                { at: T0, done: 0 },
                { at: T0 + 1000, done: 10 },
                { at: T0 + 2000, done: 20 },
                // A minute later the machine is faster; the old samples are out of the window.
                { at: T0 + 120_000, done: 120 },
                { at: T0 + 121_000, done: 220 },
                { at: T0 + 122_000, done: 320 },
            ];
            expect(throughputRate(samples, T0 + 122_000)).toBe(100);
        });

        await it('falls back to the probe only while there is nothing to measure', () => {
            const probe = {
                modelId: 'fake/model',
                tokensPerSecond: 1000,
                estimatedHours: 8,
                recommendation: 'on' as const,
                measuredAt: new Date(T0).toISOString(),
            };
            // The probe measured the whole archive; what is left of it is that estimate's share.
            expect(probeRemainingSeconds(probe, 0, 100)).toBeCloseTo(8 * 3600, 5);
            expect(probeRemainingSeconds(probe, 75, 100)).toBeCloseTo(2 * 3600, 5);
            expect(probeRemainingSeconds(probe, 100, 100)).toBe(0);
            expect(probeRemainingSeconds(undefined, 0, 100)).toBe(undefined);
        });
    });

    await describe('the controller', async () => {
        await it('probes once, indexes, and ends ready', async () => {
            await withCase(async (paths) => {
                const box = machine(100);
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                });
                await controller.enable();
                await controller.settled();

                expect(controller.state().kind).toBe('ready');
                const setting = readSemanticSetting(paths);
                expect(setting?.enabled).toBe(true);
                expect(setting?.modelId).toBe('fake/model');
                expect(setting?.dimensions).toBe(4);
                expect(setting?.probe?.recommendation).toBe('on');
                expect((setting?.probe?.tokensPerSecond ?? 0) > 0).toBe(true);
                expect(Date.parse(setting?.probe?.measuredAt ?? '') >= T0).toBe(true);
                expect(readSemanticRunStatus(paths)?.state).toBe('ready');
                expect(vectorsIn(paths)).toBe(6);
                // The run status is a file next to the case, with no mail content in it.
                expect(semanticStatusFile(paths)).toBe(join(paths.root, 'semantic-status.json'));
                expect(SEMANTIC_STATUS_NAME).toBe('semantic-status.json');
            });
        });

        await it('re-measures the estimate while indexing, instead of trusting the probe', async () => {
            await withCase(async (paths) => {
                const box = machine(1000);
                // The probe is slow on this machine (a second per message), the run is fast:
                // the machine warms up, exactly as the spike found. The probe's estimate is
                // therefore ten times too slow, and the estimate has to notice.
                const states: { kind: string; done?: number; remaining?: number }[] = [];
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(40),
                    now: () => box.clock.t,
                    onProgress: (state) => {
                        states.push({
                            kind: state.kind,
                            done: 'done' in state ? state.done : undefined,
                            remaining: state.kind === 'indexing' ? state.remainingSeconds : undefined,
                        });
                        // The probe is over after eight messages; from then on the machine is quick.
                        if (box.embedded.length >= 8) box.perDoc = 100;
                    },
                });
                await controller.enable();
                await controller.settled();

                const at16 = states.find((state) => state.done === 16);
                const at32 = states.find((state) => state.done === 32);
                expect(at16?.kind).toBe('indexing');
                expect(at32?.kind).toBe('indexing');
                // Before there is a window to measure, the probe's estimate stands in:
                // 40 messages at one per second is 40 s, a quarter of it left is 24 s.
                expect(at16?.remaining).toBeCloseTo(24, 5);
                // With three samples the run measures itself: ten messages a second.
                expect(at32?.remaining).toBeCloseTo(0.8, 5);
                // And the measurement is the better answer: the probe would say 8 s.
                expect(at32?.remaining ?? 0).toBeLessThan(8);
            });
        });

        await it('stops the run and keeps the vectors when the feature is switched off', async () => {
            await withCase(async (paths) => {
                const box = machine(100);
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                });
                await controller.enable();
                await controller.settled();
                expect(vectorsIn(paths)).toBe(6);

                await controller.disable();
                expect(controller.state()).toStrictEqual({ kind: 'off' });
                expect(readSemanticSetting(paths)?.enabled).toBe(false);
                // The hours of embedding are not thrown away: switching the feature off is not
                // the same as asking for the work to be redone.
                expect(vectorsIn(paths)).toBe(6);
            });
        });

        await it('holds while the machine is on its battery, and goes on when the power is back', async () => {
            await withCase(async (paths) => {
                const box = machine(1000);
                let onBattery = true;
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                    onBattery: () => onBattery,
                    pollMs: 5,
                });
                await controller.enable();

                const paused = controller.state();
                expect(paused.kind).toBe('paused');
                expect(paused.kind === 'paused' && paused.reason).toBe('battery');
                expect(readSemanticRunStatus(paths)?.state).toBe('paused');
                expect(readSemanticRunStatus(paths)?.pausedReason).toBe('battery');
                expect(vectorsIn(paths)).toBe(0);

                onBattery = false;
                await controller.settled();
                expect(controller.state().kind).toBe('ready');
                expect(vectorsIn(paths)).toBe(6);
            });
        });

        await it('holds the run when the person says so', async () => {
            await withCase(async (paths) => {
                const box = machine(100);
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                    pollMs: 5,
                });
                // The person holds it before the run starts: the hold still counts.
                controller.pause();
                await controller.enable();
                const paused = controller.state();
                expect(paused.kind).toBe('paused');
                expect(paused.kind === 'paused' && paused.reason).toBe('user');
                expect(readSemanticRunStatus(paths)?.pausedReason).toBe('user');

                controller.resume();
                await controller.settled();
                expect(controller.state().kind).toBe('ready');
            });
        });

        await it('continues after a restart, without measuring again', async () => {
            await withCase(async (paths) => {
                // The first run only saw half of the archive.
                const first = machine(100);
                const before = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(first),
                    source: listSource(6, 3),
                    now: () => first.clock.t,
                });
                await before.enable();
                await before.settled();
                expect(before.state().kind).toBe('ready');
                expect(vectorsIn(paths)).toBe(3);
                const measured = readSemanticSetting(paths)?.probe?.measuredAt;

                // The restart: the same setting says the feature is on, and the vectors say
                // what is missing. Nothing is measured a second time.
                const second = machine(100);
                const after = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(second),
                    source: listSource(6),
                    now: () => second.clock.t,
                });
                await after.start();
                await after.settled();

                expect(after.state().kind).toBe('ready');
                expect(vectorsIn(paths)).toBe(6);
                // Only the three missing messages were embedded.
                expect(second.embedded).toStrictEqual(['m3', 'm4', 'm5']);
                expect(readSemanticSetting(paths)?.probe?.measuredAt).toBe(measured);
            });
        });

        await it('says unavailable when this runtime cannot embed at all', async () => {
            await withCase(async (paths) => {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => undefined,
                    source: listSource(6),
                });
                await controller.enable();
                await controller.settled();

                expect(controller.state()).toStrictEqual({ kind: 'unavailable' });
                expect(readSemanticRunStatus(paths)?.state).toBe('unavailable');
                // The answer is still an answer: the case said on, and the app said it cannot.
                expect(readSemanticSetting(paths)?.enabled).toBe(true);
            });
        });

        await it('reports a failure when the embedder cannot even be measured', async () => {
            await withCase(async (paths) => {
                const box = machine(100);
                box.refuse = () => true;
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                });
                await controller.enable();
                await controller.settled();

                const state = controller.state();
                expect(state.kind).toBe('failed');
                expect(state.kind === 'failed' && state.message).toBe('cannot embed');
                expect(readSemanticRunStatus(paths)?.state).toBe('failed');
            });
        });

        await it('reports a failure when the run breaks after the measurement', async () => {
            await withCase(async (paths) => {
                const box = machine(100);
                // The measurement works; the run does not.
                box.refuse = () => box.embedded.length > 6;
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(box),
                    source: listSource(6),
                    now: () => box.clock.t,
                });
                await controller.enable();
                await controller.settled();

                const state = controller.state();
                expect(state.kind).toBe('failed');
                expect(state.kind === 'failed' && state.message).toBe(
                    'The embedder failed on several messages in a row; stopping.',
                );
                expect(readSemanticRunStatus(paths)?.state).toBe('failed');
            });
        });
    });

    await describe('the status output', async () => {
        await it('says one thing per state, in one or two lines', () => {
            expect(semanticLines({ kind: 'off' })).toStrictEqual(['Semantic search is off.']);
            expect(semanticLines({ kind: 'unavailable' })).toStrictEqual([
                'Semantic search is not available on this runtime.',
            ]);
            expect(semanticLines({ kind: 'probing' })).toStrictEqual([
                'Semantic search is measuring how fast this machine is.',
            ]);
            expect(
                semanticLines({ kind: 'indexing', done: 10, total: 40, remainingSeconds: 1200 }),
            ).toStrictEqual(['Semantic search: indexing 10 of 40 messages.', 'About 20 min left.']);
            expect(semanticLines({ kind: 'paused', reason: 'battery', done: 0, total: 0 })).toStrictEqual([
                'Semantic search is paused: this machine is running on its battery.',
            ]);
            expect(semanticLines({ kind: 'paused', reason: 'user', done: 0, total: 0 })).toStrictEqual([
                'Semantic search is paused.',
            ]);
            expect(semanticLines({ kind: 'ready', done: 40, total: 40 })).toStrictEqual([
                'Semantic search is ready: 40 messages indexed.',
            ]);
            expect(semanticLines({ kind: 'failed', message: 'the disk is full' })).toStrictEqual([
                'Semantic search failed: the disk is full',
            ]);
        });

        await it('counts in the plural', () => {
            expect(semanticLines({ kind: 'indexing', done: 1, total: 1 })).toStrictEqual([
                'Semantic search: indexing 1 of 1 message.',
            ]);
            expect(semanticLines({ kind: 'ready', done: 1, total: 1 })).toStrictEqual([
                'Semantic search is ready: 1 message indexed.',
            ]);
        });

        await it('shapes the machine form', () => {
            const json = semanticStatusJson(
                { kind: 'indexing', done: 10, total: 40, remainingSeconds: 1200.4 },
                {
                    version: 1,
                    enabled: true,
                    modelId: 'fake/model',
                    dimensions: 4,
                    probe: {
                        modelId: 'fake/model',
                        tokensPerSecond: 1200,
                        estimatedHours: 7.8,
                        recommendation: 'on',
                        measuredAt: new Date(T0).toISOString(),
                    },
                },
            );
            expect(json).toStrictEqual({
                state: 'indexing',
                done: 10,
                total: 40,
                eta: 1200,
                modelId: 'fake/model',
                dimensions: 4,
                tokensPerSecond: 1200,
                estimatedHours: 7.8,
            });
            // Without an estimate the machine form says so instead of guessing.
            expect(semanticStatusJson({ kind: 'indexing', done: 1, total: 4 }).eta).toBe(-1);
        });

        await it('stamped status shows the semantic state under the import', async () => {
            await withCase(async (paths) => {
                writeSemanticSetting(paths, {
                    version: 1,
                    enabled: true,
                    modelId: 'fake/model',
                    dimensions: 4,
                });
                writeFileSync(
                    semanticStatusFile(paths),
                    JSON.stringify({
                        version: 1,
                        state: 'indexing',
                        done: 10,
                        total: 40,
                        remainingSeconds: 1200,
                        updatedAt: new Date().toISOString(),
                        pid: process.pid,
                    }),
                );

                const text = (await runStatus({ case: paths.root })).join('\n');
                expect(text.includes('Semantic search: indexing 10 of 40 messages.')).toBe(true);
                expect(text.includes('About 20 min left.')).toBe(true);

                const json = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(json.semantic).toStrictEqual({
                    state: 'indexing',
                    done: 10,
                    total: 40,
                    eta: 1200,
                    modelId: 'fake/model',
                    dimensions: 4,
                });
            });
        });

        await it('stamped status says nothing about a case that never decided', async () => {
            await withCase(async (paths) => {
                const text = await runStatus({ case: paths.root });
                expect(text.join('\n').includes('Semantic search')).toBe(false);
                const json = JSON.parse((await runStatus({ case: paths.root, json: true })).join('\n'));
                expect(json.semantic).toBe(undefined);
            });
        });
    });
};
