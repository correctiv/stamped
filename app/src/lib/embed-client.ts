/**
 * The window's query embedder: an {@link Embedder} that asks `stamped semantic embed`.
 *
 * WHAT IT BUYS is that a GPU hang takes the helper and not the window (see `embed-serve.ts`).
 * What it costs is a model in a second process, which is why the helper goes away after a quiet
 * spell and comes back on the next search: a person who searches once an hour should not pay
 * 300 MB for the rest of it.
 *
 * A DEAD HELPER IS NOT RETRIED INSIDE THE REQUEST. The one in flight fails (the caller keeps the
 * text search, as it does for every embedder failure); the NEXT request starts a fresh helper,
 * which opens on the CPU when the dead one left the GPU marker. Retrying in place would run the
 * input that probably killed it a second time.
 *
 * The process itself is the caller's: {@link HelperChannel} is what a spawn gives back, so the
 * lifecycle can be tested without one.
 */

import type { Embedder, VectorSearchHit } from '@stamped/semantic';

import {
    parseHelperMessage,
    type HelperAnswer,
    type HelperReady,
    type HelperRequest,
    type HelperVectors,
    NO_VECTORS,
} from './embed-protocol.ts';

export interface HelperChannel {
    /** Write one line to the helper's stdin. */
    send(line: string): void;
    /** End stdin: the helper finishes what it has and exits cleanly. */
    close(): void;
    /** SIGKILL: for a helper that stopped answering. Leaves the GPU marker, on purpose. */
    kill(): void;
    /** Resolves when the process is gone, however it went. */
    readonly exited: Promise<void>;
}

export interface HelperEmbedderOptions {
    /** Start the helper; `onLine` gets every line it writes to stdout. */
    readonly spawn: (onLine: (line: string) => void) => HelperChannel;
    /** Quiet time before the helper is ended. Default five minutes. */
    readonly idleMs?: number;
    /**
     * Quiet time while the helper holds the case's vectors. Default thirty minutes: reading them
     * again takes ~40 s at 400,000 mails, far longer than starting the model.
     */
    readonly residentIdleMs?: number;
    /** How long loading the model may take. Default two minutes. */
    readonly startMs?: number;
    /** How long one query may take. Default one minute: a query is a few tokens. */
    readonly requestMs?: number;
    /**
     * How long a search may wait for the helper to finish reading the case's vectors. Default
     * thirty minutes: reading is not the GPU and does not hang, so the one-minute query timeout
     * must not kill a helper that is merely loading a large case.
     */
    readonly loadMs?: number;
}

export interface HelperEmbedder extends Embedder {
    /**
     * Search the case's vectors in the helper: the hits for a query text, best first, or
     * `undefined` when this helper cannot search (an older one, or started without a case) and the
     * caller should take its own way. An empty list means the helper holds nothing to search.
     */
    search(text: string, limit: number): Promise<VectorSearchHit[] | undefined>;
    /** Is the helper still reading the case's vectors — or about to start, after a quiet spell? */
    vectorsLoading(): boolean;
    /** End the helper now (the window closes). */
    dispose(): void;
}

interface Pending {
    resolve: (answer: HelperAnswer) => void;
    reject: (error: Error) => void;
}

interface Running {
    readonly channel: HelperChannel;
    readonly ready: Promise<HelperReady | undefined>;
    readonly pending: Map<number, Pending>;
    /** What the helper last said about its resident vectors; `undefined` before it says anything. */
    vectors: HelperVectors | undefined;
}

const FIVE_MINUTES = 5 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;

function holdsVectors(running: Running | undefined): boolean {
    return running?.vectors?.state === 'ready' && running.vectors.count > 0;
}

/** The embedder, or `undefined` when the helper says this machine has no model (or never answers). */
export async function createHelperEmbedder(options: HelperEmbedderOptions): Promise<HelperEmbedder | undefined> {
    const idleMs = options.idleMs ?? FIVE_MINUTES;
    const residentIdleMs = Math.max(idleMs, options.residentIdleMs ?? THIRTY_MINUTES);
    const startMs = options.startMs ?? 120_000;
    const requestMs = options.requestMs ?? 60_000;
    const loadMs = options.loadMs ?? 30 * 60_000;

    let current: Running | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let nextId = 1;

    const stopIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = undefined;
    };

    const startIdle = (): void => {
        stopIdle();
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            const running = current;
            if (running === undefined || running.pending.size > 0) return;
            current = undefined;
            running.channel.close();
        }, holdsVectors(current) ? residentIdleMs : idleMs);
    };

    const spawn = (): Running => {
        const pending: Running['pending'] = new Map();
        let settle!: (ready: HelperReady | undefined) => void;
        const ready = new Promise<HelperReady | undefined>((resolve) => {
            settle = resolve;
        });
        const channel = options.spawn((line) => {
            const message = parseHelperMessage(line);
            if (message === undefined) return;
            if ('type' in message) {
                if (message.type === 'vectors') {
                    running.vectors = message;
                    return;
                }
                settle(message.type === 'ready' ? message : undefined);
                return;
            }
            const waiting = pending.get(message.id);
            if (waiting === undefined) return;
            pending.delete(message.id);
            if (message.error !== undefined) waiting.reject(new Error(message.error));
            else waiting.resolve(message);
        });
        const running: Running = { channel, ready, pending, vectors: undefined };
        const gone = (): void => {
            if (current === running) current = undefined;
            settle(undefined);
            for (const waiting of pending.values()) waiting.reject(new Error('The embedding helper ended'));
            pending.clear();
        };
        channel.exited.then(gone, gone);
        return running;
    };

    /** The model's identity once the helper has loaded it; a helper that stalls is killed. */
    const awaitReady = async (running: Running): Promise<HelperReady | undefined> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
                running.channel.kill();
                resolve(undefined);
            }, startMs);
        });
        try {
            return await Promise.race([running.ready, stalled]);
        } finally {
            clearTimeout(timer);
        }
    };

    const first = spawn();
    current = first;
    const info = await awaitReady(first);
    if (info === undefined) {
        if (current === first) current = undefined;
        first.channel.close();
        return undefined;
    }
    startIdle();

    /** One request and its answer. The timeout is the GPU's: a helper that stops answering is killed. */
    const request = async (text: string, limit?: number): Promise<HelperAnswer> => {
        stopIdle();
        try {
            let running = current;
            if (running === undefined) {
                running = spawn();
                current = running;
            }
            const loaded = await awaitReady(running);
            if (loaded === undefined) throw new Error('The embedding helper is not available');
            if (loaded.modelId !== info.modelId || loaded.dimensions !== info.dimensions) {
                running.channel.kill();
                throw new Error('The embedding helper came up with another model');
            }
            const target = running;
            return await new Promise<HelperAnswer>((resolve, reject) => {
                const id = nextId++;
                const startedAt = Date.now();
                let timer: ReturnType<typeof setTimeout> | undefined;
                const arm = (): void => {
                    timer = setTimeout(() => {
                        // Reading the vectors is the helper's own work and not a hang: a search
                        // keeps waiting while it says `loading`, up to `loadMs`.
                        const loading = target.vectors?.state === 'loading';
                        if (limit !== undefined && loading && Date.now() - startedAt < loadMs) {
                            arm();
                            return;
                        }
                        target.pending.delete(id);
                        // A helper that does not answer a query is stuck in the GPU: end it hard.
                        target.channel.kill();
                        reject(new Error('The embedding helper did not answer'));
                    }, requestMs);
                };
                arm();
                target.pending.set(id, {
                    resolve: (answer) => {
                        clearTimeout(timer);
                        resolve(answer);
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        reject(error);
                    },
                });
                const message: HelperRequest = limit === undefined ? { id, text } : { id, text, limit };
                target.channel.send(JSON.stringify(message));
            });
        } finally {
            startIdle();
        }
    };

    return {
        modelId: info.modelId,
        dimensions: info.dimensions,
        async embedQuery(text: string): Promise<Float32Array> {
            const answer = await request(text);
            if (answer.vector === undefined) throw new Error('The embedding helper gave no vector');
            return Float32Array.from(answer.vector);
        },
        async search(text: string, limit: number): Promise<VectorSearchHit[] | undefined> {
            let answer: HelperAnswer;
            try {
                answer = await request(text, Math.max(1, Math.trunc(limit)));
            } catch (error) {
                // "No vectors here" is the helper's own refusal, not a failure of the helper.
                if (error instanceof Error && error.message === NO_VECTORS) return undefined;
                throw error;
            }
            // A vector back means a helper that does not know search: take the old way.
            return answer.hits === undefined ? undefined : answer.hits.map(({ hash, score }) => ({ hash, score }));
        },
        vectorsLoading(): boolean {
            // No helper right now (the quiet spell ended it): the next search starts one, and it loads.
            return current === undefined || current.vectors?.state === 'loading';
        },
        embedDocuments(): Promise<Float32Array[]> {
            return Promise.reject(new Error('The query embedder does not embed documents'));
        },
        dispose(): void {
            stopIdle();
            const running = current;
            current = undefined;
            running?.channel.close();
        },
    };
}
