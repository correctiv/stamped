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
 */

import {
    classifyMessage,
    lookupArchive,
    lookupDns,
    pairName,
    parseKeyMaterial,
    _,
    type KeyPair,
    type KeyVault,
    type LookupChannel,
    type LookupConsent,
    type MessageFinding,
    type UnverifiableReason,
    type Verdict,
} from '@stamped/core';
import {
    beginImportStatus,
    browseMessages,
    cancelImportStatus,
    caseReport,
    countMessages,
    addressesComplete,
    backfillAddresses,
    hashScope,
    peopleList,
    timeline,
    periodScope,
    personScope,
    importSources,
    isCase,
    logSources,
    mailboxHashes,
    openCase,
    openIndex,
    readImportStatus,
    readMessage,
    readRaw,
    reverifyPairs,
    searchHits,
    signatureHashes,
    sourceHashes,
    verdictHashes,
    type BrowseOptions,
    type CasePaths,
    type CaseReport,
    type HashScope,
    type ImportProgress,
    type ImportResult,
    type ImportStatus,
    type IndexedMessage,
    type LogSource,
    type Person,
    type Timeline,
    type ReverifyResult,
    type SearchHit,
    type SearchOptions,
} from '@stamped/store';
import { verifyMessage } from '@stamped/verify';

import { caseOrThrow } from '../lib/case.ts';
import { resolveTxt } from '../lib/dns.ts';
import { loadVault, saveVault } from '../lib/vault.ts';

/** An open case: its paths, its index handle, and the keys gathered for it so far. */
export interface CaseSession {
    readonly root: string;
    readonly paths: CasePaths;
    /** The `node:sqlite` handle `@stamped/store` hands out. Opaque here on purpose. */
    readonly db: ReturnType<typeof openIndex>;
    /** Mutable: `addKey` and `runLookup` grow it, and the reader re-verifies against it. */
    vault: KeyVault;
    /** Cached source filter, rebuilt when the chosen archive changes. */
    sourceScope?: { source: string; scope: HashScope };
    /** Cached scope filter, rebuilt when the tapped overview number changes. Its key, not its ref. */
    scopeFilter?: { key: string; scope: HashScope };
}

/** How many rows one page of the message list holds. */
export const PAGE_SIZE = 200;

/**
 * Open a case folder that already is one.
 *
 * Refuses a path without a `case.json` — {@link caseOrThrow}'s asymmetry, carried into the
 * window: only an explicit "Create Case" reaches {@link createSession}. A file chooser makes a
 * mistyped path easier, not harder, so the guard matters more here than on the command line.
 */
export function openSession(root: string): CaseSession {
    const paths = caseOrThrow(root);
    return { root, paths, db: openIndex(paths), vault: loadVault(root) };
}

/** Create the case folder at `root` and open it. Only ever from an explicit confirmation. */
export function createSession(root: string): CaseSession {
    const paths = openCase(root);
    return { root, paths, db: openIndex(paths), vault: loadVault(root) };
}

/**
 * Let go of a case: close the index handle before another one is opened.
 *
 * Opening a second case without this leaks the first SQLite connection for as long as the window
 * lives, and a connection held on a case folder on removable or encrypted storage is a folder
 * that cannot be unmounted — which is how a journalist's working copy of a leak is supposed to
 * live.
 */
export function closeSession(session: CaseSession): void {
    dropFilterCaches(session);
    session.db.close();
}

/**
 * Drop the cached filter tables — after the index changed underneath them.
 *
 * An import writes new rows, and a mailbox scope built before it does not contain the messages
 * that import just added: the list would go on showing the old selection and say nothing about
 * it. Both caches are temp tables on OUR connection, so dropping them here is all the repair
 * there is.
 */
export function dropFilterCaches(session: CaseSession): void {
    session.sourceScope?.scope.close();
    session.sourceScope = undefined;
    session.scopeFilter?.scope.close();
    session.scopeFilter = undefined;
}

/** Does this folder hold a case? The question the file chooser's result is put to first. */
export function isCaseFolder(root: string): boolean {
    return isCase(root);
}

/** The `<selector>._domainkey.<domain>` names the case already holds a key for. */
export function knownKeyNames(vault: KeyVault): Set<string> {
    return new Set(vault.all().map((entry) => pairName(entry)));
}

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
 * temporary table once per filter.
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
 * Mailbox provenance is the import log's (see {@link mailboxHashes}); every other scope is a
 * question about signature rows. Both answers are RAW hash sets — the same thing the index is
 * keyed by, so a scope table can join it directly.
 */
function hashesFor(session: CaseSession, ref: ScopeRef): Set<string> {
    switch (ref.kind) {
        case 'person':
        case 'period':
            // built inside SQLite by scopeFor; never reaches here
            return new Set();
        case 'mailbox':
            return mailboxHashes(session.paths).get(ref.mailbox) ?? new Set();
        case 'verdicts':
            return verdictHashes(session.db, ref.verdicts);
        case 'signer':
            return signatureHashes(session.db, { domain: ref.domain });
        case 'key':
            return signatureHashes(session.db, {
                domain: ref.domain,
                selector: ref.selector,
                ...(ref.missingOnly === true ? { reason: 'no-key' } : {}),
            });
        case 'reason':
            return signatureHashes(session.db, {
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
 * Built once per chosen scope and kept on the session, exactly like {@link sourceScopeFor} and
 * for the same reason: the mailbox scope of a 400,000-message mailbox is 400,000 inserts, and
 * re-inserting them on every scrolled page would turn a scroll into an import.
 */
function scopeFor(session: CaseSession, ref: ScopeRef): HashScope {
    const key = scopeKey(ref);
    if (session.scopeFilter?.key === key) return session.scopeFilter.scope;
    session.scopeFilter?.scope.close();
    const scope =
        ref.kind === 'person'
            ? personScope(session.db, ref.address)
            : ref.kind === 'period'
              ? periodScope(session.db, ref.period)
              : hashScope(session.db, hashesFor(session, ref));
    session.scopeFilter = { key, scope };
    return scope;
}

/** The filter a query asks with: a scope when it has one, an archive when it has that. */
function scopeOf(session: CaseSession, query: Query): HashScope | undefined {
    if (query.scope !== undefined) return scopeFor(session, query.scope);
    if (query.source !== undefined) return sourceScopeFor(session, query.source);
    return undefined;
}

/**
 * The hashes one archive contributed, as a scope the index can join.
 *
 * Built once per chosen archive and kept on the session: rebuilding it on every page would
 * re-insert a hundred thousand rows each time the person scrolled. The scope outlives a single
 * query by design — see {@link HashScope}.
 */
function sourceScopeFor(session: CaseSession, source: string): HashScope {
    if (session.sourceScope?.source === source) return session.sourceScope.scope;
    session.sourceScope?.scope.close();
    const scope = hashScope(session.db, sourceHashes(session.paths, source));
    session.sourceScope = { source, scope };
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
export function pageOf(session: CaseSession, query: Query, offset = 0): SearchHit[] {
    const scope = scopeOf(session, query);
    const text = query.text?.trim() ?? '';
    if (text === '') {
        return browseMessages(session.db, {
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
    return searchHits(session.db, text, searchOptions).slice(offset, offset + PAGE_SIZE);
}

/** How many messages a filter admits — the length of the list behind {@link pageOf}. */
export function filteredCount(session: CaseSession, query: Query): number {
    const scope = scopeOf(session, query);
    const text = query.text?.trim() ?? '';
    if (text === '') {
        return countMessages(session.db, {
            ...(query.verdict ? { verdict: query.verdict } : {}),
            ...(scope ? { scope } : {}),
        });
    }
    const searchOptions: SearchOptions = {
        ...(query.verdict ? { verdict: query.verdict } : {}),
        ...(scope ? { scope } : {}),
        limit: 5000,
    };
    return searchHits(session.db, text, searchOptions).length;
}

/** The people of the case, most mail first, narrowed by a name/address search. */
export function peopleOf(session: CaseSession, search: string, limit = 100): Person[] {
    return peopleList(session.db, { search, limit });
}

/** Mails per month (or day), plus the count without a date. */
export function timelineOf(session: CaseSession): Timeline {
    return timeline(session.db);
}

/** Is the address table complete for this case? */
export function peopleComplete(session: CaseSession): boolean {
    return addressesComplete(session.db);
}

/** One short backfill batch for a case that predates the address table; `true` when finished. */
export function backfillStep(session: CaseSession): boolean {
    return backfillAddresses(session.db, 1000).done;
}

/** How many messages the case holds, whatever the filters — the denominator of every count. */
export function totalMessages(session: CaseSession): number {
    return countMessages(session.db);
}

/** The archives this case was imported from, read out of the import log. */
export function sourcesOf(session: CaseSession): LogSource[] {
    return logSources(session.paths);
}

/** What the whole case adds up to. The same query `stamped report` prints. */
export function reportOf(session: CaseSession): CaseReport {
    return caseReport(session.db, { paths: session.paths });
}

/** The indexed row for one message — the header block, and nothing a verdict rests on. */
export function messageOf(session: CaseSession, hash: string): IndexedMessage | undefined {
    return readMessage(session.db, hash);
}

/**
 * Verify one stored message again, now, against the keys the case holds NOW.
 *
 * NOT `readMessage(...).verdict`. The index is a cache of a verification that ran at import
 * time, when the vault was whatever it then was — so a key collected since would change the
 * answer and the row would not know. The pane that shows the evidence chain is the pane that
 * must not be stale, so it re-reads the raw bytes and runs the verifier.
 */
export async function verifyStored(session: CaseSession, hash: string): Promise<MessageFinding | undefined> {
    const raw = readRaw(session.paths, hash);
    if (!raw) return undefined;
    return classifyMessage(await verifyMessage(raw, { keys: session.vault.toKeyStore() }));
}

/**
 * The raw message as text, for the source expander.
 *
 * Lossy on purpose: a mail body is octets and may be any encoding or none, so decoding it for
 * DISPLAY is allowed to produce replacement characters. Nothing is ever verified from this
 * string — {@link verifyStored} reads the bytes — which is what makes the lossiness harmless
 * here and would make it a defect anywhere else.
 */
export function rawTextOf(session: CaseSession, hash: string): string | undefined {
    const raw = readRaw(session.paths, hash);
    return raw ? new TextDecoder('utf-8').decode(raw) : undefined;
}

/**
 * Import archives into the open case. The index handle is the importer's own; ours survives.
 *
 * Writes the status file like the CLI's import does, so a run the window started in-process is
 * visible to `stamped status` and to this same banner — the file is the one channel, not the
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
                'Stored — but this case already held a DIFFERENT key for that selector. Either the domain rotated it, or one of the two is not theirs. Check both before you rely on the new verdicts.',
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
): Promise<ReverifyResult | undefined> {
    if (pairs.length === 0) return undefined;
    return reverifyPairs(session.paths, pairs, session.vault);
}

/** What one lookup run did, counted for the toast that follows it. */
export interface LookupOutcome {
    readonly stored: number;
    readonly missed: number;
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
): Promise<LookupOutcome> {
    const consent: LookupConsent = { channel, pairs };
    const result =
        channel === 'dns'
            ? await lookupDns(consent, pairs, resolveTxt)
            : await lookupArchive(consent, pairs, (url) => fetch(url));

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
    return { stored, missed: result.misses.length, conflicts, pairs: gained };
}
