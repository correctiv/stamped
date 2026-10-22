/**
 * The background indexer and the probe, with a fake embedder and a list as the document source.
 * SYNTHETIC DATA ONLY.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    countVectors,
    createIndexer,
    hasVector,
    onBattery,
    openVectorDb,
    PROBE_MAX_ARCHIVE_HOURS,
    PROBE_SAMPLE_SIZE,
    probeEmbedder,
    sampleForProbe,
} from '@stamped/semantic';
import type { DocumentSource, EmbedDocument, Embedder, SourceDocument, SourceEntry } from '@stamped/semantic';
import {
    browseMessages,
    indexDocumentSource,
    indexMessage,
    openCase,
    openIndex,
    store,
} from '@stamped/store';

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

/**
 * A real case folder: raw messages under `raw/`, a real `index.db`. SYNTHETIC messages, built
 * here rather than taken from the fixtures, because what is being tested is the ORDER over dates
 * — equal dates, missing dates — and that is what the message has to vary in.
 */
async function withCase(
    plan: readonly { subject: string; date: string; body?: string }[],
    body: (db: DatabaseSync, paths: ReturnType<typeof openCase>) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-source-'));
    const paths = openCase(root);
    const db = openIndex(paths);
    try {
        for (const message of plan) {
            const raw = encodeLatin1(
                `From: a@example.com\r\nTo: b@example.com\r\nSubject: ${message.subject}\r\n` +
                    `${message.date ? `Date: ${message.date}\r\n` : ''}\r\n${message.body ?? `body of ${message.subject}`}\r\n`,
            );
            const stored = store(paths, raw);
            indexMessage(
                db,
                {
                    hash: stored.hash,
                    bytes: raw.length,
                    summary: summarise(raw),
                    finding: { verdict: 'unsigned', caveats: [], signatures: [] },
                },
                { fresh: true },
            );
        }
        await body(db, paths);
    } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
}

/** Two dates that tie, one that does not, and messages with no `Date` at all. */
const SOURCE_PLAN = [
    { subject: 'newest', date: 'Tue, 05 Mar 2024 10:00:00 +0000' },
    { subject: 'tie-a', date: 'Mon, 04 Mar 2024 09:00:00 +0000' },
    { subject: 'tie-b', date: 'Mon, 04 Mar 2024 09:00:00 +0000' },
    { subject: 'tie-c', date: 'Mon, 04 Mar 2024 09:00:00 +0000' },
    { subject: 'oldest', date: 'Sun, 03 Mar 2024 08:00:00 +0000' },
    { subject: 'epoch', date: 'Thu, 01 Jan 1970 00:00:00 +0000' },
    { subject: 'undated-1', date: '' },
    { subject: 'undated-2', date: '' },
];

/** Every hash the source hands out, paging with `size`. */
function walkSource(source: ReturnType<typeof indexDocumentSource>, size: number): string[] {
    const seen: string[] = [];
    let cursor: SourceEntry | undefined;
    for (;;) {
        const page = source.next(cursor, size);
        if (page.length === 0) return seen;
        if (page.length > size) throw new Error('a page longer than the limit');
        seen.push(...page.map((entry) => entry.hash));
        cursor = page[page.length - 1];
        if (seen.length > SOURCE_PLAN.length * 4) throw new Error('the cursor is not advancing');
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

        await it('stop() from inside the paused progress ends the run', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                const indexer = createIndexer({
                    embedder: fakeEmbedder(),
                    source: listSource(3),
                    vectors: db,
                    onProgress: (p) => {
                        if (p.state === 'paused') indexer.stop();
                    },
                });
                indexer.pause();
                const result = await indexer.run();
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

    await describe('the source over a real index', async () => {
        await it('walks the browse order exactly, at every page size', async () => {
            await withCase(SOURCE_PLAN, async (db, paths) => {
                const expected = browseMessages(db, { limit: 100 }).map((hit) => hit.hash);
                expect(expected.length).toBe(SOURCE_PLAN.length);
                const source = indexDocumentSource(db, paths);
                for (const size of [1, 2, 3, 5, 8, 100]) {
                    const seen = walkSource(source, size);
                    // Same messages, same order, none twice: the whole contract of the cursor.
                    expect(seen.join(',')).toBe(expected.join(','));
                    expect(new Set(seen).size).toBe(expected.length);
                }
            });
        });

        await it('carries sentAt and leaves it off a message with no date', async () => {
            await withCase(SOURCE_PLAN, async (db, paths) => {
                const entries = indexDocumentSource(db, paths).next(undefined, 100);
                const dated = entries.filter((entry) => entry.sentAt !== undefined);
                expect(dated.length).toBe(6);
                // Undated last, and `sentAt` is absent rather than 0 — the epoch message proves
                // the difference is not an `if (!sentAt)` away.
                expect(entries[entries.length - 1].sentAt === undefined).toBe(true);
                expect(dated[dated.length - 1].sentAt).toBe(0);
            });
        });

        await it('reads subject and body, and skips a hash it no longer has', async () => {
            await withCase(SOURCE_PLAN, async (db, paths) => {
                const source = indexDocumentSource(db, paths);
                const hashes = source.next(undefined, 2).map((entry) => entry.hash);
                const docs = source.read([...hashes, 'deadbeef']);
                expect(docs.length).toBe(2);
                expect(docs[0].hash).toBe(hashes[0]);
                expect(docs[0].subject).toBe('newest');
                expect(docs[0].body.includes('body of newest')).toBe(true);
            });
        });

        await it('indexes a real case end to end and resumes over it', async () => {
            await withCase(SOURCE_PLAN, async (db, paths) => {
                await withDb(async (path) => {
                    const vectors = openVectorDb(path, { modelId: 'fake/model', dimensions: 4 });
                    const source = indexDocumentSource(db, paths);
                    const first = await createIndexer({
                        embedder: fakeEmbedder(),
                        source,
                        vectors,
                        batchSize: 3,
                        pageSize: 3,
                    }).run();
                    expect(first.state).toBe('finished');
                    expect(first.done).toBe(SOURCE_PLAN.length);
                    expect(countVectors(vectors)).toBe(SOURCE_PLAN.length);

                    const log: string[] = [];
                    const again = await createIndexer({
                        embedder: fakeEmbedder('fake/model', 4, log),
                        source,
                        vectors,
                        batchSize: 3,
                        pageSize: 3,
                    }).run();
                    // Nothing left to do: a second run embeds no message at all.
                    expect(log.length).toBe(0);
                    expect(again.done).toBe(SOURCE_PLAN.length);
                    vectors.close();
                });
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

        await it('samples evenly through the window', async () => {
            const picked = sampleForProbe(listSource(40));
            expect(picked.length).toBe(PROBE_SAMPLE_SIZE);
            // Spread, not the first eight in a row: 40 entries, every fifth one.
            expect(picked.map((doc) => doc.hash).join(',')).toBe('m0,m5,m10,m15,m20,m25,m30,m35');
        });

        await it('makes the sample up when the spread picks blank bodies', async () => {
            const source = listSource(40);
            const blank = new Set(['m0', 'm5', 'm10', 'm15', 'm20', 'm25']);
            const read = source.read;
            // Timing a message with no text would time the prompt, not the text.
            source.read = (hashes) =>
                read(hashes).map((doc) => (blank.has(doc.hash) ? { ...doc, body: '  ' } : doc));
            const picked = sampleForProbe(source);
            expect(picked.length).toBe(PROBE_SAMPLE_SIZE);
            expect(picked.every((doc) => doc.body.trim() !== '')).toBe(true);
            expect(new Set(picked.map((doc) => doc.hash)).size).toBe(PROBE_SAMPLE_SIZE);
        });

        await it('gives nothing back when no message has a body', async () => {
            const source = listSource(40);
            const read = source.read;
            source.read = (hashes) => read(hashes).map((doc) => ({ ...doc, body: '' }));
            expect(sampleForProbe(source).length).toBe(0);
        });

        await it('takes what there is when the case is smaller than the sample', async () => {
            const picked = sampleForProbe(listSource(3));
            expect(picked.length).toBe(3);
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
