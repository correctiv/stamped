/**
 * Who wrote to whom, and when: the people list and the timeline, as queries over the index.
 *
 * ONE ADDRESS IS ONE PERSON. Addresses are lower-cased by the parser and never merged here; the
 * display names seen for an address are listed beside it, because two spellings of a name are a
 * fact about the archive, and "these two addresses are the same human" is a judgement only the
 * journalist can make.
 *
 * Both queries are correct on a case whose `addresses` table is not yet filled, only
 * incomplete — {@link addressesComplete} tells the caller whether to say so.
 */

import type { DatabaseSync } from 'node:sqlite';

import { VERDICTS, type Verdict } from '@stamped/core';

import { type HashScope, queryScope } from './index-db.ts';

/** One name an address was seen under, with how many messages used it. */
export interface PersonName {
    readonly name: string;
    readonly messages: number;
}

/** One address: how much it sent and received, over which period, with which verdicts. */
export interface Person {
    readonly address: string;
    /** Distinct messages the address appears in, in any role. */
    readonly messages: number;
    readonly sent: number;
    readonly received: number;
    /** Earliest and latest `sent_at` among its messages; absent when none is dated. */
    readonly earliest?: number;
    readonly latest?: number;
    /** Every verdict, zeroes included, in the order of {@link VERDICTS}. */
    readonly verdicts: readonly { readonly verdict: Verdict; readonly messages: number }[];
    /** The display names seen, most used first. */
    readonly names: readonly PersonName[];
}

export interface PeopleOptions {
    /** Matches the address or any display name, case-insensitively, as a substring. */
    readonly search?: string;
    readonly limit?: number;
    readonly offset?: number;
}

/** Escape `%`, `_` and the escape character (`!`) for a `LIKE ... ESCAPE '!'`. */
function likePattern(text: string): string {
    return `%${text.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
}

/**
 * The addresses of the case, most mail first.
 *
 * Three small queries rather than one wide one: the ranking runs on `addresses` alone (an index
 * walk plus one grouping), and only the page that is shown is joined to `messages` for the
 * period and the verdicts — a million-message case is never joined end to end for a page of 50.
 */
export function peopleList(db: DatabaseSync, options: PeopleOptions = {}): Person[] {
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100) || 1));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0) || 0);
    const search = options.search?.trim() ?? '';
    const where = search === '' ? '' : "WHERE address LIKE ? ESCAPE '!' OR lower(name) LIKE ? ESCAPE '!'";
    const params = search === '' ? [] : [likePattern(search), likePattern(search)];

    const ranked = db
        .prepare(
            `SELECT address, count(*) AS n, sum(sent) AS sent, sum(received) AS received
             FROM addresses ${where}
             GROUP BY address
             ORDER BY n DESC, address ASC
             LIMIT ${limit} OFFSET ${offset}`,
        )
        .all(...params) as { address: string; n: number; sent: number; received: number }[];
    if (ranked.length === 0) return [];

    const marks = ranked.map(() => '?').join(', ');
    const addresses = ranked.map((row) => row.address);

    const spans = new Map<string, { earliest?: number; latest?: number; verdicts: Map<string, number> }>();
    for (const row of ranked) spans.set(row.address, { verdicts: new Map() });
    const detail = db
        .prepare(
            `SELECT a.address AS address, m.verdict AS verdict, count(*) AS n,
                    min(m.sent_at) AS earliest, max(m.sent_at) AS latest
             FROM addresses a JOIN messages m ON m.hash = a.hash
             WHERE a.address IN (${marks})
             GROUP BY a.address, m.verdict`,
        )
        .all(...addresses) as {
        address: string;
        verdict: string;
        n: number;
        earliest: number | null;
        latest: number | null;
    }[];
    for (const row of detail) {
        const span = spans.get(row.address);
        if (!span) continue;
        span.verdicts.set(row.verdict, Number(row.n));
        if (row.earliest !== null) span.earliest = Math.min(span.earliest ?? row.earliest, row.earliest);
        if (row.latest !== null) span.latest = Math.max(span.latest ?? row.latest, row.latest);
    }

    const names = new Map<string, PersonName[]>();
    const nameRows = db
        .prepare(
            `SELECT address, name, count(*) AS n FROM addresses
             WHERE address IN (${marks}) AND name <> ''
             GROUP BY address, name ORDER BY n DESC, name ASC`,
        )
        .all(...addresses) as { address: string; name: string; n: number }[];
    for (const row of nameRows) {
        const list = names.get(row.address) ?? [];
        list.push({ name: row.name, messages: Number(row.n) });
        names.set(row.address, list);
    }

    return ranked.map((row) => {
        const span = spans.get(row.address);
        return {
            address: row.address,
            messages: Number(row.n),
            sent: Number(row.sent),
            received: Number(row.received),
            ...(span?.earliest !== undefined ? { earliest: span.earliest } : {}),
            ...(span?.latest !== undefined ? { latest: span.latest } : {}),
            verdicts: VERDICTS.map((verdict) => ({ verdict, messages: span?.verdicts.get(verdict) ?? 0 })),
            names: names.get(row.address) ?? [],
        };
    });
}

/** The messages an address appears in, as a scope filled inside SQLite. */
export function personScope(db: DatabaseSync, address: string): HashScope {
    return queryScope(db, 'SELECT hash FROM addresses WHERE address = ?', [address.trim().toLowerCase()]);
}

/** A bucket granularity: a month (`2024-03`) or a day (`2024-03-05`). */
export type TimelineUnit = 'month' | 'day';

/** One bucket of the timeline. */
export interface TimelineBucket {
    /** `YYYY-MM` or `YYYY-MM-DD`, from `sent_at` in UTC. */
    readonly key: string;
    readonly messages: number;
    readonly verdicts: readonly { readonly verdict: Verdict; readonly messages: number }[];
}

export interface Timeline {
    readonly unit: TimelineUnit;
    /** Dated buckets, oldest first; empty buckets inside the span are not filled in. */
    readonly buckets: readonly TimelineBucket[];
    /** Messages whose `Date` could not be read — counted apart, never put at 1970. */
    readonly undated: number;
}

/** A span of this many days or fewer is bucketed per day. */
export const DAY_UNIT_MAX_DAYS = 62;

/**
 * Mails per month — per day when the whole case spans {@link DAY_UNIT_MAX_DAYS} days or fewer.
 *
 * Bucketed by the UTC calendar of `sent_at`: an instant has no day without a time zone, and the
 * list shows the day as the header wrote it. A mail written late on the 31st in Berlin can
 * therefore sit in next month's bar; the bar says what the instant is, the row says what the
 * header says. `unit` forces a granularity.
 */
export function timeline(db: DatabaseSync, unit?: TimelineUnit): Timeline {
    const span = db
        .prepare('SELECT min(sent_at) AS lo, max(sent_at) AS hi FROM messages WHERE sent_at IS NOT NULL')
        .get() as { lo: number | null; hi: number | null } | undefined;
    const days = span?.lo != null && span.hi != null ? (span.hi - span.lo) / 86_400_000 : 0;
    const chosen: TimelineUnit = unit ?? (days <= DAY_UNIT_MAX_DAYS ? 'day' : 'month');
    const format = chosen === 'day' ? '%Y-%m-%d' : '%Y-%m';

    const rows = db
        .prepare(
            `SELECT strftime('${format}', sent_at / 1000, 'unixepoch') AS key, verdict, count(*) AS n
             FROM messages WHERE sent_at IS NOT NULL
             GROUP BY key, verdict ORDER BY key`,
        )
        .all() as { key: string; verdict: string; n: number }[];

    const byKey = new Map<string, Map<string, number>>();
    for (const row of rows) {
        const verdicts = byKey.get(row.key) ?? new Map<string, number>();
        verdicts.set(row.verdict, Number(row.n));
        byKey.set(row.key, verdicts);
    }
    const buckets = [...byKey.entries()].map(([key, verdicts]) => ({
        key,
        messages: [...verdicts.values()].reduce((sum, n) => sum + n, 0),
        verdicts: VERDICTS.map((verdict) => ({ verdict, messages: verdicts.get(verdict) ?? 0 })),
    }));

    const undated = db.prepare('SELECT count(*) AS n FROM messages WHERE sent_at IS NULL').get() as
        | { n?: number }
        | undefined;
    return { unit: chosen, buckets, undated: Number(undated?.n ?? 0) };
}

/** The half-open instant range `[from, to)` of a bucket key, in epoch milliseconds (UTC). */
export function bucketRange(key: string): { from: number; to: number } | undefined {
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(key);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    if (month < 0 || month > 11) return undefined;
    if (match[3] === undefined) return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) };
    const day = Number(match[3]);
    return { from: Date.UTC(year, month, day), to: Date.UTC(year, month, day + 1) };
}

/** The messages of one bucket (`undated` for those without a date), as a scope. */
export function periodScope(db: DatabaseSync, key: string): HashScope {
    if (key === 'undated') return queryScope(db, 'SELECT hash FROM messages WHERE sent_at IS NULL');
    const range = bucketRange(key);
    if (!range) return queryScope(db, 'SELECT hash FROM messages WHERE 0');
    return queryScope(db, 'SELECT hash FROM messages WHERE sent_at >= ? AND sent_at < ?', [
        range.from,
        range.to,
    ]);
}
