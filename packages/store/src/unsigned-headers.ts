/**
 * The `unsigned_headers` table: what the header block of an UNSIGNED message shows, cached per
 * raw hash.
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, like `addresses` (see `addresses-db.ts`): a
 * `SCHEMA_VERSION` bump drops the index. The four flags are a pure function of the raw bytes and
 * the raw store is content-addressed, so a row never goes stale for its hash — only a change of
 * the RULES can, which is what {@link UNSIGNED_ANALYSER_VERSION} is for.
 *
 * One row per unsigned message: `flags` is a bitmask. {@link EXAMINED} says the header was
 * readable; a row without it records "looked, could not read", so the backfill does not retry
 * that message forever and the breakdown does not count it as examined.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { type HeaderField, parseHeaderFields, splitMessage } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { rawPath } from './raw.ts';
import { statementFor } from './statements.ts';

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

/**
 * The version of the rules in {@link analyseUnsignedHeaders}. Cached rows were produced by one
 * version; when this differs from the one in `meta`, the cache is cleared and refilled.
 * CHANGING THE RULES MEANS BUMPING THIS.
 */
export const UNSIGNED_ANALYSER_VERSION = 1;

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

const NEVER_TRANSPORTED = 1;
const RENAMED_SIGNATURE = 2;
const AUTH_RESULTS_PASS = 4;
const ARC_ONLY = 8;
const EXAMINED = 16;

function toBits(flags: UnsignedHeaderFlags): number {
    return (
        EXAMINED |
        (flags.neverTransported ? NEVER_TRANSPORTED : 0) |
        (flags.renamedSignature ? RENAMED_SIGNATURE : 0) |
        (flags.authResultsPass ? AUTH_RESULTS_PASS : 0) |
        (flags.arcOnly ? ARC_ONLY : 0)
    );
}

const READY = new WeakMap<DatabaseSync, boolean>();

function exists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

/** Create the table if missing. Best effort, like `ensureAddresses`. */
export function ensureUnsignedHeaders(db: DatabaseSync): void {
    try {
        if (!exists(db, 'unsigned_headers')) {
            db.exec('CREATE TABLE unsigned_headers (hash TEXT PRIMARY KEY, flags INTEGER NOT NULL)');
            // A new table is empty, so it is current by definition: without this, the first
            // backfill of a fresh case would clear what the importer has just written.
            setMeta(db, 'unsigned_headers_version', String(UNSIGNED_ANALYSER_VERSION));
        }
    } catch {
        // a busy database must not make the case unopenable
    }
    READY.delete(db);
}

function hasTable(db: DatabaseSync): boolean {
    let ready = READY.get(db);
    if (ready === undefined) {
        ready = exists(db, 'unsigned_headers');
        READY.set(db, ready);
    }
    return ready;
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Cache the flags of one unsigned message from its header block. Called by the importer, which
 * has the bytes at hand. A no-op when the table could not be created.
 */
export function writeUnsignedHeaders(db: DatabaseSync, hash: string, header: Uint8Array | undefined): void {
    if (!hasTable(db)) return;
    const flags = header === undefined ? 0 : toBits(analyseUnsignedHeaders(parseHeaderFields(header)));
    statementFor(db, 'INSERT OR REPLACE INTO unsigned_headers (hash, flags) VALUES (?, ?)').run(hash, flags);
}

/** Forget the cached flags of one message. */
export function deleteUnsignedHeaders(db: DatabaseSync, hash: string): void {
    if (!hasTable(db)) return;
    statementFor(db, 'DELETE FROM unsigned_headers WHERE hash = ?').run(hash);
}

function currentVersion(db: DatabaseSync): boolean {
    return metaValue(db, 'unsigned_headers_version') === String(UNSIGNED_ANALYSER_VERSION);
}

/** Does the cache cover every unsigned message that predates it, under the current rules? */
export function unsignedHeadersComplete(db: DatabaseSync): boolean {
    return hasTable(db) && currentVersion(db) && metaValue(db, 'unsigned_headers_done') === '1';
}

/**
 * Fill the cache for existing unsigned messages, one batch of at most `batch` messages.
 *
 * Idempotent and resumable: a rowid cursor in `meta` says where it stopped, and a row is
 * replaced, never added. A different analyser version clears the table and starts over. Each
 * call is its own short transaction. The old file-reading path lives here and nowhere else.
 */
export function backfillUnsignedHeaders(
    db: DatabaseSync,
    paths: CasePaths,
    batch = 2000,
): { done: boolean; processed: number } {
    if (!hasTable(db)) return { done: false, processed: 0 };
    if (!currentVersion(db)) {
        db.exec('DELETE FROM unsigned_headers');
        setMeta(db, 'unsigned_headers_cursor', '0');
        setMeta(db, 'unsigned_headers_done', '0');
        setMeta(db, 'unsigned_headers_version', String(UNSIGNED_ANALYSER_VERSION));
    }
    if (metaValue(db, 'unsigned_headers_done') === '1') return { done: true, processed: 0 };
    const cursor = Number(metaValue(db, 'unsigned_headers_cursor') ?? 0);
    const rows = db
        .prepare(
            `SELECT m.rowid AS id, m.hash AS hash FROM messages m
             LEFT JOIN unsigned_headers u ON u.hash = m.hash
             WHERE m.rowid > ? AND m.verdict = 'unsigned' AND u.hash IS NULL
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
            writeUnsignedHeaders(db, row.hash, readHeaderBlock(rawPath(paths, row.hash)));
        }
        const last = rows[rows.length - 1];
        if (last) setMeta(db, 'unsigned_headers_cursor', String(last.id));
        else setMeta(db, 'unsigned_headers_done', '1');
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

/** Run {@link backfillUnsignedHeaders} to the end — for the CLI. */
export function backfillUnsignedHeadersAll(
    db: DatabaseSync,
    paths: CasePaths,
    onProgress?: (processed: number) => void,
): void {
    let total = 0;
    for (;;) {
        const step = backfillUnsignedHeaders(db, paths);
        total += step.processed;
        if (step.processed > 0) onProgress?.(total);
        // no progress and not done covers the absent table (ensure is best effort): looping
        // forever on it would hang the caller; stopping makes the next run retry.
        if (step.done || step.processed === 0) return;
    }
}

/** The totals over the cache, joined with the current verdicts. One aggregate query. */
export function unsignedTotals(db: DatabaseSync): {
    examined: number;
    neverTransported: number;
    renamedSignature: number;
    authResultsPass: number;
    arcOnly: number;
} {
    const row = db
        .prepare(
            `SELECT
                SUM((u.flags & ${EXAMINED}) != 0) AS examined,
                SUM((u.flags & ${NEVER_TRANSPORTED}) != 0) AS never,
                SUM((u.flags & ${RENAMED_SIGNATURE}) != 0) AS renamed,
                SUM((u.flags & ${AUTH_RESULTS_PASS}) != 0) AS pass,
                SUM((u.flags & ${ARC_ONLY}) != 0) AS arc
             FROM unsigned_headers u JOIN messages m ON m.hash = u.hash
             WHERE m.verdict = 'unsigned'`,
        )
        .get() as Record<string, unknown> | undefined;
    return {
        examined: Number(row?.examined ?? 0),
        neverTransported: Number(row?.never ?? 0),
        renamedSignature: Number(row?.renamed ?? 0),
        authResultsPass: Number(row?.pass ?? 0),
        arcOnly: Number(row?.arc ?? 0),
    };
}
