/**
 * The `imported_files` table: the mail files an import has read to the end AND indexed, so that a
 * run after an interruption skips them instead of reading the whole archive again.
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, for the same reason as `addresses`: a schema bump drops
 * the index. It lives in the index rather than next to it on purpose — a row here says "every
 * message of this file is in the index", and the only place that stays true is the database that
 * holds those messages. Rebuild the index and the ledger goes with it, which costs a re-read and
 * never a lost message.
 *
 * A file is the same file when its resolved path, size and modification time all match. Anything
 * else — a part that was replaced, a mailbox that grew — is read again; the importer's dedup makes
 * that safe, so a false "changed" only costs time, while a false "same" would lose mail.
 */

import { realpathSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { statementFor } from './statements.ts';

/** What identifies one file on disk. */
export interface FileIdentity {
    readonly path: string;
    readonly size: number;
    readonly mtime: number;
}

/** Create the table if it is missing. Best effort: a case opened read-only simply has no ledger. */
export function ensureImportedFiles(db: DatabaseSync): void {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS imported_files (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            at TEXT NOT NULL
        )`);
    } catch {
        // see above
    }
}

/** The identity of a regular file, or `undefined` when it cannot be read (a Maildir, a gone file). */
export function fileIdentity(path: string): FileIdentity | undefined {
    try {
        const stat = statSync(path);
        if (!stat.isFile()) return undefined;
        return { path: realpathSync(path), size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
    } catch {
        return undefined;
    }
}

/** Every file in the ledger, keyed by path. One scan instead of a query per file. */
export function importedFiles(db: DatabaseSync): Map<string, FileIdentity> {
    const files = new Map<string, FileIdentity>();
    try {
        const rows = statementFor(db, 'SELECT path, size, mtime FROM imported_files').all() as {
            path: string;
            size: number;
            mtime: number;
        }[];
        for (const row of rows) files.set(row.path, { path: row.path, size: row.size, mtime: row.mtime });
    } catch {
        // no ledger yet: nothing was finished
    }
    return files;
}

/** Whether `file` is in the ledger exactly as it is on disk now. */
export function alreadyImported(ledger: ReadonlyMap<string, FileIdentity>, file: FileIdentity): boolean {
    const known = ledger.get(file.path);
    return known !== undefined && known.size === file.size && known.mtime === file.mtime;
}

/** Record files as read to the end and indexed. Call inside the transaction that indexed them. */
export function markImported(db: DatabaseSync, files: readonly FileIdentity[]): void {
    const insert = statementFor(
        db,
        'INSERT OR REPLACE INTO imported_files (path, size, mtime, at) VALUES (?, ?, ?, ?)',
    );
    const at = new Date().toISOString();
    for (const file of files) insert.run(file.path, file.size, file.mtime, at);
}
