/**
 * One archive in, one case folder out.
 *
 * This is the only place where the four halves meet: `@stamped/import` turns a path into single
 * messages, `raw.ts` puts each one on disk under its own hash, `@stamped/verify` and
 * `@stamped/core` say what its signatures are worth, and `index-db.ts` makes it findable. The
 * ORDER is the point and is not an implementation detail:
 *
 * 1. store the bytes, 2. append the log line, 3. verify, 4. index.
 *
 * The evidence is on disk and its provenance recorded BEFORE anything is derived from it, so a
 * run killed at any point leaves a case folder whose raw store and log are consistent and whose
 * index is merely incomplete — and an incomplete index is the one piece that can be rebuilt. The
 * reverse order would leave rows describing messages that were never saved.
 *
 * A message that cannot be verified at all does not stop the import. An archive is a few hundred
 * thousand messages and some of them are damaged; an import that aborts on the first one leaves
 * a journalist with a partial case folder and no sign of where it stopped. The failure is
 * counted and reported instead.
 */

import { classifyMessage, type KeyStore } from '@stamped/core';
import { readSource, summarise, type MboxFlavour, type SourceMessage } from '@stamped/import';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import {
    beginBatch,
    commitBatch,
    indexedHashes,
    indexMessage,
    openIndex,
    rollbackBatch,
} from './index-db.ts';
import { settleSiblings } from './siblings.ts';
import { appendLog, readRaw, store, type ImportLogEntry } from './raw.ts';

/** How many log lines are held before they are written. See {@link appendLog}. */
const LOG_BATCH = 256;

/**
 * How many messages share one index transaction.
 *
 * Without a transaction every statement is its own commit, and an index row is four to six
 * statements. A crash loses at most one batch of rows, which is harmless: the raw store and the
 * log were written first, and the next run indexes whatever the index lacks.
 */
const INDEX_BATCH = 500;

/** How an import is driven. */
export interface ImportOptions {
    /** The keys each message is verified against. An empty store yields `unverifiable`. */
    readonly keys: KeyStore;
    /** Which `From ` quoting the mbox archives use. */
    readonly flavour?: MboxFlavour;
    /** Called after each message, for a progress line. */
    readonly onProgress?: (progress: ImportProgress) => void;
    /** Called once per committed index batch. For machine-readable progress. */
    readonly onBatch?: (progress: ImportProgress) => void;
}

/** Where an import has got to. */
export interface ImportProgress {
    readonly read: number;
    readonly stored: number;
    readonly duplicates: number;
    readonly indexed: number;
    readonly failed: number;
    /** Messages of the current source still to verify and index, once its read pass is done. */
    readonly total: number;
    /** Of {@link total}, how many are processed. */
    readonly done: number;
}

/** What one import run did. */
export interface ImportResult {
    /** Messages read out of the sources, duplicates included. */
    readonly read: number;
    /** Messages whose bytes were new to the store. */
    readonly stored: number;
    /** Messages the store already held — the same mail twice in the archive. */
    readonly duplicates: number;
    /** Messages newly written to the index. */
    readonly indexed: number;
    /** Messages whose verification threw. They are stored and logged, but have no verdict. */
    readonly failed: number;
}

/**
 * Import every message under each source path into the case.
 *
 * Idempotent: running it again over the same archive stores nothing, logs the messages as
 * duplicates and leaves the index as it was. That is what makes an interrupted import simply
 * runnable again rather than something to clean up first.
 */
export async function importSources(
    paths: CasePaths,
    sources: readonly string[],
    options: ImportOptions,
): Promise<ImportResult> {
    const db = openIndex(paths);
    let read = 0;
    let stored = 0;
    let duplicates = 0;
    let indexed = 0;
    let failed = 0;
    let total = 0;
    let done = 0;
    let pending: ImportLogEntry[] = [];
    const madeDirs = new Set<string>();
    // One scan instead of a query per message. A hash added during this run goes in too, so a
    // message met twice is verified once.
    const known = indexedHashes(db);

    const flush = (): void => {
        appendLog(paths, pending);
        pending = [];
    };
    const snapshot = (): ImportProgress => ({ read, stored, duplicates, indexed, failed, total, done });

    try {
        for (const source of sources) {
            // Collected rather than verified inside the callback: `readSource` is synchronous —
            // it has to be, GJS has no always-on event loop to pump a stream with — while
            // `verifyMessage` is not. Buffering the whole archive would defeat the streaming, so
            // each message is stored and logged in the callback (both synchronous) and only its
            // HASH is carried out to be verified afterwards. That keeps the memory ceiling at one
            // message plus a list of hashes.
            const fresh: { hash: string; bytes: number }[] = [];

            readSource(
                source,
                (message: SourceMessage) => {
                    read++;
                    const result = store(paths, message.raw, madeDirs);
                    if (result.stored) stored++;
                    else duplicates++;

                    pending.push({
                        hash: result.hash,
                        source: message.path,
                        offset: message.offset,
                        kind: message.kind,
                        bytes: message.raw.length,
                        at: new Date().toISOString(),
                        duplicate: !result.stored,
                    });
                    if (pending.length >= LOG_BATCH) flush();

                    // Already indexed by an earlier run, or met twice in this one: the row would
                    // be identical, and re-verifying it costs the same as verifying a new message.
                    if (known.has(result.hash)) return;
                    known.add(result.hash);
                    fresh.push({ hash: result.hash, bytes: message.raw.length });
                },
                { flavour: options.flavour },
            );
            flush();

            total = fresh.length;
            done = 0;
            let inBatch = 0;
            try {
                for (const entry of fresh) {
                    if (inBatch === 0) beginBatch(db);
                    const raw = readRaw(paths, entry.hash);
                    if (!raw) {
                        failed++;
                    } else {
                        try {
                            const finding = classifyMessage(await verifyMessage(raw, { keys: options.keys }));
                            const sm = summarise(raw);
                            // `fresh`: not in the index (checked via `known`), so no removal scan.
                            indexMessage(
                                db,
                                { hash: entry.hash, bytes: entry.bytes, summary: sm, finding },
                                { fresh: true },
                            );
                            indexed++;
                        } catch {
                            // Stored and logged already, so the evidence is safe; only the verdict
                            // is missing. Reported as a count rather than swallowed.
                            failed++;
                        }
                    }
                    done++;
                    inBatch++;
                    options.onProgress?.(snapshot());
                    if (inBatch >= INDEX_BATCH) {
                        commitBatch(db);
                        inBatch = 0;
                        options.onBatch?.(snapshot());
                    }
                }
                if (inBatch > 0) {
                    commitBatch(db);
                    options.onBatch?.(snapshot());
                }
            } catch (error) {
                rollbackBatch(db);
                throw error;
            }
            await settleSiblings(db, paths, options.keys);
        }
    } finally {
        flush();
        db.close();
    }

    return { read, stored, duplicates, indexed, failed };
}
