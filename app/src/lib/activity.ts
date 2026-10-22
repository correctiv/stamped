/**
 * The task registry behind the header bar's status button: what is running in the background
 * of a case window, and what it left behind.
 *
 * Pure — no `gi://`, no timers, no formatting. Every background job (import, key lookup,
 * re-verification, the people backfill) writes its numbers in as DATA and the view modules turn
 * them into words, so the same registry is testable on Node and GJS alike and the window never
 * decides a sentence.
 *
 * One task per kind: a second key lookup replaces the first one's row rather than stacking
 * beside it, which is also what a person expects from a button that says "the lookup".
 * A task that ends STAYS, with its result, until `dismiss` — a finished import that vanished
 * the instant it finished would be a result nobody had time to read. Throttling is the
 * subscriber's job: the registry reports every change and a job may call `update` as often as
 * it likes.
 */

import type { LookupChannel } from '@stamped/core';
import { orphanedImport, type ImportStatus } from '@stamped/store';

import { percent } from './status.ts';

export type ActivityKind = 'import' | 'keys' | 'reverify' | 'people';

/** `running` until the job ends; the three others stay listed until dismissed. */
export type ActivityState = 'running' | 'done' | 'failed' | 'cancelled';

/** An import, as the status file says. `own` is true only for a subprocess this window started. */
export interface ImportActivity {
    readonly kind: 'import';
    readonly status: ImportStatus;
    /** The status file says `running` but the process is gone — the run was interrupted. */
    readonly orphaned: boolean;
    readonly own: boolean;
}

export interface KeysActivity {
    readonly kind: 'keys';
    readonly channel: LookupChannel;
    readonly done: number;
    readonly total: number;
    readonly found: number;
    readonly notFound: number;
    /** Lookups that failed rather than missed; stays 0 until the lookup reports them. */
    readonly errors: number;
}

export interface ReverifyActivity {
    readonly kind: 'reverify';
    readonly checked: number;
    readonly total: number;
    readonly changed: number;
}

export interface PeopleActivity {
    readonly kind: 'people';
    /** Messages whose addresses are in the table so far; the total is not known up front. */
    readonly processed: number;
}

export type ActivityData = ImportActivity | KeysActivity | ReverifyActivity | PeopleActivity;

export interface ActivityTask {
    readonly kind: ActivityKind;
    readonly state: ActivityState;
    readonly data: ActivityData;
    /** 0 … 1, or `undefined` when the job cannot say how far it is. */
    readonly fraction: number | undefined;
    /** Why a failed task failed, when the job knows. Never mail content. */
    readonly reason: string | undefined;
    readonly startedAt: number;
    readonly endedAt: number | undefined;
}

/** What the button needs, in one look at the list. */
export interface ActivitySummary {
    readonly running: number;
    /** Tasks that failed and have not been dismissed. */
    readonly failed: number;
    /** Set only when exactly one task runs and knows its progress. */
    readonly fraction: number | undefined;
}

/** How far a job is, from its own numbers. */
export function progressOf(data: ActivityData): number | undefined {
    switch (data.kind) {
        case 'import':
            return data.status.bytesTotal > 0
                ? percent(data.status.bytesRead, data.status.bytesTotal) / 100
                : undefined;
        case 'keys':
            return data.total > 0 ? Math.min(1, data.done / data.total) : undefined;
        case 'reverify':
            return data.total > 0 ? Math.min(1, data.checked / data.total) : undefined;
        case 'people':
            return undefined;
    }
}

export class ActivityRegistry {
    private readonly map = new Map<ActivityKind, ActivityTask>();
    private readonly listeners = new Set<() => void>();

    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    /** Begin a job, replacing the previous task of its kind (running or finished). */
    start(data: ActivityData): void {
        this.map.delete(data.kind); // a restarted task goes to the end of the list
        this.map.set(data.kind, this.task(data, 'running', undefined));
        this.emit();
    }

    /** New numbers for a running job. Ignored once the job has ended: the result stays as it was. */
    update(data: ActivityData): void {
        const task = this.map.get(data.kind);
        if (task?.state !== 'running') return;
        this.map.set(data.kind, { ...task, data, fraction: progressOf(data) });
        this.emit();
    }

    /** The job ended well. `cancelled` is also an end the person asked for, not a failure. */
    finish(data: ActivityData, state: 'done' | 'cancelled' = 'done'): void {
        this.end(data, state, undefined);
    }

    /** The job ended badly; it stays listed, flagged, until dismissed. */
    fail(data: ActivityData, reason?: string): void {
        this.end(data, 'failed', reason);
    }

    /** Remove a task, finished or not. */
    dismiss(kind: ActivityKind): void {
        if (this.map.delete(kind)) this.emit();
    }

    get(kind: ActivityKind): ActivityTask | undefined {
        return this.map.get(kind);
    }

    /** Every task, oldest start first. */
    list(): readonly ActivityTask[] {
        return [...this.map.values()];
    }

    summary(): ActivitySummary {
        const tasks = this.list();
        const running = tasks.filter((task) => task.state === 'running');
        return {
            running: running.length,
            failed: tasks.filter((task) => task.state === 'failed').length,
            fraction: running.length === 1 ? running[0]!.fraction : undefined,
        };
    }

    /** Be told after every change. Returns the function that stops it. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private end(data: ActivityData, state: ActivityState, reason: string | undefined): void {
        const task = this.map.get(data.kind);
        const startedAt = task?.startedAt ?? this.now();
        this.map.set(data.kind, {
            kind: data.kind,
            state,
            data,
            // A finished job is whole; a failed or cancelled one keeps how far it got.
            fraction: state === 'done' ? (progressOf(data) === undefined ? undefined : 1) : progressOf(data),
            reason,
            startedAt,
            endedAt: this.now(),
        });
        this.emit();
    }

    private task(data: ActivityData, state: ActivityState, reason: string | undefined): ActivityTask {
        return {
            kind: data.kind,
            state,
            data,
            fraction: progressOf(data),
            reason,
            startedAt: this.now(),
            endedAt: undefined,
        };
    }

    private emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** A live run: `running` in the file, and its process is still there. */
export function importRunning(status: ImportStatus | undefined): boolean {
    return status?.state === 'running' && !orphanedImport(status);
}

/**
 * Turns the import status file, polled once a second, into the registry's `import` task.
 *
 * The file is the one channel — a run started on a command line shows up just like one of the
 * window's own — so the watcher decides what a poll MEANS: a run that is going, a run that just
 * ended, or an old result nobody here saw (which is not shown: last week's finished import is
 * not news). An interrupted run is the exception: it is a warning, and it stays until dismissed.
 * Each run is reported once, by its start time, so a dismissed row does not come back at the
 * next poll while the file still says the same thing.
 */
export class ImportWatcher {
    private readonly registry: ActivityRegistry;
    private reported: string | undefined;
    private ownSince: string | undefined;

    constructor(registry: ActivityRegistry) {
        this.registry = registry;
    }

    /** Forget the case: the next one starts from a clean slate. */
    reset(): void {
        this.reported = undefined;
        this.ownSince = undefined;
        this.registry.dismiss('import');
    }

    /**
     * The window is about to start a run. A small archive imports between two polls, so the
     * window never sees it `running`; without this mark its finished result would look like an
     * old one and the list would never reload. Any run that started at or after `at` is ours.
     */
    expect(at: string = new Date().toISOString()): void {
        this.ownSince = at;
    }

    /**
     * @returns the run that ENDED with this poll (or was found interrupted), so the caller can
     *   reload the case and say so — `undefined` while nothing changed state.
     */
    poll(status: ImportStatus | undefined, own: boolean): ImportActivity | undefined {
        if (status === undefined) return undefined;
        const data: ImportActivity = { kind: 'import', status, orphaned: orphanedImport(status), own };
        if (importRunning(status)) {
            if (this.registry.get('import')?.state === 'running') this.registry.update(data);
            else this.registry.start(data);
            return undefined;
        }
        if (status.startedAt === this.reported) return undefined;
        const started = this.ownSince !== undefined && status.startedAt >= this.ownSince;
        const ours = started || this.registry.get('import')?.state === 'running';
        this.reported = status.startedAt;
        if (!ours && !data.orphaned) return undefined;
        if (started) this.ownSince = undefined;
        if (data.orphaned || status.state === 'failed') this.registry.fail(data);
        else this.registry.finish(data, status.state === 'cancelled' ? 'cancelled' : 'done');
        return data;
    }
}
