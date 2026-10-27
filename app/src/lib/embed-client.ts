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

import type { Embedder } from '@stamped/semantic';

import { parseHelperMessage, type HelperReady, type HelperRequest } from './embed-protocol.ts';

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
    /** How long loading the model may take. Default two minutes. */
    readonly startMs?: number;
    /** How long one query may take. Default one minute: a query is a few tokens. */
    readonly requestMs?: number;
}

export interface HelperEmbedder extends Embedder {
    /** End the helper now (the window closes). */
    dispose(): void;
}

interface Running {
    readonly channel: HelperChannel;
    readonly ready: Promise<HelperReady | undefined>;
    readonly pending: Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>;
}

const FIVE_MINUTES = 5 * 60_000;

/** The embedder, or `undefined` when the helper says this machine has no model (or never answers). */
export async function createHelperEmbedder(options: HelperEmbedderOptions): Promise<HelperEmbedder | undefined> {
    const idleMs = options.idleMs ?? FIVE_MINUTES;
    const startMs = options.startMs ?? 120_000;
    const requestMs = options.requestMs ?? 60_000;

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
        }, idleMs);
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
                settle(message.type === 'ready' ? message : undefined);
                return;
            }
            const waiting = pending.get(message.id);
            if (waiting === undefined) return;
            pending.delete(message.id);
            if (message.vector !== undefined) waiting.resolve(Float32Array.from(message.vector));
            else waiting.reject(new Error(message.error ?? 'The embedding helper gave no vector'));
        });
        const running: Running = { channel, ready, pending };
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

    const ask = async (text: string): Promise<Float32Array> => {
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
            return await new Promise<Float32Array>((resolve, reject) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    target.pending.delete(id);
                    // A helper that does not answer a query is stuck in the GPU: end it hard.
                    target.channel.kill();
                    reject(new Error('The embedding helper did not answer'));
                }, requestMs);
                target.pending.set(id, {
                    resolve: (vector) => {
                        clearTimeout(timer);
                        resolve(vector);
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        reject(error);
                    },
                });
                const request: HelperRequest = { id, text };
                target.channel.send(JSON.stringify(request));
            });
        } finally {
            startIdle();
        }
    };

    return {
        modelId: info.modelId,
        dimensions: info.dimensions,
        embedQuery: ask,
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
