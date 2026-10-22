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
import {
    ACTIVITY_KINDS,
    orphanedActivity,
    orphanedImport,
    type ActivityStatus,
    type ImportStatus,
} from '@stamped/store';

import type { SemanticState } from './semantic-state.ts';
import { percent } from './status.ts';

export type ActivityKind = 'import' | 'keys' | 'reverify' | 'people' | 'semantic';

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

/** The vector indexing, as the semantic controller's state says. */
export interface SemanticActivity {
    readonly kind: 'semantic';
    readonly state: SemanticState;
}

export type ActivityData =
    | ImportActivity
    | KeysActivity
    | ReverifyActivity
    | PeopleActivity
    | SemanticActivity;

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
        case 'semantic': {
            const state = data.state;
            if (state.kind !== 'indexing' && state.kind !== 'paused') return undefined;
            return state.total > 0 ? Math.min(1, state.done / state.total) : undefined;
        }
    }
}

/**
 * Put the semantic controller's state into the registry.
 *
 * A held run (`paused`) stays a RUNNING task: it is not over, and its row is where Resume is.
 * A run that is `ready` or `failed` is only news when this window saw it going — opening a case
 * whose index is complete must not leave a "Finished" row behind — and `off` / `unavailable`
 * take the row away: they are not work, and the settings dialog is where they are explained.
 */
export function syncSemanticActivity(registry: ActivityRegistry, state: SemanticState): void {
    const data: SemanticActivity = { kind: 'semantic', state };
    const going = registry.get('semantic')?.state === 'running';
    switch (state.kind) {
        case 'probing':
        case 'indexing':
        case 'paused':
            if (going) registry.update(data);
            else registry.start(data);
            break;
        case 'ready':
            if (going) registry.finish(data);
            break;
        case 'failed':
            if (going) registry.fail(data, state.message);
            break;
        default:
            registry.dismiss('semantic');
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

/** A run that is no longer live; a `running` file in that case was interrupted, which is a failure. */
function endedState(state: ActivityStatus['state']): ActivityState {
    if (state === 'finished') return 'done';
    if (state === 'running') return 'failed';
    return state;
}

/**
 * Reads the activity status files of a case into the registry, for the kinds a background run of
 * another process writes: `people`, `keys`, `reverify` — the CLI's own work.
 *
 * The window started those runs through a file rather than through the registry (an in-process run
 * of the same kinds writes the registry directly), so this is the window's half of the seam with a
 * subprocess: one tick reads the case's files and puts live runs into the activity view, and the
 * poll reports the run that ended with the tick so the caller can reload the case and say so. The
 * contract mirrors the import watcher: a `running` file whose process is gone or whose last update
 * is old reads as interrupted, never as running. A task the window holds itself is not a file, so
 * the watcher never sees it and only ever updates what it put there.
 */
export class ActivityWatcher {
    private readonly registry: ActivityRegistry;
    private readonly kinds: readonly ActivityKind[];
    private readonly reported = new Map<ActivityKind, string>();
    private readonly now: () => number;
    private since: number;

    constructor(
        registry: ActivityRegistry,
        kinds: readonly ActivityKind[] = ACTIVITY_KINDS,
        now: () => number = Date.now,
    ) {
        this.registry = registry;
        this.kinds = kinds;
        this.now = now;
        this.since = now();
    }

    /** Forget the case: the next one starts from a clean slate. */
    reset(): void {
        this.since = this.now();
        for (const kind of this.kinds) {
            this.reported.delete(kind);
            this.registry.dismiss(kind);
        }
    }

    /**
     * One tick: read the case's activity status files into the registry.
     *
     * @returns the run that ENDED with this tick (or was found interrupted), so the caller can
     *   reload the case and say so — `undefined` while nothing changed state.
     */
    poll(statuses: readonly ActivityStatus[]): ActivityTask | undefined {
        let ended: ActivityTask | undefined;
        for (const status of statuses) {
            const live = status.state === 'running' && !orphanedActivity(status);
            const task = this.taskOf(status, live);
            if (live) {
                this.reported.delete(status.kind);
                const current = this.registry.get(status.kind);
                if (current === undefined) this.registry.start(task.data);
                else if (current.state === 'running') this.registry.update(task.data);
                continue;
            }
            if (this.reported.get(status.kind) === status.startedAt) continue;
            this.reported.set(status.kind, status.startedAt);
            // A run that ended before this case was opened is history, not news: only an
            // interrupted one is worth a row, as with the import watcher.
            const interrupted = status.state === 'running';
            if (!interrupted && Date.parse(status.updatedAt) < this.since) continue;
            ended = task;
            if (task.state === 'failed') this.registry.fail(task.data, task.reason);
            else this.registry.finish(task.data, task.state === 'cancelled' ? 'cancelled' : 'done');
        }
        return ended;
    }

    private taskOf(status: ActivityStatus, live: boolean): ActivityTask {
        const data = this.dataOf(status);
        return {
            kind: status.kind,
            state: live ? 'running' : endedState(status.state),
            data,
            fraction: progressOf(data),
            reason: undefined,
            startedAt: Date.parse(status.startedAt),
            endedAt: live ? undefined : Date.parse(status.updatedAt),
        };
    }

    private dataOf(status: ActivityStatus): ActivityData {
        switch (status.kind) {
            case 'people':
                return { kind: 'people', processed: status.done };
            case 'keys': {
                const current = this.registry.get(status.kind);
                const carried =
                    current !== undefined && current.data.kind === 'keys' ? current.data : undefined;
                return {
                    kind: 'keys',
                    // A run this window started carries its channel in the task it holds; one that
                    // another process started is read off the status, whose numbers are not the
                    // channel's — the task of the last run of this kind keeps it.
                    channel: carried?.channel ?? 'archive.prove.email',
                    done: status.done,
                    total: status.total,
                    found: carried?.found ?? 0,
                    notFound: carried?.notFound ?? 0,
                    errors: carried?.errors ?? 0,
                };
            }
            case 'reverify':
                return { kind: 'reverify', checked: status.done, total: status.total, changed: 0 };
        }
    }
}
