/**
 * The numbers only the PDF report asks for: mail by mailbox and year, what lies behind "unsigned",
 * the top signing domains per verdict, and a fingerprint of the raw set.
 *
 * Kept apart from `report.ts` because none of it belongs on the screen report's hot path: the
 * unsigned breakdown reads one raw file per unsigned message, and the mailbox/year breakdown
 * walks the whole import log. Both are asked for once, by a person who wants a document.
 *
 * Everything here is a count. No subject, address or body leaves these functions.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { VERDICTS, type Verdict } from '@stamped/core';

import type { CasePaths } from './case.ts';
import {
    type BodyExplanationTotals,
    backfillBodyExplanationsAll,
    bodyExplanationTotals,
} from './body-explanations.ts';
import { mailboxScope } from './index-db.ts';
import { eachLogEntry, type ImportLogEntry } from './raw.ts';
import type { SigningDomain } from './report.ts';
import { backfillUnsignedHeadersAll, unsignedTotals } from './unsigned-headers.ts';

/** Maildir's own sub-folders: the mailbox is the folder ABOVE them. */
const MAILDIR_PARTS = new Set(['cur', 'new', 'tmp']);

/**
 * The mailbox a log entry belongs to.
 *
 * The entry's own `mailbox` field when a folder import wrote one; otherwise the parent folder of
 * the source file (issue #98). A Maildir message is a file in `cur/`, so its mailbox is the folder
 * above that. `''` means no folder could be named — the caller labels it, this does not invent one.
 */
export function mailboxOf(entry: Pick<ImportLogEntry, 'mailbox' | 'source'>): string {
    if (entry.mailbox !== undefined && entry.mailbox !== '') return entry.mailbox;
    const parts = entry.source.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    parts.pop();
    while (parts.length > 0 && MAILDIR_PARTS.has(parts[parts.length - 1] ?? '')) parts.pop();
    return parts[parts.length - 1] ?? '';
}

/** The raw hashes under each mailbox, derived with {@link mailboxOf}, in one walk of the log. */
export function derivedMailboxHashes(paths: CasePaths): Map<string, Set<string>> {
    const byMailbox = new Map<string, Set<string>>();
    eachLogEntry(paths, (entry) => {
        const key = mailboxOf(entry);
        let hashes = byMailbox.get(key);
        if (hashes === undefined) {
            hashes = new Set<string>();
            byMailbox.set(key, hashes);
        }
        hashes.add(entry.hash);
    });
    return byMailbox;
}

/** One mailbox in one year: how many messages, and how many of them are altered. */
export interface PeriodRow {
    readonly mailbox: string;
    /** UTC year of `Date`; `undefined` for mail whose date could not be read. */
    readonly year?: number;
    readonly messages: number;
    readonly bodyAltered: number;
    readonly headersAltered: number;
}

/**
 * Messages per mailbox and year, with the two alteration counts.
 *
 * Only messages the index holds are counted, as everywhere in a report. A message found in two
 * mailboxes counts under both.
 */
export function periodBreakdown(db: DatabaseSync, paths: CasePaths): PeriodRow[] {
    const byMailbox = derivedMailboxHashes(paths);
    // One scope table and one query for all mailboxes: a scope per mailbox cost a statement per hash.
    const scope = mailboxScope(db, byMailbox);
    const cells = new Map<string, Map<number | undefined, { m: number; b: number; h: number }>>();
    for (const mailbox of byMailbox.keys()) cells.set(mailbox, new Map());
    try {
        const found = db
            .prepare(
                `SELECT s.mailbox AS mailbox,
                        CAST(strftime('%Y', m.sent_at / 1000, 'unixepoch') AS INTEGER) AS year,
                        m.verdict AS verdict, count(m.hash) AS total
                 FROM ${scope.table} s JOIN messages m ON m.hash = s.hash
                 GROUP BY 1, 2, 3 ORDER BY 2, 3`,
            )
            .all() as { mailbox?: string; year?: number | null; verdict?: string; total?: number }[];
        for (const row of found) {
            const byYear = cells.get(row.mailbox ?? '');
            if (byYear === undefined) continue;
            const year = row.year === null || row.year === undefined ? undefined : Number(row.year);
            const cell = byYear.get(year) ?? { m: 0, b: 0, h: 0 };
            const n = Number(row.total ?? 0);
            cell.m += n;
            if (row.verdict === 'body-altered') cell.b += n;
            if (row.verdict === 'headers-altered') cell.h += n;
            byYear.set(year, cell);
        }
    } finally {
        scope.close();
    }
    const rows: PeriodRow[] = [];
    for (const [mailbox, byYear] of cells) {
        for (const [year, cell] of byYear) {
            rows.push({
                mailbox,
                ...(year === undefined ? {} : { year }),
                messages: cell.m,
                bodyAltered: cell.b,
                headersAltered: cell.h,
            });
        }
    }
    return rows;
}

/** The top signing domains of each verdict that has signatures, in {@link VERDICTS} order. */
export interface VerdictDomains {
    readonly verdict: Verdict;
    readonly domains: readonly SigningDomain[];
}

/** Signing domains per MESSAGE verdict, distinct messages, most mail first. */
export function domainsByVerdict(db: DatabaseSync, limit = 15): VerdictDomains[] {
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
    const out: VerdictDomains[] = [];
    for (const verdict of VERDICTS) {
        if (verdict === 'unsigned') continue;
        const rows = db
            .prepare(
                `SELECT s.domain AS domain, count(DISTINCT s.hash) AS messages
                 FROM signatures s JOIN messages m ON m.hash = s.hash
                 WHERE m.verdict = ?
                 GROUP BY s.domain ORDER BY messages DESC, s.domain ASC LIMIT ${capped}`,
            )
            .all(verdict) as Record<string, unknown>[];
        if (rows.length === 0) continue;
        out.push({
            verdict,
            domains: rows.map((row) => ({
                domain: String(row.domain ?? ''),
                messages: Number(row.messages ?? 0),
            })),
        });
    }
    return out;
}

/**
 * Why messages are unsigned, as far as the header block says.
 *
 * The groups OVERLAP: a message can be both renamed and `dkim=pass`. `embedded` (DKIM only in a
 * forwarded message) needs the body and is therefore not computed here; the field exists so a
 * later pass can fill it without the report model changing.
 */
export interface UnsignedBreakdown {
    /** Unsigned messages whose raw file was read. */
    readonly examined: number;
    readonly neverTransported: number;
    readonly renamedSignature: number;
    readonly authResultsPass: number;
    readonly arcOnly: number;
    readonly embedded?: number;
}

/**
 * Count the reasons behind the case's unsigned messages. The header blocks are read once, into
 * the `unsigned_headers` cache (see `unsigned-headers.ts`); this runs that fill to the end and
 * then answers with one aggregate query.
 */
export function unsignedBreakdown(db: DatabaseSync, paths: CasePaths): UnsignedBreakdown {
    backfillUnsignedHeadersAll(db, paths);
    return unsignedTotals(db);
}

/**
 * Which body-altered messages an export artefact explains, and what the header says about the
 * rest. Runs the `body_explanations` fill to the end, then answers with one aggregate query.
 */
export function bodyAlteredBreakdown(db: DatabaseSync, paths: CasePaths): BodyExplanationTotals {
    backfillBodyExplanationsAll(db, paths);
    return bodyExplanationTotals(db);
}

/** A fingerprint of the set of messages the index holds, and how many that is. */
export interface RawSetDigest {
    readonly messages: number;
    /** SHA-256 over the sorted message hashes, one per line. */
    readonly sha256: string;
}

/**
 * SHA-256 over the sorted raw-message hashes.
 *
 * Every hash is already the SHA-256 of a message's bytes, so this one digest commits to the whole
 * set: change, add or drop a message and it changes. Read page by page by key, never all at once.
 */
export function rawSetDigest(db: DatabaseSync): RawSetDigest {
    const hash = createHash('sha256');
    const select = db.prepare('SELECT hash FROM messages WHERE hash > ? ORDER BY hash LIMIT 20000');
    let after = '';
    let messages = 0;
    for (;;) {
        const page = select.all(after) as { hash?: string }[];
        if (page.length === 0) break;
        for (const row of page) {
            after = String(row.hash ?? '');
            hash.update(`${after}\n`);
            messages++;
        }
    }
    return { messages, sha256: hash.digest('hex') };
}
