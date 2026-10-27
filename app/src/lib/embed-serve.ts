/**
 * The helper's side of `stamped semantic embed`: load the model, say so, answer requests.
 *
 * WHY A PROCESS OF ITS OWN: a GPU that loses its device makes llama.cpp `abort()`, and nothing
 * in the process survives that. The window must not be that process, so the query embedder lives
 * here and the window only keeps a pipe to it (`embed-client.ts`). The gate is the same file
 * marker as for the indexer (`gpu-guard.ts`): a helper that dies mid-request leaves it, and the
 * next helper starts on the CPU.
 *
 * Requests are answered one at a time, in order — the model has one context, and two calls at once
 * would only queue inside it.
 */

import type { Embedder } from '@stamped/semantic';

import { parseHelperRequest, type HelperMessage } from './embed-protocol.ts';

export interface ServeIo {
    /** One request per line; ends when the window closes the pipe. */
    readonly lines: AsyncIterable<string>;
    write(line: string): void;
}

/**
 * Collect lines from the moment this is called, not from the first `next()`.
 *
 * `readline`'s own async iterator only sees lines that arrive after the loop starts, and the
 * helper's loop starts after the model has loaded — seconds in which the window may already have
 * written a request. Those would be dropped, and the window would wait for an answer to a
 * question nobody read.
 */
export function bufferedLines(source: {
    on(event: 'line', listener: (line: string) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
}): AsyncIterable<string> {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    source.on('line', (line) => {
        queue.push(line);
        wake?.();
    });
    source.on('close', () => {
        ended = true;
        wake?.();
    });
    return {
        async *[Symbol.asyncIterator]() {
            for (;;) {
                const next = queue.shift();
                if (next !== undefined) {
                    yield next;
                    continue;
                }
                if (ended) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        },
    };
}

export async function serveEmbedder(
    createEmbedder: () => Promise<Embedder | undefined>,
    io: ServeIo,
): Promise<void> {
    const send = (message: HelperMessage): void => io.write(JSON.stringify(message));

    // A model that will not load is "unavailable" here, as in the window: the text search stays.
    const embedder = await createEmbedder().catch(() => undefined);
    if (embedder === undefined) {
        send({ type: 'unavailable' });
        return;
    }
    send({ type: 'ready', modelId: embedder.modelId, dimensions: embedder.dimensions });

    let queue: Promise<void> = Promise.resolve();
    for await (const line of io.lines) {
        const request = parseHelperRequest(line);
        if (request === undefined) continue;
        queue = queue.then(async () => {
            try {
                const vector = await embedder.embedQuery(request.text);
                send({ id: request.id, vector: Array.from(vector) });
            } catch (error) {
                send({ id: request.id, error: error instanceof Error ? error.message : String(error) });
            }
        });
    }
    await queue;
    const closable = embedder as { dispose?: () => Promise<void> };
    await closable.dispose?.();
}
