/**
 * `stamped status`'s output: the human lines, and the shape `--json` prints.
 *
 * Pure — the file is read by the command, and everything after that is data in, text out, so
 * the wording and the numbers are testable without a case folder or a terminal.
 *
 * The percentages are BYTES, not messages: a folder import's byte total spans every source of
 * the run, while the message total is the current mailbox's. A percentage that jumps back to
 * zero at every mailbox is one nobody can read a progress from.
 */

import { fmt, _, _n } from '@stamped/core';
import { orphanedActivity, orphanedImport, type ActivityStatus, type ImportStatus } from '@stamped/store';

import { formatBytes, groupDigits } from '../gui/view/format.ts';
import { formatDuration } from './duration.ts';

/** `87.3` — one decimal, because a byte total in the gigabytes moves in decimals. */
export function percent(done: number, total: number): number {
    if (total <= 0) return 0;
    return Math.round(Math.min(1, done / total) * 1000) / 10;
}

/** The machine form `--json` prints: the status file, plus the two derived facts. */
export interface StatusJson {
    readonly state: ImportStatus['state'];
    /** `running`, but the process is gone or the updates stopped — see `orphanedImport`. */
    readonly orphaned: boolean;
    readonly pid: number;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly sources: readonly string[];
    readonly mailbox?: string;
    readonly mailsDone: number;
    readonly mailsTotal: number;
    readonly bytesRead: number;
    readonly bytesTotal: number;
    /** Percent of the whole run's bytes, one decimal. */
    readonly percent: number;
    readonly rate: number;
    readonly bytesRate: number;
    /** Seconds left, -1 when unknown, 0 when the run is over. */
    readonly eta: number;
    readonly errors: number;
}

export function statusJson(status: ImportStatus): StatusJson {
    return {
        state: status.state,
        orphaned: orphanedImport(status),
        pid: status.pid,
        startedAt: status.startedAt,
        updatedAt: status.updatedAt,
        sources: [...status.sources],
        ...(status.mailbox === undefined ? {} : { mailbox: status.mailbox }),
        mailsDone: status.mailsDone,
        mailsTotal: status.mailsTotal,
        bytesRead: status.bytesRead,
        bytesTotal: status.bytesTotal,
        percent: percent(status.bytesRead, status.bytesTotal),
        rate: status.rate,
        bytesRate: status.bytesRate,
        eta: status.eta,
        errors: status.errors,
    };
}

/** The headline: what state the case's last import is in, in one sentence. */
export function statusHeadline(status: ImportStatus): string {
    if (status.state === 'running') {
        return orphanedImport(status)
            ? _(
                  'An import is marked running, but its process is gone or it has not reported for a while. It was interrupted.',
              )
            : _('An import is running in this case.');
    }
    switch (status.state) {
        case 'finished':
            return _('The last import finished.');
        case 'failed':
            return _('The last import failed.');
        case 'cancelled':
            return _('The last import was cancelled.');
    }
}

/**
 * The human report, one fact per line.
 *
 * Ordered by what an operator asks first — is it running, then how far, then what it is doing,
 * then the times — and every count is formatted, because `1204337` is not a number a person
 * reads off a terminal.
 */
export function statusLines(status: ImportStatus): string[] {
    const lines = [statusHeadline(status)];
    lines.push(
        // No "of N": `mailsTotal` is the CURRENT source's count and `mailsDone` the run's, so the
        // pair read "4 of 1" on a folder import. The run-wide progress is the byte percentage.
        fmt(_n('{done} message read ({percent}% of {size}).', '{done} messages read ({percent}% of {size}).', status.mailsDone), {
            done: groupDigits(status.mailsDone),
            percent: String(percent(status.bytesRead, status.bytesTotal)),
            size: formatBytes(status.bytesTotal),
        }),
    );
    if (status.mailbox !== undefined) {
        lines.push(fmt(_('Mailbox: {mailbox}'), { mailbox: status.mailbox }));
    }
    lines.push(fmt(_('Sources: {sources}'), { sources: status.sources.join(', ') }));
    if (status.rate > 0) {
        lines.push(fmt(_('{rate} messages/s, {bytes}/s.'), {
            rate: String(status.rate),
            bytes: formatBytes(status.bytesRate),
        }));
    }
    if (status.state === 'running' && status.eta >= 0) {
        lines.push(fmt(_('About {time} left.'), { time: formatDuration(status.eta * 1000) }));
    }
    if (status.errors > 0) {
        lines.push(
            fmt(
                _n(
                    '{count} message has no verdict because verification failed.',
                    '{count} messages have no verdict because verification failed.',
                    status.errors,
                ),
                { count: String(status.errors) },
            ),
        );
    }
    lines.push(
        fmt(_('Started {started}, last update {updated}.'), {
            started: status.startedAt,
            updated: status.updatedAt,
        }),
    );
    return lines;
}

/** The line for a case folder that has never had an import run in it. */
export function noStatusLine(root: string): string {
    return fmt(_('No import has run in {path}.'), { path: root });
}

/** The machine form of one background run: `state` plus the derived `orphaned`, numbers only. */
export interface ActivityJson {
    readonly kind: ActivityStatus['kind'];
    readonly state: ActivityStatus['state'];
    readonly orphaned: boolean;
    readonly pid: number;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly done: number;
    readonly total: number;
    readonly percent: number;
}

export function activityJson(status: ActivityStatus, now: number = Date.now()): ActivityJson {
    return {
        kind: status.kind,
        state: status.state,
        orphaned: orphanedActivity(status, now),
        pid: status.pid,
        startedAt: status.startedAt,
        updatedAt: status.updatedAt,
        done: status.done,
        total: status.total,
        percent: percent(status.done, status.total),
    };
}

/** One sentence per background run; a `running` file that is not alive reads as interrupted. */
export function activityLine(status: ActivityStatus, now: number = Date.now()): string {
    const args = { done: groupDigits(status.done), total: groupDigits(status.total) };
    if (status.state === 'running' && orphanedActivity(status, now)) {
        switch (status.kind) {
            case 'people':
                return _('The address listing was interrupted.');
            case 'keys':
                return _('The key lookup was interrupted.');
            case 'reverify':
                return _('The re-verification was interrupted.');
        }
    }
    switch (status.kind) {
        case 'people':
            switch (status.state) {
                case 'running':
                    return fmt(_('Listing addresses: {done} of {total} messages.'), args);
                case 'finished':
                    return _('The last address listing finished.');
                case 'failed':
                    return _('The last address listing failed.');
                case 'cancelled':
                    return _('The last address listing was cancelled.');
            }
            break;
        case 'keys':
            switch (status.state) {
                case 'running':
                    return fmt(_('Looking up keys: {done} of {total} stored.'), args);
                case 'finished':
                    return _('The last key lookup finished.');
                case 'failed':
                    return _('The last key lookup failed.');
                case 'cancelled':
                    return _('The last key lookup was cancelled.');
            }
            break;
        case 'reverify':
            switch (status.state) {
                case 'running':
                    return fmt(_('Re-verifying: {done} of {total} messages.'), args);
                case 'finished':
                    return _('The last re-verification finished.');
                case 'failed':
                    return _('The last re-verification failed.');
                case 'cancelled':
                    return _('The last re-verification was cancelled.');
            }
    }
}
