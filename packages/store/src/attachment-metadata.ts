/**
 * The `attachment_metadata` table: what the attachments of each message say about their own
 * history, cached per raw hash (analysis: `@stamped/import`, `attachment-metadata.ts`).
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, like `unsigned_headers`: a `SCHEMA_VERSION` bump drops the
 * index. A row is a pure function of the raw bytes, and only a change of the RULES can make it
 * stale — that is {@link ATTACHMENT_ANALYSER_VERSION}.
 *
 * OPT-IN. Unlike the other caches nothing fills this at import: reading every attachment of every
 * message is the most expensive pass over a case there is, and the finding is an indication, not
 * a verdict. It is filled when someone asks (`stamped report --pdf --attachment-metadata`), in
 * short transactions that can be interrupted and resumed. A new message has no row, and the next
 * fill picks it up — there is no `done` flag to go stale.
 *
 * One row per message that was looked at; `flags` is a bitmask. {@link LOOKED} says the raw file
 * was read; {@link EXAMINED} says an attachment of a supported format was found in it. A message
 * with no examinable attachment still has a row, so it is never read again.
 */

import type { DatabaseSync } from 'node:sqlite';

import { ATTACHMENT_ANALYSER_VERSION, attachmentFindings, isFlagged } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { readRaw } from './raw.ts';
import { statementFor } from './statements.ts';

const LOOKED = 1;
const EXAMINED = 2;
const AFTER_SENT = 4;
const LONG_AFTER_CREATION = 8;
const INCREMENTAL = 16;
const FLAGGED = AFTER_SENT | LONG_AFTER_CREATION | INCREMENTAL;

/** The bitmask for one message's raw bytes. */
export function attachmentFlags(raw: Uint8Array): number {
    let flags = LOOKED;
    try {
        for (const { indication } of attachmentFindings(raw)) {
            flags |= EXAMINED;
            if (isFlagged(indication)) {
                flags |=
                    (indication.modifiedAfterSent ? AFTER_SENT : 0) |
                    (indication.modifiedLongAfterCreation ? LONG_AFTER_CREATION : 0) |
                    (indication.incrementalUpdates ? INCREMENTAL : 0);
            }
        }
    } catch {
        // a message that cannot be walked is "looked, nothing to say"
    }
    return flags;
}

const READY = new WeakMap<DatabaseSync, boolean>();

function exists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Create the table if missing. Best effort, like `ensureUnsignedHeaders`. */
export function ensureAttachmentMetadata(db: DatabaseSync): void {
    try {
        if (!exists(db, 'attachment_metadata')) {
            db.exec('CREATE TABLE attachment_metadata (hash TEXT PRIMARY KEY, flags INTEGER NOT NULL)');
            setMeta(db, 'attachment_metadata_version', String(ATTACHMENT_ANALYSER_VERSION));
        }
    } catch {
        // a busy database must not make the case unopenable
    }
    READY.delete(db);
}

function hasTable(db: DatabaseSync): boolean {
    let ready = READY.get(db);
    if (ready === undefined) {
        ready = exists(db, 'attachment_metadata');
        READY.set(db, ready);
    }
    return ready;
}

/** Forget the cached row of one message. */
export function deleteAttachmentMetadata(db: DatabaseSync, hash: string): void {
    if (!hasTable(db)) return;
    statementFor(db, 'DELETE FROM attachment_metadata WHERE hash = ?').run(hash);
}

/**
 * Fill the cache for messages that have no row yet, one batch of at most `batch` messages.
 *
 * Idempotent and resumable: a rowid cursor in `meta` says where it stopped and a row is replaced,
 * never added. A different analyser version clears the table and starts over. `processed` counts
 * the messages taken; `done` is true when no message without a row is left past the cursor.
 */
export function backfillAttachmentMetadata(
    db: DatabaseSync,
    paths: CasePaths,
    batch = 500,
): { done: boolean; processed: number } {
    if (!hasTable(db)) return { done: false, processed: 0 };
    if (metaValue(db, 'attachment_metadata_version') !== String(ATTACHMENT_ANALYSER_VERSION)) {
        db.exec('DELETE FROM attachment_metadata');
        setMeta(db, 'attachment_metadata_cursor', '0');
        setMeta(db, 'attachment_metadata_version', String(ATTACHMENT_ANALYSER_VERSION));
    }
    const cursor = Number(metaValue(db, 'attachment_metadata_cursor') ?? 0);
    const rows = db
        .prepare(
            `SELECT m.rowid AS id, m.hash AS hash FROM messages m
             LEFT JOIN attachment_metadata a ON a.hash = m.hash
             WHERE m.rowid > ? AND a.hash IS NULL
             ORDER BY m.rowid LIMIT ${Math.max(1, Math.trunc(batch))}`,
        )
        .all(cursor) as { id: number; hash: string }[];

    let own = true;
    try {
        db.exec('BEGIN');
    } catch {
        own = false;
    }
    try {
        for (const row of rows) {
            const raw = readRaw(paths, row.hash);
            // An unreadable file gets no row: the file may come back, and "looked" would be a lie.
            if (raw === undefined) continue;
            statementFor(db, 'INSERT OR REPLACE INTO attachment_metadata (hash, flags) VALUES (?, ?)').run(
                row.hash,
                attachmentFlags(raw),
            );
        }
        const last = rows[rows.length - 1];
        if (last) setMeta(db, 'attachment_metadata_cursor', String(last.id));
        if (own) db.exec('COMMIT');
    } catch (error) {
        if (own) {
            try {
                db.exec('ROLLBACK');
            } catch {
                // no transaction was open
            }
        }
        throw error;
    }
    return { done: rows.length === 0, processed: rows.length };
}

/** Run {@link backfillAttachmentMetadata} to the end — for the report. */
export function backfillAttachmentMetadataAll(
    db: DatabaseSync,
    paths: CasePaths,
    onProgress?: (processed: number) => void,
): void {
    let total = 0;
    for (;;) {
        const step = backfillAttachmentMetadata(db, paths);
        total += step.processed;
        if (step.processed > 0) onProgress?.(total);
        // no progress and not done covers the absent table: looping on it would hang the caller
        if (step.done || step.processed === 0) return;
    }
}

/**
 * True when the cache is of the current rules and every message has a row. Nothing is stored for
 * this: a message without a row is exactly what the next fill looks for.
 */
export function attachmentMetadataComplete(db: DatabaseSync): boolean {
    if (!hasTable(db)) return false;
    if (metaValue(db, 'attachment_metadata_version') !== String(ATTACHMENT_ANALYSER_VERSION)) return false;
    const row = db
        .prepare(
            'SELECT 1 AS missing FROM messages m LEFT JOIN attachment_metadata a ON a.hash = m.hash WHERE a.hash IS NULL LIMIT 1',
        )
        .get() as { missing?: number } | undefined;
    return row === undefined;
}

/** How many messages the cache covers, and what it found in them. */
export interface AttachmentTotals {
    /** Messages whose raw file was read. */
    readonly looked: number;
    /** Messages with at least one attachment of a supported format. */
    readonly examined: number;
    /** Messages with at least one attachment that carries any flag. */
    readonly flagged: number;
    readonly modifiedAfterSent: number;
    readonly modifiedLongAfterCreation: number;
    readonly incrementalUpdates: number;
}

/** The totals over the cache. One aggregate query. */
export function attachmentTotals(db: DatabaseSync): AttachmentTotals {
    const row = hasTable(db)
        ? (db
              .prepare(
                  `SELECT
                      count(*) AS looked,
                      SUM((a.flags & ${EXAMINED}) != 0) AS examined,
                      SUM((a.flags & ${FLAGGED}) != 0) AS flagged,
                      SUM((a.flags & ${AFTER_SENT}) != 0) AS after_sent,
                      SUM((a.flags & ${LONG_AFTER_CREATION}) != 0) AS long_after,
                      SUM((a.flags & ${INCREMENTAL}) != 0) AS incremental
                   FROM attachment_metadata a JOIN messages m ON m.hash = a.hash`,
              )
              .get() as Record<string, unknown> | undefined)
        : undefined;
    return {
        looked: Number(row?.looked ?? 0),
        examined: Number(row?.examined ?? 0),
        flagged: Number(row?.flagged ?? 0),
        modifiedAfterSent: Number(row?.after_sent ?? 0),
        modifiedLongAfterCreation: Number(row?.long_after ?? 0),
        incrementalUpdates: Number(row?.incremental ?? 0),
    };
}

/** What the report shows: the totals of a fill that ran to the end. */
export function attachmentBreakdown(
    db: DatabaseSync,
    paths: CasePaths,
    onProgress?: (processed: number) => void,
): AttachmentTotals {
    backfillAttachmentMetadataAll(db, paths, onProgress);
    return attachmentTotals(db);
}
