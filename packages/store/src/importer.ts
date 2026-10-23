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
 *
 * THE SAME RULE, ONE LEVEL UP, FOR A FOLDER. A leaked archive is a tree of mailboxes, and one
 * damaged file in it must not cost the other thousand — so in folder mode the failure is
 * collected PER FILE and the import goes on. The difference from the plain mode is deliberate:
 * a mistyped source is a typo and stops everything, while a file inside a tree that is being
 * imported anyway is one damaged file among many.
 */

import { statSync } from 'node:fs';

import { classifyMessage, fmt, type KeyStore, _ } from '@stamped/core';
import {
    planFolder,
    readMboxFile,
    readSource,
    splitMessage,
    summarise,
    type MboxFlavour,
    type SourceMessage,
} from '@stamped/import';
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
import { writeUnsignedHeaders } from './unsigned-headers.ts';
import {
    alreadyImported,
    ensureImportedFiles,
    fileIdentity,
    importedFiles,
    markImported,
    type FileIdentity,
} from './imported-files.ts';
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

/**
 * How a source is read.
 *
 * - `sources` — each source as it is: an mbox, a Maildir, a message, a folder of those. What
 *   the window imports, and what the CLI does for anything that is not a folder of mailboxes.
 * - `folders` — the source is a folder tree: every folder that holds mail is one mailbox, named
 *   after the folder. Only the CLI does this, and only when it is asked to.
 * - `auto` — a folder that holds `.mbox` files is read as a folder tree, everything else as it
 *   is. The CLI's default.
 */
export type ImportMode = 'sources' | 'folders' | 'auto';

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
    /** How a source is read. `sources` unless the caller says otherwise. */
    readonly mode?: ImportMode;
}

/** Where an import has got to. */
export interface ImportProgress {
    readonly read: number;
    readonly stored: number;
    readonly duplicates: number;
    readonly indexed: number;
    readonly failed: number;
    /**
     * Bytes read out of the sources so far, across the whole run.
     *
     * Optional because a caller may synthesise a progress snapshot (the closing jsonl line
     * does); the importer always fills it. It is what makes one percentage span a multi-source
     * run — `total` is the current source's.
     */
    readonly bytesRead?: number;
    /** Messages of the current source still to verify and index, once its read pass is done. */
    readonly total: number;
    /** Of {@link total}, how many are processed. */
    readonly done: number;
    /** The mailbox being imported, when the layout names one. */
    readonly mailbox?: string;
}

/** A file that could not be read. The import went on without it. */
export interface ImportFailure {
    /** The file. */
    readonly path: string;
    /** Why it could not be read. */
    readonly reason: string;
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
    /** The mailboxes a folder tree held. 0 when the sources were not a folder tree. */
    readonly mailboxes: number;
    /**
     * The mailbox the run ended in — the last one it read.
     *
     * The closing progress line is about the whole run, and the run has no single mailbox; this
     * is the one the import finished in, so the line can still say where it stopped.
     */
    readonly lastMailbox?: string;
    /** The mail files that were read. One per source in the plain mode. */
    readonly files: number;
    /** The files that were left alone because they are not mail. */
    readonly skipped: number;
    /** The mail files an earlier, interrupted run had already read and indexed in full. */
    readonly resumed: number;
    /** The files that could not be read. The import went on without them. */
    readonly failures: readonly ImportFailure[];
}

/** One thing to read: a file, a folder, a Maildir — or one part of a mailbox. */
interface Part {
    readonly path: string;
    /** `source` is read as the general reader reads it; the others know what they are. */
    readonly kind: 'source' | 'mbox' | 'eml' | 'maildir';
}

/** One mailbox, or one plain source: what a single run of the importer reads. */
interface Unit {
    /** The mailbox the messages belong to, when the layout names one. */
    readonly mailbox?: string;
    /** The files to read, in order. */
    readonly parts: readonly Part[];
    /** Collect a read failure instead of letting it end the import. */
    readonly collect: boolean;
}

/** What one source turned out to be. */
interface SourcePlan {
    readonly units: readonly Unit[];
    readonly mailboxes: number;
    readonly skipped: number;
    /** The folders of the tree that could not be read at all. */
    readonly failures: readonly ImportFailure[];
}

/**
 * Import every message under each source path into the case.
 *
 * Idempotent: running it again over the same archive stores nothing, logs the messages as
 * duplicates and leaves the index as it was. That is what makes an interrupted import simply
 * runnable again rather than something to clean up first. A file an earlier run finished in full
 * is not even read again — see `imported-files.ts`.
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
    let bytesRead = 0;
    let files = 0;
    let mailboxes = 0;
    let skipped = 0;
    let resumed = 0;
    let lastMailbox: string | undefined;
    let pending: ImportLogEntry[] = [];
    const madeDirs = new Set<string>();
    const failures: ImportFailure[] = [];
    // One scan instead of a query per message. A hash added during this run goes in too, so a
    // message met twice is verified once.
    const known = indexedHashes(db);
    ensureImportedFiles(db);
    const ledger = importedFiles(db);

    const flush = (): void => {
        appendLog(paths, pending);
        pending = [];
    };
    const snapshot = (mailbox?: string): ImportProgress => ({
        read,
        stored,
        duplicates,
        indexed,
        failed,
        total,
        done,
        bytesRead,
        ...(mailbox === undefined ? {} : { mailbox }),
    });

    try {
        for (const source of sources) {
            const plan = planSource(source, options.mode ?? 'sources');
            mailboxes += plan.mailboxes;
            skipped += plan.skipped;
            failures.push(...plan.failures);

            for (const unit of plan.units) {
                if (unit.mailbox !== undefined) lastMailbox = unit.mailbox;
                // Collected rather than verified inside the callback: `readSource` is synchronous —
                // it has to be, GJS has no always-on event loop to pump a stream with — while
                // `verifyMessage` is not. Buffering the whole archive would defeat the streaming,
                // so each message is stored and logged in the callback (both synchronous) and
                // only its HASH is carried out to be verified afterwards. That keeps the memory
                // ceiling at one message plus a list of hashes.
                const fresh: { hash: string; bytes: number }[] = [];
                // Whether the last failure was a WRITE rather than a read. A full disk or a
                // read-only case folder is not one damaged file among many — it ends the import
                // with the message that says what to do about it.
                let writeFailed = false;

                // The reader hands every message over here, and this is where a message is
                // stored and logged. The same function for a plain source and for a part of a
                // mailbox: the difference between them is the name the mailbox goes by, not what
                // happens to the message.
                const emit = (message: SourceMessage): void => {
                    read++;
                    bytesRead += message.raw.length;
                    let result: ReturnType<typeof store>;
                    try {
                        result = store(paths, message.raw, madeDirs);
                    } catch (error) {
                        writeFailed = true;
                        throw error;
                    }
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
                        ...(message.mailbox === undefined ? {} : { mailbox: message.mailbox }),
                    });
                    if (pending.length >= LOG_BATCH) flush();

                    // Already indexed by an earlier run, or met twice in this one: the row would
                    // be identical, and re-verifying it costs the same as verifying a new message.
                    if (known.has(result.hash)) return;
                    known.add(result.hash);
                    fresh.push({ hash: result.hash, bytes: message.raw.length });
                };

                const readOptions = {
                    flavour: options.flavour,
                    ...(unit.mailbox === undefined ? {} : { mailbox: unit.mailbox }),
                };

                // The files of this unit read to the end. They go into the ledger only together with
                // the index rows of their messages, and only when every one of those got a row: a
                // message whose verification failed must be met again by the next run.
                const finished: FileIdentity[] = [];
                const failedBefore = failed;

                for (const part of unit.parts) {
                    const identity = fileIdentity(part.path);
                    if (identity !== undefined && alreadyImported(ledger, identity)) {
                        resumed++;
                        bytesRead += identity.size;
                        continue;
                    }
                    let found = 0;
                    writeFailed = false;
                    try {
                        found =
                            part.kind === 'mbox'
                                ? readMboxFile(part.path, emit, readOptions)
                                : readSource(part.path, emit, readOptions);
                    } catch (error) {
                        // A file that cannot be read is a failure OF THAT FILE, and the rest of
                        // the tree still gets imported. The two exceptions are a mistyped source
                        // in the plain mode, where there is no "the rest" to go on to, and a
                        // write that failed — the case folder not being writable is not one
                        // damaged file among many.
                        if (writeFailed || !unit.collect) throw error;
                        failures.push({ path: part.path, reason: reasonOf(error) });
                        continue;
                    }
                    files++;
                    if (part.kind === 'mbox' && found === 0) {
                        // A part of a mailbox that holds no message is a damaged archive, not an
                        // empty mailbox. It is reported, because an archive that silently loses
                        // a part is an archive whose report covers less than it claims.
                        failures.push({
                            path: part.path,
                            reason: fmt(_('{path} holds no messages.'), { path: part.path }),
                        });
                    } else if (identity !== undefined) {
                        finished.push(identity);
                    }
                }
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
                                const finding = classifyMessage(
                                    await verifyMessage(raw, { keys: options.keys }),
                                );
                                const sm = summarise(raw);
                                // `fresh`: not in the index (checked via `known`), so no removal scan.
                                indexMessage(
                                    db,
                                    { hash: entry.hash, bytes: entry.bytes, summary: sm, finding },
                                    { fresh: true },
                                );
                                // The header is in hand already: cache it, no re-read later.
                                if (finding.verdict === 'unsigned') {
                                    writeUnsignedHeaders(db, entry.hash, splitMessage(raw).header);
                                }
                                indexed++;
                            } catch (error) {
                                // Stored and logged already, so the evidence is safe; only the verdict
                                // is missing. Reported as a count rather than swallowed. The hash as
                                // path is deliberate — an index error has no file, the hash is the
                                // nearest location there is. The reason goes with it, because a
                                // failure that shows up only as a number is not debuggable.
                                failed++;
                                failures.push({ path: entry.hash, reason: reasonOf(error) });
                            }
                        }
                        done++;
                        inBatch++;
                        options.onProgress?.(snapshot(unit.mailbox));
                        if (inBatch >= INDEX_BATCH) {
                            commitBatch(db);
                            inBatch = 0;
                            options.onBatch?.(snapshot(unit.mailbox));
                        }
                    }
                    if (failed === failedBefore && finished.length > 0) {
                        if (inBatch === 0) beginBatch(db);
                        markImported(db, finished);
                        commitBatch(db);
                    } else if (inBatch > 0) {
                        commitBatch(db);
                    }
                    // One line per mailbox, ALWAYS — also for a mailbox that held no message at
                    // all. A progress stream that skips the empty ones cannot say that a
                    // mailbox was empty, and "no line" reads like "not reached yet".
                    options.onBatch?.(snapshot(unit.mailbox));
                } catch (error) {
                    rollbackBatch(db);
                    throw error;
                }
                await settleSiblings(db, paths, options.keys);
            }
        }
    } finally {
        flush();
        db.close();
    }

    return {
        read,
        stored,
        duplicates,
        indexed,
        failed,
        mailboxes,
        ...(lastMailbox === undefined ? {} : { lastMailbox }),
        files,
        skipped,
        resumed,
        failures,
    };
}

/**
 * What one source turned out to be: a folder tree of mailboxes, or a plain source.
 *
 * The plain mode reads a source as it is and lets a broken one end the import — a mistyped path
 * is a typo, and half a case folder with no sign of where it stopped is worse than an error.
 * The folder mode collects the failures instead, because a tree of a thousand mailboxes with one
 * damaged file in it is the normal case for a leak.
 */
function planSource(source: string, mode: ImportMode): SourcePlan {
    const plain: SourcePlan = {
        units: [{ parts: [{ path: source, kind: 'source' }], collect: false }],
        mailboxes: 0,
        skipped: 0,
        failures: [],
    };
    if (mode === 'sources') return plain;

    if (!isDirectory(source)) {
        if (mode === 'folders') {
            throw new Error(fmt(_('{path} is not a folder.'), { path: source }));
        }
        return plain;
    }

    const plan = planFolder(source);
    const hasMailbox = plan.mailboxes.length > 0;
    const hasMbox = plan.mailboxes.some((mailbox) => mailbox.parts.some((part) => part.kind === 'mbox'));
    if (!hasMailbox) {
        if (mode === 'folders') {
            throw new Error(fmt(_('{path} holds no mail files.'), { path: source }));
        }
        return plain;
    }
    // In the automatic mode a folder of loose `.eml` files is still a folder of messages, and is
    // read as one — the tree of mailboxes is for a tree of mbox PARTS.
    if (mode === 'auto' && !hasMbox) return plain;

    // A folder that could not be listed is a failure, not a file that was left alone: the import
    // cannot say what is in it, and the report covers less than the archive.
    const failures = plan.skipped
        .filter((file) => file.reason === 'unreadable')
        .map((file) => ({ path: file.path, reason: fmt(_('Cannot read {path}.'), { path: file.path }) }));

    return {
        units: plan.mailboxes.map((mailbox) => ({
            mailbox: mailbox.name,
            parts: mailbox.parts.map((part) => ({ path: part.path, kind: part.kind })),
            collect: true,
        })),
        mailboxes: plan.mailboxes.length,
        skipped: plan.skipped.length - failures.length,
        failures,
    };
}

/** Is this path a folder? A path that cannot be read is not one — and the reader will say so. */
function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** The message of a failure, without the stack. */
function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
