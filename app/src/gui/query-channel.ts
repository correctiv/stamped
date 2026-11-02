/**
 * The real transport behind {@link QueryClient}: one WHATWG `Worker` per case, driven through
 * Comlink.
 *
 * Separate from `query-client.ts` so the rules — queueing, timeout, restart — can be tested
 * without a worker at all. Everything thread-shaped is here; everything rule-shaped is there.
 */

import * as Comlink from 'comlink';

import type { QueryChannel } from './query-client.ts';
import type { QueryWorkerApi } from './query-worker.ts';

/**
 * Start a query worker.
 *
 * The literal `new Worker(new URL('./…', import.meta.url))` is what the gjsify bundler looks
 * for: it builds the worker file beside the bundle and rewrites the URL to it, so `gjsify ship`
 * stages the pair together and the URL resolves to wherever that ended up. Keep it a literal —
 * a computed specifier is left alone and the worker is then simply not shipped.
 */
export function workerChannel(): QueryChannel {
    const worker = new Worker(new URL('./query-worker.ts', import.meta.url), { type: 'module' });
    const api = Comlink.wrap<QueryWorkerApi>(worker as unknown as Comlink.Endpoint);
    let closed = false;
    return {
        call(op: string, params: unknown): Promise<unknown> {
            if (op === 'open')
                return api.open((params as { paths: Parameters<QueryWorkerApi['open']>[0] }).paths);
            if (op === 'ping') return api.ping();
            return api.run(op, params);
        },
        onClose(handler: (reason: string) => void): void {
            worker.addEventListener('error', (event) => {
                // Ours to report: the client restarts, and the default would only log it too.
                event.preventDefault();
                if (!closed) handler(event.message || 'worker failed');
            });
        },
        close(): void {
            if (closed) return;
            closed = true;
            // `terminate()` is a hard kill on GJS and nothing the window does next depends on the
            // thread being gone, so do not wait for it.
            worker.terminate();
        },
    };
}
