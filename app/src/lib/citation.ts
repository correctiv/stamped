/**
 * The citation sentence of one message, with the two facts only the raw bytes and the clock know.
 *
 * `citationFor` in `@stamped/core` is pure; this is the part every surface that holds the bytes
 * does the same way, so the terminal and the window cannot disagree about the receiving server's
 * record or the date.
 */

import { citationFor, type MessageFinding } from '@stamped/core';
import { parseHeaderFields, splitMessage } from '@stamped/import';
import { hasReceiverPass } from '@stamped/store';

/** The citation for a finding of these bytes, checked `now`. Call after `initI18n()`. */
export function citationOf(finding: MessageFinding, raw: Uint8Array, now: Date = new Date()): string {
    const domain = finding.basis?.evidence.domain;
    const receiverPass =
        domain !== undefined && hasReceiverPass(parseHeaderFields(splitMessage(raw).header), domain);
    return citationFor(finding, { verifiedOn: now.toISOString().slice(0, 10), receiverPass });
}
