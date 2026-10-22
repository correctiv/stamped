/**
 * The semantic search controls of the window: probe without indexing, the status button's row,
 * the settings dialog's words and the marker on a hit.
 *
 * SYNTHETIC DATA ONLY: a fake embedder and made-up messages. No model, no download.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import type { DocumentSource, EmbedDocument, Embedder, SourceDocument, SourceEntry } from '@stamped/semantic';
import { type CasePaths, openCase, readSemanticSetting, type SemanticSetting } from '@stamped/store';

import { ActivityRegistry, syncSemanticActivity } from '../../src/lib/activity.ts';
import { createSemanticController } from '../../src/lib/semantic.ts';
import { createGuiEmbedder, embedderAvailability } from '../../src/lib/semantic-embedder.ts';
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

function rowOf(state: SemanticState) {
    const registry = new ActivityRegistry();
    registry.start({ kind: 'semantic', state });
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
        });

        await it('shows the state line and estimate when the runtime is there', async () => {
            const view = semanticSettingsView('ready', { kind: 'off' }, probed, 50);
            expect(view.sensitive).toBe(true);
            expect(view.active).toBe(false);
            expect(view.lines).toStrictEqual(['Semantic search is off.']);
            expect(view.estimate === undefined).toBe(false);
        });

        await it('marks hits the meaning found, and only those', async () => {
            expect(matchBadge('text')).toBe(undefined);
            expect(matchBadge('semantic') === undefined).toBe(false);
            expect(matchBadge('both') === matchBadge('semantic')).toBe(false);
        });
    });

    await describe('the GUI embedder', async () => {
        await it('is none under GJS, and never throws', async () => {
            expect(embedderAvailability({}, true)).toBe('runtime');
            expect(await createGuiEmbedder({}, true)).toBe(undefined);
        });
    });
};
