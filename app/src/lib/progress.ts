/**
 * The machine-readable progress line `--progress=jsonl` prints.
 *
 * JSON Lines rather than a table, because the reader of this output is a script and a script
 * wants one object per line it can read without a parser. The line is a SNAPSHOT, not an event:
 * every line says how far the import has got, so a line that is lost does not cost the reader
 * the state.
 *
 * THE MAILBOX IS IN THE LINE, because a folder of mailboxes is imported one mailbox after the
 * other, and a progress stream that does not say which mailbox it is talking about cannot tell
 * a journalist that the import has reached the interesting one — or that it is still stuck in the
 * first.
 */

import type { ImportProgress } from '@stamped/store';

/** One progress line, as it is printed. */
export interface ProgressLine {
    /** How many messages are done. */
    readonly done: number;
    /** How many messages the current source holds. */
    readonly total: number;
    /** Messages per second. */
    readonly rate: number;
    /** Seconds left, 0 when the rate is unknown or the run is over. */
    readonly eta: number;
    /** How many messages could not be verified. */
    readonly errors: number;
    /** How many messages the store already held. */
    readonly duplicates: number;
    /** The mailbox being imported, when the layout names one. */
    readonly mailbox?: string;
    /** `true` for the last line of the run. */
    readonly final: boolean;
}

/**
 * The line for one point of the import.
 *
 * `seconds` is how long the run has been going; the rate and the estimate are computed from it
 * rather than from a moving average, because a moving average of a rate needs a history this
 * line does not carry.
 */
export function progressLine(progress: ImportProgress, final: boolean, seconds: number): ProgressLine {
    const rate = progress.done / seconds;
    const remaining = Math.max(progress.total - progress.done, 0);
    return {
        done: progress.done,
        total: progress.total,
        rate: Math.round(rate * 10) / 10,
        eta: final || rate === 0 ? 0 : Math.round(remaining / rate),
        errors: progress.failed,
        duplicates: progress.duplicates,
        ...(progress.mailbox === undefined ? {} : { mailbox: progress.mailbox }),
        final,
    };
}
