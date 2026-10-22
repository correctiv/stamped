/**
 * Vectors stored in a SEPARATE SQLite file (vectors.db) next to index.db.
 *
 * WHY SEPARATE: index.db is a cache, rebuildable from raw/ in minutes; the vectors cost hours
 * to compute (the spike measured 7.8 h for 100k messages on ten CPU threads). Keeping them in
 * their own file means rebuilding the FTS index never touches the vectors, and a corrupted
 * index never costs the journalist a re-embedding run.
 *
 * VERSIONED BY MODEL: the table records the model id and the dimension count it was built with.
 * A different model id or dimension count DROPS the table and starts over — a vector from one
 * model has no meaning in another, and a mixed table would return confident nonsense. The
 * reindex is expensive, so it happens once, loudly, at open time, rather than silently in the
 * middle of a search.
 *
 * BLOBS, NOT TEXT: a vector is 768 float32s. As a BLOB of little-endian float32s it is half
 * the size of the decimal text, and it round-trips exactly — a text encoding would lose bits
 * to float32's decimal representation.
 */

import { DatabaseSync } from 'node:sqlite';

export interface VectorDbOptions {
    /** Identifies the model that produced the vectors; a different one means a reindex. */
    readonly modelId: string;
    /** How many float32s a vector has; a different count means a reindex. */
    readonly dimensions: number;
}

export interface VectorSearchHit {
    readonly hash: string;
    /** Cosine similarity against the query, in [-1, 1]. */
    readonly score: number;
}

/** Bumped whenever the table's columns change; an older table is dropped, not migrated. */
export const VECTOR_SCHEMA_VERSION = 1;

/**
 * The bytes of a blob column.
 *
 * Fixed upstream in gjsify 0.64.4 (gjsify/gjsify#2332): `@gjsify/sqlite` hands BLOB columns
 * back as `Uint8Array` on both runtimes, where GJS used to return a boxed `Gda_Binary` whose
 * bytes only `hex(vector)` could reach. The bump re-measures that under GJS (issue #45 step 5);
 * if a runtime ever hands something else back, `blobBytes` says so.
 */
function blobBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value as number[]);
    throw new Error('This runtime cannot read a vector blob.');
}

/**
 * Open the case's vector database, creating it or starting it over as needed.
 *
 * The caller closes it.
 */
export function openVectorDb(path: string, options: VectorDbOptions): DatabaseSync {
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(path);
    } catch {
        throw new Error(`Cannot open the vector database at ${path}.`);
    }
    if (needsRebuild(db, options)) createSchema(db, options);
    return db;
}

/** Is this table there? Asked instead of `IF NOT EXISTS`, which the SQL splitter of gjsify's
 * `node:sqlite` does not reliably survive. */
function tableExists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

/** The version the database was created at, or 0 when it holds no schema of ours. */
function schemaVersion(db: DatabaseSync): number {
    if (!tableExists(db, 'meta')) return 0;
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
        | { value?: string }
        | undefined;
    return row?.value === undefined ? 0 : Number(row.value);
}

/**
 * Does the table have to be dropped and rebuilt?
 *
 * Either because the schema moved on, or because the vectors in it were made by a different
 * model or a different dimension count — the two cases where the stored numbers would be
 * meaningless rather than merely old.
 */
function needsRebuild(db: DatabaseSync, options: VectorDbOptions): boolean {
    if (schemaVersion(db) !== VECTOR_SCHEMA_VERSION) return true;
    if (!tableExists(db, 'meta')) return true;
    const model = db.prepare("SELECT value FROM meta WHERE key = 'modelId'").get() as
        | { value?: string }
        | undefined;
    const dimensions = db.prepare("SELECT value FROM meta WHERE key = 'dimensions'").get() as
        | { value?: string }
        | undefined;
    if (model?.value !== options.modelId) return true;
    if (Number(dimensions?.value) !== options.dimensions) return true;
    return false;
}

/** Drop whatever is there and lay out the current schema. */
function createSchema(db: DatabaseSync, options: VectorDbOptions): void {
    for (const table of ['vectors', 'meta']) {
        if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`);
    }
    db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE vectors (
            hash TEXT PRIMARY KEY,
            vector BLOB NOT NULL
        );
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(VECTOR_SCHEMA_VERSION));
    db.prepare("INSERT INTO meta (key, value) VALUES ('modelId', ?)").run(options.modelId);
    db.prepare("INSERT INTO meta (key, value) VALUES ('dimensions', ?)").run(String(options.dimensions));
}

/**
 * The vector as bytes.
 *
 * A fresh Uint8Array with the bytes copied in, rather than a view on the Float32Array's
 * buffer: gjsify's `node:sqlite` binds a BLOB from the buffer's own bytes, and a view that
 * starts mid-buffer would hand it the wrong ones.
 */
function vectorToBlob(vector: Float32Array): Uint8Array {
    const bytes = new Uint8Array(vector.byteLength);
    bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
    return bytes;
}

/** The bytes back as float32s, little-endian — the byte order the BLOB was written in. */
function blobToVector(blob: Uint8Array): Float32Array {
    const vector = new Float32Array(blob.length / 4);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    for (let i = 0; i < vector.length; i++) vector[i] = view.getFloat32(i * 4, true);
    return vector;
}

/**
 * Store one vector, replacing whatever was there for that hash.
 *
 * Replacing rather than failing on a conflict: the hash is the identity, and a message that
 * was re-embedded with the same model must end up with the newer vector.
 */
export function putVector(db: DatabaseSync, hash: string, vector: Float32Array): void {
    db.prepare('INSERT OR REPLACE INTO vectors (hash, vector) VALUES (?, ?)').run(hash, vectorToBlob(vector));
}

/**
 * Store many vectors in ONE transaction.
 *
 * The indexer embeds in batches; a transaction per vector would make the write cost
 * dominate, and a crash in the middle of a batch would leave the table half-written. The
 * transaction is all-or-nothing, so a resumed run sees a consistent table.
 */
export function putVectors(db: DatabaseSync, entries: readonly (readonly [string, Float32Array])[]): void {
    if (entries.length === 0) return;
    const statement = db.prepare('INSERT OR REPLACE INTO vectors (hash, vector) VALUES (?, ?)');
    // Separate statements, not one script: gjsify's `node:sqlite` splits a script on every
    // `;`, and a transaction has to be begun and committed as two calls.
    db.exec('BEGIN');
    try {
        for (const [hash, vector] of entries) statement.run(hash, vectorToBlob(vector));
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

/** Is there a vector for this hash? */
export function hasVector(db: DatabaseSync, hash: string): boolean {
    return db.prepare('SELECT 1 AS n FROM vectors WHERE hash = ?').get(hash) !== undefined;
}

/** How many vectors the table holds. */
export function countVectors(db: DatabaseSync): number {
    const row = db.prepare('SELECT count(*) AS n FROM vectors').get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
}

/**
 * Which of these hashes have no vector yet?
 *
 * The question that makes indexing resumable: after a restart, the indexer asks what is
 * still missing instead of starting over.
 */
export function missingVectors(db: DatabaseSync, hashes: readonly string[]): string[] {
    if (hashes.length === 0) return [];
    const statement = db.prepare('SELECT 1 AS n FROM vectors WHERE hash = ?');
    const missing: string[] = [];
    for (const hash of hashes) {
        if (statement.get(hash) === undefined) missing.push(hash);
    }
    return missing;
}

/** Cosine similarity of two vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return Number.NEGATIVE_INFINITY;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The best matches for a query vector, best first.
 *
 * Brute force over every stored vector: a case holds tens of thousands of them, and a scan
 * of that size costs milliseconds — an index structure would only pay off at a scale the
 * archive does not reach, and would cost the ability to change the model.
 */
export function searchVectors(db: DatabaseSync, query: Float32Array, limit: number): VectorSearchHit[] {
    if (limit <= 0) return [];
    const rows = db.prepare(`SELECT hash, vector FROM vectors`).all() as Array<{
        hash: string;
        vector: unknown;
    }>;
    const hits: VectorSearchHit[] = [];
    for (const row of rows) {
        const score = cosine(query, blobToVector(blobBytes(row.vector)));
        if (Number.isFinite(score)) hits.push({ hash: row.hash, score });
    }
    // Ties broken by hash so that the same query always gives the same order: a list that
    // reshuffles between two runs of the same search reads as a bug in the ranking.
    hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.hash < b.hash ? -1 : 1));
    return hits.slice(0, limit);
}
