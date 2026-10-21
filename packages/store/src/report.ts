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

import { CAVEATS, VERDICTS, type Caveat, type Verdict } from '@stamped/core';

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

/** The whole report for a case. */
export interface CaseReport {
    readonly messages: number;
    readonly bytes: number;
    readonly verdicts: readonly VerdictCount[];
    readonly caveats: readonly CaveatCount[];
    readonly keys: readonly KeyDemand[];
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

/** Everything the `report` command prints, as data. */
export function caseReport(db: DatabaseSync, keyLimit = 50): CaseReport {
    const totals = db
        .prepare(
            'SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes, min(sent_at) AS earliest, max(sent_at) AS latest FROM messages',
        )
        .get() as Record<string, unknown> | undefined;

    return {
        messages: Number(totals?.n ?? 0),
        bytes: Number(totals?.bytes ?? 0),
        verdicts: verdictCounts(db),
        caveats: caveatCounts(db),
        keys: keyDemand(db, keyLimit),
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
