/**
 * Every question the case index can be asked, as data in and data out.
 *
 * WHY THIS IS NOT IN `gui/session.ts` ANY MORE. These queries are the slow part of the app — a
 * page of a 400,000-message mailbox, a timeline over a whole archive, the report — and a slow
 * query on the GTK main thread is a frozen window. So they moved into a module that knows
 * neither a widget nor a Worker: {@link runQuery} is the one dispatcher the worker entry calls,
 * and the SAME functions are what a test (or a command) calls directly with a context of its
 * own. One implementation per query, two callers.
 *
 * The contract with the worker boundary is that everything crossing it is JSON: GJS structured
 * clone is `JSON.parse(JSON.stringify(…))` in practice (no Date, no Map, no typed array, and a
 * BigInt kills the reply outright). Every type below is therefore plain strings, numbers,
 * booleans, arrays and objects — see `docs/spikes/query-worker.md` for the measurements.
 */

import type { UnverifiableReason, Verdict } from '@stamped/core';
import { openVectorDbForSearch } from '@stamped/semantic';
import {
    addressesComplete,
    backfillAddresses,
    browseMessages,
    caseReport,
    countMessages,
    hashScope,
    logSources,
    mailboxHashes,
    openIndex,
    peopleList,
    periodScope,
    personScope,
    readMessage,
    searchHits,
    signatureHashes,
    sourceHashes,
    timeline,
    verdictHashes,
    type BrowseOptions,
    type CasePaths,
    type CaseReport,
    type HashScope,
    type IndexedMessage,
    type LogSource,
    type Person,
    type SearchHit,
    type SearchOptions,
    type Timeline,
} from '@stamped/store';

import { fuseHybrid, type HybridHit } from './hybrid-search.ts';

/**
 * What a query runs against: the case on disk, one index connection, and the scope tables.
 *
 * The caches are part of the CONTEXT and not of a query, because a `HashScope` is a temp table on
 * one connection — it belongs to whoever holds that connection and dies with it. In the GUI that
 * owner is the query worker, so the caches live over there with the connection they are made of.
 */
export interface QueryContext {
    readonly paths: CasePaths;
    /** The `node:sqlite` handle `@stamped/store` hands out. Opaque here on purpose. */
    readonly db: ReturnType<typeof openIndex>;
    /** Cached source filter, rebuilt when the chosen archive changes. */
    sourceScope?: { source: string; scope: HashScope };
    /** Cached scope filter, rebuilt when the tapped overview number changes. Its key, not its ref. */
    scopeFilter?: { key: string; scope: HashScope };
}

/** How many rows one page of the message list holds. */
export const PAGE_SIZE = 200;

/** How a message list is asked for: a search term, a verdict, an archive, a scope, or nothing at all. */
export interface Query {
    readonly text?: string;
    readonly verdict?: BrowseOptions['verdict'];
    /** A `LogSource.source` — the path an import read the messages out of. */
    readonly source?: string;
    /**
     * A set of messages named by what is true of them — what tapping an overview number sets.
     *
     * The same "where from" axis as `source`, so the two never stand together: a mailbox, a
     * signer, a key and an archive all answer "which of these messages", and a list narrowed by
     * both would be a set nobody asked for.
     */
    readonly scope?: ScopeRef;
}

/**
 * A set of messages, named by what the index can enumerate about it.
 *
 * NOT by a hash list: a scope is rebuilt whenever the query runs (a page of a scrolled list, the
 * counter under it, a search), and the hashes behind it are only reachable through the log and
 * the signature rows — so the REFERENCE is what travels, and {@link scopeFor} turns it into a
 * temporary table once per filter. Being a reference is also what lets it cross to the worker:
 * a hash set of a big mailbox would be megabytes of JSON per page.
 */
export type ScopeRef =
    /** The messages a mailbox of a folder import contributed. */
    | { readonly kind: 'mailbox'; readonly mailbox: string }
    /** Several verdicts at once, for a row that counts two of them together. */
    | { readonly kind: 'verdicts'; readonly verdicts: readonly Verdict[] }
    /** Everything carrying a signature from this `d=`. */
    | { readonly kind: 'signer'; readonly domain: string }
    /** Everything carrying this `s=` — with `missingOnly` for the messages still waiting on it. */
    | {
          readonly kind: 'key';
          readonly domain: string;
          readonly selector: string;
          readonly missingOnly?: boolean;
      }
    /** The messages with no verdict because of this reason. */
    | { readonly kind: 'reason'; readonly reason: UnverifiableReason }
    /** Every message one address appears in, in any role. */
    | { readonly kind: 'person'; readonly address: string }
    /** The messages of one timeline bucket: `2024-03`, `2024-03-05` or `undated`. */
    | { readonly kind: 'period'; readonly period: string };

/**
 * The hashes one scope names, from wherever they live.
 *
 * Mailbox provenance is the import log's (see `mailboxHashes`); every other scope is a question
 * about signature rows. Both answers are RAW hash sets — the same thing the index is keyed by, so
 * a scope table can join it directly.
 */
function hashesFor(ctx: QueryContext, ref: ScopeRef): Set<string> {
    switch (ref.kind) {
        case 'person':
        case 'period':
            // built inside SQLite by scopeFor; never reaches here
            return new Set();
        case 'mailbox':
            return mailboxHashes(ctx.paths).get(ref.mailbox) ?? new Set();
        case 'verdicts':
            return verdictHashes(ctx.db, ref.verdicts);
        case 'signer':
            return signatureHashes(ctx.db, { domain: ref.domain });
        case 'key':
            return signatureHashes(ctx.db, {
                domain: ref.domain,
                selector: ref.selector,
                ...(ref.missingOnly === true ? { reason: 'no-key' } : {}),
            });
        case 'reason':
            return signatureHashes(ctx.db, {
                reason: ref.reason,
                messageVerdict: 'unverifiable',
            });
    }
}

/** One string per scope, so "is this still the filter from last page?" is a string comparison. */
function scopeKey(ref: ScopeRef): string {
    switch (ref.kind) {
        case 'mailbox':
            return `mailbox:${ref.mailbox}`;
        case 'verdicts':
            return `verdicts:${[...ref.verdicts].sort().join(',')}`;
        case 'signer':
            return `signer:${ref.domain.toLowerCase()}`;
        case 'key':
            return `key:${ref.domain.toLowerCase()}:${ref.selector.toLowerCase()}:${ref.missingOnly === true ? 'missing' : 'any'}`;
        case 'reason':
            return `reason:${ref.reason}`;
        case 'person':
            return `person:${ref.address.toLowerCase()}`;
        case 'period':
            return `period:${ref.period}`;
    }
}

/**
 * The hashes one scope names, as a table the index can join.
 *
 * Built once per chosen scope and kept on the context, exactly like {@link sourceScopeFor} and
 * for the same reason: the mailbox scope of a 400,000-message mailbox is 400,000 inserts, and
 * re-inserting them on every scrolled page would turn a scroll into an import.
 */
function scopeFor(ctx: QueryContext, ref: ScopeRef): HashScope {
    const key = scopeKey(ref);
    if (ctx.scopeFilter?.key === key) return ctx.scopeFilter.scope;
    ctx.scopeFilter?.scope.close();
    const scope =
        ref.kind === 'person'
            ? personScope(ctx.db, ref.address)
            : ref.kind === 'period'
              ? periodScope(ctx.db, ref.period)
              : hashScope(ctx.db, hashesFor(ctx, ref));
    ctx.scopeFilter = { key, scope };
    return scope;
}

/** The filter a query asks with: a scope when it has one, an archive when it has that. */
function scopeOf(ctx: QueryContext, query: Query): HashScope | undefined {
    if (query.scope !== undefined) return scopeFor(ctx, query.scope);
    if (query.source !== undefined) return sourceScopeFor(ctx, query.source);
    return undefined;
}

/**
 * The hashes one archive contributed, as a scope the index can join.
 *
 * Built once per chosen archive and kept on the context: rebuilding it on every page would
 * re-insert a hundred thousand rows each time the person scrolled. The scope outlives a single
 * query by design — see `HashScope`.
 */
function sourceScopeFor(ctx: QueryContext, source: string): HashScope {
    if (ctx.sourceScope?.source === source) return ctx.sourceScope.scope;
    ctx.sourceScope?.scope.close();
    const scope = hashScope(ctx.db, sourceHashes(ctx.paths, source));
    ctx.sourceScope = { source, scope };
    return scope;
}

/**
 * One page of the message list.
 *
 * Search and browse are two different queries and stay two different functions in
 * `@stamped/store`; this picks between them. With a search term the order is FTS5 relevance,
 * without one it is newest first — and the verdict filter is applied in TypeScript for a search,
 * because narrowing the ranked hits is not the same query as ranking the narrowed set, and the
 * second would silently return other messages than the first.
 *
 * Paged: `offset` selects which page. The default keeps the first page, so callers that never
 * ask for more keep working.
 */
export function pageOf(ctx: QueryContext, query: Query, offset = 0): SearchHit[] {
    const scope = scopeOf(ctx, query);
    const text = query.text?.trim() ?? '';
    if (text === '') {
        return browseMessages(ctx.db, {
            ...(query.verdict ? { verdict: query.verdict } : {}),
            ...(scope ? { scope } : {}),
            limit: PAGE_SIZE,
            offset,
        });
    }
    const searchOptions: SearchOptions = {
        ...(query.verdict ? { verdict: query.verdict } : {}),
        ...(scope ? { scope } : {}),
        limit: PAGE_SIZE,
    };
    return searchHits(ctx.db, text, searchOptions).slice(offset, offset + PAGE_SIZE);
}

/** The model a query vector came from — the vector table only answers for its own. */
export interface QueryModel {
    readonly modelId: string;
    readonly dimensions: number;
}

/**
 * The first page of a text query, with the meaning's hits fused in.
 *
 * The VECTOR arrives, not the embedder: the model lives in the process that loaded it, and this
 * runs on the worker. It comes as a plain number array because the boundary is JSON and a
 * `Float32Array` does not survive it (see the module note) — so the array is turned back into
 * one here, where the vector table expects it.
 *
 * `null` means there was nothing to fuse: no query, no vector table, or a case whose vectors
 * were written by another model. The caller keeps the text page it already has.
 */
export function hybridPageOf(
    ctx: QueryContext,
    query: Query,
    vector: readonly number[],
    model: QueryModel,
): HybridHit[] | null {
    const text = query.text?.trim() ?? '';
    if (text === '') return null;
    const vectors = openVectorDbForSearch(ctx.paths.vectors, model);
    if (vectors === undefined) return null;
    try {
        const scope = scopeOf(ctx, query);
        return fuseHybrid({
            index: ctx.db,
            vectors,
            vector: Float32Array.from(vector),
            query: text,
            options: {
                ...(query.verdict ? { verdict: query.verdict } : {}),
                ...(scope ? { scope } : {}),
                limit: PAGE_SIZE,
            },
        });
    } finally {
        vectors.close();
    }
}

/** How many messages a filter admits — the length of the list behind {@link pageOf}. */
export function filteredCount(ctx: QueryContext, query: Query): number {
    const scope = scopeOf(ctx, query);
    const text = query.text?.trim() ?? '';
    if (text === '') {
        return countMessages(ctx.db, {
            ...(query.verdict ? { verdict: query.verdict } : {}),
            ...(scope ? { scope } : {}),
        });
    }
    const searchOptions: SearchOptions = {
        ...(query.verdict ? { verdict: query.verdict } : {}),
        ...(scope ? { scope } : {}),
        limit: 5000,
    };
    return searchHits(ctx.db, text, searchOptions).length;
}

/** The people of the case, most mail first, narrowed by a name/address search. */
export function peopleOf(ctx: QueryContext, search: string, limit = 100): Person[] {
    return peopleList(ctx.db, { search, limit });
}

/** Mails per month (or day), plus the count without a date. */
export function timelineOf(ctx: QueryContext): Timeline {
    return timeline(ctx.db);
}

/** Is the address table complete for this case? */
export function peopleComplete(ctx: QueryContext): boolean {
    return addressesComplete(ctx.db);
}

/** One short backfill batch for a case that predates the address table. */
export function backfillStep(ctx: QueryContext): { done: boolean; processed: number } {
    return backfillAddresses(ctx.db, 1000);
}

/** How many messages the case holds, whatever the filters — the denominator of every count. */
export function totalMessages(ctx: QueryContext): number {
    return countMessages(ctx.db);
}

/** The archives this case was imported from, read out of the import log. */
export function sourcesOf(ctx: QueryContext): LogSource[] {
    return logSources(ctx.paths);
}

/** What the whole case adds up to. The same query `stamped report` prints. */
export function reportOf(ctx: QueryContext): CaseReport {
    return caseReport(ctx.db, { paths: ctx.paths, keyLimit: 10_000 });
}

/**
 * The indexed row for one message — the header block, and nothing a verdict rests on.
 *
 * `null` rather than `undefined` for "no such message": the answer travels as JSON, which has no
 * `undefined`, and a key that silently disappears from the reply would read as a protocol error.
 */
export function messageOf(ctx: QueryContext, hash: string): IndexedMessage | null {
    return readMessage(ctx.db, hash) ?? null;
}

/**
 * Drop the cached filter tables — after the index changed underneath them.
 *
 * An import writes new rows, and a mailbox scope built before it does not contain the messages
 * that import just added: the list would go on showing the old selection and say nothing about
 * it. Both caches are temp tables on OUR connection, so dropping them here is all the repair
 * there is.
 */
export function dropScopes(ctx: QueryContext): void {
    ctx.sourceScope?.scope.close();
    ctx.sourceScope = undefined;
    ctx.scopeFilter?.scope.close();
    ctx.scopeFilter = undefined;
}

/** The parameters each operation takes. One object per op, so the wire format is `{op, params}`. */
export interface QueryRequests {
    readonly page: { readonly query: Query; readonly offset?: number };
    readonly hybrid: {
        readonly query: Query;
        /** The embedded query, as plain numbers — a typed array does not cross. */
        readonly vector: readonly number[];
        readonly model: QueryModel;
    };
    readonly count: { readonly query: Query };
    readonly people: { readonly search: string; readonly limit?: number };
    readonly timeline: Record<string, never>;
    readonly peopleComplete: Record<string, never>;
    readonly backfillStep: Record<string, never>;
    readonly total: Record<string, never>;
    readonly sources: Record<string, never>;
    readonly report: Record<string, never>;
    readonly message: { readonly hash: string };
    readonly dropScopes: Record<string, never>;
}

/** What each operation answers with. `null` where there is nothing to say — never `undefined`. */
export interface QueryResults {
    readonly page: SearchHit[];
    readonly hybrid: HybridHit[] | null;
    readonly count: number;
    readonly people: Person[];
    readonly timeline: Timeline;
    readonly peopleComplete: boolean;
    readonly backfillStep: { done: boolean; processed: number };
    readonly total: number;
    readonly sources: LogSource[];
    readonly report: CaseReport;
    readonly message: IndexedMessage | null;
    readonly dropScopes: null;
}

/** The name of one operation — what travels in the `op` field. */
export type QueryOp = keyof QueryRequests;

/** Is this string one of the operations? The worker's guard against a message it cannot serve. */
export function isQueryOp(op: string): op is QueryOp {
    return op in handlers;
}

const handlers: {
    [Op in QueryOp]: (ctx: QueryContext, params: QueryRequests[Op]) => QueryResults[Op];
} = {
    page: (ctx, params) => pageOf(ctx, params.query, params.offset ?? 0),
    hybrid: (ctx, params) => hybridPageOf(ctx, params.query, params.vector, params.model),
    count: (ctx, params) => filteredCount(ctx, params.query),
    people: (ctx, params) => peopleOf(ctx, params.search, params.limit ?? 100),
    timeline: (ctx) => timelineOf(ctx),
    peopleComplete: (ctx) => peopleComplete(ctx),
    backfillStep: (ctx) => backfillStep(ctx),
    total: (ctx) => totalMessages(ctx),
    sources: (ctx) => sourcesOf(ctx),
    report: (ctx) => reportOf(ctx),
    message: (ctx, params) => messageOf(ctx, params.hash),
    dropScopes: (ctx) => {
        dropScopes(ctx);
        return null;
    },
};

/**
 * Run one operation against one context. The whole surface the worker exposes.
 *
 * A dispatcher rather than twelve exported endpoints, because the worker receives an `op` as a
 * STRING and has to turn it into a call: with a table that is one lookup and a guard
 * ({@link isQueryOp}), and the compiler still checks every pairing of parameters and result.
 * Tests call this directly with a context of their own — no Worker, no bundle, same code path.
 */
export function runQuery<Op extends QueryOp>(
    ctx: QueryContext,
    op: Op,
    params: QueryRequests[Op],
): QueryResults[Op] {
    // The cast is the one place the generic has to be flattened: indexing the handler table with
    // a type variable gives TypeScript a union of signatures it will not call.
    const handler = handlers[op] as (ctx: QueryContext, params: QueryRequests[Op]) => QueryResults[Op];
    return handler(ctx, params);
}
