/**
 * The semantic search controls of the window: probe without indexing, the status button's row,
 * the settings dialog's words and the marker on a hit.
 *
 * SYNTHETIC DATA ONLY: a fake embedder and made-up messages. No model, no download.
 */

import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import type { DocumentSource, EmbedDocument, Embedder, SourceDocument, SourceEntry } from '@stamped/semantic';
import {
    type CasePaths,
    openCase,
    readSemanticSetting,
    type SemanticSetting,
    writeSemanticSetting,
} from '@stamped/store';

import { EMBEDDING_MODEL_BYTES } from '../../src/lib/model-path.ts';
import { ActivityRegistry, syncSemanticActivity } from '../../src/lib/activity.ts';
import { createSemanticController } from '../../src/lib/semantic.ts';
import {
    createGuiEmbedder,
    embedderAvailability,
    registerLlamaEmbedder,
} from '../../src/lib/semantic-embedder.ts';
import type { SemanticState } from '../../src/lib/semantic-state.ts';
import { buttonView, rowView } from '../../src/gui/view/activity.ts';
import { matchBadge, semanticEstimate, semanticSettingsView } from '../../src/gui/view/semantic.ts';

const T0 = Date.parse('2026-10-22T10:00:00Z');

function fakeEmbedder(clock: { t: number }, perDoc = 100): Embedder {
    return {
        modelId: 'fake/model',
        dimensions: 4,
        async embedQuery() {
            return new Float32Array(4).fill(1);
        },
        async embedDocuments(docs: readonly EmbedDocument[]) {
            return docs.map(() => {
                clock.t += perDoc;
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
    const root = mkdtempSync(join(tmpdir(), 'stamped-semantic-gui-'));
    try {
        await body(openCase(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function rowOf(state: SemanticState, own = true) {
    const registry = new ActivityRegistry();
    registry.start({ kind: 'semantic', state, own });
    return rowView(registry.get('semantic')!);
}

export default async () => {
    await describe('probeOnly', async () => {
        await it('measures and keeps the probe, without switching on or indexing', async () => {
            await withCase(async (paths) => {
                const clock = { t: T0 };
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => fakeEmbedder(clock),
                    source: listSource(20),
                    now: () => clock.t,
                });
                const setting = await controller.probeOnly();
                expect(setting?.enabled).toBe(false);
                expect(setting?.probe?.modelId).toBe('fake/model');
                expect(readSemanticSetting(paths)?.probe?.modelId).toBe('fake/model');
                expect(existsSync(paths.vectors)).toBe(false);
                expect(controller.state()).toStrictEqual({ kind: 'off' });
            });
        });

        await it('is quiet when there is no embedder', async () => {
            await withCase(async (paths) => {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => undefined,
                    source: listSource(5),
                });
                expect(await controller.probeOnly()).toBe(undefined);
                expect(readSemanticSetting(paths)).toBe(undefined);
            });
        });

        await it('is quiet when the embedder throws', async () => {
            await withCase(async (paths) => {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => {
                        throw new Error('model will not load');
                    },
                    source: listSource(5),
                });
                expect(await controller.probeOnly()).toBe(undefined);
            });
        });
    });

    await describe('a failed run', async () => {
        await it('names the embedder error, not only the indexer wrapper', async () => {
            await withCase(async (paths) => {
                writeSemanticSetting(paths, {
                    version: 1,
                    enabled: true,
                    modelId: 'fake/model',
                    dimensions: 4,
                    probe: {
                        modelId: 'fake/model',
                        tokensPerSecond: 1000,
                        estimatedHours: 0.1,
                        recommendation: 'on',
                        measuredAt: '2026-10-22T10:00:00Z',
                    },
                });
                const broken: Embedder = {
                    ...fakeEmbedder({ t: T0 }),
                    async embedDocuments() {
                        throw new Error('input is longer than the context');
                    },
                };
                const controller = createSemanticController({
                    paths,
                    createEmbedder: async () => broken,
                    source: listSource(10),
                });
                await controller.start();
                for (let i = 0; i < 200 && controller.state().kind === 'indexing'; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                const state = controller.state();
                expect(state.kind).toBe('failed');
                expect(state.kind === 'failed' && state.message.includes('longer than the context')).toBe(
                    true,
                );
            });
        });
    });

    await describe('the semantic activity', async () => {
        await it('keeps a held run listed and drops off and unavailable', async () => {
            const registry = new ActivityRegistry();
            syncSemanticActivity(registry, { kind: 'indexing', done: 1, total: 4 });
            expect(registry.get('semantic')?.state).toBe('running');
            syncSemanticActivity(registry, { kind: 'paused', reason: 'user', done: 1, total: 4 });
            expect(registry.get('semantic')?.state).toBe('running');
            syncSemanticActivity(registry, { kind: 'ready', done: 4, total: 4 });
            expect(registry.get('semantic')?.state).toBe('done');
            syncSemanticActivity(registry, { kind: 'off' });
            expect(registry.get('semantic')).toBe(undefined);
        });

        await it('leaves no row for a complete index it did not see running', async () => {
            const registry = new ActivityRegistry();
            syncSemanticActivity(registry, { kind: 'ready', done: 4, total: 4 });
            syncSemanticActivity(registry, { kind: 'failed', message: 'x' });
            expect(registry.get('semantic')).toBe(undefined);
        });

        await it('shows Pause while indexing', async () => {
            const row = rowOf({ kind: 'indexing', done: 1200, total: 5000, remainingSeconds: 7200 });
            expect(row.control).toBe('pause');
            expect(row.stats.includes('2.0 h')).toBe(true);
        });

        await it('offers no Pause for a run another process started, and says so', async () => {
            const state: SemanticState = { kind: 'indexing', done: 1200, total: 5000, remainingSeconds: 60 };
            const own = rowOf(state);
            const other = rowOf(state, false);
            expect(other.control).toBe(undefined);
            expect(other.subtitle.includes('another process')).toBe(true);
            expect(own.subtitle.includes('another process')).toBe(false);
            expect(other.stats === '').toBe(false);
        });

        await it('tells the battery pause from the person\u2019s', async () => {
            const battery = rowOf({ kind: 'paused', reason: 'battery', done: 1, total: 4 });
            const user = rowOf({ kind: 'paused', reason: 'user', done: 1, total: 4 });
            expect(battery.control).toBe(undefined);
            expect(user.control).toBe('resume');
            expect(battery.subtitle === user.subtitle).toBe(false);
        });

        await it('counts a running semantic task in the button', async () => {
            const registry = new ActivityRegistry();
            syncSemanticActivity(registry, { kind: 'indexing', done: 2, total: 4 });
            expect(buttonView(registry.list()).mode).toBe('progress');
        });
    });

    await describe('the settings words', async () => {
        const probed: SemanticSetting = {
            version: 1,
            enabled: false,
            probe: {
                modelId: 'fake/model',
                tokensPerSecond: 10,
                estimatedHours: 7.8,
                recommendation: 'on',
                measuredAt: '2026-10-22T10:00:00Z',
            },
        };

        await it('words the estimate once a probe exists', async () => {
            expect(semanticEstimate(undefined, 100)).toBe(undefined);
            expect(semanticEstimate(probed, 0)).toBe(undefined);
            expect(semanticEstimate(probed, 120000)).toBe('About 7.8 h for 120000 messages.');
        });

        await it('explains a missing runtime and disables the switch', async () => {
            const view = semanticSettingsView('runtime', { kind: 'unavailable' }, undefined, 10);
            expect(view.sensitive).toBe(false);
            expect(view.note === undefined).toBe(false);
            expect(view.lines).toStrictEqual([]);
            expect(view.pinNote).toBeUndefined();
        });

        await it('shows the state line and estimate when the runtime is there', async () => {
            const view = semanticSettingsView('ready', { kind: 'off' }, probed, 50);
            expect(view.sensitive).toBe(true);
            expect(view.active).toBe(false);
            expect(view.lines).toStrictEqual(['Semantic search is off.']);
            expect(view.estimate === undefined).toBe(false);
            expect(view.pinNote).toBeUndefined();
        });

        await it('says where a running index runs, and nothing once it is done', async () => {
            const running = semanticSettingsView(
                'ready',
                { kind: 'indexing', done: 1, total: 10 },
                probed,
                10,
                {
                    backend: 'gpu',
                },
            );
            expect(running.lines[0]).toBe('Runs on the graphics card.');
            const done = semanticSettingsView(
                'ready',
                { kind: 'ready', total: 10 } as SemanticState,
                probed,
                10,
                {
                    backend: 'gpu',
                },
            );
            expect(done.lines.includes('Runs on the graphics card.')).toBe(false);
        });

        await it('explains a GPU pin, naming the process and the full graphics memory', async () => {
            const pin = { at: '2026-10-22T10:00:00Z', pid: 1234 };
            const view = semanticSettingsView('ready', { kind: 'indexing', done: 1, total: 10 }, probed, 10, {
                backend: 'cpu',
                pin,
            });
            expect(view.lines[0]).toBe('Runs on the processor.');
            expect(view.pinNote?.includes('1234')).toBe(true);
            expect(view.pinNote?.includes('graphics memory')).toBe(true);
        });

        await it('has no pin note when the environment decides the GPU, or nothing can embed', async () => {
            const pin = { at: '2026-10-22T10:00:00Z', pid: 1234 };
            for (const gpu of ['on', 'off'] as const) {
                expect(
                    semanticSettingsView('ready', { kind: 'off' }, probed, 10, { pin, gpu }).pinNote,
                ).toBeUndefined();
            }
            expect(
                semanticSettingsView('runtime', { kind: 'off' }, probed, 10, { pin }).pinNote,
            ).toBeUndefined();
        });

        await it('marks hits the meaning found, and only those', async () => {
            expect(matchBadge('text')).toBe(undefined);
            expect(matchBadge('semantic') === undefined).toBe(false);
            expect(matchBadge('both') === matchBadge('semantic')).toBe(false);
        });
    });

    await describe('the GUI embedder', async () => {
        await it('is none without a prebuilt binary, and never throws', async () => {
            expect(embedderAvailability({}, false)).toBe('runtime');
            expect(await createGuiEmbedder({}, false)).toBe(undefined);
        });

        await it('asks for a model once the machine could run one', async () => {
            // No STAMPED_EMBED_MODEL, no XDG_DATA_DIRS, a cache that holds nothing: the binary is
            // there, the model is not, and that difference is what the dialog explains.
            expect(embedderAvailability({ XDG_CACHE_HOME: '/nonexistent' }, true)).toBe('model');
            expect(await createGuiEmbedder({ XDG_CACHE_HOME: '/nonexistent' }, true)).toBe(undefined);
        });

        await it('creates the registered embedder for the model the environment names', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'stamped-gui-embedder-'));
            try {
                const model = join(dir, 'model.gguf');
                // A sparse file of the pinned size: the size is all the lookup checks.
                writeFileSync(model, '');
                truncateSync(model, EMBEDDING_MODEL_BYTES);
                const seen: string[] = [];
                registerLlamaEmbedder(async (options) => {
                    seen.push(options.modelPath);
                    return fakeEmbedder({ t: 0 });
                });
                const embedder = await createGuiEmbedder({ STAMPED_EMBED_MODEL: model }, true);
                expect(embedder?.modelId).toBe('fake/model');
                expect(seen.length).toBe(1);
                expect(seen[0]).toBe(model);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
};
