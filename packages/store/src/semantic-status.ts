/**
 * The semantic layer's RUN STATUS: what the indexing of this case folder is doing right now.
 *
 * THE SAME IDEA AS THE IMPORT STATUS, AND FOR THE SAME REASON: progress is a FILE in the case
 * folder, not the property of whoever started the run. `stamped status` reads it from another
 * terminal, the window polls it, and either works for a run the other started.
 *
 * WRITTEN AT MOST ABOUT ONCE A SECOND, and always atomically (`tmp` + rename). The file STAYS
 * with its last state, so "what did the indexing do" is a question about the case and not about
 * a process that is long gone.
 *
 * A `running` file whose last update is stale belongs to a run that is no longer alive — the app
 * was killed, the machine went down, the process was killed with the window. It reads as a
 * failure, because "the indexing is running" is the one thing this file must never claim when
 * nothing is running. A `paused` file is never stale: a paused run is waiting on purpose.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CasePaths } from './case.ts';

/** Bumped when a build would misread a status an older build wrote. */
export const SEMANTIC_STATUS_VERSION = 1;

/** The file's name inside the case folder. */
export const SEMANTIC_STATUS_NAME = 'semantic-status.json';

/**
 * How long a running file may go without an update before the run reads as interrupted.
 * The same minute the import status uses: long enough that a busy machine is not mistaken for a
 * dead one, short enough that nobody waits an hour for a run that is not there.
 */
export const SEMANTIC_STATUS_STALE_SECONDS = 60;

/** The states a run is ever in. */
export type SemanticRunState = 'probing' | 'indexing' | 'paused' | 'ready' | 'failed' | 'unavailable';

const RUN_STATES: readonly SemanticRunState[] = [
    'probing',
    'indexing',
    'paused',
    'ready',
    'failed',
    'unavailable',
];

/** Why a run is on hold. */
export type SemanticPauseReason = 'battery' | 'user';

/** One snapshot of the run. Numbers about messages, never the messages themselves. */
export interface SemanticRunStatus {
    readonly version: number;
    readonly state: SemanticRunState;
    /** Messages that have a vector. */
    readonly done: number;
    /** Messages in the case. */
    readonly total: number;
    /** Seconds left, when they can be estimated. */
    readonly remainingSeconds?: number;
    /** Why the run is on hold; only in the `paused` state. */
    readonly pausedReason?: SemanticPauseReason;
    /** What went wrong; only in the `failed` state. */
    readonly error?: string;
    /** When the snapshot was written, ISO 8601. */
    readonly updatedAt: string;
    /** The process doing the work; 0 when the runtime does not say. */
    readonly pid: number;
}

/** The file's path inside a case folder. */
export function semanticStatusFile(paths: CasePaths): string {
    return join(paths.root, SEMANTIC_STATUS_NAME);
}

/** The status, or `undefined` when there is none or it cannot be trusted. */
export function readSemanticRunStatus(paths: CasePaths): SemanticRunStatus | undefined {
    let text: string;
    try {
        text = readFileSync(semanticStatusFile(paths), 'utf8');
    } catch {
        return undefined;
    }
    let parsed: Partial<SemanticRunStatus>;
    try {
        parsed = JSON.parse(text) as Partial<SemanticRunStatus>;
    } catch {
        return undefined;
    }
    if (typeof parsed.version !== 'number' || parsed.version > SEMANTIC_STATUS_VERSION) {
        return undefined;
    }
    if (typeof parsed.state !== 'string' || !RUN_STATES.includes(parsed.state as SemanticRunState)) {
        return undefined;
    }
    if (!Number.isFinite(parsed.done) || !Number.isFinite(parsed.total)) return undefined;
    if (parsed.remainingSeconds !== undefined && !Number.isFinite(parsed.remainingSeconds)) {
        return undefined;
    }
    if (
        parsed.pausedReason !== undefined &&
        parsed.pausedReason !== 'battery' &&
        parsed.pausedReason !== 'user'
    ) {
        return undefined;
    }
    if (parsed.error !== undefined && typeof parsed.error !== 'string') return undefined;
    if (typeof parsed.updatedAt !== 'string') return undefined;
    if (typeof parsed.pid !== 'number') return undefined;
    return parsed as SemanticRunStatus;
}

/** Write the status atomically: a reader sees the old snapshot or the new one, never a torn one. */
export function writeSemanticRunStatus(paths: CasePaths, status: SemanticRunStatus): void {
    const target = semanticStatusFile(paths);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, undefined, 2)}\n`);
    renameSync(tmp, target);
}

/**
 * Is a running file describing a run that is no longer running?
 *
 * The staleness of the last update is the whole test: the run writes at least once a second
 * while it works, so a file that has not been touched for a minute belongs to a run that is
 * gone. A run that is paused or finished is never stale — a paused run waits on purpose, and an
 * end state is a record.
 */
export function staleSemanticRun(status: SemanticRunStatus, now: number = Date.now()): boolean {
    if (status.state !== 'probing' && status.state !== 'indexing') return false;
    const at = Date.parse(status.updatedAt);
    if (!Number.isFinite(at)) return true;
    return now - at > SEMANTIC_STATUS_STALE_SECONDS * 1000;
}
