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
 * - **Timeout, then restart.** On GJS a worker that dies emits no `error` and no `exit` event
 *   (measured; Node emits both), so a lost worker is only ever detectable as an answer that
 *   never came. The timeout is therefore not a safety net but the primary detection, and the
 *   repair is a fresh worker on the next request.
 * - **The channel is injected.** {@link QueryChannel} is the whole transport, so the protocol —
 *   queueing, timeout, restart, error propagation — is testable in-process on both runtimes
 *   without a built worker file.
 *
 * And one handshake, which is not a design choice but a measured necessity — see
 * {@link READY_ID}.
 */

import { _, fmt } from '@stamped/core';
import type { CasePaths } from '@stamped/store';

import type { QueryOp, QueryRequests, QueryResults } from '../lib/queries.ts';

/** One question on the wire. `id` pairs it with its answer; `op` names the operation. */
export interface QueryRequest {
    readonly id: number;
    readonly op: string;
    readonly params: unknown;
}

/** One answer. `ok` decides which of the other two fields is meant. */
export interface QueryReply {
    readonly id: number;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: string;
}

/**
 * The transport to one worker, and the only thing {@link QueryClient} knows about threads.
 *
 * `onClose` covers both of Node's death signals (`error`, `exit`) collapsed into one, because the
 * client does the same thing for either: reject what was in flight and start again. On GJS it
 * simply never fires.
 */
export interface QueryChannel {
    post(request: QueryRequest): void;
    onMessage(handler: (reply: QueryReply) => void): void;
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

/** The id of the implicit `open`: no caller waits for it, so it never collides with a request. */
const OPEN_ID = 0;

/**
 * The id the worker announces itself with, once — and the reason a handshake exists at all.
 *
 * gjsify gap (unfixed, no upstream issue yet): on GJS a message posted to a worker BEFORE that
 * worker's module has finished evaluating is dropped without a trace — no reply, no `error`, no
 * `exit`. Measured with a two-line reproducer: a `ping` posted right after `new Worker(url)` is
 * never answered, the same `ping` posted two seconds later answers in under a millisecond. Node
 * buffers those messages, which is why the protocol tests saw none of this.
 *
 * So the worker posts one reply of its own as soon as it is listening, and the client holds
 * everything — including the implicit `open` — until it arrives. Negative so that it can never
 * be a request id: those count up from {@link OPEN_ID}.
 */
export const READY_ID = -1;

interface Pending {
    readonly id: number;
    readonly generation: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

/** A question the client has not sent yet, with the promise waiting on it. */
export class QueryClient {
    private readonly paths: CasePaths;
    private readonly spawn: QueryChannelFactory;
    private readonly timeoutMs: number;

    private channel: QueryChannel | undefined;
    /**
     * Which worker the current requests belong to. Bumped on every spawn and every drop, so a
     * reply from a worker that was given up on cannot resolve a request the next one owns.
     */
    private generation = 0;
    private seq = OPEN_ID;
    private pending: Pending | undefined;
    /** Has the current worker announced itself? Reset with every spawn. */
    private ready = false;
    /** What was asked before it did. Emptied in order the moment it does. */
    private outbox: QueryRequest[] = [];
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
        this.ready = false;
        this.outbox = [];
        pending?.reject(new Error(_('The case was closed while the index was being read.')));
        channel?.close();
    }

    private send(op: string, params: unknown): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error(_('The case was closed while the index was being read.')));
        }
        this.ensure();
        const generation = this.generation;
        const id = ++this.seq;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending?.id !== id) return;
                this.pending = undefined;
                this.restart(generation);
                reject(
                    new Error(
                        fmt(
                            _(
                                'The index did not answer within {seconds} seconds. Reading it was started over.',
                            ),
                            { seconds: Math.round(this.timeoutMs / 1000) },
                        ),
                    ),
                );
            }, this.timeoutMs);
            this.pending = {
                id,
                generation,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            this.post({ id, op, params });
        });
    }

    /**
     * Out to the worker, or into the outbox until it says it is listening.
     *
     * The request's own timeout covers the wait: a worker that never announces itself looks
     * exactly like one that never answers, and the repair is the same.
     */
    private post(request: QueryRequest): void {
        if (!this.ready) {
            this.outbox.push(request);
            return;
        }
        this.channel?.post(request);
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
        this.ready = false;
        this.outbox = [];
        const channel = this.spawn();
        this.channel = channel;
        channel.onMessage((reply) => {
            if (reply.id === READY_ID) {
                if (this.generation !== generation) return;
                this.ready = true;
                const queued = this.outbox;
                this.outbox = [];
                for (const request of queued) channel.post(request);
                return;
            }
            const pending = this.pending;
            if (pending === undefined || pending.generation !== generation || pending.id !== reply.id) {
                return;
            }
            this.pending = undefined;
            if (reply.ok) pending.resolve(reply.result);
            else pending.reject(new Error(reply.error ?? _('The index could not answer that.')));
        });
        channel.onClose((reason) => {
            if (this.generation !== generation) return;
            this.restart(generation);
            const pending = this.pending;
            this.pending = undefined;
            pending?.reject(new Error(reason));
        });
        this.post({ id: OPEN_ID, op: 'open', params: { paths: this.paths } });
    }

    /** Give up on this worker. The next request starts a fresh one through {@link ensure}. */
    private restart(generation: number): void {
        if (this.generation !== generation) return;
        const channel = this.channel;
        this.channel = undefined;
        this.ready = false;
        this.outbox = [];
        this.restartCount++;
        channel?.close();
    }
}
