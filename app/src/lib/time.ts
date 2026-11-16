/**
 * The time layer for one message: the header values it reads, handed to `@stamped/core`.
 *
 * Core is pure and reads no message; this is the one place that knows where the values sit. It
 * reads the FIRST `Date` (the one a reader sees) and every `Received` in file order, topmost
 * first, which is the order `checkTime` expects.
 *
 * It is also where the two-message check gets its second message. Core reads no `In-Reply-To`, so
 * the rule for which earlier message a reply names lives here, with the conversation in hand. A
 * caller without a conversation — `stamped verify` on one file — passes none, and that check
 * reads `not-checkable`.
 */

import {
    checkTime,
    type MessageFinding,
    type TimeFinding,
    type TimeParent,
    type TimeParentCandidate,
} from '@stamped/core';
import {
    type HeaderField,
    headerValue,
    headerValues,
    parseHeaderFields,
    splitMessage,
} from '@stamped/import';
import { messageIds, type Thread } from '@stamped/store';

/**
 * The ids a reply names as the message it answers: every id in `In-Reply-To`, or the last of
 * `References` when there is no `In-Reply-To`.
 *
 * DELIBERATELY NOT the rule `buildThread` uses. That one takes a single id, because a conversation
 * has to come out a tree and a tree needs one parent per node. This one must not pick, because
 * picking is a guess and a guess here produces a finding: a malformed `In-Reply-To` naming two
 * ids names two messages this reply might be answering, and `checkTime` refuses the comparison
 * when they disagree rather than comparing against whichever happens to come last.
 */
function parentIds(fields: readonly HeaderField[]): string[] {
    const inReplyTo = headerValues(fields, 'in-reply-to').flatMap((value) => messageIds(value));
    if (inReplyTo.length > 0) return inReplyTo;
    const last = headerValues(fields, 'references')
        .flatMap((value) => messageIds(value))
        .at(-1);
    return last === undefined ? [] : [last];
}

/**
 * What the conversation holds of the messages the reply names.
 *
 * One candidate per entry carrying the id, so an archive holding two mails under one id yields
 * two of them. An id the conversation has only as a MISSING entry, or does not have at all,
 * yields one that is not held — which stops the comparison instead of dropping out of it.
 *
 * The message itself is never a candidate: an `In-Reply-To` naming its own `Message-ID` would
 * otherwise be compared against its own `Date` and come out `consistent` by arithmetic, which
 * reads as a check that was made when none was.
 */
function parentOf(fields: readonly HeaderField[], thread: Thread): TimeParent {
    const candidates: TimeParentCandidate[] = [];
    for (const id of parentIds(fields)) {
        const held = thread.entries.filter(
            (entry) => entry.messageId === id && !entry.missing && !entry.focus,
        );
        if (held.length === 0) {
            candidates.push({ held: false });
            continue;
        }
        for (const entry of held) {
            candidates.push({ held: true, ...(entry.date === '' ? {} : { date: entry.date }) });
        }
    }
    return { candidates };
}

export function timeFindingOf(
    raw: Uint8Array,
    finding: MessageFinding,
    thread?: Thread,
): TimeFinding {
    const fields = parseHeaderFields(splitMessage(raw).header);
    const date = headerValue(fields, 'date');
    return checkTime({
        ...(date === undefined ? {} : { date }),
        received: headerValues(fields, 'received'),
        signatures: finding.signatures.map((signature) => signature.evidence),
        ...(thread === undefined ? {} : { parent: parentOf(fields, thread) }),
    });
}
