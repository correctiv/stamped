/**
 * What a case folder adds up to: how many messages of each verdict, and which keys would move
 * the most of them.
 *
 * WHY THIS LIVES IN A PACKAGE AND NOT IN THE CLI. The `(domain, selector)` table is not a
 * display: it is the WORK LIST for the next stage. A case imported offline is mostly
 * `unverifiable`, because an archive arrives without the DNS records that would check it, and the
 * question "which key, fetched once, turns the most of these into a verdict" is the question that
 * decides where an hour of key collection goes. Stage 2 reads {@link keyDemand} to drive that
 * collection; `stamped report` prints the same numbers. One function, so the printed table and
 * the collected keys can never disagree.
 *
 * Everything here is a query over the index — a cache — and the index is built from the raw
 * store, so a report is never more than a restatement of what `raw/` already holds.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
    CAVEATS,
    UNVERIFIABLE_REASONS,
    VERDICTS,
    type Caveat,
    type UnverifiableReason,
    type Verdict,
} from '@stamped/core';

import type { CasePaths } from './case.ts';
import { hashScope } from './index-db.ts';
import { mailboxHashes } from './raw.ts';

/** How many messages reached each verdict. Every verdict appears, including the zeroes. */
export interface VerdictCount {
    readonly verdict: Verdict;
    readonly messages: number;
}

/**
 * One `(domain, selector)` pair and how much of the case depends on it.
 *
 * `messages` is what the pair is sorted by — the size of the prize. `unverifiable` is how much of
 * that prize is still unclaimed, which is the number that actually ranks the work: a pair with
 * 4,000 messages that are all confirmed already needs no key at all.
 */
export interface KeyDemand {
    /** `d=` — the signing domain. */
    readonly domain: string;
    /** `s=` — which of that domain's keys. */
    readonly selector: string;
    /** Messages carrying a signature from this pair. */
    readonly messages: number;
    /** Of those, how many have no verdict yet for want of this key. */
    readonly unverifiable: number;
    /** Of those, how many are already confirmed, with or without caveats — i.e. the key is in the store. */
    readonly confirmed: number;
    /** Of the confirmed, how many carry caveats. */
    readonly withCaveats: number;
}

/** How many messages carry one caveat. A message with two caveats counts once under each. */
export interface CaveatCount {
    readonly caveat: Caveat;
    readonly messages: number;
}

/** How much of the SIGNED mail is confirmed. Unsigned mail is not in the denominator. */
export interface ConfirmationShare {
    /** Messages with at least one DKIM signature. */
    readonly signed: number;
    /** Confirmed without caveats. */
    readonly clean: number;
    /** Confirmed, but with caveats. */
    readonly withCaveats: number;
}

/** A key that is missing, and how many messages it would give a verdict. */
export interface MissingSelector {
    readonly domain: string;
    readonly selector: string;
    readonly messages: number;
}

/** Why a message has no verdict, and how many messages are without one for that reason. */
export interface UnverifiableReasonCount {
    readonly reason: UnverifiableReason;
    readonly messages: number;
}

/**
 * One mailbox of a folder import, and what its mail added to the case.
 *
 * PROVENANCE, so it needs the import log: the index never records a mailbox (see `index-db.ts`),
 * and a report asked for without the case folder therefore has no per-mailbox breakdown at all
 * rather than an empty one — an empty list would read as "these mailboxes held nothing".
 */
export interface MailboxReport {
    /** The folder's name, exactly as the import log recorded it. */
    readonly mailbox: string;
    /** Indexed messages out of it. A message found in two mailboxes counts under both. */
    readonly messages: number;
    /** How that mail landed: all six verdicts, zeroes included — the same rule as the case. */
    readonly verdicts: readonly VerdictCount[];
}

/** A signing domain, by how many distinct messages carry a signature from it. */
export interface SigningDomain {
    /** `d=` — the signing domain, as the signatures spell it. */
    readonly domain: string;
    readonly messages: number;
}

/** The two tampering verdicts. Deliberately not a `Verdict` alias: these two are never merged. */
export type AlteredVerdict = 'body-altered' | 'headers-altered';

/** One `(domain, selector)` pair behind an alteration count, by distinct messages. */
export interface AlterationReason {
    readonly domain: string;
    readonly selector: string;
    readonly messages: number;
}

/**
 * One kind of alteration, summed — with the keys that produced it.
 *
 * `messages` counts the MESSAGE's verdict, like every other count in a report. `reasons` counts
 * the SIGNATURES that carried that verdict on those messages, so a forwarder's intact signature
 * is never listed as the reason a body was altered.
 *
 * `possiblyWrongKey` is the number that keeps a sum from being read as an accusation: a
 * `headers-altered` message whose key was first seen AFTER the message was sent is what a key
 * rotation looks like, and calling that tampering would spike the finding this tool exists to
 * prevent. It is a caveat count, so it can only ever be a subset of `messages`.
 */
export interface AlterationCount {
    readonly verdict: AlteredVerdict;
    readonly messages: number;
    /** Of those, how many are equally explained by a key that postdates the message. */
    readonly possiblyWrongKey: number;
    readonly reasons: readonly AlterationReason[];
}

/** The whole report for a case. */
export interface CaseReport {
    readonly messages: number;
    readonly bytes: number;
    readonly verdicts: readonly VerdictCount[];
    readonly caveats: readonly CaveatCount[];
    readonly keys: readonly KeyDemand[];
    /**
     * Verdict counts at the first indexing, i.e. before any key was fetched. Absent when the
     * index predates the history column (legacy rows have none), so "before" is never invented.
     */
    readonly before?: readonly VerdictCount[];
    readonly confirmation: ConfirmationShare;
    /** The selectors that would clear the most mail, most first. */
    readonly missing: readonly MissingSelector[];
    /** Why messages here have no verdict, by how many messages each reason leaves without one. */
    readonly reasons: readonly UnverifiableReasonCount[];
    /**
     * The mailboxes a folder import read from, most mail first. Absent when the import log has no
     * mailbox field — a plain import's provenance is its source file, which has its own section.
     */
    readonly mailboxes?: readonly MailboxReport[];
    /** The signing domains, most mail first — the coarse view under the `(domain, selector)` table. */
    readonly domains: readonly SigningDomain[];
    /** The two alterations, each with the keys behind it. Both present, zeroes included. */
    readonly alterations: readonly AlterationCount[];
    /** The earliest and latest `Date` that could be read, as epoch milliseconds. */
    readonly earliest?: number;
    readonly latest?: number;
}

/**
 * Count messages per verdict, in the order {@link VERDICTS} declares.
 *
 * A verdict with no messages is reported as zero rather than omitted. The six verdicts are the
 * vocabulary, and a report that printed only four of them would read as if the other two had not
 * been looked for — which is exactly the wrong impression when the missing one is `body-altered`.
 */
export function verdictCounts(db: DatabaseSync): VerdictCount[] {
    const rows = db.prepare('SELECT verdict, count(*) AS n FROM messages GROUP BY verdict').all() as {
        verdict?: string;
        n?: number;
    }[];
    const counted = new Map<string, number>();
    for (const row of rows) counted.set(String(row.verdict ?? ''), Number(row.n ?? 0));
    return VERDICTS.map((verdict) => ({ verdict, messages: counted.get(verdict) ?? 0 }));
}

/**
 * Count messages per caveat, in the order {@link CAVEATS} declares, zeroes included.
 *
 * A caveat limits what a confirmation proves, so a case with 3,000 `archive-key` messages needs
 * that said next to the verdicts rather than discovered one message at a time.
 */
export function caveatCounts(db: DatabaseSync): CaveatCount[] {
    const rows = db
        .prepare(
            'SELECT j.value AS caveat, count(*) AS n FROM messages, json_each(messages.caveats) AS j GROUP BY j.value',
        )
        .all() as { caveat?: string; n?: number }[];
    const counted = new Map<string, number>();
    for (const row of rows) counted.set(String(row.caveat ?? ''), Number(row.n ?? 0));
    return CAVEATS.map((caveat) => ({ caveat, messages: counted.get(caveat) ?? 0 }));
}

/**
 * The `(domain, selector)` pairs in the case, most mail first.
 *
 * Counted over DISTINCT messages, not over signature rows: a message signed twice by the same
 * pair — a list that re-signs, a resend — would otherwise count twice and push a pair up the work
 * list on the strength of duplicate signatures rather than of mail.
 *
 * The per-verdict columns come from the MESSAGE's verdict, not the signature's. The message
 * verdict is what the journalist sees in a search result, so it is also what "how many of these
 * are still unanswered" has to mean.
 */
export function keyDemand(db: DatabaseSync, limit = 50): KeyDemand[] {
    const capped = Math.max(1, Math.min(10_000, Math.trunc(limit) || 1));
    const rows = db
        .prepare(
            `SELECT s.domain AS domain,
                    s.selector AS selector,
                    count(DISTINCT s.hash) AS messages,
                    count(DISTINCT CASE WHEN m.verdict = 'unverifiable' THEN s.hash END) AS unverifiable,
                    count(DISTINCT CASE WHEN m.verdict IN ('confirmed', 'confirmed-with-caveats') THEN s.hash END) AS confirmed,
                    count(DISTINCT CASE WHEN m.verdict = 'confirmed-with-caveats' THEN s.hash END) AS with_caveats
             FROM signatures s
             JOIN messages m ON m.hash = s.hash
             GROUP BY s.domain, s.selector
             ORDER BY messages DESC, s.domain ASC, s.selector ASC
             LIMIT ${capped}`,
        )
        .all() as Record<string, unknown>[];

    return rows.map((row) => ({
        domain: String(row.domain ?? ''),
        selector: String(row.selector ?? ''),
        messages: Number(row.messages ?? 0),
        unverifiable: Number(row.unverifiable ?? 0),
        confirmed: Number(row.confirmed ?? 0),
        withCaveats: Number(row.with_caveats ?? 0),
    }));
}

/** Counts per verdict at first indexing, or undefined when any row has no history. */
export function firstVerdictCounts(db: DatabaseSync): VerdictCount[] | undefined {
    const rows = db
        .prepare('SELECT first_verdict AS verdict, count(*) AS n FROM messages GROUP BY first_verdict')
        .all() as {
        verdict?: string | null;
        n?: number;
    }[];
    if (rows.length === 0 || rows.some((row) => row.verdict === null || row.verdict === undefined)) {
        return undefined;
    }
    const counted = new Map<string, number>();
    for (const row of rows) counted.set(String(row.verdict), Number(row.n ?? 0));
    return VERDICTS.map((verdict) => ({ verdict, messages: counted.get(verdict) ?? 0 }));
}

/** Signed messages, and how many of them are confirmed with and without caveats. */
export function confirmationShare(counts: readonly VerdictCount[]): ConfirmationShare {
    const of = (verdict: Verdict) => counts.find((count) => count.verdict === verdict)?.messages ?? 0;
    const clean = of('confirmed');
    const withCaveats = of('confirmed-with-caveats');
    const signed = counts.reduce(
        (sum, count) => (count.verdict === 'unsigned' ? sum : sum + count.messages),
        0,
    );
    return { signed, clean, withCaveats };
}

/** The `no-key` selectors by the number of distinct messages they leave unverifiable. */
export function missingSelectors(db: DatabaseSync, limit = 5): MissingSelector[] {
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
    const rows = db
        .prepare(
            `SELECT lower(domain) AS domain, lower(selector) AS selector, count(DISTINCT hash) AS messages
             FROM signatures WHERE reason = 'no-key'
             GROUP BY lower(domain), lower(selector)
             ORDER BY messages DESC, domain ASC, selector ASC
             LIMIT ${capped}`,
        )
        .all() as Record<string, unknown>[];
    return rows.map((row) => ({
        domain: String(row.domain ?? ''),
        selector: String(row.selector ?? ''),
        messages: Number(row.messages ?? 0),
    }));
}

/**
 * The reasons this case has no verdict, by how many messages each one leaves without one.
 *
 * ONLY over messages whose own verdict is `unverifiable`: a message that is confirmed although a
 * second signature could not be checked has a verdict, and it does not belong to this question. A
 * message whose signatures failed for two different reasons counts under each — the rule
 * {@link caveatCounts} follows too, because both reasons are true of the message.
 *
 * A reason the running code does not know (an index written by another version) is dropped rather
 * than passed on: the frontends render an identifier as a sentence, so an unknown one would show
 * as `unsupported`-shaped gibberish where an explanation belongs.
 */
export function unverifiableReasonCounts(db: DatabaseSync): UnverifiableReasonCount[] {
    const rows = db
        .prepare(
            `SELECT s.reason AS reason, count(DISTINCT s.hash) AS n
             FROM signatures s JOIN messages m ON m.hash = s.hash
             WHERE m.verdict = 'unverifiable' AND s.reason != ''
             GROUP BY s.reason ORDER BY n DESC, s.reason ASC`,
        )
        .all() as { reason?: string; n?: number }[];
    const known = new Set<string>(UNVERIFIABLE_REASONS);
    const counts: UnverifiableReasonCount[] = [];
    for (const row of rows) {
        if (typeof row.reason !== 'string' || !known.has(row.reason)) continue;
        // Narrowed by the set above, which holds exactly the members of the union.
        counts.push({ reason: row.reason as UnverifiableReason, messages: Number(row.n ?? 0) });
    }
    return counts;
}

/**
 * The signing domains in the case, most mail first.
 *
 * Counted over DISTINCT messages, like {@link keyDemand}: a domain that signed the same message
 * twice is one message, and a mailing list that re-signs every resend must not climb this list
 * for it. No join to `messages` — a signature row exists only for an indexed message.
 */
export function signingDomains(db: DatabaseSync, limit = 10): SigningDomain[] {
    const capped = Math.max(1, Math.min(10_000, Math.trunc(limit) || 1));
    const rows = db
        .prepare(
            `SELECT s.domain AS domain, count(DISTINCT s.hash) AS messages
             FROM signatures s
             GROUP BY s.domain
             ORDER BY messages DESC, s.domain ASC
             LIMIT ${capped}`,
        )
        .all() as Record<string, unknown>[];
    return rows.map((row) => ({
        domain: String(row.domain ?? ''),
        messages: Number(row.messages ?? 0),
    }));
}

/**
 * The mailboxes of a folder import, most mail first — or `undefined` when there are none to name.
 *
 * The log's hashes are intersected with the index through a temporary scope, so a message whose
 * raw bytes are in the case but that was never indexed is not counted: every number in a report
 * is a number about the index, and a per-mailbox breakdown that counted differently would be the
 * one figure a reader could not check against the verdict totals beside it.
 *
 * `undefined` rather than an empty list when the log names no mailbox at all: "no mailbox field"
 * and "mailboxes that held nothing" are different facts, and only the first one is true of a
 * plain import.
 */
export function mailboxReports(db: DatabaseSync, paths: CasePaths): MailboxReport[] | undefined {
    const grouped = [...mailboxHashes(paths)].filter(([mailbox]) => mailbox !== '');
    if (grouped.length === 0) return undefined;

    const reports: MailboxReport[] = [];
    for (const [mailbox, hashes] of grouped) {
        const scope = hashScope(db, hashes);
        try {
            const rows = db
                .prepare(
                    `SELECT m.verdict AS verdict, count(*) AS n FROM messages m
                     JOIN ${scope.table} ON ${scope.table}.hash = m.hash
                     GROUP BY m.verdict`,
                )
                .all() as { verdict?: string; n?: number }[];
            const counted = new Map<string, number>();
            let messages = 0;
            for (const row of rows) {
                const n = Number(row.n ?? 0);
                counted.set(String(row.verdict ?? ''), n);
                messages += n;
            }
            // Nothing indexed: the mailbox is in the log but not in the report's subject, and a
            // zero row next to rows of thousands reads as an empty mailbox rather than as this.
            if (messages === 0) continue;
            reports.push({
                mailbox,
                messages,
                verdicts: VERDICTS.map((verdict) => ({
                    verdict,
                    messages: counted.get(verdict) ?? 0,
                })),
            });
        } finally {
            scope.close();
        }
    }
    return reports.sort((a, b) => b.messages - a.messages || a.mailbox.localeCompare(b.mailbox));
}

/** The two alterations, in the order {@link VERDICTS} declares them, zeroes included. */
const ALTERED: readonly AlteredVerdict[] = ['body-altered', 'headers-altered'];

/**
 * How many messages each kind of alteration reached, and which keys stand behind them.
 *
 * Both kinds are always reported, so a case with no tampering says `0 body-altered` in the data
 * the same way the verdict table does — the zero is the finding.
 *
 * `reasons` is limited to signatures that carried the SAME verdict as the message: a message
 * whose author signature broke while a mailing list's still verifies is `body-altered` because
 * of the author's key, and listing the list's key under it would point the reader at the wrong
 * signer. Sorted by messages, then domain and selector, so the same index gives the same table.
 */
export function alterationCounts(db: DatabaseSync): AlterationCount[] {
    return ALTERED.map((verdict) => {
        const messages = countMessagesOf(db, verdict);
        return {
            verdict,
            messages,
            possiblyWrongKey: newerKeyMessages(db, verdict),
            reasons: alterationReasons(db, verdict),
        };
    });
}

/** Messages under this verdict — one `count(*)`, so the sums beside it agree with the verdict table. */
function countMessagesOf(db: DatabaseSync, verdict: Verdict): number {
    const row = db.prepare('SELECT count(*) AS n FROM messages WHERE verdict = ?').get(verdict) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0);
}

/**
 * Messages under this verdict whose `key-newer-than-message` caveat says a key first seen after
 * the message explains the failure just as well as a header change would.
 */
function newerKeyMessages(db: DatabaseSync, verdict: Verdict): number {
    const row = db
        .prepare(
            `SELECT count(*) AS n FROM messages, json_each(messages.caveats) AS j
             WHERE messages.verdict = ? AND j.value = 'key-newer-than-message'`,
        )
        .get(verdict) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
}

/** The signatures behind one alteration kind, by distinct messages, most first. */
function alterationReasons(db: DatabaseSync, verdict: AlteredVerdict): AlterationReason[] {
    const rows = db
        .prepare(
            `SELECT s.domain AS domain, s.selector AS selector, count(DISTINCT s.hash) AS messages
             FROM signatures s JOIN messages m ON m.hash = s.hash
             WHERE m.verdict = ? AND s.verdict = ?
             GROUP BY s.domain, s.selector
             ORDER BY messages DESC, s.domain ASC, s.selector ASC`,
        )
        .all(verdict, verdict) as Record<string, unknown>[];
    return rows.map((row) => ({
        domain: String(row.domain ?? ''),
        selector: String(row.selector ?? ''),
        messages: Number(row.messages ?? 0),
    }));
}

/** What a case report is asked for, beyond the index it is a report OF. */
export interface CaseReportOptions {
    /** How many `(domain, selector)` pairs to list. */
    readonly keyLimit?: number;
    /**
     * The case folder, for what the index cannot answer: mailbox provenance lives only in the
     * import log. Without it `mailboxes` is absent rather than empty (see {@link MailboxReport}).
     */
    readonly paths?: CasePaths;
}

/** Everything the `report` command prints, as data. */
export function caseReport(db: DatabaseSync, options: CaseReportOptions = {}): CaseReport {
    const { keyLimit = 50, paths } = options;
    const totals = db
        .prepare(
            'SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes, min(sent_at) AS earliest, max(sent_at) AS latest FROM messages',
        )
        .get() as Record<string, unknown> | undefined;

    const verdicts = verdictCounts(db);
    const before = firstVerdictCounts(db);
    const mailboxes = paths === undefined ? undefined : mailboxReports(db, paths);
    return {
        messages: Number(totals?.n ?? 0),
        bytes: Number(totals?.bytes ?? 0),
        verdicts,
        caveats: caveatCounts(db),
        keys: keyDemand(db, keyLimit),
        ...(before ? { before } : {}),
        confirmation: confirmationShare(verdicts),
        missing: missingSelectors(db),
        reasons: unverifiableReasonCounts(db),
        ...(mailboxes ? { mailboxes } : {}),
        domains: signingDomains(db),
        alterations: alterationCounts(db),
        earliest: optionalNumber(totals?.earliest),
        latest: optionalNumber(totals?.latest),
    };
}

/** A SQL aggregate over no rows, or over rows that all had NULL, is NULL — not zero. */
function optionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    const number = Number(value);
    return Number.isNaN(number) ? undefined : number;
}
