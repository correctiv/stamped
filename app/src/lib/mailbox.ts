/**
 * How a mailbox of the report is named and summed up, for every surface that shows one.
 *
 * Shared by the overview and `stamped report`, so the two cannot disagree on what "verifiable"
 * counts or on what the mail without a mailbox is called.
 */

import { _ } from '@stamped/core';
import type { MailboxReport } from '@stamped/store';

/** The name to show: the mailbox's own, or a label for the mail no mailbox could be named for. */
export function mailboxLabel(name: string): string {
    return name === '' ? _('Unknown mailbox') : name;
}

/**
 * The messages whose signature checks out, and their share of the mailbox.
 *
 * Both `confirmed` verdicts count: a caveat limits what the signature covers, it does not make it
 * fail. Everything else is "not shown to be unchanged", which is NOT "forged" — most mail has no
 * signature at all, so a low share describes the mailbox, not any one message in it.
 */
export function verifiableShare(mailbox: MailboxReport): { readonly count: number; readonly share: number } {
    const count = mailbox.verdicts
        .filter((entry) => entry.verdict === 'confirmed' || entry.verdict === 'confirmed-with-caveats')
        .reduce((sum, entry) => sum + entry.messages, 0);
    return { count, share: mailbox.messages === 0 ? 0 : count / mailbox.messages };
}

/** `2019-01-02 to 2024-05-06`, or `undefined` when no message of it has a readable date. */
export function mailboxSpan(mailbox: MailboxReport): { readonly from: string; readonly to: string } | undefined {
    if (mailbox.earliest === undefined || mailbox.latest === undefined) return undefined;
    return { from: mailbox.earliest.slice(0, 10), to: mailbox.latest.slice(0, 10) };
}
