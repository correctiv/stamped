/**
 * The time layer for one message: the header values it reads, handed to `@stamped/core`.
 *
 * Core is pure and reads no message; this is the one place that knows where the values sit. It
 * reads the FIRST `Date` (the one a reader sees) and every `Received` in file order, topmost
 * first, which is the order `checkTime` expects.
 */

import { checkTime, type MessageFinding, type TimeFinding } from '@stamped/core';
import { headerValue, headerValues, parseHeaderFields, splitMessage } from '@stamped/import';

export function timeFindingOf(raw: Uint8Array, finding: MessageFinding): TimeFinding {
    const fields = parseHeaderFields(splitMessage(raw).header);
    const date = headerValue(fields, 'date');
    return checkTime({
        ...(date === undefined ? {} : { date }),
        received: headerValues(fields, 'received'),
        signatures: finding.signatures.map((signature) => signature.evidence),
    });
}
