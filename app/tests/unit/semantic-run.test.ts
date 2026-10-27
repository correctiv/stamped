/**
 * The semantic index as a subprocess: the argv, the live-run test, the CLI's run to the end and
 * its refusal of a second run, the window's side (never a second run, the import goes first, only
 * its own process is ended), and two connections on one `vectors.db`.
 *
 * SYNTHETIC DATA ONLY: a fake embedder, made-up messages, a fake clock, a fake process.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    countVectors,
    openVectorDb,
    openVectorDbForSearch,
    putVector,
    type DocumentSource,
    type EmbedDocument,
    type Embedder,
    type SourceDocument,
    type SourceEntry,
} from '@stamped/semantic';
import {
    openCase,
    readSemanticRunStatus,
    SEMANTIC_SETTING_VERSION,
    SEMANTIC_STATUS_VERSION,
    semanticStatusFile,
    writeSemanticRunStatus,
    writeSemanticSetting,
    type CasePaths,
    type SemanticRunStatus,
} from '@stamped/store';

import { refuseLiveRun, type RefuseOptions } from '../../src/commands/semantic.ts';
import { createSemanticController } from '../../src/lib/semantic.ts';
import {
    createSubprocessSemantic,
    liveSemanticRun,
    runSemanticIndex,
    semanticArgv,
    type SemanticProcess,
} from '../../src/lib/semantic-run.ts';

const T0 = Date.parse('2026-10-22T10:00:00Z');

function fakeEmbedder(clock: { t: number }, onBatch?: () => void): Embedder {
    return {
        modelId: 'fake/model',
        dimensions: 4,
        async embedQuery() {
            return new Float32Array(4).fill(1);
        },
        async embedDocuments(docs: readonly EmbedDocument[]) {
            onBatch?.();
            return docs.map(() => {
                clock.t += 100;
                return new Float32Array(4).fill(1);
            });
        },
    };
}

function listSource(count: number): DocumentSource {
    const entries: SourceEntry[] = [];
    for (let i = 0; i < count; i++) entries.push({ hash: `m${i}`, sentAt: 1_000_000 - i });
    return {
        count: () => entries.length,
        next(after: SourceEntry | undefined, size: number) {
            const start = after ? entries.findIndex((entry) => entry.hash === after.hash) + 1 : 0;
            return entries.slice(start, start + size);
        },
        read(hashes: readonly string[]): SourceDocument[] {
            return hashes.map((hash) => ({ hash, subject: hash, body: `body of ${hash}` }));
        },
    };
}

async function withCase(body: (paths: CasePaths) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-semantic-run-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function status(over: Partial<SemanticRunStatus>): SemanticRunStatus {
    return {
        version: SEMANTIC_STATUS_VERSION,
        state: 'indexing',
        done: 1,
        total: 10,
        updatedAt: new Date(T0).toISOString(),
        pid: 4242,
        ...over,
    };
}

function enable(paths: CasePaths): void {
    writeSemanticSetting(paths, { version: SEMANTIC_SETTING_VERSION, enabled: true });
}

/** A process the test ends by hand. */
function fakeProcess(): SemanticProcess & { terminated: number; exit: () => void } {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
        exit = resolve;
    });
    const proc = {
        terminated: 0,
        exit,
        exited,
        terminate() {
            proc.terminated++;
            exit();
        },
    };
    return proc;
}

export default async () => {
    await describe('semanticArgv', async () => {
        await it('prefers the program itself, then the one on the path, else nothing', async () => {
            expect(semanticArgv(['gjs', '-m', 'a.mjs'], '/bin/stamped', '/c')).toStrictEqual([
                'gjs',
                '-m',
                'a.mjs',
                'semantic',
                'index',
                '--case',
                '/c',
            ]);
            expect(semanticArgv(null, '/bin/stamped', '/c')).toStrictEqual([
                '/bin/stamped',
                'semantic',
                'index',
                '--case',
                '/c',
            ]);
            expect(semanticArgv(null, null, '/c')).toBe(null);
        });

        await it('names the probe when asked for it', async () => {
            expect(semanticArgv(null, '/bin/stamped', '/c', 'probe')).toStrictEqual([
                '/bin/stamped',
                'semantic',
                'probe',
                '--case',
                '/c',
            ]);
        });
    });

    await describe('liveSemanticRun', async () => {
        const alive = (): boolean => true;
        const dead = (): boolean => false;
        await it('believes a fresh working file with a living pid only', async () => {
            expect(liveSemanticRun(status({}), T0 + 5000, alive)).toBe(true);
            expect(liveSemanticRun(status({}), T0 + 5000, dead)).toBe(false);
            expect(liveSemanticRun(status({}), T0 + 120_000, alive)).toBe(false);
            expect(liveSemanticRun(undefined, T0, alive)).toBe(false);
        });
        await it('asks the pid for a paused run, which is never stale', async () => {
            const paused = status({ state: 'paused', pausedReason: 'battery' });
            expect(liveSemanticRun(paused, T0 + 3_600_000, alive)).toBe(true);
            expect(liveSemanticRun(paused, T0, dead)).toBe(false);
            expect(liveSemanticRun(status({ state: 'ready' }), T0, alive)).toBe(false);
        });
    });

    await describe('refuseLiveRun', async () => {
        const alive = (): boolean => true;
        const dead = (): boolean => false;
        const refusal = (paths: CasePaths, options: RefuseOptions): string => {
            try {
                refuseLiveRun(paths, options);
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            return '';
        };

        await it('names the pid of the live run and leaves its status file as it was', async () => {
            await withCase(async (paths) => {
                writeSemanticRunStatus(paths, status({}));
                const before = readFileSync(semanticStatusFile(paths), 'utf8');
                const text = refusal(paths, { now: T0 + 1000, alive });
                expect(text.includes('4242')).toBe(true);
                expect(readFileSync(semanticStatusFile(paths), 'utf8')).toBe(before);
            });
        });

        await it('refuses a paused run whose process is still there', async () => {
            await withCase(async (paths) => {
                writeSemanticRunStatus(paths, status({ state: 'paused', pausedReason: 'user' }));
                expect(refusal(paths, { now: T0 + 3_600_000, alive }).includes('4242')).toBe(true);
                expect(refusal(paths, { now: T0 + 3_600_000, alive: dead })).toBe('');
            });
        });

        await it('lets a free case, a stale run and a dead pid through', async () => {
            await withCase(async (paths) => {
                expect(refusal(paths, { now: T0, alive })).toBe('');
                writeSemanticRunStatus(paths, status({}));
                expect(refusal(paths, { now: T0 + 120_000, alive })).toBe('');
                expect(refusal(paths, { now: T0 + 1000, alive: dead })).toBe('');
            });
        });
    });

    await describe('runSemanticIndex', async () => {
        await it('runs to the end and leaves a ready status', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const clock = { t: T0 };
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(clock),
                    source: listSource(12),
                    now: () => clock.t,
                });
                const state = await runSemanticIndex({ controller, onSignal: () => () => undefined });
                expect(state).toStrictEqual({ kind: 'ready', done: 12, total: 12 });
                expect(readSemanticRunStatus(paths)?.state).toBe('ready');
            });
        });

        await it('indexes nothing when the setting is off', async () => {
            await withCase(async (paths) => {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder({ t: T0 }),
                    source: listSource(3),
                });
                const state = await runSemanticIndex({ controller, onSignal: () => () => undefined });
                expect(state.kind).toBe('off');
                expect(existsSync(paths.vectors)).toBe(false);
            });
        });

        await it('stops on a signal, keeps the vectors and resumes from them', async () => {
            await withCase(async (paths) => {
                // Measured already, so the probe's own batches cannot trip the signal early.
                writeSemanticSetting(paths, {
                    version: SEMANTIC_SETTING_VERSION,
                    enabled: true,
                    modelId: 'fake/model',
                    dimensions: 4,
                    probe: {
                        modelId: 'fake/model',
                        tokensPerSecond: 100,
                        estimatedHours: 1,
                        recommendation: 'on',
                        measuredAt: new Date(T0).toISOString(),
                    },
                });
                const clock = { t: T0 };
                let signal: (() => void) | undefined;
                const first = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(clock, () => signal?.()),
                    source: listSource(300),
                    now: () => clock.t,
                    batchSize: 10,
                });
                const state = await runSemanticIndex({
                    controller: first,
                    onSignal: (handler) => {
                        signal = handler;
                        return () => undefined;
                    },
                });
                expect(state.kind).toBe('paused');
                const db = openVectorDb(paths.vectors, { modelId: 'fake/model', dimensions: 4 });
                const kept = countVectors(db);
                db.close();
                expect(kept > 0).toBe(true);
                expect(kept < 300).toBe(true);

                const second = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(clock),
                    source: listSource(300),
                    now: () => clock.t,
                    batchSize: 10,
                });
                const done = await runSemanticIndex({ controller: second, onSignal: () => () => undefined });
                expect(done).toStrictEqual({ kind: 'ready', done: 300, total: 300 });
            });
        });
    });

    await describe('createSubprocessSemantic', async () => {
        function make(paths: CasePaths, flags: { importing: boolean; alive: boolean }) {
            const spawned: ReturnType<typeof fakeProcess>[] = [];
            const sub = createSubprocessSemantic({
                paths,
                spawn: () => {
                    const proc = fakeProcess();
                    spawned.push(proc);
                    return proc;
                },
                spawnProbe: () => {
                    throw new Error('not needed');
                },
                importRunning: () => flags.importing,
                now: () => T0 + 1000,
                alive: () => flags.alive,
            });
            return { sub, spawned };
        }

        await it('does not start when the setting is off', async () => {
            await withCase(async (paths) => {
                const { sub, spawned } = make(paths, { importing: false, alive: true });
                await sub.start();
                expect(spawned.length).toBe(0);
            });
        });

        await it('starts once, and never beside a live run of someone else', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const { sub, spawned } = make(paths, { importing: false, alive: true });
                await sub.start();
                await sub.start();
                expect(spawned.length).toBe(1);

                await withCase(async (other) => {
                    enable(other);
                    writeSemanticRunStatus(other, status({ updatedAt: new Date(T0).toISOString() }));
                    const live = make(other, { importing: false, alive: true });
                    await live.sub.start();
                    expect(live.spawned.length).toBe(0);
                    expect(live.sub.state().kind).toBe('indexing');
                    // Not ours: closing the window leaves that run alone.
                    await live.sub.stop();
                    expect(live.spawned.length).toBe(0);
                });
            });
        });

        await it('knows a live run is external only while it did not start it', async () => {
            await withCase(async (paths) => {
                enable(paths);
                writeSemanticRunStatus(paths, status({ updatedAt: new Date(T0).toISOString() }));
                const { sub, spawned } = make(paths, { importing: false, alive: true });
                expect(sub.external()).toBe(true);
                await sub.start();
                expect(spawned.length).toBe(0);
            });
            await withCase(async (paths) => {
                enable(paths);
                const { sub } = make(paths, { importing: false, alive: true });
                expect(sub.external()).toBe(false);
                await sub.start();
                expect(sub.external()).toBe(false);
            });
        });

        await it('reads a run whose process died as interrupted and starts anew', async () => {
            await withCase(async (paths) => {
                enable(paths);
                writeSemanticRunStatus(paths, status({}));
                const { sub, spawned } = make(paths, { importing: false, alive: false });
                expect(sub.state().kind).toBe('failed');
                await sub.start();
                expect(spawned.length).toBe(1);
            });
        });

        await it('waits for an import, then starts', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const flags = { importing: true, alive: true };
                const { sub, spawned } = make(paths, flags);
                await sub.start();
                sub.poll();
                expect(spawned.length).toBe(0);
                flags.importing = false;
                sub.poll();
                expect(spawned.length).toBe(1);
            });
        });

        await it('ends its own run when an import begins', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const flags = { importing: false, alive: true };
                const { sub, spawned } = make(paths, flags);
                await sub.start();
                flags.importing = true;
                sub.poll();
                expect(spawned[0]?.terminated).toBe(1);
            });
        });

        await it('disable writes the setting and ends its process; pause holds it', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const { sub, spawned } = make(paths, { importing: false, alive: true });
                await sub.start();
                sub.pause();
                expect(spawned[0]?.terminated).toBe(1);
                await sub.start();
                expect(spawned.length).toBe(1);
                await sub.enable();
                expect(spawned.length).toBe(2);
                await sub.disable();
                expect(spawned[1]?.terminated).toBe(1);
                expect(sub.setting()?.enabled).toBe(false);
            });
        });
    });

    await describe('probeOnly through a subprocess', async () => {
        const probeRecord = {
            modelId: 'fake/model',
            tokensPerSecond: 500,
            estimatedHours: 2,
            recommendation: 'on' as const,
            measuredAt: '2026-10-27T12:00:00.000Z',
        };

        function make(paths: CasePaths, probeTimeoutMs?: number) {
            const probes: ReturnType<typeof fakeProcess>[] = [];
            const indexers: ReturnType<typeof fakeProcess>[] = [];
            const sub = createSubprocessSemantic({
                paths,
                spawn: () => {
                    const proc = fakeProcess();
                    indexers.push(proc);
                    return proc;
                },
                spawnProbe: () => {
                    const proc = fakeProcess();
                    probes.push(proc);
                    return proc;
                },
                ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
                importRunning: () => false,
                now: () => T0 + 1000,
                alive: () => false,
            });
            return { sub, probes, indexers };
        }

        /** What the real subprocess does: write the measurement, then end. */
        function finishWithEstimate(paths: CasePaths, proc: ReturnType<typeof fakeProcess>): void {
            writeSemanticSetting(paths, {
                version: SEMANTIC_SETTING_VERSION,
                enabled: false,
                modelId: 'fake/model',
                dimensions: 4,
                probe: probeRecord,
            });
            proc.exit();
        }

        await it('returns what the subprocess wrote, and loads no model itself', async () => {
            await withCase(async (paths) => {
                const { sub, probes } = make(paths);
                const asked = sub.probeOnly();
                expect(probes.length).toBe(1);
                finishWithEstimate(paths, probes[0]!);
                expect((await asked)?.probe?.tokensPerSecond).toBe(500);
            });
        });

        await it('answers with the old setting when the subprocess dies without measuring', async () => {
            await withCase(async (paths) => {
                const { sub, probes } = make(paths);
                const asked = sub.probeOnly();
                probes[0]!.exit();
                expect(await asked).toBe(undefined);
            });
        });

        await it('lets a second ask join the probe that is going', async () => {
            await withCase(async (paths) => {
                const { sub, probes } = make(paths);
                const first = sub.probeOnly();
                const second = sub.probeOnly();
                expect(probes.length).toBe(1);
                finishWithEstimate(paths, probes[0]!);
                expect((await first)?.probe?.recommendation).toBe('on');
                expect((await second)?.probe?.recommendation).toBe('on');
                // Done: a later ask measures again.
                void sub.probeOnly();
                expect(probes.length).toBe(2);
                probes[1]!.exit();
            });
        });

        await it('stops waiting for a probe that hangs, and ends it', async () => {
            await withCase(async (paths) => {
                const { sub, probes } = make(paths, 20);
                const asked = sub.probeOnly();
                // The fake exits on terminate, so this also proves terminate was called.
                expect(await asked).toBe(undefined);
                expect(probes[0]?.terminated).toBe(1);
            });
        });

        await it('does not probe beside a live indexer', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const { sub, probes, indexers } = make(paths);
                await sub.start();
                expect(indexers.length).toBe(1);
                await sub.probeOnly();
                expect(probes.length).toBe(0);
            });
        });

        await it('starts the indexer only after the probe has written its estimate', async () => {
            await withCase(async (paths) => {
                enable(paths);
                const { sub, probes, indexers } = make(paths);
                const asked = sub.probeOnly();
                const started = sub.start();
                await Promise.resolve();
                expect(indexers.length).toBe(0);
                probes[0]!.exit();
                await asked;
                await started;
                expect(indexers.length).toBe(1);
            });
        });
    });

    await describe('vectors.db with two connections', async () => {
        await it('lets a reader see what a writer commits while both are open', async () => {
            await withCase(async (paths) => {
                const options = { modelId: 'fake/model', dimensions: 4 };
                const writer = openVectorDb(paths.vectors, options);
                putVector(writer, 'a', new Float32Array(4).fill(1));
                const reader = openVectorDbForSearch(paths.vectors, options);
                expect(reader !== undefined).toBe(true);
                if (reader === undefined) return;
                expect(countVectors(reader)).toBe(1);
                putVector(writer, 'b', new Float32Array(4).fill(1));
                expect(countVectors(reader)).toBe(2);
                reader.close();
                writer.close();
            });
        });
    });
};
