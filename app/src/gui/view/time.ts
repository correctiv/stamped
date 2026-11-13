/**
 * The "Time" group of the reader: whether the time values inside one message agree.
 *
 * A SECOND LAYER, NOT A SECOND VERDICT. Everything shown here comes from
 * `@stamped/core`'s time layer, and that layer says nothing about who wrote a message or whether
 * it was altered: a wrong clock, a client in the wrong timezone and a queued mail all read as
 * `inconsistent`. So this group is presentation only — the sentences are the ones the CLI prints,
 * never rephrased here, and the group carries the standing reminder that the signature verdict
 * above it is untouched.
 *
 * THE COLOURS ARE DELIBERATELY NOT THE VERDICT COLOURS. `inconsistent` is a `warning` at most and
 * never `error`: `error` belongs to `body-altered` and `headers-altered`, the two findings of
 * tampering, and a red badge beside "Time" would read as one of them. `consistent` is `accent`
 * rather than `success` for the mirror-image reason — a green tick under a green verdict card
 * reads as a second confirmation, and agreeing clocks confirm nothing about a message.
 *
 * Strings are Pango-escaped like the rest of the view layer.
 */

import {
    describeTimeCheck,
    describeTimeProtection,
    describeTimeResult,
    timeResultLabel,
    type TimeCheck,
    type TimeCheckKind,
    type TimeFinding,
    type TimeResult,
    _,
} from '@stamped/core';

import { escapeLine } from './markup.ts';

/** One check of the time layer, as a row. */
export interface TimeRow {
    readonly kind: TimeCheckKind;
    readonly result: TimeResult;
    /** What the check compares, as a short column label. */
    readonly title: string;
    /** `describeTimeCheck`: what was found, or why the check could not be made. */
    readonly subtitle: string;
    /** One or two words, from `timeResultLabel`. */
    readonly badge: string;
    readonly cssClass: string;
    /**
     * `describeTimeProtection`, for the row's ⓘ. Absent for a check that could not be made: there
     * is no result for a signature to cover.
     */
    readonly protection?: string;
}

/** What the group shows. There is always one: a message with no usable value says so. */
export interface TimeGroup {
    readonly result: TimeResult;
    readonly title: string;
    readonly badge: string;
    readonly cssClass: string;
    readonly description: string;
    readonly rows: readonly TimeRow[];
}

/** See the module note: never an `error`, and `consistent` is not a second green tick. */
function timeCssClass(result: TimeResult): string {
    switch (result) {
        case 'consistent':
            return 'accent';
        case 'inconsistent':
            return 'warning';
        case 'not-checkable':
            return 'dimmed';
    }
}

/**
 * What a check compares, in two or three words.
 *
 * The one wording this module owns, and it names the VALUES rather than the outcome: the outcome
 * is the badge beside it and the sentence below it, both from core. A row whose title judged
 * would be judging twice, in words core never agreed to.
 */
function timeCheckTitle(kind: TimeCheckKind): string {
    switch (kind) {
        case 'date-vs-signature':
            return _('Date against the signing time');
        case 'signature-lifetime':
            return _('Signing time against the expiry');
        case 'received-order':
            return _('Order of the Received headers');
        case 'date-vs-received':
            return _('Date against the first Received header');
    }
}

export function timeRow(check: TimeCheck): TimeRow {
    const protection =
        check.result === 'not-checkable' ? undefined : escapeLine(describeTimeProtection(check));
    return {
        kind: check.kind,
        result: check.result,
        title: escapeLine(timeCheckTitle(check.kind)),
        subtitle: escapeLine(describeTimeCheck(check)),
        badge: escapeLine(timeResultLabel(check.result)),
        cssClass: timeCssClass(check.result),
        ...(protection === undefined ? {} : { protection }),
    };
}

export function timeGroup(time: TimeFinding): TimeGroup {
    const parts = [describeTimeResult(time.result)];
    // Core's `inconsistent` sentence ends with "The signature verdict is unaffected." — the one
    // result where it matters enough to be in the finding itself. The other two get it here, so
    // the group never reads as a claim about the message whatever it found.
    if (time.result !== 'inconsistent') {
        parts.push(_('This layer sits beside the signature verdict and never changes it.'));
    }
    return {
        result: time.result,
        title: escapeLine(_('Time')),
        badge: escapeLine(timeResultLabel(time.result)),
        cssClass: timeCssClass(time.result),
        description: escapeLine(parts.join(' ')),
        rows: time.checks.map(timeRow),
    };
}
