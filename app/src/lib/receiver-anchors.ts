/**
 * What the receiver-anchor section of a report says, as data both the text and the PDF report render.
 *
 * Counted over MESSAGES. The receiving server's `Authentication-Results` line is a witness
 * outside the signature, and an unsigned one: it is an indication that never lifts a verdict, so
 * the section says so before it gives a number.
 */

import { _, fmt, formatNumber } from '@stamped/core';
import type { ReceiverAnchorTotals } from '@stamped/store';

export interface ReceiverAnchorSection {
    readonly heading: string;
    readonly note: string;
    /** Label, messages the receiving server recorded as passed, messages in the group. */
    readonly groups: readonly [label: string, anchored: number, messages: number][];
    /** Signing domain, anchored messages, messages with an unverifiable signature of that domain. */
    readonly domains: readonly [domain: string, anchored: number, messages: number][];
}

/** The section, or `undefined` when no message is without proof of its own. Call after `initI18n()`. */
export function receiverAnchorSection(totals: ReceiverAnchorTotals): ReceiverAnchorSection | undefined {
    const groups: [string, number, number][] = [];
    if (totals.unverifiable.messages > 0) {
        groups.push([
            _('No key available (unverifiable)'),
            totals.unverifiable.anchored,
            totals.unverifiable.messages,
        ]);
    }
    if (totals.recoveredKey.messages > 0) {
        groups.push([
            _('Key recovered from signatures (confirmed with caveats)'),
            totals.recoveredKey.anchored,
            totals.recoveredKey.messages,
        ]);
    }
    if (groups.length === 0) return undefined;
    return {
        heading: _('Confirmed by the receiving server'),
        note: _(
            'For messages whose signature cannot be checked against a published key, the receiving server may have recorded dkim=pass for it at delivery. That line is not signed: it is a claim of the archive and an indication, not proof, and it never changes a verdict. If the receiving system is part of the same leak, the line can have been written by whoever controlled it.',
        ),
        groups,
        domains: totals.domains.map((row): [string, number, number] => [row.domain, row.anchored, row.messages]),
    };
}

/** One text-report line for a group or domain: `anchored of messages`. */
export function anchorShare(anchored: number, messages: number): string {
    return fmt(_('{anchored} of {messages}'), {
        anchored: formatNumber(anchored),
        messages: formatNumber(messages),
    });
}
