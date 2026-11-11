/**
 * The window's side of the query worker: ask the index a question, await the answer.
 *
 * The GTK main thread holds NO index connection. Every question about the case goes through here
 * to a second thread that owns the only `DatabaseSync` handle, because a SQLite query over a
 * six-figure archive takes seconds and a second on the main thread is a window that has stopped
 * repainting — measured in `docs/spikes/query-worker.md`: the same query keeps the main loop
 * ticking at 50 ms through the worker and stalls it for 1230 ms inline.
 *
 * Three decisions carry the rest:
 *
 * - **Serial.** One request in flight, the rest queued in order. SQLite on one connection is
 *   serial anyway, so concurrency would buy nothing, and it makes "what does a timeout cancel?"
 *   answerable: the one request that timed out.
 * - **Timeout, then restart.** On GJS a worker that dies can go unnoticed (an unhandled rejection
 *   or a hang emits no `error` and no `exit`), so a lost worker is only reliably detectable as an
 *   answer that never came. The timeout is therefore not a safety net but the primary detection,
 *   and the repair is a fresh worker on the next request.
 * - **The channel is injected.** {@link QueryChannel} is the whole transport (a Comlink proxy
 *   over a WHATWG `Worker` in production), so queueing, timeout, restart and error propagation
 *   are testable in-process on both runtimes without a built worker file.
 */

import { _, fmt } from '@stamped/core';
import type { CasePaths } from '@stamped/store';

import type { QueryOp, QueryRequests, QueryResults } from '../lib/queries.ts';

/**
 * The transport to one worker, and the only thing {@link QueryClient} knows about threads.
 *
 * `onClose` is the worker's death signal collapsed into one, because the client does the same
 * thing for any of them: reject what was in flight and start again. It may never fire.
 */
export interface QueryChannel {
    /** Run one operation on the worker. Rejects with the worker's error. */
    call(op: string, params: unknown): Promise<unknown>;
    onClose(handler: (reason: string) => void): void;
    close(): void;
}

/** Makes one worker. Called again after a restart, so it must be callable more than once. */
export type QueryChannelFactory = () => QueryChannel;

/**
 * How long one request may take before the worker counts as lost.
 *
 * Generous on purpose. A wait costs nothing here — the window keeps painting — while a timeout
 * that fires on a report of a 400,000-message case would throw away a query that was about to
 * answer and then run it again from the start.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Mark an error as one the person cannot act on and that fixes itself on the next question.
 * A field rather than a class, so the check holds wherever the error was constructed.
 */
function recoverable(error: Error): Error {
    return Object.assign(error, { recoverable: true });
}

/** Did this fail in a way that deserves a toast instead of a dialog? */
export function isRecoverable(error: unknown): boolean {
    return error instanceof Error && (error as Error & { recoverable?: unknown }).recoverable === true;
}

interface Pending {
    readonly generation: number;
    reject(error: Error): void;
}

export class QueryClient {
    private readonly paths: CasePaths;
    private readonly spawn: QueryChannelFactory;
    private readonly timeoutMs: number;

    private channel: QueryChannel | undefined;
    /**
     * Which worker the current requests belong to. Bumped on every spawn and every drop, so a
     * death report from a worker that was given up on cannot affect the next one.
     */
    private generation = 0;
    private pending: Pending | undefined;
    /** The `open` of the current worker; every request waits for it. Never rejects. */
    private opening: Promise<void> = Promise.resolve();
    /** The queue, as a promise chain: each request waits for the previous one to settle. */
    private tail: Promise<void> = Promise.resolve();
    private closed = false;
    private restartCount = 0;

    constructor(paths: CasePaths, spawn: QueryChannelFactory, timeoutMs: number = REQUEST_TIMEOUT_MS) {
        this.paths = paths;
        this.spawn = spawn;
        this.timeoutMs = timeoutMs;
    }

    /** How often a worker had to be replaced. For a test, and for a bug report that says "again". */
    get restarts(): number {
        return this.restartCount;
    }

    /**
     * Ask one question. Resolves with the answer, rejects with what went wrong — and queues
     * behind whatever is already in flight.
     */
    ask<Op extends QueryOp>(op: Op, params: QueryRequests[Op]): Promise<QueryResults[Op]> {
        const run = this.tail.then(() => this.send(op, params) as Promise<QueryResults[Op]>);
        // The chain itself must never reject, or every later request would inherit the failure.
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Is the worker there and answering? The round trip the startup measurement times. */
    async ping(): Promise<void> {
        await this.tail.then(() => this.send('ping', {}));
    }

    /**
     * Let go of the case: the worker, its connection and its scope tables all end here.
     *
     * A connection held on a case folder on removable or encrypted storage is a folder that
     * cannot be unmounted — which is how a journalist's working copy of a leak is supposed to
     * live — and a worker thread nobody terminates holds it for as long as the window runs.
     */
    close(): void {
        this.closed = true;
        this.generation++;
        const pending = this.pending;
        this.pending = undefined;
        const channel = this.channel;
        this.channel = undefined;
        pending?.reject(new Error(_('The case was closed while the index was being read.')));
        channel?.close();
    }

    /**
     * One request, and one more after a timeout: the restart already happened, nothing was lost,
     * and a second silence is the answer worth showing. Only a timeout is retried — an error the
     * worker itself reported would come back the same.
     */
    private async send(op: string, params: unknown): Promise<unknown> {
        try {
            return await this.attempt(op, params);
        } catch (error) {
            if (!isRecoverable(error)) throw error;
            return this.attempt(op, params);
        }
    }

    private attempt(op: string, params: unknown): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error(_('The case was closed while the index was being read.')));
        }
        this.ensure();
        const generation = this.generation;
        const channel = this.channel as QueryChannel;
        const opening = this.opening;
        return new Promise<unknown>((resolve, reject) => {
            let settled = false;
            const finish = (settle: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this.pending === entry) this.pending = undefined;
                settle();
            };
            const timer = setTimeout(() => {
                finish(() => {
                    this.restart(generation);
                    reject(
                        recoverable(
                            new Error(
                                fmt(
                                    _(
                                        'The index did not answer within {seconds} seconds. Reading it was started over.',
                                    ),
                                    { seconds: Math.round(this.timeoutMs / 1000) },
                                ),
                            ),
                        ),
                    );
                });
            }, this.timeoutMs);
            const entry: Pending = { generation, reject: (error) => finish(() => reject(error)) };
            this.pending = entry;
            // An answer that arrives after the timeout finds `settled` and is dropped.
            opening
                .then(() => channel.call(op, params))
                .then(
                    (value) => finish(() => resolve(value)),
                    (error: unknown) =>
                        finish(() =>
                            reject(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error ?? _('The index could not answer that.'))),
                            ),
                        ),
                );
        });
    }

    /**
     * The worker, started if there is none.
     *
     * The `open` goes out as part of starting it rather than as a request somebody awaits: it is
     * what makes a worker usable, so it belongs to the spawn, and a case folder that cannot be
     * opened is reported on the first real question instead — which is the one a person asked.
     */
    private ensure(): void {
        if (this.channel !== undefined) return;
        this.generation++;
        const generation = this.generation;
        const channel = this.spawn();
        this.channel = channel;
        channel.onClose((reason) => {
            if (this.generation !== generation) return;
            this.restart(generation);
            const pending = this.pending;
            this.pending = undefined;
            pending?.reject(new Error(reason));
        });
        this.opening = channel.call('open', { paths: this.paths }).then(
            () => undefined,
            () => undefined,
        );
    }

    /** Give up on this worker. The next request starts a fresh one through {@link ensure}. */
    private restart(generation: number): void {
        if (this.generation !== generation) return;
        const channel = this.channel;
        this.channel = undefined;
        this.restartCount++;
        channel?.close();
    }
}
