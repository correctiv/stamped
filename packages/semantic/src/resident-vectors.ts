/**
 * The case's vectors, resident in the process that answers queries.
 *
 * Wraps {@link VectorIndex} with the part that is about `vectors.db` and its other writer: the
 * indexing subprocess keeps writing it while this reader holds a connection (WAL, busy_timeout —
 * `tuneConnection`), so every search first looks at what changed.
 *
 * - **Not there yet** (no file, or a table made by another model): the state is `none`, nothing
 *   is held, and the next search looks again. Never creates or rebuilds the file.
 * - **Grown**: only rows above the last rowid are read.
 * - **Reset** (the indexer started the table over): reloaded from scratch, see `VectorIndex.refresh`.
 * - **Another model** (the meta says so): everything is let go; a window and a helper that
 *   disagree about the model must not search each other's numbers.
 *
 * One chain of work: a load and a search never interleave, so a search sees a whole batch or none.
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { openVectorDbForSearch, sqliteVectorSource, vectorDbMatches } from './vector-db.ts';
import type { VectorDbOptions } from './vector-db.ts';
import { VectorIndex } from './vector-index.ts';
import type { VectorHit, VectorIndexOptions } from './vector-index.ts';

export type ResidentState = 'loading' | 'ready' | 'none';

export interface ResidentVectorsOptions extends VectorIndexOptions {
    /** `<case>/vectors.db`. */
    readonly path: string;
    /** The model the query is embedded with. */
    readonly model: VectorDbOptions;
    /** Told when the state changes, with how many vectors are held. */
    readonly onState?: (state: ResidentState, count: number) => void;
    /** Test seam: open the database. Default {@link openVectorDbForSearch}. */
    readonly open?: (path: string, model: VectorDbOptions) => DatabaseSync | undefined;
}

export class ResidentVectors {
    private readonly options: ResidentVectorsOptions;
    private db: DatabaseSync | undefined;
    private index: VectorIndex | undefined;
    private tail: Promise<unknown> = Promise.resolve();
    private lastState: ResidentState | undefined;

    constructor(options: ResidentVectorsOptions) {
        this.options = options;
    }

    /** How many vectors are searchable right now. */
    get size(): number {
        return this.index?.size ?? 0;
    }

    /** Load in the background. Resolves when the first read is done; never rejects. */
    load(): Promise<void> {
        this.announce('loading');
        return this.enqueue(async () => {
            await this.sync();
        }).catch(() => undefined);
    }

    /** Bring the index up to date, then search it. Empty when there is nothing to search. */
    search(query: Float32Array, limit: number): Promise<VectorHit[]> {
        return this.enqueue(async () => {
            await this.sync();
            return this.index === undefined ? [] : this.index.search(query, limit);
        });
    }

    /** Let go of the connection and the memory. */
    close(): void {
        void this.enqueue(async () => {
            this.drop();
        }).catch(() => undefined);
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const run = this.tail.then(work);
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private announce(state: ResidentState): void {
        if (this.lastState === state && state !== 'ready') return;
        this.lastState = state;
        this.options.onState?.(state, this.size);
    }

    private drop(): void {
        this.index?.clear();
        this.index = undefined;
        try {
            this.db?.close();
        } catch {
            // already gone
        }
        this.db = undefined;
    }

    private async sync(): Promise<void> {
        try {
            if (this.db === undefined) {
                if (!existsSync(this.options.path)) return this.settle('none');
                const open = this.options.open ?? openVectorDbForSearch;
                this.db = open(this.options.path, this.options.model);
                if (this.db === undefined) return this.settle('none');
            } else if (!vectorDbMatches(this.db, this.options.model)) {
                this.drop();
                return this.settle('none');
            }
            if (this.index === undefined) {
                this.index = new VectorIndex(sqliteVectorSource(this.db), this.options.model.dimensions, {
                    batchSize: this.options.batchSize,
                    yieldTo: this.options.yieldTo,
                    onProgress: this.options.onProgress,
                });
                await this.index.load();
            } else {
                await this.index.refresh();
            }
            this.settle('ready');
        } catch {
            // The table went away or changed under the read (a reset in progress): start over
            // from a fresh connection on the next call, and answer without semantics for now.
            this.settle('none');
        }
    }

    private settle(state: ResidentState): void {
        if (state === 'none') this.drop();
        this.announce(state);
    }
}
