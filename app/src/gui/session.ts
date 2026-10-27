/**
 * The open case, and every operation the window performs on it.
 *
 * WHY THIS IS NOT IN `window.ts`. The window may touch the disk and the network in exactly the
 * ways this module names, and nowhere else — a widget callback that called `verifyMessage` or
 * `lookupDns` on its own would put a disclosure decision inside a `connect()`. Keeping them here
 * makes the list of things the GUI can do readable in one file, and the one thing it refuses to
 * do — go online without a {@link LookupConsent} — enforceable in one place.
 *
 * The other half of the split is that none of this knows a widget. Everything below takes data
 * and returns data, so a change to the flow can be reasoned about without a display.
 *
 * EVERY INDEX QUERY IS ASYNC, and that is the point rather than a detail. The main thread holds
 * no index connection at all: the questions go to a worker thread ({@link QueryClient}) that owns
 * the only one, because a SQLite query over a six-figure archive takes seconds and a second on
 * the GTK main thread is a window that has stopped repainting. The functions below are therefore
 * one-line awaits over a protocol, and the queries themselves live in `lib/queries.ts` — shared,
 * so the worker and a test run the same code.
 */

import {
    lookupArchive,
    lookupDns,
    type LookupResult,
    pairName,
    parseKeyMaterial,
    _,
    type KeyPair,
    type KeyVault,
    type LookupChannel,
    type LookupConsent,
    type MessageFinding,
} from '@stamped/core';
import { readableBody, type ReadableBody } from '@stamped/import';
import {
    beginImportStatus,
    cancelImportStatus,
    importSources,
    indexDocumentSource,
    isCase,
    openCase,
    openIndex,
    readImportStatus,
    readRaw,
    reverifyPairs,
    type CasePaths,
    type CaseReport,
    type ImportProgress,
    type ImportResult,
    type ImportStatus,
    type IndexDocumentSource,
    type IndexedMessage,
    type LogSource,
    type Person,
    type SearchHit,
    type Timeline,
    type ReverifyResult,
} from '@stamped/store';

import { checkVector, type Embedder } from '@stamped/semantic';

import { caseOrThrow } from '../lib/case.ts';
import type { HelperEmbedder } from '../lib/embed-client.ts';
import { asksForMeaning, candidateCount, type HybridHit } from '../lib/hybrid-search.ts';
import { resolveTxt } from '../lib/dns.ts';
import { PAGE_SIZE, type Query } from '../lib/queries.ts';
import { loadVault, saveVault } from '../lib/vault.ts';
import { workerChannel } from './query-channel.ts';
import { QueryClient } from './query-client.ts';

export { PAGE_SIZE, type Query, type ScopeRef } from '../lib/queries.ts';

/** An open case: its paths, the thread that reads its index, and the keys gathered for it so far. */
export interface CaseSession {
    readonly root: string;
    readonly paths: CasePaths;
    /**
     * The worker that owns the index connection — this thread has none.
     *
     * Not a `DatabaseSync` any more, and that is the whole change: a handle here is a query here,
     * and a query here is a frozen window. The scope caches went with the connection, because a
     * `HashScope` is a temp table on it.
     */
    readonly query: QueryClient;
    /** Mutable: `addKey` and `runLookup` grow it, and the reader re-verifies against it. */
    vault: KeyVault;
}

/**
 * Open a case folder that already is one.
 *
 * Refuses a path without a `case.json` — {@link caseOrThrow}'s asymmetry, carried into the
 * window: only an explicit "Create Case" reaches {@link createSession}. A file chooser makes a
 * mistyped path easier, not harder, so the guard matters more here than on the command line.
 */
export function openSession(root: string): CaseSession {
    const paths = caseOrThrow(root);
    return { root, paths, query: new QueryClient(paths, workerChannel), vault: loadVault(root) };
}

/** Create the case folder at `root` and open it. Only ever from an explicit confirmation. */
export function createSession(root: string): CaseSession {
    const paths = openCase(root);
    return { root, paths, query: new QueryClient(paths, workerChannel), vault: loadVault(root) };
}

/**
 * Let go of a case: end the reader thread before another one is opened.
 *
 * Opening a second case without this leaks the first SQLite connection — and the thread holding
 * it — for as long as the window lives, and a connection held on a case folder on removable or
 * encrypted storage is a folder that cannot be unmounted, which is how a journalist's working
 * copy of a leak is supposed to live.
 */
export function closeSession(session: CaseSession): void {
    session.query.close();
}

/**
 * Drop the cached filter tables — after the index changed underneath them.
 *
 * An import writes new rows, and a mailbox scope built before it does not contain the messages
 * that import just added: the list would go on showing the old selection and say nothing about
 * it. Both caches are temp tables on the WORKER's connection, so this is a request like any
 * other — and the repair it asks for is all the repair there is.
 */
export async function dropFilterCaches(session: CaseSession): Promise<void> {
    await session.query.ask('dropScopes', {});
}

/** Does this folder hold a case? The question the file chooser's result is put to first. */
export function isCaseFolder(root: string): boolean {
    return isCase(root);
}

/** The `<selector>._domainkey.<domain>` names the case already holds a key for. */
export function knownKeyNames(vault: KeyVault): Set<string> {
    return new Set(vault.all().map((entry) => pairName(entry)));
}

/**
 * One page of the message list.
 *
 * Search and browse are two different queries and stay two different functions in
 * `@stamped/store`; `lib/queries.ts` picks between them, on the worker's thread. Paged:
 * `offset` selects which page, and the default keeps the first one.
 */
export async function pageOf(session: CaseSession, query: Query, offset = 0): Promise<SearchHit[]> {
    return session.query.ask('page', { query, offset });
}

/** The helper's resident search, when this embedder is one that has it. */
function resident(embedder: Embedder): Pick<HelperEmbedder, 'search'> | undefined {
    const search = (embedder as Partial<HelperEmbedder>).search;
    return typeof search === 'function' ? { search: search.bind(embedder) } : undefined;
}

/**
 * The first page of a text query with the meaning's hits merged in, or `undefined` when there is
 * nothing to merge (no query, no vectors). The caller keeps the text page it already has.
 */
export async function hybridPageOf(
    session: CaseSession,
    query: Query,
    embedder: Embedder,
): Promise<HybridHit[] | undefined> {
    const text = query.text?.trim() ?? '';
    if (text === '' || !asksForMeaning(text)) return undefined;
    // The ONE step that stays here: the model runtime was loaded in this process and a worker
    // cannot borrow it. Everything the vector is then used for — the vector table, the FTS5
    // half, the rows behind both — happens over there.
    const found = await resident(embedder)?.search(text, candidateCount(PAGE_SIZE));
    if (found !== undefined)
        return (await session.query.ask('hybrid', { query, semantic: found })) ?? undefined;
    const vector = await embedder.embedQuery(text);
    checkVector(vector);
    const model = { modelId: embedder.modelId, dimensions: embedder.dimensions };
    const merged = await session.query.ask('hybrid', { query, vector: Array.from(vector), model });
    return merged ?? undefined;
}

/**
 * A second index connection, for the semantic indexer's walk over the case.
 *
 * NOT the worker's, and deliberately so. The indexer is not a question the window asks and waits
 * for: it walks every message in the case in background slices, a cursor page between two model
 * calls, for as long as the indexing runs. Those pages are small and seek directly (see
 * `indexDocumentSource`), but there are tens of thousands of them, and putting them through the
 * one channel the list also uses would queue every scroll behind the indexer. SQLite takes
 * concurrent readers and `openIndex` sets `busy_timeout`, so the two connections wait for each
 * other at most briefly and only around a write.
 *
 * The caller owns it and must {@link SemanticSource.close} it when the case closes — a second
 * handle on the case folder keeps it just as unmountable as the first.
 */
export interface SemanticSource {
    readonly source: IndexDocumentSource;
    close(): void;
}

export function openSemanticSource(session: CaseSession): SemanticSource {
    const db = openIndex(session.paths);
    return { source: indexDocumentSource(db, session.paths), close: () => db.close() };
}

/** How many messages a filter admits — the length of the list behind {@link pageOf}. */
export async function filteredCount(session: CaseSession, query: Query): Promise<number> {
    return session.query.ask('count', { query });
}

/** The people of the case, most mail first, narrowed by a name/address search. */
export async function peopleOf(session: CaseSession, search: string, limit = 100): Promise<Person[]> {
    return session.query.ask('people', { search, limit });
}

/** Mails per month (or day), plus the count without a date. */
export async function timelineOf(session: CaseSession): Promise<Timeline> {
    return session.query.ask('timeline', {});
}

/** Is the address table complete for this case? */
export async function peopleComplete(session: CaseSession): Promise<boolean> {
    return session.query.ask('peopleComplete', {});
}

/**
 * One short backfill batch for a case that predates the address table.
 *
 * A WRITE, and the one on this path — it runs in the worker like every read, because the
 * connection it writes through is the worker's and because a batch of a thousand messages is
 * exactly as long a stall as a query.
 */
export async function backfillStep(session: CaseSession): Promise<{ done: boolean; processed: number }> {
    return session.query.ask('backfillStep', {});
}

/** How many messages the case holds, whatever the filters — the denominator of every count. */
export async function totalMessages(session: CaseSession): Promise<number> {
    return session.query.ask('total', {});
}

/** The archives this case was imported from, read out of the import log. */
export async function sourcesOf(session: CaseSession): Promise<LogSource[]> {
    return session.query.ask('sources', {});
}

/** What the whole case adds up to. The same query `stamped report` prints. */
export async function reportOf(session: CaseSession): Promise<CaseReport> {
    return session.query.ask('report', {});
}

/**
 * The indexed row for one message — the header block, and nothing a verdict rests on.
 *
 * The worker answers `null` for a hash it does not know, because JSON has no `undefined`; the
 * callers here are GUI code and expect the absence they always had.
 */
export async function messageOf(session: CaseSession, hash: string): Promise<IndexedMessage | undefined> {
    return (await session.query.ask('message', { hash })) ?? undefined;
}

/**
 * Verify one stored message again, now, against the keys the case holds NOW.
 *
 * NOT `readMessage(...).verdict`. The index is a cache of a verification that ran at import
 * time, when the vault was whatever it then was — so a key collected since would change the
 * answer and the row would not know. The pane that shows the evidence chain is the pane that
 * must not be stale, so it re-reads the raw bytes and runs the verifier — on the query worker
 * (`verifyOf` in `lib/queries.ts`), which reads the case's saved key vault itself.
 */
export async function verifyStored(session: CaseSession, hash: string): Promise<MessageFinding | undefined> {
    return (await session.query.ask('verify', { hash })) ?? undefined;
}

/**
 * The stored bytes of one message, read once per click.
 *
 * The reader needs them three times — verification, the readable body, the header block — and
 * a message with an attachment can be tens of megabytes, so each caller used to pay a read and
 * a copy of its own on the main thread. Every consumer takes these bytes instead.
 */
export function storedRaw(session: CaseSession, hash: string): Uint8Array | undefined {
    return readRaw(session.paths, hash);
}

/**
 * The readable body and attachments of one stored message, decoded for display only.
 *
 * The raw text for the source expander is deliberately not here: only the header block is shown
 * (`headerBlockOf`), and the whole message is decoded when somebody presses copy, not on every
 * click. Lossy on purpose when it is — a mail body is octets, and nothing is verified from text.
 */
export function bodyOf(raw: Uint8Array): ReadableBody {
    return readableBody(raw);
}

/**
 * Import archives into the open case. The index handle is the importer's own; ours survives.
 *
 * Writes the status file like the CLI's import does, so a run the window started in-process is
 * visible to `stamped status` and to the window’s status button — the file is the one channel, not the
 * process that happens to write it.
 */
export async function importInto(
    session: CaseSession,
    sources: readonly string[],
    onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
    const status = beginImportStatus(session.paths, sources);
    try {
        const result = await importSources(session.paths, sources, {
            keys: session.vault.toKeyStore(),
            onProgress: (progress) => {
                status.update(progress);
                onProgress?.(progress);
            },
        });
        status.finish(result);
        return result;
    } catch (error) {
        status.fail();
        throw error;
    }
}

/**
 * The open case's import status, read from its file.
 *
 * The window polls this about once a second while a case is open: the status file is the ONLY
 * channel — an import started on a command line writes the same file, and the window shows it
 * just like one of its own.
 */
export function importStatusOf(session: CaseSession): ImportStatus | undefined {
    return readImportStatus(session.paths);
}

/**
 * Stop the running import by marking its status file cancelled.
 *
 * The window calls this after killing ITS OWN subprocess; the file is how every other reader
 * learns the run is over. A run the window did not start is never touched — killing somebody
 * else's terminal session from a window is not the window's to do.
 */
export function markImportCancelled(session: CaseSession): void {
    cancelImportStatus(session.paths);
}

/** What storing a key did, in the words the toast uses. */
export interface KeyOutcome {
    readonly name: string;
    /** The whole sentence, conflict included — the window displays it and decides nothing. */
    readonly message: string;
    /** The case already held a DIFFERENT key for this pair: a rotation, or a forgery. */
    readonly conflict: boolean;
}

/**
 * Store a key the person pasted.
 *
 * `parseKeyMaterial` takes all three forms an operator actually has — a PEM block, a TXT record
 * copied out of `dig`, a bare `p=` — so the dialog needs one text field and no format picker.
 * Origin `operator`: a key someone typed is one they vouch for, and that is the difference the
 * `archive-key` caveat reports.
 */
export function addKey(session: CaseSession, pair: KeyPair, text: string): KeyOutcome {
    const key = parseKeyMaterial(text);
    if (key.kind === 'revoked') {
        throw new Error(
            _('That record has an empty p=: the domain withdrew this key, so there is nothing to store.'),
        );
    }
    const outcome = session.vault.add({
        ...pair,
        key,
        origin: 'operator',
        fetchedAt: new Date().toISOString(),
    });
    saveVault(session.root, session.vault);
    return {
        name: pairName(pair),
        message: addedMessage(outcome.status),
        conflict: outcome.status === 'conflict',
    };
}

/**
 * The sentence for what `KeyVault.add` did.
 *
 * A conflict is NOT reported as a successful store, even though the key was stored. The case
 * already held a different key for the same selector, which is either a rotation the archive
 * predates or a key somebody substituted — and the second is the finding this whole tool is for.
 * The sentence therefore says what happened and leaves the question open, because nothing here
 * can tell the two apart; the verdicts computed from the new key carry the consequence.
 */
function addedMessage(status: 'added' | 'unchanged' | 'conflict'): string {
    switch (status) {
        case 'unchanged':
            return _('That key was already stored.');
        case 'conflict':
            return _(
                'Stored, but this case already held a DIFFERENT key for that selector. Either the domain rotated it, or one of the two is not theirs. Check both before you rely on the new verdicts.',
            );
        case 'added':
            return _('Key stored.');
    }
}

/**
 * Re-verify the messages a newly stored key bears on, so the whole window agrees about them.
 *
 * {@link verifyStored} already re-reads the raw bytes for the message in the reader, which is why
 * the pane the person is looking at is never stale. Everything ELSE is: the verdict counts in the
 * sidebar, the badge on every row of the list and the overview all come from the index, and the
 * index holds the verdict that import time produced — computed against a vault that did not have
 * this key yet. Without this the window would answer the same question two ways at once, and the
 * sidebar's "47 unverifiable" would survive the key that answered all 47.
 *
 * `reverifyPairs` is the same function `stamped reverify` runs, reading `raw/` rather than the
 * index's copy, so a verdict a key changes here is exactly the verdict a re-import would give. It
 * leaves a pair the vault holds two different keys for alone — choosing one would let an unproven
 * key upgrade a verdict — and reports those back in `skippedConflicts`.
 */
export async function applyKeys(
    session: CaseSession,
    pairs: readonly KeyPair[],
    yieldTurn?: () => Promise<void>,
    onProgress?: (checked: number, total: number) => void,
): Promise<ReverifyResult | undefined> {
    if (pairs.length === 0) return undefined;
    return reverifyPairs(session.paths, pairs, session.vault, yieldTurn, onProgress);
}

/** How far a lookup is: pairs asked, and what came back so far. */
export interface LookupProgress {
    readonly done: number;
    readonly total: number;
    readonly found: number;
    readonly notFound: number;
    /** Pairs the lookup could not answer for so far. */
    readonly errors: number;
}

/** Pairs per slice of a lookup — a few rounds of the core's own concurrency. */
const LOOKUP_SLICE = 16;

/** What one lookup run did, counted for the toast that follows it. */
export interface LookupOutcome {
    readonly stored: number;
    readonly missed: number;
    /** Pairs the lookup could not answer for: unknown, to be retried. */
    readonly errors: number;
    readonly conflicts: number;
    /** The pairs that gained a key — what {@link applyKeys} has to re-verify. */
    readonly pairs: readonly KeyPair[];
}

/**
 * Look keys up over one channel, for exactly the pairs the consent lists.
 *
 * The consent is built here from the same `pairs` that go to the lookup, so the list the dialog
 * showed and the list that is sent cannot drift apart. `consentCovers` then refuses any pair
 * outside it inside `@stamped/core` — belt and braces, because the cost of a wrong pair is a
 * name server learning which domain is being examined.
 */
export async function runLookup(
    session: CaseSession,
    channel: LookupChannel,
    pairs: readonly KeyPair[],
    onProgress?: (progress: LookupProgress) => void,
): Promise<LookupOutcome> {
    const consent: LookupConsent = { channel, pairs };
    // In slices, so the window can show how far a long list is: each slice is checked against the
    // same consent and runs at the lookup's own concurrency, the join between slices is the cost.
    const result: {
        found: LookupResult['found'][number][];
        misses: LookupResult['misses'][number][];
        errors: LookupResult['errors'][number][];
    } = { found: [], misses: [], errors: [] };
    onProgress?.({ done: 0, total: pairs.length, found: 0, notFound: 0, errors: 0 });
    for (let at = 0; at < pairs.length; at += LOOKUP_SLICE) {
        const slice = pairs.slice(at, at + LOOKUP_SLICE);
        const part =
            channel === 'dns'
                ? await lookupDns(consent, slice, resolveTxt)
                : await lookupArchive(consent, slice, (url) => fetch(url));
        result.found.push(...part.found);
        result.misses.push(...part.misses);
        result.errors.push(...part.errors);
        onProgress?.({
            done: Math.min(pairs.length, at + slice.length),
            total: pairs.length,
            found: result.found.length,
            notFound: result.misses.length,
            errors: result.errors.length,
        });
    }

    const now = new Date().toISOString();
    const gained: KeyPair[] = [];
    let stored = 0;
    let conflicts = 0;
    for (const found of result.found) {
        const outcome = session.vault.add({
            ...found.pair,
            key: found.key,
            origin: found.origin,
            fetchedAt: now,
            ...(found.seenFrom ? { seenFrom: found.seenFrom } : {}),
            ...(found.seenTo ? { seenTo: found.seenTo } : {}),
        });
        if (outcome.status !== 'unchanged') stored++;
        if (outcome.status === 'conflict') conflicts++;
        gained.push(found.pair);
    }
    saveVault(session.root, session.vault);
    return { stored, missed: result.misses.length, errors: result.errors.length, conflicts, pairs: gained };
}
