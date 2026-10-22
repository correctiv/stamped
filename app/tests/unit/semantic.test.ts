/**
 * The semantic search primitives: the embedder seam, the text preparation, the vector table
 * and the rank fusion.
 *
 * SYNTHETIC DATA ONLY — no real message, address or domain; `example.com` throughout. The
 * embedder is a fake (a hashed bag of characters) so the suite runs in milliseconds and needs
 * no model, no download and no GPU — which is also what makes it runnable on both runtimes.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    checkVector,
    countVectors,
    documentText,
    fuseRrf,
    hasVector,
    missingVectors,
    normalize,
    openVectorDb,
    openVectorDbForSearch,
    putVector,
    putVectors,
    searchVectors,
} from '@stamped/semantic';
import type { EmbedDocument } from '@stamped/semantic';

/**
 * A deterministic fake embedder: every character of the text adds to one bucket, so two texts
 * that share words land near each other. Deterministic is the point — the assertions below
 * are about the ORDER the storage and the fusion produce, and a random embedder would make
 * them flaky rather than wrong.
 */
function fakeEmbedder(dimensions = 32) {
    const embed = (text: string): Float32Array => {
        const vector = new Float32Array(dimensions);
        for (let i = 0; i < text.length; i++) {
            vector[(text.charCodeAt(i) * 31 + i) % dimensions] += 1;
        }
        let norm = 0;
        for (let i = 0; i < dimensions; i++) norm += vector[i] * vector[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dimensions; i++) vector[i] = vector[i] / norm;
        return vector;
    };
    return {
        modelId: 'fake/hashed-characters',
        dimensions,
        async embedQuery(text: string): Promise<Float32Array> {
            return embed(text);
        },
        async embedDocuments(documents: readonly EmbedDocument[]): Promise<Float32Array[]> {
            return documents.map((doc) => embed(documentText(doc.subject, doc.body)));
        },
    };
}

/** A vector database in a temporary folder, removed when `body` returns. */
function withVectorDb(
    body: (db: ReturnType<typeof openVectorDb>, root: string) => void | Promise<void>,
    options: { modelId?: string; dimensions?: number } = {},
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-vectors-'));
    const db = openVectorDb(join(root, 'vectors.db'), {
        modelId: options.modelId ?? 'fake/hashed-characters',
        dimensions: options.dimensions ?? 8,
    });
    try {
        return Promise.resolve(body(db, root)).finally(() => {
            db.close();
            rmSync(root, { recursive: true, force: true });
        });
    } catch (error) {
        db.close();
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

export default async () => {
    await describe('@stamped/semantic', async () => {
        await describe('the embedder seam', async () => {
            await it('embeds a query and a document into the same space', async () => {
                const embedder = fakeEmbedder(16);
                const query = await embedder.embedQuery('the harbour contract');
                const documents = await embedder.embedDocuments([
                    { body: 'the harbour contract' },
                    { body: 'lighthouse' },
                ]);
                expect(query.length).toBe(16);
                expect(documents.length).toBe(2);
                expect(documents[0].length).toBe(16);
                // The same text must land on the same vector, whichever door it came through —
                // a query and a document are embedded by different code paths in the real
                // backend, and a mismatch there would make every search return nonsense.
                expect(Array.from(documents[0])).toStrictEqual(Array.from(query));
            });

            await it('refuses a vector with a NaN in it', async () => {
                // The spike found that a float16 backend silently yields NaN, and a NaN in the
                // table would poison every score it touches. The check has to throw, not
                // return false: a caller that ignored a false would store the vector anyway.
                let threw = false;
                try {
                    checkVector(new Float32Array([1, Number.NaN, 2]));
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });

            await it('refuses a vector of zeros', async () => {
                // A zero vector has no direction: its cosine similarity with anything is
                // undefined, and it would come back as a match with a meaningless score.
                let threw = false;
                try {
                    checkVector(new Float32Array([0, 0, 0]));
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });

            await it('accepts a healthy vector', async () => {
                expect(checkVector(new Float32Array([1, 2, 3]))).toBe(true);
            });

            await it('normalizes to unit length', async () => {
                const normalized = normalize(new Float32Array([3, 4]));
                expect(normalized.length).toBe(2);
                let norm = 0;
                for (const value of normalized) norm += value * value;
                expect(Math.abs(Math.sqrt(norm) - 1) < 1e-6).toBe(true);
            });
        });

        await describe('the text to embed', async () => {
            await it('keeps the subject and the body', async () => {
                const text = documentText('Quarterly figures', 'The spreadsheet covers the contract.');
                expect(text.includes('Quarterly figures')).toBe(true);
                expect(text.includes('spreadsheet')).toBe(true);
            });

            await it('drops quoted reply lines', async () => {
                const text = documentText('Rechnung', 'Danke.\n> Vorheriger Text\n> noch mehr');
                expect(text.includes('Vorheriger Text')).toBe(false);
                expect(text.includes('Danke')).toBe(true);
            });

            await it('drops an English reply header and everything after it', async () => {
                const text = documentText(
                    'Rechnung',
                    'Danke.\n\nOn Tue, 1 Jan 2024 John Smith wrote:\n> the old message',
                );
                expect(text.includes('John Smith')).toBe(false);
                expect(text.includes('the old message')).toBe(false);
                expect(text.includes('Danke')).toBe(true);
            });

            await it('drops a German reply header and everything after it', async () => {
                const text = documentText(
                    'Rechnung',
                    'Danke.\n\nAm Dienstag, 2. Januar 2024 schrieb Max Müller:\n> die alte Nachricht',
                );
                expect(text.includes('Max Müller')).toBe(false);
                expect(text.includes('die alte Nachricht')).toBe(false);
                expect(text.includes('Danke')).toBe(true);
            });

            await it('drops a German reply header with a time in it', async () => {
                const text = documentText(
                    'Rechnung',
                    'Danke.\n\nAm 5. Januar 2024 um 14:33 schrieb Max Müller:\n> die alte Nachricht',
                );
                expect(text.includes('Max Müller')).toBe(false);
                expect(text.includes('die alte Nachricht')).toBe(false);
            });

            await it('drops the original-message marker and everything after it', async () => {
                const text = documentText(
                    undefined,
                    'Danke.\n\n-----Original Message-----\nFrom: someone@example.com',
                );
                expect(text.includes('Original Message')).toBe(false);
                expect(text.includes('someone@example.com')).toBe(false);
            });

            await it('drops the German original-message marker and everything after it', async () => {
                const text = documentText(
                    undefined,
                    'Danke.\n\n-----Ursprüngliche Nachricht-----\nVon: jemand@example.com',
                );
                expect(text.includes('Ursprüngliche Nachricht')).toBe(false);
                expect(text.includes('jemand@example.com')).toBe(false);
            });

            await it('drops the transcribed German original-message marker too', async () => {
                // A mailer that cannot write an umlaut writes "Urspruengliche" — the marker is
                // the same, and a half-recognised one would leave the quoted mail in the text.
                for (const marker of ['-----Urspruengliche Nachricht-----']) {
                    const text = documentText(undefined, `Danke.\n\n${marker}\nVon: jemand@example.com`);
                    expect(text.includes('Nachricht')).toBe(false);
                    expect(text.includes('jemand@example.com')).toBe(false);
                }
            });

            await it('drops the signature after a lone -- ', async () => {
                const text = documentText(
                    'Rechnung',
                    'Der Betrag ist überwiesen.\n\n-- \nAda Lovelace\nAnalytical Engines Ltd',
                );
                expect(text.includes('Analytical Engines')).toBe(false);
                expect(text.includes('Der Betrag ist überwiesen')).toBe(true);
            });

            await it('keeps a line that only looks like a signature separator', async () => {
                // "--" without the trailing space is not the RFC 3676 separator, and a message
                // that merely contains a dash-dash would lose half its text.
                const text = documentText('Rechnung', 'Der Betrag -- erstaunlich -- ist überwiesen.');
                expect(text.includes('erstaunlich')).toBe(true);
            });

            await it('caps the length, because the context is fixed at 512 tokens', async () => {
                const text = documentText('Rechnung', 'word '.repeat(1000));
                expect(text.length <= 2000).toBe(true);
            });
        });

        await describe('the rank fusion', async () => {
            await it('puts a document that both lists rank highly first', async () => {
                // FTS5 finds the keyword, the vector search finds the meaning; the document
                // both of them rank highly is the one the journalist meant.
                const fused = fuseRrf([
                    ['keyword', 'both'],
                    ['meaning', 'both'],
                ]);
                expect(fused[0]).toBe('both');
                expect(fused.length).toBe(3);
            });

            await it('keeps a document that only one list found', async () => {
                const fused = fuseRrf([['a', 'b'], ['c']]);
                expect(fused.length).toBe(3);
                expect(fused.includes('c')).toBe(true);
            });

            await it('orders ties by where they were first seen', async () => {
                // Two documents at the same rank in the same list are equally good; the order
                // between them must not change from one run to the next, or the list of
                // results jumps around while the journalist reads it.
                const first = fuseRrf([
                    ['a', 'b'],
                    ['c', 'd'],
                ]);
                const second = fuseRrf([
                    ['a', 'b'],
                    ['c', 'd'],
                ]);
                expect(first).toStrictEqual(second);
                // 'a' and 'c' both sit at rank 1 (score 1/61), 'b' and 'd' at rank 2
                // (1/62) — so the score decides the groups, and the first-seen order
                // decides within them.
                expect(first).toStrictEqual(['a', 'c', 'b', 'd']);
            });

            await it('gives the same order when a list is repeated', async () => {
                expect(fuseRrf([['a'], ['a']])).toStrictEqual(['a']);
            });

            await it('fuses an empty list of lists into nothing', async () => {
                expect(fuseRrf([])).toStrictEqual([]);
                expect(fuseRrf([[], []])).toStrictEqual([]);
            });
        });

        await describe('the vector table', async () => {
            await it('finds the closest vector first', async () => {
                await withVectorDb((db) => {
                    const query = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
                    putVector(db, 'far', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
                    putVector(db, 'near', new Float32Array([0.99, 0.1, 0, 0, 0, 0, 0, 0]));
                    const hits = searchVectors(db, query, 10);
                    expect(hits.length).toBe(2);
                    expect(hits[0].hash).toBe('near');
                    expect(hits[0].score > hits[1].score).toBe(true);
                });
            });

            await it('reads a stored vector back bit for bit', async () => {
                // The score of a vector against ITSELF must be exactly 1. It is the check
                // that the bytes survived the round trip through the BLOB column: a wrong
                // byte order, a truncated blob or a mis-decoded hex would show up here as
                // a score of 0.99 or of nothing at all.
                await withVectorDb((db) => {
                    const vector = new Float32Array([0.25, -0.5, 0.75, 1, -1, 0, 0.125, -2]);
                    putVector(db, 'a', vector);
                    const hits = searchVectors(db, vector, 1);
                    expect(hits.length).toBe(1);
                    expect(hits[0].hash).toBe('a');
                    expect(Math.abs(hits[0].score - 1) < 1e-6).toBe(true);
                });
            });

            await it('scores a vector against another one exactly', async () => {
                await withVectorDb((db) => {
                    putVector(db, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    putVector(db, 'b', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
                    const hits = searchVectors(db, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 10);
                    expect(hits.find((hit) => hit.hash === 'a')?.score).toBe(1);
                    expect(hits.find((hit) => hit.hash === 'b')?.score).toBe(0);
                });
            });

            await it('honours the limit', async () => {
                await withVectorDb((db) => {
                    putVector(db, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    putVector(db, 'b', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
                    expect(searchVectors(db, new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 1).length).toBe(1);
                });
            });

            await it('keeps the vectors across a reopen', async () => {
                // The whole point of a separate file: the index can be thrown away and rebuilt
                // without paying for the embeddings again.
                const root = mkdtempSync(join(tmpdir(), 'stamped-vectors-'));
                const path = join(root, 'vectors.db');
                try {
                    const first = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 8 });
                    putVector(first, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    first.close();

                    const second = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 8 });
                    expect(countVectors(second)).toBe(1);
                    expect(hasVector(second, 'a')).toBe(true);
                    second.close();
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });

            await it('stores a batch in one go', async () => {
                await withVectorDb((db) => {
                    putVectors(db, [
                        ['a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])],
                        ['b', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0])],
                    ]);
                    expect(countVectors(db)).toBe(2);
                    expect(hasVector(db, 'b')).toBe(true);
                });
            });

            await it('starts over when the model changes', async () => {
                // A vector from one model means nothing in another: mixing them would return
                // confident nonsense, so the table is dropped and the case has to be re-embedded.
                const root = mkdtempSync(join(tmpdir(), 'stamped-vectors-'));
                const path = join(root, 'vectors.db');
                try {
                    const first = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 8 });
                    putVector(first, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    expect(countVectors(first)).toBe(1);
                    first.close();

                    const second = openVectorDb(path, { modelId: 'other/model', dimensions: 8 });
                    expect(countVectors(second)).toBe(0);
                    second.close();
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });

            await it('leaves another model’s table alone when a search opens it', async () => {
                // A search must never cost the person their index: a build with another model
                // gets nothing back, and the vectors stay for the build that made them.
                const root = mkdtempSync(join(tmpdir(), 'stamped-vectors-'));
                const path = join(root, 'vectors.db');
                try {
                    expect(
                        openVectorDbForSearch(path, { modelId: 'fake/hashed-characters', dimensions: 8 }),
                    ).toBeUndefined();
                    expect(existsSync(path)).toBe(false);

                    const first = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 8 });
                    putVector(first, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    first.close();

                    expect(
                        openVectorDbForSearch(path, { modelId: 'other/model', dimensions: 8 }),
                    ).toBeUndefined();
                    const same = openVectorDbForSearch(path, {
                        modelId: 'fake/hashed-characters',
                        dimensions: 8,
                    });
                    expect(same === undefined ? 0 : countVectors(same)).toBe(1);
                    same?.close();
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });

            await it('starts over when the dimension count changes', async () => {
                const root = mkdtempSync(join(tmpdir(), 'stamped-vectors-'));
                const path = join(root, 'vectors.db');
                try {
                    const first = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 8 });
                    putVector(first, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    first.close();

                    const second = openVectorDb(path, { modelId: 'fake/hashed-characters', dimensions: 16 });
                    expect(countVectors(second)).toBe(0);
                    second.close();
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            });

            await it('names the hashes it still misses', async () => {
                // What makes an interrupted indexing run resumable: ask for what is left
                // instead of starting over.
                await withVectorDb((db) => {
                    putVector(db, 'a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
                    putVector(db, 'b', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));
                    expect(missingVectors(db, ['a', 'b', 'c', 'd'])).toStrictEqual(['c', 'd']);
                    expect(missingVectors(db, [])).toStrictEqual([]);
                });
            });
        });
    });
};
