/**
 * How the semantic state is shown: the human lines, and the shape `--json` prints.
 *
 * Pure, like `status.ts` for the import: the wording and the numbers are testable without a
 * case folder and without a terminal.
 *
 * ONE OR TWO LINES, because the semantic layer is a BACKGROUND feature and its state is a note
 * under the import's, not a second report. A person who reads only the last line still learns
 * whether the indexing is running, on what, and whether it is worth waiting for.
 */

import { _, _n, fmt } from '@stamped/core';
import type { SemanticPauseReason, SemanticSetting } from '@stamped/store';

import type { SemanticState } from './semantic-state.ts';

/** The machine form `--json` prints. */
export interface SemanticStatusJson {
    /** `off`, `unavailable`, `probing`, `indexing`, `paused`, `ready` or `failed`. */
    readonly state: SemanticState['kind'];
    /** Messages that have a vector. */
    readonly done: number;
    /** Messages in the case. */
    readonly total: number;
    /** Seconds left, -1 when unknown. */
    readonly eta: number;
    /** Why the run is on hold; only in the `paused` state. */
    readonly pausedReason?: SemanticPauseReason;
    /** What went wrong; only in the `failed` state. */
    readonly message?: string;
    /** The model the vectors belong to. */
    readonly modelId?: string;
    /** How many float32s a vector of that model has. */
    readonly dimensions?: number;
    /** Tokens per second, as the last probe measured them. */
    readonly tokensPerSecond?: number;
    /** How long the whole archive would take at that speed. */
    readonly estimatedHours?: number;
}

/** The human lines, one fact per line. */
export function semanticLines(state: SemanticState): string[] {
    switch (state.kind) {
        case 'off':
            return [_('Semantic search is off.')];
        case 'unavailable':
            return [_('Semantic search is not available on this runtime.')];
        case 'probing':
            return [_('Semantic search is measuring how fast this machine is.')];
        case 'indexing': {
            const lines = [
                fmt(
                    _n(
                        'Semantic search: indexing {done} of {total} message.',
                        'Semantic search: indexing {done} of {total} messages.',
                        state.total,
                    ),
                    { done: String(state.done), total: String(state.total) },
                ),
            ];
            if (state.remainingSeconds !== undefined) {
                lines.push(fmt(_('About {time} left.'), { time: remainingTime(state.remainingSeconds) }));
            }
            return lines;
        }
        case 'paused':
            return state.reason === 'battery'
                ? [_('Semantic search is paused: this machine is running on its battery.')]
                : [_('Semantic search is paused.')];
        case 'ready':
            return [
                fmt(
                    _n(
                        'Semantic search is ready: {count} message indexed.',
                        'Semantic search is ready: {count} messages indexed.',
                        state.done,
                    ),
                    { count: String(state.done) },
                ),
            ];
        case 'failed':
            return [fmt(_('Semantic search failed: {message}'), { message: state.message })];
    }
}

/** The machine form of the same state. */
export function semanticStatusJson(state: SemanticState, setting?: SemanticSetting): SemanticStatusJson {
    const done = 'done' in state ? state.done : 0;
    const total = 'total' in state ? state.total : 0;
    const eta =
        state.kind === 'indexing' && state.remainingSeconds !== undefined
            ? Math.round(state.remainingSeconds)
            : -1;
    return {
        state: state.kind,
        done,
        total,
        eta,
        ...(state.kind === 'paused' ? { pausedReason: state.reason } : {}),
        ...(state.kind === 'failed' ? { message: state.message } : {}),
        ...(setting?.modelId === undefined ? {} : { modelId: setting.modelId }),
        ...(setting?.dimensions === undefined ? {} : { dimensions: setting.dimensions }),
        ...(setting?.probe === undefined
            ? {}
            : {
                  tokensPerSecond: setting.probe.tokensPerSecond,
                  estimatedHours: setting.probe.estimatedHours,
              }),
    };
}

/**
 * How long the rest will take, in words a person reads.
 *
 * The semantic estimate is in HOURS — the probe measured a whole archive — so it needs a unit
 * the import's `formatDuration` does not have: "7.8 h" says what "468 min 0 s" hides.
 */
export function remainingTime(seconds: number): string {
    if (seconds >= 3600) return fmt(_('{n} h'), { n: (seconds / 3600).toFixed(1) });
    if (seconds >= 60) return fmt(_('{n} min'), { n: String(Math.round(seconds / 60)) });
    return fmt(_('{n} s'), { n: String(Math.round(seconds)) });
}
