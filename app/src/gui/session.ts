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
} from '@stamped/core';
import {
    caseReport,
    importSources,
    isCase,
    listMessages,
    logSources,
    messageCount,
    openCase,
    openIndex,
    readMessage,
    readRaw,
    searchMessages,
    sourceHashes,
    type CasePaths,
    type CaseReport,
    type ImportProgress,
    type ImportResult,
    type IndexedMessage,
    type ListOptions,
    type LogSource,
    type SearchHit,
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
    session.db.close();
}

/** Does this folder hold a case? The question the file chooser's result is put to first. */
export function isCaseFolder(root: string): boolean {
    return isCase(root);
}

/** The `<selector>._domainkey.<domain>` names the case already holds a key for. */
export function knownKeyNames(vault: KeyVault): Set<string> {
    return new Set(vault.all().map((entry) => pairName(entry)));
}

/** How a message list is asked for: a search term, a verdict, an archive, or nothing at all. */
export interface Query {
    readonly text?: string;
    readonly verdict?: ListOptions['verdict'];
    /** A `LogSource.source` — the path an import read the messages out of. */
    readonly source?: string;
}

/**
 * One page of the message list.
 *
 * Search and browse are two different queries and stay two different functions in
 * `@stamped/store`; this picks between them. With a search term the order is FTS5 relevance,
 * without one it is newest first — and the verdict filter is applied in TypeScript for a search,
 * because narrowing the ranked hits is not the same query as ranking the narrowed set, and the
 * second would silently return other messages than the first.
 */
export function pageOf(session: CaseSession, query: Query): SearchHit[] {
    const hashes = query.source ? sourceHashes(session.paths, query.source) : undefined;
    const text = query.text?.trim() ?? '';
    if (text === '') {
        return listMessages(session.db, {
            ...(query.verdict ? { verdict: query.verdict } : {}),
            ...(hashes ? { hashes } : {}),
            limit: PAGE_SIZE,
        });
    }
    return searchMessages(session.db, text, PAGE_SIZE).filter(
        (hit) =>
            (query.verdict === undefined || hit.verdict === query.verdict) &&
            (hashes === undefined || hashes.has(hit.hash)),
    );
}

/** How many messages the case holds, whatever the filters — the denominator of every count. */
export function totalMessages(session: CaseSession): number {
    return messageCount(session.db);
}

/** The archives this case was imported from, read out of the import log. */
export function sourcesOf(session: CaseSession): LogSource[] {
    return logSources(session.paths);
}

/** What the whole case adds up to. The same query `stamped report` prints. */
export function reportOf(session: CaseSession): CaseReport {
    return caseReport(session.db);
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

/** Import archives into the open case. The index handle is the importer's own; ours survives. */
export async function importInto(
    session: CaseSession,
    sources: readonly string[],
    onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
    return importSources(session.paths, sources, {
        keys: session.vault.toKeyStore(),
        ...(onProgress ? { onProgress } : {}),
    });
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
            return _('Key stored. Reopen a message to see its new verdict.');
    }
}

/** What one lookup run did, counted for the toast that follows it. */
export interface LookupOutcome {
    readonly stored: number;
    readonly missed: number;
    readonly conflicts: number;
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
    }
    saveVault(session.root, session.vault);
    return { stored, missed: result.misses.length, conflicts };
}
