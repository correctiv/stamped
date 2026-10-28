/**
 * The real transport behind {@link QueryClient}: one `node:worker_threads` worker per case.
 *
 * Separate from `query-client.ts` so the protocol — queueing, timeout, restart — can be tested
 * without a worker at all. Everything thread-shaped is here; everything rule-shaped is there.
 */

import { Worker } from 'node:worker_threads';

import { runningOnGjs } from '@stamped/semantic/runtime';

import type { QueryChannel, QueryReply, QueryRequest } from './query-client.ts';

/**
 * Which bundle the worker has to be, since both targets' files sit in the same `dist/`.
 *
 * `runningOnGjs()`, not "is there an `imports`": node-gi defines `imports` on Node too, and the
 * macOS and Windows apps are Node plus node-gi — they asked for `query-worker.gjs.mjs`, which the
 * Node bundle does not carry, and no case ever loaded. Asked at call time rather than at module
 * level: a bundle is built per target, but the test suite runs the SAME source on both runtimes.
 */
function target(): 'gjs' | 'node' {
    return runningOnGjs() ? 'gjs' : 'node';
}

/**
 * Start a query worker beside the bundle that starts it.
 *
 * `new URL('./…', import.meta.url)` is what makes `gjsify ship` work without a ship-config
 * change: the worker file is staged next to the bundle, and the URL resolves to wherever that
 * pair ended up — a `dist/` in the source tree, a staged payload, an installed prefix.
 *
 * On GJS this spawns a `gjs` from PATH (measured in the spike), so the launcher the package
 * writes has to provide one — which it does, since that is what runs the bundle itself.
 */
export function workerChannel(): QueryChannel {
    const url = new URL(`./query-worker.${target()}.mjs`, import.meta.url);
    const worker = new Worker(url);
    let closed = false;
    return {
        post(request: QueryRequest): void {
            if (!closed) worker.postMessage(request);
        },
        onMessage(handler: (reply: QueryReply) => void): void {
            worker.on('message', (message: QueryReply) => {
                if (!closed) handler(message);
            });
        },
        onClose(handler: (reason: string) => void): void {
            // Node emits both for a thread that dies, GJS emits neither — so the client treats
            // them as one signal and relies on its timeout where there is none.
            worker.on('error', (error: Error) => {
                if (!closed) handler(String(error.message ?? error));
            });
            worker.on('exit', (code: number) => {
                if (!closed) handler(`worker exited with code ${code}`);
            });
        },
        close(): void {
            if (closed) return;
            closed = true;
            // Fire and forget: `terminate()` is a ~0.5 s hard kill on GJS and blocks on Node, and
            // nothing the window does next depends on the thread being gone.
            void Promise.resolve(worker.terminate()).catch(() => undefined);
        },
    };
}
