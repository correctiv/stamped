/**
 * Hybrid search: the text search and the vector search, fused into one list.
 *
 * WHY THE COMPOSITION LIVES HERE AND NOT IN A PACKAGE: `@stamped/store` knows the case and
 * `@stamped/semantic` knows the vectors, and neither may know the other — the store must stay
 * free of a model runtime, and the semantic package must stay free of the case. The app is the
 * layer that holds both, the same way `document-source.ts` holds the store's side of the
 * indexer.
 *
 * THE FUSION IS BY RANK, not by score: FTS5 gives a relevance rank, the vector search gives a
 * cosine similarity, and the two numbers are not comparable (see `@stamped/semantic`'s `rrf.ts`).
 * RRF looks at the ranks only, so a half-indexed case fuses as well as a complete one.
 *
 * THE TEXT SEARCH NEVER GOES AWAY. A case without vectors, a build without an embedder, a
 * vector table that is still empty, a query the embedder cannot handle — every one of them
 * leaves the plain FTS5 answer standing, without an error. A search that cannot be semantic
 * must still be a search: "no result" reads as "the mail is not in the leak", and that answer
 * must never come from a feature that was switched off.
 *
 * A TEXT QUERY THAT FINDS NOTHING IS NOT THE END, either: the mail that answers the question
 * may not share a word with it, which is the whole reason the second half exists. So the two
 * halves are asked independently and fused afterwards.
 */

import type { DatabaseSync } from 'node:sqlite';

import { checkVector, countVectors, fuseRrf, searchVectors } from '@stamped/semantic';
import type { Embedder } from '@stamped/semantic';
import { hitsForHashes, searchHits } from '@stamped/store';
import type { SearchHit, SearchOptions } from '@stamped/store';

/** How a hit was found: by a word, by the meaning, or by both. */
export type MatchKind = 'text' | 'semantic' | 'both';

/** A hit, with the way it was found. */
export interface HybridHit extends SearchHit {
    readonly match: MatchKind;
}

/** What a hybrid search is asked. */
export interface HybridSearchRequest {
    /** The case index: the FTS5 half, and the rows behind every hit. */
    readonly index: DatabaseSync;
    /** The vector database, when the case has one. */
    readonly vectors?: DatabaseSync;
    /** The embedder, when this build has one. */
    readonly embedder?: Embedder;
    /** The query, as the person wrote it. */
    readonly query: string;
    /** The same narrowing a text search takes: verdict, source, and how many hits. */
    readonly options?: SearchOptions;
}

/**
 * The same request with the query already embedded — what the worker gets.
 *
 * THE EMBEDDING IS THE ONE PART THAT CANNOT CROSS: a model runtime is loaded once, in the
 * process that owns it, and that is the main thread. Everything else here is SQLite, which is
 * exactly what must not run there. So the split goes through the vector: the main thread
 * embeds, the worker searches, and {@link fuseHybrid} is the half that needs no `await`.
 */
export interface HybridFuseRequest extends Omit<HybridSearchRequest, 'embedder'> {
    /** The embedded query, when the main thread could produce one. */
    readonly vector?: Float32Array;
    /**
     * Hits somebody else already found in the vectors (the query helper's resident copy). When
     * given, `vectors` and `vector` are not used: the same filter, rank and score rules apply.
     */
    readonly semantic?: readonly { readonly hash: string; readonly score: number }[];
}

/**
 * How many candidates each half offers per wanted hit.
 *
 * OVER-FETCHING, because the filters come after the ranking: the semantic half asks for the
 * hundred closest messages and then throws away the ones the verdict or the source filter
 * excludes. Without the surplus the page would be short — and a short page of results reads as
 * "there is nothing more", which is the one answer this tool must never give by accident.
 */
const CANDIDATE_FACTOR = 5;

/** …but never fewer than this, so a small page still has something to fuse. */
const MIN_CANDIDATES = 50;

/** The most candidates either half may offer. The same ceiling a text search has. */
const MAX_CANDIDATES = 5000;

/**
 * Search the case for the query, by text and by meaning at once.
 *
 * Returns the hits in one order, each marked with the way it was found. The list is at most
 * `options.limit` long — a search that returns more than a page of hits is not a search result
 * but an export.
 */
export async function hybridSearch(request: HybridSearchRequest): Promise<HybridHit[]> {
    return fuseHybrid({ ...request, ...(await embedFor(request)) });
}

/**
 * The embedded query, or nothing at all when this search stays a text search.
 *
 * Every failure is swallowed here for the reason the module note gives, and the
 * {@link asksForMeaning} check comes BEFORE the model rather than after it: a person who typed
 * an address gets no vector, so the model is not asked to embed one.
 */
async function embedFor(request: HybridSearchRequest): Promise<{ vector?: Float32Array }> {
    const { embedder } = request;
    if (!embedder || !request.vectors || !asksForMeaning(request.query)) return {};
    try {
        // THE QUERY GOES IN RAW. `Embedder.embedQuery` applies the model's own prompt format
        // — the llama backend wraps it in `task: search result | query: …` — so wrapping it
        // here as well would hand the model a prompt inside a prompt. The seam owns the
        // format; the search owns the words.
        const vector = await embedder.embedQuery(request.query);
        checkVector(vector);
        return { vector };
    } catch {
        return {};
    }
}

/**
 * The search itself: both halves against SQLite, fused by rank. Synchronous on purpose.
 *
 * This is what runs on the query worker. Nothing in it awaits, because nothing in it may — the
 * worker thread answers one request at a time, and a query that yields in the middle would let
 * the next one open a cursor on the same connection.
 */
export function fuseHybrid(request: HybridFuseRequest): HybridHit[] {
    const options = request.options ?? {};
    const limit = clampLimit(options.limit ?? 20);
    const candidates = candidateCount(limit);

    // The text half. Its error is the one error a search can have: the query is not FTS5.
    let textHits: SearchHit[] = [];
    let textError: unknown;
    try {
        textHits = searchHits(request.index, request.query, { ...options, limit: candidates });
    } catch (error) {
        textError = error;
    }

    // The semantic half. It never fails the search — see the module note.
    const semanticHits = semanticHitsFor(request, candidates);

    if (textHits.length === 0 && semanticHits.length === 0) {
        // Nothing to show and something to complain about: the query is the problem.
        if (textError !== undefined) throw textError;
        return [];
    }

    const textHashes = textHits.map((hit) => hit.hash);
    const semanticHashes = semanticHits.map((hit) => hit.hash);
    const byHash = new Map<string, SearchHit>();
    for (const hit of [...textHits, ...semanticHits]) byHash.set(hit.hash, hit);

    const foundByText = new Set(textHashes);
    const foundByMeaning = new Set(semanticHashes);

    const hits: HybridHit[] = [];
    for (const hash of fuseRrf([textHashes, semanticHashes])) {
        const hit = byHash.get(hash);
        if (!hit) continue;
        hits.push({ ...hit, match: matchKind(hash, foundByText, foundByMeaning) });
        if (hits.length >= limit) break;
    }
    return hits;
}

/**
 * The hits the vector search finds, as rows of the index.
 *
 * EVERY FAILURE HERE IS SWALLOWED: no vector (see {@link embedFor}), an empty vector table, a
 * vector database that will not open. The text half's answer stands, and a search that cannot
 * be semantic must still be a search.
 */
function semanticHitsFor(request: HybridFuseRequest, candidates: number): SearchHit[] {
    const { vectors, vector } = request;
    if (!request.semantic && (!vectors || !vector)) return [];
    try {
        let found: readonly { hash: string; score: number }[];
        if (request.semantic) {
            found = request.semantic;
        } else {
            // An empty table is not an error: the case is simply not indexed yet.
            if (countVectors(vectors!) === 0) return [];
            found = searchVectors(vectors!, vector!, candidates);
        }
        // A vector that points in another direction is not a match. The score is not comparable
        // across models, but its SIGN is: a cosine of zero or less means the query and the
        // message share nothing, and offering that as a "semantic match" would put an unrelated
        // mail into the result list.
        const hashes = found.filter((hit) => hit.score > 0).map((hit) => hit.hash);
        if (hashes.length === 0) return [];
        // The same filters as the text half, so a semantic hit can never show a message the
        // person filtered away.
        return hitsForHashes(request.index, hashes, { ...request.options, limit: candidates });
    } catch {
        return [];
    }
}

/**
 * Does the query ask for a meaning, or for an exact string?
 *
 * THE VECTOR SEARCH ALWAYS ANSWERS: it returns the nearest messages whether or not any of them
 * is near. For a question in words that is the point. For an address, a domain, a message id,
 * a quoted phrase or an FTS5 expression it is noise — the person asked for exactly this string,
 * and RRF would slot the closest unrelated mail in at rank two. So those stay text searches.
 */
export function asksForMeaning(query: string): boolean {
    const trimmed = query.trim();
    if (trimmed === '') return false;
    // An address, a message id, a quoted phrase, a prefix search, a column filter.
    if (/[@"*:<>]/.test(trimmed)) return false;
    // FTS5's own operators: whoever writes them is writing a query, not a question.
    if (/(^|\s)(AND|OR|NOT|NEAR)(\s|\(|$)/.test(trimmed)) return false;
    // A lone domain or file name: `firma.de`, `vertrag.pdf`.
    if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(trimmed)) return false;
    return true;
}

/** How a hash was found. */
function matchKind(
    hash: string,
    textHashes: ReadonlySet<string>,
    semanticHashes: ReadonlySet<string>,
): MatchKind {
    const inText = textHashes.has(hash);
    const inSemantic = semanticHashes.has(hash);
    if (inText && inSemantic) return 'both';
    return inText ? 'text' : 'semantic';
}

/** How many hits a search may return. At least one, at most five thousand. */
function clampLimit(limit: number): number {
    return Math.max(1, Math.min(5000, Math.trunc(limit) || 1));
}

/** The candidates each half offers for a page of `limit` hits. */
export function candidateCount(limit: number): number {
    return Math.max(MIN_CANDIDATES, Math.min(MAX_CANDIDATES, limit * CANDIDATE_FACTOR));
}
