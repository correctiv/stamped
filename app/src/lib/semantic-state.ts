/**
 * The semantic layer's state model: what the case folder says, and what that means for the
 * person using it.
 *
 * PURE ON PURPOSE. The state is derived from two files in the case folder — the setting (on or
 * off, what the probe measured) and the run status (what the last run is doing) — so the same
 * derivation serves the running app and `stamped status` in another terminal. There is no
 * second answer to "is the indexing running" depending on who asks.
 *
 * THE STATES, AND WHY THERE IS ONE MORE THAN THE LIST SUGGESTS:
 *
 * | state         | means                                                       |
 * |---------------|-------------------------------------------------------------|
 * | `off`         | not on — either never decided or switched off on purpose     |
 * | `unavailable` | this runtime cannot embed at all (no model runtime)          |
 * | `probing`     | measuring how fast this machine is                           |
 * | `indexing`    | embedding, with what is done and what is left               |
 * | `paused`      | on hold — on battery, or because the person said so          |
 * | `ready`       | everything in the case has a vector                          |
 * | `failed`      | the run broke, and the message says why                      |
 *
 * `unavailable` is not one of the failures: a machine without the model runtime cannot do the
 * work at all, and saying "failed" would blame the case for a missing piece of the program.
 *
 * THE REMAINING TIME IS MEASURED WHILE INDEXING, not taken from the probe. The spike found that
 * a three-second probe was off by 32 % in one run out of six — good enough to decide whether to
 * switch the feature on, not good enough to promise a journalist an hour. So the estimate comes
 * from the throughput of the running indexer, over a MOVING WINDOW, and the probe's number is
 * only a stand-in for the first seconds before there is a window to measure.
 */

import { _ } from '@stamped/core';
import type {
    CasePaths,
    SemanticPauseReason,
    SemanticProbeRecord,
    SemanticRunStatus,
    SemanticSetting,
} from '@stamped/store';
import { readSemanticRunStatus, readSemanticSetting, staleSemanticRun } from '@stamped/store';

/** The state of the semantic layer, as the app and the CLI see it. */
export type SemanticState =
    | { readonly kind: 'off' }
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'probing' }
    | {
          readonly kind: 'indexing';
          readonly done: number;
          readonly total: number;
          /** Seconds left, when they can be estimated. */
          readonly remainingSeconds?: number;
      }
    | {
          readonly kind: 'paused';
          readonly reason: SemanticPauseReason;
          readonly done: number;
          readonly total: number;
      }
    | { readonly kind: 'ready'; readonly done: number; readonly total: number }
    | { readonly kind: 'failed'; readonly message: string };

/** What the case folder says about the semantic layer. */
export interface SemanticSnapshot {
    /** The setting; absent when the case never decided about semantic search. */
    readonly setting?: SemanticSetting;
    /** The last run's status; absent when no run ever wrote one. */
    readonly run?: SemanticRunStatus;
}

/**
 * Read the two files of a case folder.
 *
 * `undefined` when there is no setting at all: a case that never decided about semantic search
 * has nothing to show, and saying "off" about it would be an opinion the folder never gave.
 */
export function semanticSnapshot(paths: CasePaths): SemanticSnapshot | undefined {
    const setting = readSemanticSetting(paths);
    if (setting === undefined) return undefined;
    return { setting, run: readSemanticRunStatus(paths) };
}

/**
 * What the snapshot means.
 *
 * The setting comes first: a case that is switched off is off whatever the last run did, and the
 * vectors it left behind stay where they are.
 */
export function semanticState(snapshot: SemanticSnapshot, now: number = Date.now()): SemanticState {
    const setting = snapshot.setting;
    if (setting === undefined || !setting.enabled) return { kind: 'off' };

    const run = snapshot.run;
    // On, but nothing has run yet: the work is on hold until the app runs again. That is what
    // "paused" means here — not "the person paused it", but "it is not going on by itself".
    if (run === undefined) return { kind: 'paused', reason: 'user', done: 0, total: 0 };

    switch (run.state) {
        case 'probing':
            return staleSemanticRun(run, now)
                ? { kind: 'failed', message: _('The measurement was interrupted and is not running any more.') }
                : { kind: 'probing' };
        case 'indexing':
            return staleSemanticRun(run, now)
                ? { kind: 'failed', message: _('The indexing was interrupted and is not running any more.') }
                : {
                      kind: 'indexing',
                      done: run.done,
                      total: run.total,
                      ...(run.remainingSeconds === undefined ? {} : { remainingSeconds: run.remainingSeconds }),
                  };
        case 'paused':
            return {
                kind: 'paused',
                reason: run.pausedReason ?? 'user',
                done: run.done,
                total: run.total,
            };
        case 'ready':
            return { kind: 'ready', done: run.done, total: run.total };
        case 'failed':
            return { kind: 'failed', message: run.error ?? _('The indexing failed.') };
        case 'unavailable':
            return { kind: 'unavailable' };
    }
}

/** One measurement of the indexer's throughput. */
export interface ThroughputSample {
    /** Epoch milliseconds when the sample was taken. */
    readonly at: number;
    /** Messages that have a vector by then. */
    readonly done: number;
}

/** How far back the moving window reaches. */
export const THROUGHPUT_WINDOW_MS = 60_000;

/**
 * How many samples the window needs before its rate is worth anything.
 *
 * Two samples make a rate out of one interval, and one interval can be a single fast batch. Three
 * samples span at least two intervals, which is the difference between a measurement and an
 * accident.
 */
export const THROUGHPUT_MIN_SAMPLES = 3;

/**
 * The messages per second over the last window.
 *
 * A MOVING WINDOW, not the average over the whole run: the machine's speed changes with what it
 * is doing, and an average over hours says what the machine did hours ago. The window is short
 * enough to follow a change and long enough not to follow every batch.
 *
 * `undefined` when there is not enough to measure — the caller then falls back to the probe.
 */
export function throughputRate(
    samples: readonly ThroughputSample[],
    now: number,
): number | undefined {
    const recent = samples.filter((sample) => now - sample.at <= THROUGHPUT_WINDOW_MS);
    if (recent.length < THROUGHPUT_MIN_SAMPLES) return undefined;
    const first = recent[0] as ThroughputSample;
    const last = recent[recent.length - 1] as ThroughputSample;
    const seconds = (last.at - first.at) / 1000;
    if (seconds <= 0) return undefined;
    const done = last.done - first.done;
    if (done <= 0) return undefined;
    return done / seconds;
}

/**
 * The seconds left, by the probe's estimate.
 *
 * The probe measured the whole archive, so what is left of it is that estimate times the share
 * that is still missing. It is a stand-in for the first seconds of a run, not the answer: the
 * spike's probe was off by 32 % in one run out of six, which is why the running indexer's own
 * throughput takes over as soon as there is a window to measure.
 */
export function probeRemainingSeconds(
    probe: SemanticProbeRecord | undefined,
    done: number,
    total: number,
): number | undefined {
    if (probe === undefined || total <= 0) return undefined;
    const missing = Math.max(total - done, 0);
    return (probe.estimatedHours * 3600 * missing) / total;
}
