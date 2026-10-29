/**
 * The vectors of a case, resident in memory: one contiguous Float32Array and a list of hashes.
 *
 * WHY THIS EXISTS: `searchVectors` reads every row out of SQLite on every query. On GJS that is
 * ~9 s and a 2.6 GB peak at 100,000 vectors, of which the dot products are 0.33 s — the cost is
 * the read, not the maths. A process that asks SQLite once and then searches memory pays the read
 * once and every query after that only the dot products.
 *
 * PURE: the rows come through {@link VectorRowSource}, so the index is tested without SQLite and
 * the SQLite side (`resident-vectors.ts`) stays a thin reader.
 *
 * BOUNDED WHILE LOADING: rows come in rowid-ordered batches, each copied into the big array and
 * dropped, so the transient cost is one batch, not a second copy of the table. Between batches
 * the loop yields, so the process that owns the index keeps answering its pipe, and collects
 * garbage: each batch leaves result objects whose memory is native (measured on libgda), so GJS sees a small
 * heap and never collects on its own. Without that, 400,000 vectors (a 1.2 GB array) peaked at
 * 4.56 GB on GJS; with one collection per batch, 1.38 GB, at about the same load time (#162).
 *
 * SCORES ARE THE ONES `searchVectors` gives. Stored vectors are normalised by the embedder, but
 * the cosine still divides by both norms (a truncated vector is not unit length), so the norm of
 * every stored vector is computed once at load, in the same order and in the same double
 * arithmetic, and the query's once per search. Same operations, same bits.
 */

import { collectGarbage } from './runtime.ts';

/** One stored vector, as the table has it. */
export interface VectorRow {
    /** SQLite's rowid: strictly increasing for new inserts, the cursor of an incremental refresh. */
    readonly rowid: number;
    readonly hash: string;
    /** The little-endian float32 bytes of the vector. */
    readonly vector: Uint8Array;
}

/** Where the rows come from. Synchronous, because the SQLite binding is. */
export interface VectorRowSource {
    /** At most `limit` rows with `rowid > after`, in rowid order. */
    readAfter(after: number, limit: number): VectorRow[];
    /** How many rows there are; sizes the first allocation. */
    count(): number;
    /** The highest rowid, or 0 for an empty table. A value below the last one seen means a reset. */
    maxRowid(): number;
}

export interface VectorIndexOptions {
    /** Rows per batch. Default {@link DEFAULT_LOAD_BATCH}. */
    readonly batchSize?: number;
    /** Called between batches so the caller's event loop can breathe. Default a macrotask. */
    readonly yieldTo?: () => Promise<void>;
    /** Called after every batch with the number of vectors held so far. */
    readonly onProgress?: (loaded: number) => void;
}

export interface VectorHit {
    readonly hash: string;
    readonly score: number;
}

/** Rows per batch: ~6 MB of blobs at 768 dimensions, small enough to bound the transient copy. */
export const DEFAULT_LOAD_BATCH = 2000;

/** Spare room on every allocation, so the indexer's next batches do not each copy the whole array. */
const GROWTH = 0.25;
const MIN_SPARE_SLOTS = 4096;

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class VectorIndex {
    readonly dimensions: number;

    private readonly source: VectorRowSource;
    private readonly batchSize: number;
    private readonly yieldTo: () => Promise<void>;
    private readonly onProgress: ((loaded: number) => void) | undefined;

    private data: Float32Array;
    private norms: Float64Array;
    private hashes: string[] = [];
    private slots = new Map<string, number>();
    private used = 0;
    private lastRowid = 0;
    private skippedRows = 0;

    constructor(source: VectorRowSource, dimensions: number, options: VectorIndexOptions = {}) {
        if (!Number.isInteger(dimensions) || dimensions <= 0) {
            throw new Error('A vector index needs a positive dimension count.');
        }
        this.source = source;
        this.dimensions = dimensions;
        this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_LOAD_BATCH));
        this.yieldTo = options.yieldTo ?? nextMacrotask;
        this.onProgress = options.onProgress;
        this.data = new Float32Array(0);
        this.norms = new Float64Array(0);
    }

    /** How many vectors are searchable. */
    get size(): number {
        return this.used;
    }

    /** The highest rowid read so far. */
    get cursor(): number {
        return this.lastRowid;
    }

    /** Rows that could not be used: a blob of the wrong length, or a vector of zeros. */
    get skipped(): number {
        return this.skippedRows;
    }

    /** Forget everything; the next {@link load} starts from the first row. */
    clear(): void {
        this.data = new Float32Array(0);
        this.norms = new Float64Array(0);
        this.hashes = [];
        this.slots = new Map();
        this.used = 0;
        this.lastRowid = 0;
        this.skippedRows = 0;
    }

    /** Read the whole table, batch by batch. Start over when something was loaded before. */
    async load(): Promise<void> {
        this.clear();
        this.reserve(this.source.count());
        await this.readNewRows();
    }

    /**
     * Pick up what was written since the last read, and report whether the table was reset.
     *
     * A reset — the indexer dropped and recreated the table, so rowids start again — shows as a
     * highest rowid BELOW the cursor: inserts only ever go above it. Then the index is reloaded
     * from scratch, which is the only way to a state that matches the table again.
     */
    async refresh(): Promise<'unchanged' | 'extended' | 'reloaded'> {
        const top = this.source.maxRowid();
        if (top < this.lastRowid) {
            await this.load();
            return 'reloaded';
        }
        if (top === this.lastRowid) return 'unchanged';
        const before = this.used;
        const cursor = this.lastRowid;
        await this.readNewRows();
        return this.used !== before || this.lastRowid !== cursor ? 'extended' : 'unchanged';
    }

    /**
     * The best matches for a query vector, best first: highest score, ties by hash — the order
     * `searchVectors` gives. A bounded top-N: a heap of `limit` entries, never a sort of all scores.
     */
    search(query: Float32Array, limit: number): VectorHit[] {
        if (query.length !== this.dimensions) {
            throw new Error(`The query has ${query.length} dimensions, the vectors have ${this.dimensions}.`);
        }
        const wanted = Math.min(Math.trunc(limit), this.used);
        if (!(wanted > 0)) return [];

        let queryNorm = 0;
        for (let i = 0; i < query.length; i++) queryNorm += query[i] * query[i];
        if (queryNorm === 0) return [];
        const queryRoot = Math.sqrt(queryNorm);

        const { data, norms, hashes, dimensions } = this;
        const heap = new TopN(wanted, hashes);
        for (let slot = 0, offset = 0; slot < this.used; slot++, offset += dimensions) {
            let dot = 0;
            for (let i = 0; i < dimensions; i++) dot += query[i] * data[offset + i];
            const score = dot / (queryRoot * norms[slot]);
            // NaN and infinities are not matches; `searchVectors` drops them the same way.
            if (Number.isFinite(score)) heap.offer(slot, score);
        }
        return heap.best();
    }

    private async readNewRows(): Promise<void> {
        for (;;) {
            const rows = this.source.readAfter(this.lastRowid, this.batchSize);
            if (rows.length === 0) return;
            this.reserve(this.used + rows.length);
            for (const row of rows) this.add(row);
            this.lastRowid = rows[rows.length - 1].rowid;
            this.onProgress?.(this.used);
            collectGarbage();
            if (rows.length < this.batchSize) return;
            await this.yieldTo();
        }
    }

    private add(row: VectorRow): void {
        const { dimensions } = this;
        if (row.vector.length !== dimensions * 4) {
            this.skippedRows++;
            return;
        }
        // A replaced vector (INSERT OR REPLACE gives the row a new rowid) overwrites its slot.
        const known = this.slots.get(row.hash);
        const slot = known ?? this.used;
        const offset = slot * dimensions;
        this.write(row.vector, offset);
        let norm = 0;
        for (let i = 0; i < dimensions; i++) norm += this.data[offset + i] * this.data[offset + i];
        if (norm === 0 || !Number.isFinite(norm)) {
            // A vector without a direction never matches. A replaced slot must not keep the old one.
            this.skippedRows++;
            if (known !== undefined) this.norms[known] = Number.NaN;
            return;
        }
        this.norms[slot] = Math.sqrt(norm);
        if (known === undefined) {
            this.hashes.push(row.hash);
            this.slots.set(row.hash, slot);
            this.used++;
        }
    }

    private write(bytes: Uint8Array, offset: number): void {
        if (LITTLE_ENDIAN) {
            new Uint8Array(this.data.buffer, this.data.byteOffset + offset * 4, bytes.length).set(bytes);
            return;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < this.dimensions; i++) this.data[offset + i] = view.getFloat32(i * 4, true);
    }

    /** Room for at least `slots` vectors, with spare so a growing table does not copy every batch. */
    private reserve(slots: number): void {
        if (slots * this.dimensions <= this.data.length) return;
        const target = slots + Math.max(MIN_SPARE_SLOTS, Math.ceil(slots * GROWTH));
        const data = new Float32Array(target * this.dimensions);
        data.set(this.data.subarray(0, this.used * this.dimensions));
        const norms = new Float64Array(target);
        norms.set(this.norms.subarray(0, this.used));
        this.data = data;
        this.norms = norms;
    }
}

/**
 * A bounded min-heap of the best `capacity` candidates: the root is the worst one kept, so a
 * candidate is compared with one entry, not with the list.
 */
class TopN {
    private readonly capacity: number;
    private readonly hashes: readonly string[];
    private readonly slots: Int32Array;
    private readonly scores: Float64Array;
    private count = 0;

    constructor(capacity: number, hashes: readonly string[]) {
        this.capacity = capacity;
        this.hashes = hashes;
        this.slots = new Int32Array(capacity);
        this.scores = new Float64Array(capacity);
    }

    offer(slot: number, score: number): void {
        if (this.count < this.capacity) {
            const at = this.count++;
            this.slots[at] = slot;
            this.scores[at] = score;
            this.siftUp(at);
            return;
        }
        if (!this.beats(slot, score, this.slots[0], this.scores[0])) return;
        this.slots[0] = slot;
        this.scores[0] = score;
        this.siftDown(0);
    }

    /** Best first: score descending, then hash ascending. */
    best(): VectorHit[] {
        const hits: VectorHit[] = [];
        for (let i = 0; i < this.count; i++) {
            hits.push({ hash: this.hashes[this.slots[i]], score: this.scores[i] });
        }
        hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.hash < b.hash ? -1 : 1));
        return hits;
    }

    /** Is the first candidate better than the second? Equal scores: the smaller hash is better. */
    private beats(slotA: number, scoreA: number, slotB: number, scoreB: number): boolean {
        if (scoreA !== scoreB) return scoreA > scoreB;
        return this.hashes[slotA] < this.hashes[slotB];
    }

    private worse(i: number, j: number): boolean {
        return this.beats(this.slots[j], this.scores[j], this.slots[i], this.scores[i]);
    }

    private swap(i: number, j: number): void {
        const slot = this.slots[i];
        const score = this.scores[i];
        this.slots[i] = this.slots[j];
        this.scores[i] = this.scores[j];
        this.slots[j] = slot;
        this.scores[j] = score;
    }

    private siftUp(from: number): void {
        let i = from;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.worse(i, parent)) return;
            this.swap(i, parent);
            i = parent;
        }
    }

    private siftDown(from: number): void {
        let i = from;
        for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let worst = i;
            if (left < this.count && this.worse(left, worst)) worst = left;
            if (right < this.count && this.worse(right, worst)) worst = right;
            if (worst === i) return;
            this.swap(i, worst);
            i = worst;
        }
    }
}
