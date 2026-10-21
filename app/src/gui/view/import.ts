/**
 * What an import run did, in the one sentence the toast after it shows.
 *
 * The counts are reported, never netted off. `read` minus `duplicates` would be the tidier
 * number and it would hide the fact a journalist came for: the same message arriving from two
 * archives says the two overlap, which is often how a leak's provenance is reconstructed —
 * the same rule [`sources.ts`](sources.ts) follows for the folder list.
 *
 * `failed` is in the sentence for a harder reason. Those messages ARE stored and ARE in the
 * case, and they have no verdict because verification threw on them. A summary that left them
 * out would let a message disappear from every count a reader checks while still being in the
 * archive they are about to draw conclusions from.
 */

import { fmt, _, _n } from '@stamped/core';
import { orphanedImport, type ImportResult, type ImportStatus } from '@stamped/store';

import { percent } from '../../lib/status.ts';
import { groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';

export function importSummary(result: ImportResult): string {
    if (result.read === 0) {
        return escapeLine(_('Nothing imported: no messages were found in it.'));
    }
    const parts = [
        fmt(_n('{count} new message', '{count} new messages', result.stored), {
            count: groupDigits(result.stored),
        }),
    ];
    if (result.duplicates > 0) {
        parts.push(
            fmt(
                _n('{count} was already in the case', '{count} were already in the case', result.duplicates),
                { count: groupDigits(result.duplicates) },
            ),
        );
    }
    if (result.failed > 0) {
        parts.push(
            fmt(
                _n(
                    '{count} could not be verified and has no verdict',
                    '{count} could not be verified and have no verdict',
                    result.failed,
                ),
                { count: groupDigits(result.failed) },
            ),
        );
    }
    return escapeLine(`${parts.join(', ')}.`);
}

/**
 * The import banner: what the window says while a run is going, in one line.
 *
 * The percentage is by BYTES over the whole run (`percent` in `lib/status.ts`), because the message total is
 * the current mailbox's — a number that restarts at every mailbox reads as an import going
 * backwards. The mailbox is named when the layout names one: "which account is it reading right
 * now" is the question a journalist actually has during a folder import.
 *
 * Escaped like every view model's text — the mailbox is a folder name from the leak, and a name
 * with an `&` in it must not take the rest of the banner with it.
 */
export function importBannerTitle(status: ImportStatus, orphaned: boolean): string {
    if (orphaned) {
        return escapeLine(_('Import interrupted — its process is gone. Run the import again to resume.'));
    }
    const parts = [
        // The run's count without the current source's total — see `statusLines`.
        fmt(_n('{percent}% · {done} message', '{percent}% · {done} messages', status.mailsDone), {
            percent: String(percent(status.bytesRead, status.bytesTotal)),
            done: groupDigits(status.mailsDone),
        }),
    ];
    if (status.mailbox !== undefined) parts.push(status.mailbox);
    if (status.eta >= 0) {
        parts.push(fmt(_('about {time} left'), { time: formatBannerEta(status.eta) }));
    }
    return escapeLine(parts.join(' · '));
}

/** `3 min` / `45 s` — the banner has no room for seconds once there are minutes. */
function formatBannerEta(seconds: number): string {
    if (seconds < 60) return fmt(_('{n} s'), { n: String(Math.max(0, Math.round(seconds))) });
    return fmt(_('{n} min'), { n: String(Math.round(seconds / 60)) });
}

/**
 * The banner for a case's current import, or `undefined` when there is none to show.
 *
 * One function rather than three setters in the window: what the banner says, whether it is up
 * at all and whether its button may kill anything are ONE decision taken from the file, and a
 * window that took it in three places would be three places for the states to disagree.
 * `cancellable` is true only for a run that is really going — nobody may kill a run that is
 * already over, and the orphaned case names a process that is already gone.
 */
export function importBannerView(
    status: ImportStatus | undefined,
): { readonly revealed: boolean; readonly title: string; readonly cancellable: boolean } | undefined {
    if (status === undefined) return undefined;
    const orphaned = orphanedImport(status);
    const running = status.state === 'running' && !orphaned;
    return {
        revealed: running || orphaned,
        title: importBannerTitle(status, orphaned),
        cancellable: running,
    };
}

/**
 * The sentence shown once a run ENDS and the case reloads.
 *
 * One sentence per outcome, and the failed one is a sticky toast rather than a passing one: a
 * failed import is a finding to read, not a confirmation to watch go by.
 */
export function importOutcome(status: ImportStatus, orphaned: boolean): string {
    if (orphaned) {
        return _('The import stopped without finishing. Run it again to resume.');
    }
    switch (status.state) {
        case 'finished':
            return _('Import finished.');
        case 'failed':
            return _('The import failed.');
        case 'cancelled':
            return _('Import cancelled. Run it again to resume.');
        case 'running':
            return _('Import running.');
    }
}
