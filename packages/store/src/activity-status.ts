/**
 * The activity status files: where a background run other than an import has got to.
 *
 * `people`, `keys fetch` and `reverify` used to be invisible to every other process, so a window
 * open on the case could neither show their progress nor know to leave the same work alone. They
 * follow the contract of the import status (`import-status.ts`): a FILE in the case folder, PID
 * and times, done/total, a state, written atomically at most once a second, the final state
 * staying after the run.
 *
 * ONE FILE PER KIND, not one file holding all of them. A shared file needs a read-modify-write,
 * and two processes of different kinds (a `people` run beside a `keys fetch`) would overwrite
 * each other's entry. With a file per kind there is one writer per file — the window does not
 * start a run of a kind that is already live — so a plain atomic write is race-free, and the
 * final state of each kind survives independently.
 *
 * NUMBERS ONLY. The PID, the timestamps and two counts: never a message, an address or a key
 * name. The file travels next to a leak.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CasePaths } from './case.ts';
import { processAlive, STATUS_STALE_SECONDS } from './import-status.ts';

/** Bumped when a build would misread a file an older build wrote. */
export const ACTIVITY_STATUS_VERSION = 1;

/** The background runs that report. */
export type ActivityKind = 'people' | 'keys' | 'reverify';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['people', 'keys', 'reverify'];

/** The four states a run is ever in. The file keeps the last one for good. */
export type ActivityState = 'running' | 'finished' | 'failed' | 'cancelled';

const STATES: readonly ActivityState[] = ['running', 'finished', 'failed', 'cancelled'];

/** One snapshot of a run. */
export interface ActivityStatus {
    readonly version: number;
    readonly kind: ActivityKind;
    readonly state: ActivityState;
    readonly pid: number;
    /** When the run started, ISO 8601. */
    readonly startedAt: string;
    /** When the snapshot was written, ISO 8601. */
    readonly updatedAt: string;
    readonly done: number;
    /** 0 while the size of the run is not known yet. */
    readonly total: number;
}

/** The file's name for a kind, inside the case folder. */
export function activityStatusName(kind: ActivityKind): string {
    return `activity-${kind}-status.json`;
}

export function activityStatusFile(paths: CasePaths, kind: ActivityKind): string {
    return join(paths.root, activityStatusName(kind));
}

/** The status of one kind, or `undefined` when there is none or it cannot be trusted. */
export function readActivityStatus(paths: CasePaths, kind: ActivityKind): ActivityStatus | undefined {
    let parsed: Partial<ActivityStatus>;
    try {
        parsed = JSON.parse(readFileSync(activityStatusFile(paths, kind), 'utf8')) as Partial<ActivityStatus>;
    } catch {
        return undefined;
    }
    if (typeof parsed.version !== 'number' || parsed.version > ACTIVITY_STATUS_VERSION) return undefined;
    if (parsed.kind !== kind) return undefined;
    if (typeof parsed.state !== 'string' || !STATES.includes(parsed.state as ActivityState)) return undefined;
    if (typeof parsed.pid !== 'number') return undefined;
    if (typeof parsed.done !== 'number' || typeof parsed.total !== 'number') return undefined;
    if (typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string') return undefined;
    return parsed as ActivityStatus;
}

/** Every kind's status that exists, in the order of {@link ACTIVITY_KINDS}. */
export function readActivityStatuses(paths: CasePaths): ActivityStatus[] {
    const found: ActivityStatus[] = [];
    for (const kind of ACTIVITY_KINDS) {
        const status = readActivityStatus(paths, kind);
        if (status !== undefined) found.push(status);
    }
    return found;
}

/** Write atomically: a reader sees the old snapshot or the new one, never a torn one. */
export function writeActivityStatus(paths: CasePaths, status: ActivityStatus): void {
    const target = activityStatusFile(paths, status.kind);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, undefined, 2)}\n`);
    renameSync(tmp, target);
}

/**
 * Is a `running` file describing a run that is no longer running? Dead PID or a last update
 * older than {@link STATUS_STALE_SECONDS}; an end state is a record and never orphaned.
 */
export function orphanedActivity(status: ActivityStatus, now: number = Date.now()): boolean {
    if (status.state !== 'running') return false;
    if (status.pid > 0 && !processAlive(status.pid)) return true;
    const at = Date.parse(status.updatedAt);
    if (!Number.isFinite(at)) return true;
    return now - at > STATUS_STALE_SECONDS * 1000;
}

/** A run of this kind that is really going on — what the window must not start a second one of. */
export function liveActivity(paths: CasePaths, kind: ActivityKind, now: number = Date.now()): boolean {
    const status = readActivityStatus(paths, kind);
    return status !== undefined && status.state === 'running' && !orphanedActivity(status, now);
}

/** How often the handle writes while the run is going. State changes are written at once. */
const WRITE_INTERVAL_MS = 1000;

export interface ActivityStatusHandle {
    /** Throttled to about one write per second; the latest numbers are kept for the end state. */
    update(done: number, total: number): void;
    finish(): void;
    fail(): void;
    cancel(): void;
}

export interface ActivityStatusOptions {
    /** Defaults to the current process. */
    readonly pid?: number;
    /** The clock, injectable so the throttle and the timestamps are testable. */
    readonly now?: () => number;
}

/** Begin writing the status of a run about to start; the `running` snapshot is written at once. */
export function beginActivityStatus(
    paths: CasePaths,
    kind: ActivityKind,
    options: ActivityStatusOptions = {},
): ActivityStatusHandle {
    const now = options.now ?? Date.now;
    const pid = options.pid ?? (typeof process.pid === 'number' ? process.pid : 0);
    const started = new Date(now()).toISOString();
    let snapshot: ActivityStatus = {
        version: ACTIVITY_STATUS_VERSION,
        kind,
        state: 'running',
        pid,
        startedAt: started,
        updatedAt: started,
        done: 0,
        total: 0,
    };
    let latest = { done: 0, total: 0 };
    let writtenAt = now();
    writeActivityStatus(paths, snapshot);

    const end = (state: ActivityState): void => {
        snapshot = { ...snapshot, ...latest, state, updatedAt: new Date(now()).toISOString() };
        writeActivityStatus(paths, snapshot);
    };
    return {
        update(done: number, total: number): void {
            latest = { done, total };
            const at = now();
            if (at - writtenAt < WRITE_INTERVAL_MS) return;
            writtenAt = at;
            snapshot = { ...snapshot, ...latest, updatedAt: new Date(at).toISOString() };
            writeActivityStatus(paths, snapshot);
        },
        finish: () => end('finished'),
        fail: () => end('failed'),
        cancel: () => end('cancelled'),
    };
}

/** Does any activity file exist? Cheap pre-check for callers that only want to skip the reads. */
export function hasActivityStatus(paths: CasePaths): boolean {
    return ACTIVITY_KINDS.some((kind) => existsSync(activityStatusFile(paths, kind)));
}
