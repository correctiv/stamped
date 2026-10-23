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
import { closeSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { VERDICTS, type Verdict } from '@stamped/core';
import { type HeaderField, parseHeaderFields, splitMessage } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { hashScope } from './index-db.ts';
import { eachLogEntry, type ImportLogEntry, rawPath } from './raw.ts';
import type { SigningDomain } from './report.ts';

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
    const rows: PeriodRow[] = [];
    for (const [mailbox, hashes] of derivedMailboxHashes(paths)) {
        const scope = hashScope(db, hashes);
        try {
            const found = db
                .prepare(
                    `SELECT CAST(strftime('%Y', m.sent_at / 1000, 'unixepoch') AS INTEGER) AS year,
                            m.verdict AS verdict, count(m.hash) AS total
                     FROM messages m, ${scope.table} s WHERE s.hash = m.hash
                     GROUP BY 1, 2`,
                )
                .all() as { year?: number | null; verdict?: string; total?: number }[];
            const byYear = new Map<number | undefined, { m: number; b: number; h: number }>();
            for (const row of found) {
                const year = row.year === null || row.year === undefined ? undefined : Number(row.year);
                const cell = byYear.get(year) ?? { m: 0, b: 0, h: 0 };
                const n = Number(row.total ?? 0);
                cell.m += n;
                if (row.verdict === 'body-altered') cell.b += n;
                if (row.verdict === 'headers-altered') cell.h += n;
                byYear.set(year, cell);
            }
            for (const [year, cell] of byYear) {
                rows.push({
                    mailbox,
                    ...(year === undefined ? {} : { year }),
                    messages: cell.m,
                    bodyAltered: cell.b,
                    headersAltered: cell.h,
                });
            }
        } finally {
            scope.close();
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

/** What the header block of one unsigned message shows. */
export interface UnsignedHeaderFlags {
    /** No `Received` header: the message never travelled through a mail server. */
    readonly neverTransported: boolean;
    /** A header such as `X-Foo-DKIM-Signature`: a signature that was renamed, not removed. */
    readonly renamedSignature: boolean;
    /** `Authentication-Results` reports `dkim=pass` although no signature is left. */
    readonly authResultsPass: boolean;
    /** `ARC-Message-Signature` present: an ARC chain without a DKIM signature. */
    readonly arcOnly: boolean;
}

/** Read the flags off parsed header fields. Pure, so the rules can be tested without a case. */
export function analyseUnsignedHeaders(fields: readonly HeaderField[]): UnsignedHeaderFlags {
    const has = (test: (lower: string) => boolean) => fields.some((field) => test(field.lower));
    return {
        neverTransported: !has((name) => name === 'received'),
        renamedSignature: has((name) => name !== 'dkim-signature' && name.endsWith('dkim-signature')),
        authResultsPass: fields.some(
            (field) => field.lower === 'authentication-results' && /\bdkim\s*=\s*pass\b/i.test(field.value),
        ),
        arcOnly: has((name) => name === 'arc-message-signature'),
    };
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

/** Bytes read per attempt at the header block; doubled until the blank line shows up. */
const HEADER_CHUNK = 64 * 1024;
const HEADER_LIMIT = 4 * 1024 * 1024;

/** The header block of a raw file, without reading the body. `undefined` for an unreadable file. */
export function readHeaderBlock(path: string): Uint8Array | undefined {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return undefined;
    }
    try {
        for (let size = HEADER_CHUNK; ; size *= 2) {
            const buffer = new Uint8Array(size);
            const read = readSync(fd, buffer, 0, size, 0);
            const { header } = splitMessage(buffer.subarray(0, read));
            if (read < size || header.length < read || size >= HEADER_LIMIT) return header;
        }
    } catch {
        return undefined;
    } finally {
        closeSync(fd);
    }
}

/**
 * Count the reasons behind the case's unsigned messages. Reads the header block of every
 * unsigned raw file — the reason this is opt-in.
 */
export function unsignedBreakdown(db: DatabaseSync, paths: CasePaths): UnsignedBreakdown {
    const totals = { examined: 0, neverTransported: 0, renamedSignature: 0, authResultsPass: 0, arcOnly: 0 };
    const select = db.prepare(
        "SELECT hash FROM messages WHERE verdict = 'unsigned' AND hash > ? ORDER BY hash LIMIT 5000",
    );
    let after = '';
    for (;;) {
        const page = select.all(after) as { hash?: string }[];
        if (page.length === 0) break;
        for (const row of page) {
            const hash = String(row.hash ?? '');
            after = hash;
            const header = readHeaderBlock(rawPath(paths, hash));
            if (header === undefined) continue;
            const flags = analyseUnsignedHeaders(parseHeaderFields(header));
            totals.examined++;
            if (flags.neverTransported) totals.neverTransported++;
            if (flags.renamedSignature) totals.renamedSignature++;
            if (flags.authResultsPass) totals.authResultsPass++;
            if (flags.arcOnly) totals.arcOnly++;
        }
    }
    return totals;
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
