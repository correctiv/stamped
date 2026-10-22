/**
 * The indexer's view of a case: which messages, in what order, and what text.
 *
 * The shapes are declared here, not imported from `@stamped/semantic`, which must stay free of
 * this package; TypeScript matches them structurally.
 *
 * ORDER is the browse order of the message list (newest `sent_at` first, undated last, hash as
 * the tie-break), so the walk is an index walk on `messages_browse` and the mail a journalist
 * sees first is searchable first. The cursor is a keyset, not an offset: a deep page stays cheap.
 *
 * THE DATED HALF AND THE UNDATED TAIL ARE TWO QUERIES, and that is what makes the keyset a
 * keyset. `messages_browse` is an index on the EXPRESSION `sent_at IS NULL` plus `sent_at DESC,
 * hash ASC`, and SQLite only SEEKS it when the WHERE names that expression the same way and the
 * ORDER BY does not mention it. One query with `… OR sent_at IS NULL` reads as the same walk but
 * SCANS the whole index on every page, so the walk costs the square of the case. MEASURED over
 * 200,000 messages at a page size of 128: 8.3 s for the one-query form, 90 ms for this one — and
 * the gap grows, because only one of the two is linear. A resumed run, which lists everything and
 * embeds almost nothing, is exactly where that cost is the whole run.
 *
 * TEXT comes from `raw/` through `summarise`, not from the FTS table: its `hash` column is
 * UNINDEXED, so a lookup by hash there is a scan of the whole table per page.
 */

import type { DatabaseSync } from 'node:sqlite';

import { summarise } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { countMessages } from './index-db.ts';
import { readRaw } from './raw.ts';

export interface IndexSourceEntry {
    readonly hash: string;
    readonly sentAt?: number;
}

export interface IndexSourceDocument {
    readonly hash: string;
    readonly subject: string;
    readonly body: string;
}

export interface IndexDocumentSource {
    count(): number;
    next(after: IndexSourceEntry | undefined, limit: number): IndexSourceEntry[];
    read(hashes: readonly string[]): IndexSourceDocument[];
}

type SourceRow = { hash: string; sent_at: number | null };

function toEntry(row: SourceRow): IndexSourceEntry {
    return {
        hash: String(row.hash),
        ...(row.sent_at === null || row.sent_at === undefined ? {} : { sentAt: Number(row.sent_at) }),
    };
}

/**
 * The messages that have a date, newest first, strictly after the cursor.
 *
 * `sent_at <= ? AND (sent_at < ? OR hash > ?)` is "after (sentAt, hash) in this order" written so
 * that SQLite can seek: the first term bounds the index, the second drops the part of the
 * cursor's tie group that was already handed out.
 */
function datedPage(db: DatabaseSync, after: IndexSourceEntry | undefined, size: number): SourceRow[] {
    const sql = `SELECT hash, sent_at FROM messages WHERE (sent_at IS NULL) = 0`;
    const order = `ORDER BY sent_at DESC, hash ASC LIMIT ${size}`;
    if (after?.sentAt === undefined) return db.prepare(`${sql} ${order}`).all() as SourceRow[];
    return db
        .prepare(`${sql} AND sent_at <= ? AND (sent_at < ? OR hash > ?) ${order}`)
        .all(after.sentAt, after.sentAt, after.hash) as SourceRow[];
}

/** The messages whose `Date` could not be read, by hash, strictly after `afterHash`. */
function undatedPage(db: DatabaseSync, afterHash: string | undefined, size: number): SourceRow[] {
    const sql = `SELECT hash, sent_at FROM messages WHERE (sent_at IS NULL) = 1 AND sent_at IS NULL`;
    const order = `ORDER BY hash ASC LIMIT ${size}`;
    if (afterHash === undefined) return db.prepare(`${sql} ${order}`).all() as SourceRow[];
    return db.prepare(`${sql} AND hash > ? ${order}`).all(afterHash) as SourceRow[];
}

export function indexDocumentSource(db: DatabaseSync, paths: CasePaths): IndexDocumentSource {
    return {
        count: () => countMessages(db),
        next(after, limit) {
            const size = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
            const rows: SourceRow[] =
                after === undefined || after.sentAt !== undefined ? datedPage(db, after, size) : [];
            // A page the dated half could not fill is the proof that it is exhausted, so the rest
            // comes from the tail — continuing after the cursor when the cursor is already in it.
            if (rows.length < size) {
                const from = after !== undefined && after.sentAt === undefined ? after.hash : undefined;
                rows.push(...undatedPage(db, from, size - rows.length));
            }
            return rows.map(toEntry);
        },
        read(hashes) {
            const out: IndexSourceDocument[] = [];
            for (const hash of hashes) {
                const raw = readRaw(paths, hash);
                if (!raw) continue;
                const summary = summarise(raw);
                out.push({ hash, subject: summary.subject, body: summary.text });
            }
            return out;
        },
    };
}
