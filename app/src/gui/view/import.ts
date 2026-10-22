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
import type { ImportResult, ImportStatus } from '@stamped/store';

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
