/**
 * The embedder seam: a boundary around the model runtime.
 *
 * WHY A SEAM: the spike measured EmbeddingGemma 2 through node-llama-cpp, but the choice of
 * backend (node-llama-cpp under @gjsify/napi, or something else) is a packaging concern.
 * Keeping this package model-agnostic means the indexer and the search path can be tested
 * without downloading or loading a GGUF, and a future backend swap does not leak into
 * storage or fusion. This step ships the seam only — no llama dependency.
 */

export interface Embedder {
    readonly modelId: string;
    readonly dimensions: number;
    embedQuery(text: string): Promise<Float32Array>;
    embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

/**
 * A non-finite vector is poison: it will produce NaN/Inf scores and can silently corrupt
 * ordering. The embedder must never return one; this guard exists to catch bugs at the
 * boundary (and matches the issue's requirement to "check every vector").
 */
export function checkVector(v: Float32Array | ArrayLike<number>): boolean {
    if (!v) return false;
    const len = (v as ArrayLike<number>).length;
    if (typeof len !== 'number' || len === 0) return false;
    let norm2 = 0;
    for (let i = 0; i < len; i++) {
        const val = (v as ArrayLike<number>)[i];
        if (!Number.isFinite(val)) {
            throw new Error('embedder returned non-finite value');
        }
        norm2 += val * val;
    }
    // Zero norm means all zeros — unusable for cosine similarity.
    if (norm2 === 0) {
        throw new Error('embedder returned zero-norm vector');
    }
    return true;
}

/** Normalize to unit length in place where possible; returns a new Float32Array copy. */
export function normalize(v: Float32Array | ArrayLike<number>): Float32Array {
    const len = (v as ArrayLike<number>).length;
    if (typeof len !== 'number' || len === 0) {
        throw new Error('cannot normalize empty vector');
    }
    let norm2 = 0;
    for (let i = 0; i < len; i++) {
        const val = (v as ArrayLike<number>)[i];
        if (!Number.isFinite(val)) {
            throw new Error('cannot normalize non-finite vector');
        }
        norm2 += val * val;
    }
    const norm = Math.sqrt(norm2);
    if (norm === 0) {
        throw new Error('cannot normalize zero-norm vector');
    }
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = (v as ArrayLike<number>)[i] / norm;
    }
    return out;
}
