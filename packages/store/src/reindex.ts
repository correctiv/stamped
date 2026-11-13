/**
 * Put a case's index back from `raw/`.
 *
 * WHY THIS CAN WORK. The index is derived from the messages' own bytes (`index-db.ts` says so
 * in its first lines), and `raw/` holds every message under the SHA-256 of those bytes. What is
 * not derivable is HISTORY: `first_verdict`, the "before" of the report's before/now table. Only
 * the old index remembers it, so it is read out of the old file and carried over; a message the
 * old index did not have gets the verdict it has now. Provenance (which archive, which mailbox)
 * never lived in the index: it is in `import-log.jsonl`, which this does not touch.
 *
 * ORDER. The new index is built in a file beside the old one and swapped in by a rename at the
 * very end. A run that fails or is killed leaves the old index exactly as it was, and a leftover
 * `index.db.rebuild` is deleted by the next run. Nothing is written to `raw/` or to the log.
 *
 * WHAT IS NOT BROUGHT BACK. The `imported_files` ledger stays empty (a later import reads its
 * files again and finds every message known, so nothing is lost but time); the attachment
 * metadata is opt-in and filled by its own command; `vectors.db` is a different file.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { classifyMessage, type KeyStore, _ } from '@stamped/core';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { beginBatch, commitBatch, openIndex, rollbackBatch } from './index-db.ts';
import { indexRaw } from './index-raw.ts';
import { readPerimeter } from './perimeter.ts';
import { digest, listRawHashes, readRaw } from './raw.ts';
import { settleSiblings } from './siblings.ts';

/** Messages per transaction, as in an import. */
const BATCH = 500;

/** The file the new index is built in. */
export function rebuildPath(paths: CasePaths): string {
    return `${paths.database}.rebuild`;
}

export interface ReindexOptions {
    /** The keys verification may use: the vault's, so the result does not depend on a flag. */
    readonly keys: KeyStore;
    /** Swap the new index in although some messages could not be indexed. */
    readonly acceptFailures?: boolean;
    readonly onProgress?: (done: number, total: number) => void;
}

/** A message that could not be put into the index. */
export interface ReindexFailure {
    readonly hash: string;
    readonly reason: string;
}

export interface ReindexResult {
    /** Messages in the new index. */
    readonly indexed: number;
    /** Messages the old index had. `undefined` when there was no readable old index. */
    readonly before?: number;
    /** Of {@link indexed}, how many kept their `first_verdict` from the old index. */
    readonly carried: number;
    readonly failures: readonly ReindexFailure[];
    /** Whether the new index took the old one's place. */
    readonly replaced: boolean;
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * `hash → first_verdict` out of the old index, or `undefined` when there is none to read.
 *
 * Read through a read-only handle and never repaired: an index too damaged to read just means no
 * history to carry, and the rebuild goes on. A column the old schema lacks reads as a legacy row
 * (NULL), the same state an in-place upgrade leaves.
 */
function oldHistory(paths: CasePaths): Map<string, string | null> | undefined {
    if (!existsSync(paths.database)) return undefined;
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(paths.database, { readOnly: true });
        let rows: { hash?: string; first_verdict?: string | null }[];
        try {
            rows = db.prepare('SELECT hash, first_verdict FROM messages').all();
        } catch {
            rows = db.prepare('SELECT hash FROM messages').all();
        }
        const history = new Map<string, string | null>();
        for (const row of rows) {
            if (typeof row.hash === 'string') history.set(row.hash, row.first_verdict ?? null);
        }
        return history;
    } catch {
        return undefined;
    } finally {
        db?.close();
    }
}

function removeRebuild(paths: CasePaths): void {
    const base = rebuildPath(paths);
    for (const file of [base, `${base}-wal`, `${base}-shm`, `${base}-journal`]) {
        rmSync(file, { force: true });
    }
}

export async function reindexCase(paths: CasePaths, options: ReindexOptions): Promise<ReindexResult> {
    const hashes = listRawHashes(paths);
    const history = oldHistory(paths);
    const classifyOptions = { perimeter: readPerimeter(paths) };
    const failures: ReindexFailure[] = [];
    let indexed = 0;
    let carried = 0;

    removeRebuild(paths);
    const db = openIndex({ ...paths, database: rebuildPath(paths) });
    let open = true;
    let swap = false;
    try {
        let inBatch = 0;
        try {
            for (const [position, hash] of hashes.entries()) {
                if (inBatch === 0) beginBatch(db);
                const raw = readRaw(paths, hash);
                if (raw === undefined) {
                    failures.push({ hash, reason: _('The message file cannot be read.') });
                } else if (digest(raw) !== hash) {
                    // A name that does not describe its contents is evidence that changed after
                    // it was stored. It is not indexed under a hash it does not have.
                    failures.push({ hash, reason: _('The message file does not match its name.') });
                } else {
                    try {
                        const finding = classifyMessage(
                            await verifyMessage(raw, { keys: options.keys }),
                            classifyOptions,
                        );
                        const known = history !== undefined && history.has(hash);
                        indexRaw(db, hash, raw, finding, {
                            fresh: true,
                            ...(known ? { firstVerdict: history.get(hash) ?? null } : {}),
                        });
                        if (known) carried++;
                        indexed++;
                    } catch (error) {
                        failures.push({ hash, reason: reasonOf(error) });
                    }
                }
                inBatch++;
                options.onProgress?.(position + 1, hashes.length);
                if (inBatch >= BATCH) {
                    commitBatch(db);
                    inBatch = 0;
                }
            }
            if (inBatch > 0) commitBatch(db);
        } catch (error) {
            rollbackBatch(db);
            throw error;
        }
        await settleSiblings(db, paths, options.keys);
        swap = failures.length === 0 || options.acceptFailures === true;
        if (swap) {
            // A rollback journal, not the WAL the app wants: the file must be one self-contained
            // file to be renamed. The next open switches it back.
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            db.exec('PRAGMA journal_mode=DELETE');
        }
        db.close();
        open = false;
        if (swap) {
            // The old file's log must not outlive it: next to the new file it would be read as
            // its own.
            rmSync(`${paths.database}-wal`, { force: true });
            rmSync(`${paths.database}-shm`, { force: true });
            renameSync(rebuildPath(paths), paths.database);
        }
    } finally {
        if (open) db.close();
        if (!swap) removeRebuild(paths);
    }
    return {
        indexed,
        ...(history === undefined ? {} : { before: history.size }),
        carried,
        failures,
        replaced: swap,
    };
}
