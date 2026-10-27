/**
 * The wire between the window and `stamped semantic embed`: one JSON object per line.
 *
 * JSON because that is what a pipe can carry on both runtimes (a structured clone is JSON under
 * GJS anyway), and plain lines because a stray log line from a native library must not break it:
 * the reader skips whatever is not one of these.
 *
 * Helper → window: `ready` once the model is loaded, or `unavailable` when this machine has none;
 * then one answer per request. Window → helper: `{ id, text }`. Closing the helper's stdin is the
 * polite way to end it, and also what happens when the window dies.
 */

export interface HelperReady {
    readonly type: 'ready';
    readonly modelId: string;
    readonly dimensions: number;
}

export interface HelperUnavailable {
    readonly type: 'unavailable';
}

export interface HelperAnswer {
    readonly id: number;
    readonly vector?: readonly number[];
    readonly error?: string;
}

export interface HelperRequest {
    readonly id: number;
    readonly text: string;
}

export type HelperMessage = HelperReady | HelperUnavailable | HelperAnswer;

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
    if (typeof value.id !== 'number') return undefined;
    if (typeof value.error === 'string') return { id: value.id, error: value.error };
    if (Array.isArray(value.vector)) return { id: value.id, vector: value.vector as number[] };
    return undefined;
}

/** A line the window wrote, or `undefined`. */
export function parseHelperRequest(line: string): HelperRequest | undefined {
    const value = asObject(line);
    if (value === undefined || typeof value.id !== 'number' || typeof value.text !== 'string') return undefined;
    return { id: value.id, text: value.text };
}
