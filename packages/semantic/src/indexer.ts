/**
 * The background indexer: walks the messages of the case in priority order and fills the
 * vector database, a batch at a time.
 *
 * THE DOCUMENT SOURCE IS AN INTERFACE, not `@stamped/store`: this package stays free of the
 * store and of mailauth, and the indexer is tested without an index. `@stamped/store` ships the
 * adapter over the real index (`indexDocumentSource`); a test passes a list.
 *
 * RESUMABLE BY CONSTRUCTION: nothing is remembered between runs except the vectors themselves.
 * Every run walks the source from the top and asks the vector table which hashes are still
 * missing, so a crash, a stop or a power cut loses at most the batch that was being embedded —
 * `putVectors` is one transaction, a batch lands whole or not at all.
 *
 * ORDER: the source's own. The adapter hands over newest first, undated last (the order of the
 * message list), so the mail a journalist looks at first is searchable first.
 *
 * PAUSING never interrupts an embedding in flight — a model call cannot be cancelled — it takes
 * effect at the next batch boundary. Two causes, one effect: `pause()` (a person's choice) and
 * the `shouldPause` predicate (a condition, polled; on battery, say).
 */

import type { DatabaseSync } from 'node:sqlite';

import { checkVector } from './embedder.ts';
import type { Embedder } from './embedder.ts';
import { countVectors, missingVectors, putVectors } from './vector-db.ts';

/** A message as the indexer lists it: enough to order, resume and look it up. */
export interface SourceEntry {
    readonly hash: string;
    /** Epoch milliseconds from the `Date` header; absent when it could not be read. */
    readonly sentAt?: number;
}

/** A message as the embedder gets it. */
export interface SourceDocument {
    readonly hash: string;
    readonly subject: string;
    readonly body: string;
}

export interface DocumentSource {
    /** How many messages the source holds. */
    count(): number;
    /** The next `limit` entries in priority order, strictly after `after` (the start when absent). */
    next(after: SourceEntry | undefined, limit: number): SourceEntry[];
    /** The text of these messages. A hash the source no longer has is left out. */
    read(hashes: readonly string[]): SourceDocument[];
}

export type IndexerState = 'idle' | 'running' | 'paused' | 'finished' | 'stopped' | 'failed';

export interface IndexerProgress {
    readonly state: IndexerState;
    /** Messages that have a vector, from earlier runs and this one. */
    readonly done: number;
    readonly total: number;
    /** Embedded by this run. */
    readonly embedded: number;
    /** Messages the embedder refused; they are tried again by the next run. */
    readonly skipped: number;
    /** Messages per second while working — time spent paused does not count. Absent before the first batch. */
    readonly rate?: number;
    readonly etaSeconds?: number;
}

export interface IndexerResult extends IndexerProgress {
    readonly skippedHashes: readonly string[];
}

export interface IndexerOptions {
    readonly embedder: Embedder;
    readonly source: DocumentSource;
    /** Opened with `openVectorDb` for THIS embedder's model id and dimensions. */
    readonly vectors: DatabaseSync;
    /** Documents per `embedDocuments` call and per transaction. */
    readonly batchSize?: number;
    /** Entries listed (and texts read) at a time; larger than a batch, so the source is asked less often. */
    readonly pageSize?: number;
    /** Asked before every batch; true holds the run until it turns false. */
    readonly shouldPause?: () => boolean;
    /** How often a true `shouldPause` is asked again. */
    readonly pollMs?: number;
    /** Milliseconds clock; injectable so that rate and ETA are testable. */
    readonly now?: () => number;
    readonly onProgress?: (progress: IndexerProgress) => void;
}

export interface Indexer {
    readonly state: IndexerState;
    progress(): IndexerProgress;
    /** Resolves when the source is exhausted or `stop()` was called; rejects when the embedder keeps failing. */
    run(): Promise<IndexerResult>;
    /** Hold at the next batch boundary. */
    pause(): void;
    resume(): void;
    /** End `run()` at the next batch boundary. Everything written so far stays. */
    stop(): void;
}

export const DEFAULT_BATCH_SIZE = 16;
export const DEFAULT_PAGE_SIZE = 128;
export const DEFAULT_POLL_MS = 5000;

/**
 * One document the embedder cannot handle is skipped; this many in a row means the embedder
 * itself is broken, and going on would "skip" the whole archive.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Is this vector table for this model? A table built for another one would be mixed, not replaced. */
function assertCompatible(vectors: DatabaseSync, embedder: Embedder): void {
    let model: string | undefined;
    let dimensions: number | undefined;
    try {
        const rows = vectors.prepare("SELECT key, value FROM meta WHERE key IN ('modelId', 'dimensions')").all() as {
            key: string;
            value: string;
        }[];
        for (const row of rows) {
            if (row.key === 'modelId') model = row.value;
            else dimensions = Number(row.value);
        }
    } catch {
        // no meta table: falls through to the error below
    }
    if (model !== embedder.modelId || dimensions !== embedder.dimensions) {
        throw new Error(
            'The vector database was not opened for this embedder. Open it with openVectorDb and the embedder\'s model id and dimensions.',
        );
    }
}

export function createIndexer(options: IndexerOptions): Indexer {
    const { embedder, source, vectors } = options;
    const batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE));
    const pageSize = Math.max(batchSize, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE));
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const now = options.now ?? Date.now;

    let state: IndexerState = 'idle';
    let running = false;
    let manualPause = false;
    let stopRequested = false;
    let wake: (() => void) | undefined;
    /**
     * A `stop()` or `resume()` that arrives while nobody is waiting must not be lost. The gate
     * emits progress SYNCHRONOUSLY on its way into a pause, so a listener — a window wiring its
     * Stop button to the paused state is the obvious one — can call either between the gate's
     * last look at the flags and the wait that follows it. Without this the run parks on a wake
     * that has already happened and never comes back.
     */
    let wakePending = false;

    let baseline = 0;
    let total = 0;
    let embedded = 0;
    let workMs = 0;
    let failures = 0;
    let skippedHashes: string[] = [];

    const progress = (): IndexerProgress => {
        const done = baseline + embedded;
        const rate = embedded > 0 && workMs > 0 ? embedded / (workMs / 1000) : undefined;
        const remaining = Math.max(0, Math.max(total, done) - done - skippedHashes.length);
        return {
            state,
            done,
            total: Math.max(total, done),
            embedded,
            skipped: skippedHashes.length,
            ...(rate !== undefined ? { rate, etaSeconds: remaining / rate } : {}),
        };
    };

    const emit = (): void => {
        try {
            options.onProgress?.(progress());
        } catch {
            // a listener's error is not the index's
        }
    };

    const setState = (next: IndexerState): void => {
        if (state === next) return;
        state = next;
        emit();
    };

    /** Wake whoever is waiting, and remember the wake for whoever is about to. */
    const signalWake = (): void => {
        wakePending = true;
        wake?.();
    };

    /** Sleep until `signalWake()` or, when given, `ms` have passed. */
    const waitWake = (ms?: number): Promise<void> =>
        new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = (): void => {
                if (timer !== undefined) clearTimeout(timer);
                wake = undefined;
                wakePending = false;
                resolve();
            };
            if (wakePending) {
                done();
                return;
            }
            wake = done;
            if (ms !== undefined) timer = setTimeout(done, ms);
        });

    const conditionHolds = (): boolean => {
        try {
            return options.shouldPause?.() === true;
        } catch {
            // a predicate that cannot answer must not stall the index forever
            return false;
        }
    };

    /** Returns when work may go on, or when a stop was asked. */
    const gate = async (): Promise<void> => {
        for (;;) {
            if (stopRequested) return;
            if (manualPause) {
                setState('paused');
                await waitWake();
            } else if (conditionHolds()) {
                setState('paused');
                await waitWake(pollMs);
            } else {
                setState('running');
                return;
            }
        }
    };

    const embedAll = async (docs: readonly SourceDocument[]): Promise<[string, Float32Array][]> => {
        const out = await embedder.embedDocuments(docs.map((doc) => ({ subject: doc.subject, body: doc.body })));
        if (out.length !== docs.length) throw new Error('embedder returned the wrong number of vectors');
        return docs.map((doc, i) => {
            const vector = out[i];
            if (vector.length !== embedder.dimensions) throw new Error('embedder returned a vector of the wrong size');
            checkVector(vector);
            return [doc.hash, vector] as [string, Float32Array];
        });
    };

    const skip = (doc: SourceDocument, cause: unknown): void => {
        skippedHashes.push(doc.hash);
        failures++;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error('The embedder failed on several messages in a row; stopping.', { cause });
        }
    };

    /** A failing batch is retried message by message, so one bad message costs one message. */
    const embedBatch = async (docs: readonly SourceDocument[]): Promise<[string, Float32Array][]> => {
        try {
            const entries = await embedAll(docs);
            failures = 0;
            return entries;
        } catch (error) {
            if (docs.length === 1) {
                skip(docs[0], error);
                return [];
            }
            const entries: [string, Float32Array][] = [];
            for (const doc of docs) {
                try {
                    entries.push(...(await embedAll([doc])));
                    failures = 0;
                } catch (single) {
                    skip(doc, single);
                }
            }
            return entries;
        }
    };

    const walk = async (): Promise<void> => {
        let cursor: SourceEntry | undefined;
        for (;;) {
            await gate();
            if (stopRequested) return;
            const page = source.next(cursor, pageSize);
            if (page.length === 0) return;
            cursor = page[page.length - 1];

            const missing = missingVectors(
                vectors,
                page.map((entry) => entry.hash),
            );
            if (missing.length === 0) continue;
            const byHash = new Map(source.read(missing).map((doc) => [doc.hash, doc] as const));
            const docs = missing.map((hash) => byHash.get(hash)).filter((doc): doc is SourceDocument => doc !== undefined);

            for (let i = 0; i < docs.length; i += batchSize) {
                await gate();
                if (stopRequested) return;
                const started = now();
                const entries = await embedBatch(docs.slice(i, i + batchSize));
                putVectors(vectors, entries);
                workMs += now() - started;
                embedded += entries.length;
                emit();
            }
        }
    };

    return {
        get state(): IndexerState {
            return state;
        },
        progress,
        async run(): Promise<IndexerResult> {
            if (running) throw new Error('The indexer is already running.');
            assertCompatible(vectors, embedder);
            running = true;
            stopRequested = false;
            wakePending = false;
            embedded = 0;
            workMs = 0;
            failures = 0;
            skippedHashes = [];
            total = source.count();
            baseline = Math.min(countVectors(vectors), total);
            try {
                state = 'idle';
                setState('running');
                await walk();
                setState(stopRequested ? 'stopped' : 'finished');
            } catch (error) {
                setState('failed');
                throw error;
            } finally {
                running = false;
            }
            return { ...progress(), skippedHashes: [...skippedHashes] };
        },
        pause(): void {
            manualPause = true;
        },
        resume(): void {
            manualPause = false;
            signalWake();
        },
        stop(): void {
            stopRequested = true;
            signalWake();
        },
    };
}
