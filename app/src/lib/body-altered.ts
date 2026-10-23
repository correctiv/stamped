/**
 * What the body-altered section of a report says, as data both the text and the PDF report render.
 *
 * Counted over MESSAGES. An explained message "was most likely changed by the export, content
 * unchanged" — the verdict stays `body-altered`. The indicator groups for the rest are an
 * INDICATION, never proof, and they overlap.
 */

import type { ExportArtefact } from '@stamped/core';
import { fmt, formatNumber, _, _n } from '@stamped/core';
import type { BodyExplanationTotals } from '@stamped/store';

export interface BodyAlteredSection {
    readonly basis: string;
    readonly explainedNote: string;
    readonly explained: readonly [label: string, messages: number][];
    readonly unexplained: number;
    readonly indicatorNote: string;
    readonly indicators: readonly [label: string, messages: number][];
}

const ARTEFACT_ORDER: readonly ExportArtefact[] = [
    'dot-stuffing',
    'line-endings',
    'dot-stuffing-and-line-endings',
    'base64-rewrapped',
    'base64-trailing-newline',
    'quoted-printable-decoded',
];

function artefactLabel(artefact: ExportArtefact): string {
    switch (artefact) {
        case 'dot-stuffing':
            return _('Doubled leading dots (dot-stuffing)');
        case 'line-endings':
            return _('Line endings converted');
        case 'dot-stuffing-and-line-endings':
            return _('Doubled leading dots and line endings');
        case 'base64-rewrapped':
            return _('Base64 lines re-wrapped');
        case 'base64-trailing-newline':
            return _('Base64 line break before the boundary added or removed');
        case 'quoted-printable-decoded':
            return _('Quoted-printable text stored decoded');
    }
}

/** The section, or `undefined` when no message is body-altered. Call after `initI18n()`. */
export function bodyAlteredSection(totals: BodyExplanationTotals): BodyAlteredSection | undefined {
    if (totals.examined === 0) return undefined;
    const explained = ARTEFACT_ORDER.flatMap((artefact): [string, number][] => {
        const messages = totals.explained[artefact] ?? 0;
        return messages > 0 ? [[artefactLabel(artefact), messages]] : [];
    });
    const sum = explained.reduce((all, [, messages]) => all + messages, 0);
    return {
        basis: fmt(
            _n(
                'Counted over {count} message with a body-altered signature, by re-checking its raw file against the hash the sender signed.',
                'Counted over {count} messages with a body-altered signature, by re-checking their raw files against the hash the sender signed.',
                totals.examined,
            ),
            { count: formatNumber(totals.examined) },
        ),
        explainedNote: fmt(
            _(
                '{count} most likely changed by the export, content unchanged: undoing the artefact brings the signed hash back. The verdict stays body-altered.',
            ),
            { count: formatNumber(sum) },
        ),
        explained,
        unexplained: totals.unexplained,
        indicatorNote: _(
            'Of the rest, no known export artefact explains the difference. The groups below are an indication, not proof, and overlap.',
        ),
        indicators: [
            [_('Exchange/TNEF markers in the header'), totals.exchange],
            [_('Receiving server recorded no dkim=pass'), totals.noReceiverPass],
        ],
    };
}
