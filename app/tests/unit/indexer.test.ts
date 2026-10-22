/**
 * The background indexer and the probe, with a fake embedder and a list as the document source.
 * SYNTHETIC DATA ONLY.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    countVectors,
    createIndexer,
    hasVector,
    onBattery,
    openVectorDb,
    PROBE_MAX_ARCHIVE_HOURS,
    probeEmbedder,
} from '@stamped/semantic';
import type { DocumentSource, EmbedDocument, Embedder, SourceDocument, SourceEntry } from '@stamped/semantic';

function fakeEmbedder(modelId = 'fake/model', dimensions = 4, log: string[] = []): Embedder {
    return {
        modelId,
        dimensions,
        async embedQuery() {
            return new Float32Array(dimensions).fill(1);
        },
        async embedDocuments(docs: readonly EmbedDocument[]) {
            return docs.map((doc) => {
                log.push(doc.subject ?? '');
                if (doc.body === 'poison') throw new Error('cannot embed');
                return new Float32Array(dimensions).fill(1);
            });
        },
    };
}

/** `n` messages: m0 newest … m(n-1) oldest, then `undated` ones with no date. */
function listSource(n: number, undated = 0): DocumentSource & { reads: number } {
    const entries: SourceEntry[] = [];
    for (let i = 0; i < n; i++) entries.push({ hash: `m${i}`, sentAt: 1_000_000 - i });
    for (let i = 0; i < undated; i++) entries.push({ hash: `u${i}` });
    const source = {
        reads: 0,
        count: () => entries.length,
        next(after: SourceEntry | undefined, limit: number) {
            const start = after ? entries.findIndex((e) => e.hash === after.hash) + 1 : 0;
            return entries.slice(start, start + limit);
        },
        read(hashes: readonly string[]): SourceDocument[] {
            source.reads += hashes.length;
            return hashes.map((hash) => ({ hash, subject: hash, body: `body of ${hash}` }));
        },
    };
    return source;
}

async function withDb(body: (path: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-indexer-'));
    try {
        await body(join(root, 'vectors.db'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export default async () => {
    await describe('the indexer', async () => {
        await it('embeds in the source order and reports progress', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                const log: string[] = [];
                const seen: number[] = [];
                const indexer = createIndexer({
                    embedder: fakeEmbedder('fake/model', 4, log),
                    source: listSource(5, 2),
                    vectors: db,
                    batchSize: 2,
                    pageSize: 3,
                    onProgress: (p) => seen.push(p.done),
                });
                const result = await indexer.run();
                expect(log.join(',')).toBe('m0,m1,m2,m3,m4,u0,u1');
                expect(result.state).toBe('finished');
                expect(result.done).toBe(7);
                expect(result.total).toBe(7);
                expect(seen[seen.length - 1]).toBe(7);
                expect(countVectors(db)).toBe(7);
                db.close();
            });
        });

        await it('resumes: a second run embeds only what is missing', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                let batches = 0;
                const stopper = createIndexer({
                    embedder: fakeEmbedder(),
                    source: listSource(6),
                    vectors: db,
                    batchSize: 2,
                    onProgress: () => {
                        if (++batches === 2) stopper.stop();
                    },
                });
                const partial = await stopper.run();
                expect(partial.state).toBe('stopped');
                expect(countVectors(db) < 6).toBe(true);
                expect(countVectors(db) > 0).toBe(true);

                const log: string[] = [];
                const again = createIndexer({
                    embedder: fakeEmbedder('fake/model', 4, log),
                    source: listSource(6),
                    vectors: db,
                    batchSize: 2,
                });
                const result = await again.run();
                expect(result.state).toBe('finished');
                expect(log.length).toBe(6 - partial.done);
                expect(countVectors(db)).toBe(6);
                db.close();
            });
        });

        await it('holds while paused and goes on after resume()', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                const indexer = createIndexer({
                    embedder: fakeEmbedder(),
                    source: listSource(4),
                    vectors: db,
                    batchSize: 1,
                });
                indexer.pause();
                const running = indexer.run();
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(indexer.state).toBe('paused');
                expect(countVectors(db)).toBe(0);
                indexer.resume();
                const result = await running;
                expect(result.state).toBe('finished');
                expect(countVectors(db)).toBe(4);
                db.close();
            });
        });

        await it('pauses while shouldPause holds, polling again', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                let asked = 0;
                const indexer = createIndexer({
                    embedder: fakeEmbedder(),
                    source: listSource(3),
                    vectors: db,
                    batchSize: 1,
                    pollMs: 5,
                    shouldPause: () => ++asked <= 3,
                });
                const result = await indexer.run();
                expect(result.state).toBe('finished');
                expect(asked > 3).toBe(true);
                expect(countVectors(db)).toBe(3);
                db.close();
            });
        });

        await it('stop() ends a paused run', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                const indexer = createIndexer({
                    embedder: fakeEmbedder(),
                    source: listSource(3),
                    vectors: db,
                });
                indexer.pause();
                const running = indexer.run();
                await new Promise((resolve) => setTimeout(resolve, 10));
                indexer.stop();
                const result = await running;
                expect(result.state).toBe('stopped');
                expect(countVectors(db)).toBe(0);
                db.close();
            });
        });

        await it('skips a message the embedder refuses and reports it', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                const source = listSource(3);
                const read = source.read;
                source.read = (hashes) =>
                    read(hashes).map((d) => (d.hash === 'm1' ? { ...d, body: 'poison' } : d));
                const result = await createIndexer({
                    embedder: fakeEmbedder(),
                    source,
                    vectors: db,
                    batchSize: 3,
                }).run();
                expect(result.skipped).toBe(1);
                expect(result.skippedHashes[0]).toBe('m1');
                expect(hasVector(db, 'm0')).toBe(true);
                expect(hasVector(db, 'm1')).toBe(false);
                expect(hasVector(db, 'm2')).toBe(true);
                db.close();
            });
        });

        await it('rebuilds on a model change and refuses a database for another model', async () => {
            await withDb(async (path) => {
                let db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                await createIndexer({ embedder: fakeEmbedder(), source: listSource(3), vectors: db }).run();
                expect(countVectors(db)).toBe(3);

                let threw = false;
                try {
                    await createIndexer({
                        embedder: fakeEmbedder('other/model'),
                        source: listSource(3),
                        vectors: db,
                    }).run();
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
                db.close();

                db = openVectorDb(path, { modelId: 'other/model', dimensions: 4 });
                expect(countVectors(db)).toBe(0);
                const log: string[] = [];
                await createIndexer({
                    embedder: fakeEmbedder('other/model', 4, log),
                    source: listSource(3),
                    vectors: db,
                }).run();
                expect(log.length).toBe(3);
                db.close();
            });
        });

        await it('estimates rate and ETA from working time only', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                let clock = 0;
                const last: { rate?: number; eta?: number } = {};
                const embedder = fakeEmbedder();
                const slow: Embedder = {
                    ...embedder,
                    async embedDocuments(docs) {
                        clock += 1000 * docs.length;
                        return embedder.embedDocuments(docs);
                    },
                };
                const indexer = createIndexer({
                    embedder: slow,
                    source: listSource(4),
                    vectors: db,
                    batchSize: 2,
                    now: () => clock,
                    onProgress: (p) => {
                        if (p.done === 2) {
                            last.rate = p.rate;
                            last.eta = p.etaSeconds;
                        }
                    },
                });
                await indexer.run();
                expect(last.rate).toBe(1);
                expect(last.eta).toBe(2);
                db.close();
            });
        });
    });

    await describe('the probe', async () => {
        const docs: SourceDocument[] = [0, 1, 2, 3, 4].map((i) => ({
            hash: `h${i}`,
            subject: 's',
            body: 'word '.repeat(80),
        }));

        await it('extrapolates to the archive and recommends on for a fast machine', async () => {
            let clock = 0;
            const base = fakeEmbedder();
            const embedder: Embedder = {
                ...base,
                async embedDocuments(d) {
                    clock += 100 * d.length;
                    return base.embedDocuments(d);
                },
            };
            const result = await probeEmbedder(embedder, docs, 10_000, { now: () => clock });
            expect(result.sampled).toBe(4);
            expect(Math.round(result.docsPerSecond)).toBe(10);
            expect(Math.round(result.estimatedSeconds)).toBe(1000);
            expect(result.tokensPerSecond > 0).toBe(true);
            expect(result.recommendation).toBe('on');
        });

        await it('recommends off when the archive would take longer than the limit', async () => {
            let clock = 0;
            const base = fakeEmbedder();
            const embedder: Embedder = {
                ...base,
                async embedDocuments(d) {
                    clock += 1000 * d.length;
                    return base.embedDocuments(d);
                },
            };
            const pending = Math.ceil(PROBE_MAX_ARCHIVE_HOURS * 3600) + 1;
            const result = await probeEmbedder(embedder, docs, pending, { now: () => clock });
            expect(result.recommendation).toBe('off');
        });
    });

    await describe('the battery check', async () => {
        await it('is false where there is no power_supply directory', async () => {
            expect(onBattery('/nonexistent/power_supply')).toBe(false);
        });
    });
};
