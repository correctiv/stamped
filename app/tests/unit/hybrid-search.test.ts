/**
 * The hybrid search: the text half, the semantic half, and the fusion of the two.
 *
 * SYNTHETIC DATA ONLY — no real message, address or domain; `example.com` throughout. The
 * embedder is a fake (a bag of words hashed into buckets) so the suite runs in milliseconds and
 * needs no model, no download and no GPU — which is also what makes it runnable on both
 * runtimes.
 *
 * THE FAKE EMBEDS THE BODY ONLY, and that is deliberate: it lets a test tell a hit the TEXT
 * search found in a header from a hit the MEANING found in the message — exactly the distinction
 * the `match` marker makes. It also stems a trailing "s", which FTS5 does not: so "harbours" is
 * found by the meaning of "harbour" and not by the word, and the suite can build a hit that only
 * the semantic half finds.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding, Verdict } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import { countVectors, openVectorDb, putVector } from '@stamped/semantic';
import type { EmbedDocument, Embedder } from '@stamped/semantic';
import { digest, hashScope, indexMessage, openCase, openIndex, type CasePaths } from '@stamped/store';

import { matchMarker, searchCommand } from '../../src/commands/search.ts';
import { hybridSearch } from '../../src/lib/hybrid-search.ts';

/** How many buckets the fake hashes its words into — the model's dimension count. */
const DIMENSIONS = 768;

/** The model id the fake claims. A vector table only means something with the model that made it. */
const MODEL_ID = 'fake/bag-of-words';

/**
 * A word, as the fake counts it: lower case, and without a trailing plural "s".
 *
 * The stemming is what makes the semantic half find something the text half cannot: FTS5's
 * tokenizer knows no plural, so "harbours" is a different word than "harbour".
 */
function stem(word: string): string {
    return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The bucket a word lands in. Stable, so the same word always counts the same. */
function bucketOf(word: string): number {
    let hash = 0;
    for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) % DIMENSIONS;
    return hash;
}

/**
 * The words of a text, as the fake counts them.
 *
 * The model's prompt wrapper is dropped first: the real embedder wraps the query in `task:
 * search result | query: …` before it embeds it (see `@stamped/semantic`'s `llama-embedder.ts`),
 * and the fake does not care where that wrapper is applied — it counts the words either way.
 */
function wordsOf(text: string): string[] {
    const bare = text
        .replace('task: search result | query: ', ' ')
        .replace(/^title: /, ' ')
        .replace(/ \| text: /, ' ');
    return bare
        .toLowerCase()
        .split(/[^a-zäöüß0-9]+/)
        .filter((word) => word.length > 0)
        .map(stem);
}

/**
 * A deterministic fake embedder: a bag of words, hashed into buckets and normalised.
 *
 * Deterministic is the point — the assertions below are about the ORDER the fusion produces, and
 * a random embedder would make them flaky rather than wrong.
 */
function fakeEmbedder(): Embedder {
    const embed = (text: string): Float32Array => {
        const vector = new Float32Array(DIMENSIONS);
        for (const word of wordsOf(text)) vector[bucketOf(word)] += 1;
        let norm = 0;
        for (let i = 0; i < DIMENSIONS; i++) norm += vector[i] * vector[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < DIMENSIONS; i++) vector[i] = vector[i] / norm;
        return vector;
    };
    return {
        modelId: MODEL_ID,
        dimensions: DIMENSIONS,
        async embedQuery(text: string): Promise<Float32Array> {
            return embed(text);
        },
        async embedDocuments(documents: readonly EmbedDocument[]): Promise<Float32Array[]> {
            // The BODY only — see the module note.
            return documents.map((doc) => embed(doc.body));
        },
    };
}

/** A message as bytes, from a subject and a body. */
function message(id: string, subject: string, body: string): Uint8Array {
    return encodeLatin1(
        [
            'From: Ada Lovelace <ada@example.com>',
            'To: Grace Hopper <grace@example.net>',
            `Subject: ${subject}`,
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            `Message-ID: <${id}@example.com>`,
            '',
            body,
            '',
        ].join('\n'),
    );
}

/**
 * A finding, without running a verifier.
 *
 * The index stores what a classification concluded; what the classification IS has its own suite
 * (`classify.test.ts`). Building one here by hand keeps this suite about the search.
 */
function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

/**
 * The messages of the synthetic case, and what they say.
 *
 * The vocabulary is chosen so that every claim of the suite has a message to prove it:
 *
 * - A carries the query word in its BODY — the text search finds it, and so does the meaning.
 * - D carries the PLURAL of the query word — FTS5 does not know plurals, so only the meaning
 *   finds it. This is the hit that makes the semantic half worth having.
 * - E carries the query word in its SUBJECT but not in its body — the text search finds it, the
 *   meaning (which reads bodies) does not.
 * - F carries the plural of a second query word — the text-empty case.
 */
const MESSAGES: readonly { id: string; subject: string; body: string; verdict: Verdict }[] = [
    {
        id: 'a',
        subject: 'Harbour contract',
        body: 'harbour contract signed yesterday',
        verdict: 'confirmed',
    },
    { id: 'b', subject: 'Quay notes', body: 'quay notes signed yesterday', verdict: 'unverifiable' },
    { id: 'c', subject: 'Lighthouse duty', body: 'lighthouse duty roster', verdict: 'unsigned' },
    { id: 'd', subject: 'Ferry timetables', body: 'harbours timetables ferry', verdict: 'body-altered' },
    { id: 'e', subject: 'Harbour dues', body: 'sheet enclosed', verdict: 'headers-altered' },
    {
        id: 'f',
        subject: 'Port fees',
        body: 'quay tariffs annex',
        verdict: 'confirmed-with-caveats',
    },
];

/** A case with the messages indexed, and the hashes of them. */
interface Fixture {
    readonly paths: CasePaths;
    readonly index: DatabaseSync;
    /** The hash of each message, by its id. */
    readonly hashes: Readonly<Record<string, string>>;
}

async function withFixture(body: (fixture: Fixture) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-hybrid-'));
    const paths = openCase(root);
    const index = openIndex(paths);
    const hashes: Record<string, string> = {};
    try {
        for (const entry of MESSAGES) {
            const raw = message(entry.id, entry.subject, entry.body);
            const hash = digest(raw);
            indexMessage(index, {
                hash,
                bytes: raw.length,
                summary: summarise(raw),
                finding: finding(entry.verdict),
            });
            hashes[entry.id] = hash;
        }
        await body({ paths, index, hashes });
    } finally {
        index.close();
        rmSync(root, { recursive: true, force: true });
    }
}

/**
 * The case's vector table, filled with the fake's vectors for the messages.
 *
 * The ids whose vectors are written are given; a message left out has no vector, which is what
 * a half-indexed case looks like.
 */
async function withVectors(
    paths: CasePaths,
    ids: readonly string[],
    body: (db: DatabaseSync) => void | Promise<void>,
): Promise<void> {
    const db = openVectorDb(paths.vectors, { modelId: MODEL_ID, dimensions: DIMENSIONS });
    try {
        const embedder = fakeEmbedder();
        for (const entry of MESSAGES) {
            if (!ids.includes(entry.id)) continue;
            const raw = message(entry.id, entry.subject, entry.body);
            const [vector] = await embedder.embedDocuments([{ subject: entry.subject, body: entry.body }]);
            putVector(db, digest(raw), vector);
        }
        await body(db);
    } finally {
        db.close();
    }
}

/** The hashes of a list of hits, sorted — the order FTS5 gives them is not the order to assert. */
function hashesOf(hits: readonly { hash: string }[]): string[] {
    return hits.map((hit) => hit.hash).sort();
}

export default async () => {
    await describe('the hybrid search', async () => {
        await it('puts the message both halves found first', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'harbour',
                    });
                    // A is the message both halves found: the word is in its body, and its
                    // meaning is close to the query. The message only the meaning found must
                    // not push it off the top.
                    expect(hits[0].hash).toBe(hashes.a);
                    expect(hits[0].match).toBe('both');
                });
            });
        });

        await it('marks how every hit was found', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'harbour',
                    });
                    const kindOf = (id: string) => hits.find((hit) => hit.hash === hashes[id])?.match;
                    // The word in the body: both halves. The word in the subject: the text half
                    // only. The plural: the meaning only.
                    expect(kindOf('a')).toBe('both');
                    expect(kindOf('d')).toBe('semantic');
                    expect(kindOf('e')).toBe('text');
                });
            });
        });

        await it('finds a message the query’s words do not reach', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    // "tariff" is in no message as a word — F has only the plural — so the text
                    // search finds NOTHING here, and the hit comes from the meaning alone.
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'tariff',
                    });
                    expect(hits.length).toBe(1);
                    expect(hits[0].hash).toBe(hashes.f);
                    expect(hits[0].match).toBe('semantic');
                });
            });
        });

        await it('keeps a semantic hit the verdict filter excludes out', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'harbour',
                        options: { verdict: 'body-altered' },
                    });
                    // D is the semantic hit, and it is the only message with this verdict. The
                    // filters narrow the semantic half exactly as they narrow the text one.
                    expect(hits.length).toBe(1);
                    expect(hits[0].hash).toBe(hashes.d);
                    expect(hits[0].match).toBe('semantic');
                });
            });
        });

        await it('keeps a semantic hit the source filter excludes out', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const scope = hashScope(index, [hashes.a]);
                    try {
                        const hits = await hybridSearch({
                            index,
                            vectors,
                            embedder: fakeEmbedder(),
                            query: 'harbour',
                            options: { scope },
                        });
                        expect(hits.length).toBe(1);
                        expect(hits[0].hash).toBe(hashes.a);
                    } finally {
                        scope.close();
                    }
                });
            });
        });

        await it('falls back to the text search when the case has no vectors', async () => {
            await withFixture(async ({ index, hashes }) => {
                const hits = await hybridSearch({
                    index,
                    embedder: fakeEmbedder(),
                    query: 'harbour',
                });
                expect(hits.length).toBe(2);
                expect(hits.every((hit) => hit.match === 'text')).toBe(true);
                expect(hashesOf(hits)).toStrictEqual([hashes.a, hashes.e].sort());
            });
        });

        await it('falls back to the text search when there is no embedder', async () => {
            await withFixture(async ({ paths, index }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const hits = await hybridSearch({ index, vectors, query: 'harbour' });
                    expect(hits.length).toBe(2);
                    expect(hits.every((hit) => hit.match === 'text')).toBe(true);
                });
            });
        });

        await it('falls back to the text search when the vector table is empty', async () => {
            await withFixture(async ({ paths, index }) => {
                await withVectors(paths, [], async (vectors) => {
                    expect(countVectors(vectors)).toBe(0);
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'harbour',
                    });
                    expect(hits.length).toBe(2);
                    expect(hits.every((hit) => hit.match === 'text')).toBe(true);
                });
            });
        });

        await it('falls back to the text search when the embedder fails', async () => {
            await withFixture(async ({ paths, index }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const broken: Embedder = {
                        modelId: MODEL_ID,
                        dimensions: DIMENSIONS,
                        async embedQuery(): Promise<Float32Array> {
                            throw new Error('the model is not there');
                        },
                        async embedDocuments(): Promise<Float32Array[]> {
                            throw new Error('the model is not there');
                        },
                    };
                    // A model that fails must not take the search down with it.
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: broken,
                        query: 'harbour',
                    });
                    expect(hits.length).toBe(2);
                    expect(hits.every((hit) => hit.match === 'text')).toBe(true);
                });
            });
        });

        await it('drops a vector whose message the index does not hold', async () => {
            await withFixture(async ({ paths, index }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    // A vector for a message that is not in the case: the vector table and the
                    // index can disagree, and a hit without a row has nothing to show.
                    const embedder = fakeEmbedder();
                    const [vector] = await embedder.embedDocuments([{ body: 'harbour ghost' }]);
                    putVector(vectors, 'ghost-hash', vector);
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder,
                        query: 'harbour',
                    });
                    expect(hits.every((hit) => hit.hash !== 'ghost-hash')).toBe(true);
                });
            });
        });

        await it('agrees with the text search when both halves find the same message', async () => {
            await withFixture(async ({ paths, index, hashes }) => {
                await withVectors(paths, ['a', 'b', 'c', 'd', 'e', 'f'], async (vectors) => {
                    const hits = await hybridSearch({
                        index,
                        vectors,
                        embedder: fakeEmbedder(),
                        query: 'lighthouse',
                    });
                    expect(hits.length).toBe(1);
                    expect(hits[0].hash).toBe(hashes.c);
                    expect(hits[0].match).toBe('both');
                });
            });
        });
    });

    await describe('the marker of a semantic hit', async () => {
        await it('says nothing for a hit the text search found', async () => {
            expect(matchMarker('text')).toBe(undefined);
        });

        await it('names the meaning for a hit only the meaning found', async () => {
            expect(matchMarker('semantic')).toBe('  semantic match');
        });

        await it('names both halves for a hit both found', async () => {
            expect(matchMarker('both')).toBe('  text and semantic match');
        });
    });

    await describe('the search command', async () => {
        /** Run `stamped search` and capture what it printed. */
        async function runSearch(args: Record<string, unknown>): Promise<string[]> {
            const lines: string[] = [];
            const original = console.log;
            console.log = (...parts: unknown[]) => void lines.push(parts.join(' '));
            try {
                const command = searchCommand();
                await (command.handler as (a: unknown) => unknown)({
                    ...args,
                    _: [],
                    $0: 'stamped',
                });
            } finally {
                console.log = original;
            }
            return lines;
        }

        await it('prints the hits without a marker while the meaning is unavailable', async () => {
            await withFixture(async ({ paths }) => {
                const lines = await runSearch({ case: paths.root, first: 'harbour' });
                // No marker: the build has no model, so every hit is a text hit, and the output
                // is the one the command has always printed.
                expect(lines.some((line) => line.includes('semantic'))).toBe(false);
                expect(lines.some((line) => line.includes('Harbour contract'))).toBe(true);
                expect(lines[lines.length - 1]).toBe('2 matches.');
            });
        });

        await it('says how the case holds when nothing matches', async () => {
            await withFixture(async ({ paths }) => {
                const lines = await runSearch({ case: paths.root, first: 'nothingmatchesthis' });
                expect(lines[0]).toBe('No match.');
                expect(lines[1]).toBe('The case holds 6 messages.');
            });
        });

        await it('names how each hit was found in the JSON', async () => {
            await withFixture(async ({ paths }) => {
                const lines = await runSearch({ case: paths.root, first: 'harbour', json: true });
                const parsed = JSON.parse(lines.join('\n')) as {
                    query: string;
                    hits: { hash: string; match: string }[];
                };
                expect(parsed.query).toBe('harbour');
                expect(parsed.hits.length).toBe(2);
                expect(parsed.hits.every((hit) => hit.match === 'text')).toBe(true);
            });
        });
    });
};
