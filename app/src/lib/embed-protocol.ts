/**
 * The wire between the window and `stamped semantic embed`: one JSON object per line.
 *
 * JSON because that is what a pipe can carry on both runtimes (a structured clone is JSON under
 * GJS anyway), and plain lines because a stray log line from a native library must not break it:
 * the reader skips whatever is not one of these.
 *
 * Helper → window: `ready` once the model is loaded, or `unavailable` when this machine has none;
 * then `vectors` messages telling how far the helper's resident copy of the case's vectors is,
 * and one answer per request. Window → helper: `{ id, text }` for a query vector, or
 * `{ id, text, limit }` to have the helper search its resident vectors and answer with hashes.
 * Closing the helper's stdin is the polite way to end it, and also what happens when the window dies.
 *
 * VERSIONLESS, AND SAFE BOTH WAYS: a helper that does not know `limit` embeds the text and answers
 * with a vector, which the window reads as "this helper cannot search" and falls back. A window
 * that does not know `vectors` skips the message like any other line it cannot read.
 */

export interface HelperReady {
    readonly type: 'ready';
    readonly modelId: string;
    readonly dimensions: number;
}

export interface HelperUnavailable {
    readonly type: 'unavailable';
}

/**
 * How the helper's resident vectors are doing: `loading` while the case is being read, `ready`
 * when searches are answered from memory, `none` when there is nothing to search (no vector file
 * yet, or one made by another model). `count` is how many vectors are held.
 */
export interface HelperVectors {
    readonly type: 'vectors';
    readonly state: 'loading' | 'ready' | 'none';
    readonly count: number;
}

/** One hit of a search: the message's hash and its cosine similarity. */
export interface HelperHit {
    readonly hash: string;
    readonly score: number;
}

export interface HelperAnswer {
    readonly id: number;
    readonly vector?: readonly number[];
    readonly hits?: readonly HelperHit[];
    readonly error?: string;
}

export interface HelperRequest {
    readonly id: number;
    readonly text: string;
    /** Present for a search: how many hits to answer with. Absent for a plain query embedding. */
    readonly limit?: number;
}

/** What the helper answers a search with when it was started without a case. */
export const NO_VECTORS = 'This helper holds no vectors to search';

export type HelperMessage = HelperReady | HelperUnavailable | HelperVectors | HelperAnswer;

function asObject(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/** A line the helper wrote, or `undefined` for anything that is not one of its messages. */
export function parseHelperMessage(line: string): HelperMessage | undefined {
    const value = asObject(line);
    if (value === undefined) return undefined;
    if (value.type === 'unavailable') return { type: 'unavailable' };
    if (value.type === 'ready') {
        if (typeof value.modelId !== 'string' || typeof value.dimensions !== 'number') return undefined;
        return { type: 'ready', modelId: value.modelId, dimensions: value.dimensions };
    }
    if (value.type === 'vectors') {
        const { state, count } = value;
        if (state !== 'loading' && state !== 'ready' && state !== 'none') return undefined;
        return { type: 'vectors', state, count: typeof count === 'number' && count >= 0 ? count : 0 };
    }
    if (typeof value.id !== 'number') return undefined;
    if (typeof value.error === 'string') return { id: value.id, error: value.error };
    if (Array.isArray(value.vector)) return { id: value.id, vector: value.vector as number[] };
    if (Array.isArray(value.hits)) {
        const hits: HelperHit[] = [];
        for (const hit of value.hits as unknown[]) {
            const entry = hit as { hash?: unknown; score?: unknown } | null;
            if (typeof entry?.hash !== 'string' || typeof entry.score !== 'number') return undefined;
            hits.push({ hash: entry.hash, score: entry.score });
        }
        return { id: value.id, hits };
    }
    return undefined;
}

/** A line the window wrote, or `undefined`. */
export function parseHelperRequest(line: string): HelperRequest | undefined {
    const value = asObject(line);
    if (value === undefined || typeof value.id !== 'number' || typeof value.text !== 'string') return undefined;
    if (value.limit === undefined) return { id: value.id, text: value.text };
    if (typeof value.limit !== 'number' || !Number.isFinite(value.limit) || value.limit < 1) return undefined;
    return { id: value.id, text: value.text, limit: Math.trunc(value.limit) };
}
