/**
 * The "Zeit" layer: whether the time values INSIDE one message agree with each other.
 *
 * This sits beside the six DKIM verdicts and never changes one. A DKIM verdict says what a
 * signature covers; this layer says whether the clocks written into the message tell a story
 * that hangs together. Three answers only — `consistent`, `inconsistent`, `not-checkable` — and
 * none of them is a claim about who wrote the message or whether it was altered: a wrong clock,
 * a client in the wrong timezone and a queued mail all read as `inconsistent`, and that is the
 * whole of what the word means.
 *
 * Pure and deterministic, like the classifier: no clock is read, every input is passed in.
 * Stufe 1 is PER MESSAGE: it uses nothing but what one message carries. Anything that needs
 * other mails (a sender's rhythm, a thread's order) belongs to a later stage.
 *
 * What a value is worth depends on who could have written it. A `Date` listed in `h=` of a
 * verified signature, and that signature's `t=`/`x=`, are covered by cryptography; `Received`
 * lines never are. Every check says which of its values are covered, and a result that rests on
 * covered values says so.
 */

import { fmt, _ } from './i18n.ts';
import type { SignatureEvidence } from './verdict.ts';

/** The three answers, and the only three. */
export const TIME_RESULTS = ['consistent', 'inconsistent', 'not-checkable'] as const;

/** One of the three things the time layer may say. */
export type TimeResult = (typeof TIME_RESULTS)[number];

/** The checks of Stufe 1, in the order they are reported. */
export const TIME_CHECKS = [
    'date-vs-signature',
    'signature-lifetime',
    'received-order',
    'date-vs-received',
] as const;

/** One kind of check. */
export type TimeCheckKind = (typeof TIME_CHECKS)[number];

/** Why a check could not be made. Always a missing or unreadable value, never a judgement. */
export type TimeUnavailableReason =
    /** The message has no `Date` header. */
    | 'no-date'
    /** The `Date` header does not parse as an RFC 5322 date. */
    | 'bad-date'
    /** No VERIFIED signature carries a `t=`. An unverified signature's `t=` is not evidence. */
    | 'no-signature-time'
    /** No verified signature carries both `t=` and `x=`. */
    | 'no-expiry'
    /** Fewer than two `Received` headers: a single hop has no order. */
    | 'too-few-received'
    /** `Received` headers exist, but fewer than the check needs have a readable timestamp. */
    | 'bad-received';

/** Every unavailable reason, in the order they are documented. */
export const TIME_UNAVAILABLE_REASONS: readonly TimeUnavailableReason[] = [
    'no-date',
    'bad-date',
    'no-signature-time',
    'no-expiry',
    'too-few-received',
    'bad-received',
];

/*
 * Tolerances, in SECONDS. Fixed constants, not per case: a threshold chosen after looking at a
 * mail is a threshold chosen to fit the story. They are sized against the clock noise of a real
 * archive — thousands of ordinary mails — so that "inconsistent" stays rare enough to mean
 * something. Each one allows the ordinary cause of a gap and names the direction it cares about.
 */

/**
 * Date LATER than a verified signature's `t=`: one hour.
 *
 * A message cannot be signed before the date it claims, but the two clocks (the sender's device
 * and the signing server) are not synchronised and neither is guaranteed to be right: minutes of
 * drift are routine, tens of minutes happen on unmanaged devices. One hour clears that. Beyond
 * it the usual cause is a wrong timezone label, which is exactly what should be flagged.
 */
export const TOLERANCE_DATE_AFTER_SIGNATURE = 3600;

/**
 * Date EARLIER than a verified signature's `t=`: seven days.
 *
 * Many clients stamp `Date` when the mail is started and the signer stamps `t=` when it leaves:
 * a draft kept open, an outbox waiting for a connection, an MTA queue retrying (queue lifetimes
 * of four to five days are the defaults of the common servers). A gap in this direction is
 * therefore normal for days; a week clears even a draft left over a weekend plus a retry.
 */
export const TOLERANCE_DATE_BEFORE_SIGNATURE = 7 * 86400;

/**
 * A signature's `x=` earlier than its own `t=`: zero.
 *
 * Not clock noise. Both values are written by the same signer in the same moment, and an expiry
 * before the creation is not something a signer produces. No tolerance is needed.
 */
export const TOLERANCE_EXPIRY_BEFORE_SIGNATURE = 0;

/**
 * A lower `Received` header dated LATER than the one above it: fifteen minutes.
 *
 * Each hop stamps its own clock and the clocks of different operators differ; a few minutes of
 * drift between hops is common and ten to fifteen occurs on badly kept servers. Mail that really
 * travelled never goes backwards by more than that without a clock being off by far more.
 */
export const TOLERANCE_RECEIVED_STEP_BACK = 900;

/**
 * Date LATER than the first (bottom-most) readable `Received`: one hour.
 *
 * The first hop sees the mail at or after the moment the client stamped it, so a `Date` after it
 * means the client clock ran ahead or labelled its timezone wrongly. Same reasoning and same
 * size as {@link TOLERANCE_DATE_AFTER_SIGNATURE}. A `Date` far BEFORE the first hop is the
 * ordinary delayed mail and is not checked.
 */
export const TOLERANCE_DATE_AFTER_FIRST_RECEIVED = 3600;

/** All tolerances in one table, for documentation and for a reader who wants to quote them. */
export const TIME_TOLERANCES = {
    dateAfterSignature: TOLERANCE_DATE_AFTER_SIGNATURE,
    dateBeforeSignature: TOLERANCE_DATE_BEFORE_SIGNATURE,
    expiryBeforeSignature: TOLERANCE_EXPIRY_BEFORE_SIGNATURE,
    receivedStepBack: TOLERANCE_RECEIVED_STEP_BACK,
    dateAfterFirstReceived: TOLERANCE_DATE_AFTER_FIRST_RECEIVED,
} as const;

/** Which header or tag a compared instant came from. */
export type TimeValueKind = 'date' | 'signature-time' | 'signature-expiry' | 'received';

/** One instant that was compared, and whether a verified signature covers it. */
export interface TimeValue {
    readonly kind: TimeValueKind;
    /** The instant, in milliseconds since the epoch (UTC). */
    readonly at: number;
    /**
     * True when a verified signature covers this value: a `t=`/`x=` of a verified signature, or
     * a `Date` listed in that signature's `h=`. A `Received` header is never covered.
     */
    readonly protectedBySignature: boolean;
    /** `d=` of the signature the value belongs to, when it belongs to one. */
    readonly domain?: string;
}

/** One check, its answer, and the basis for the answer. */
export interface TimeCheck {
    readonly kind: TimeCheckKind;
    readonly result: TimeResult;
    /** The instants that were compared. Empty when the check was not checkable. */
    readonly values: readonly TimeValue[];
    /** The deviation in seconds; what is subtracted from what is named per check in `timecheck.md`. */
    readonly deviationSeconds?: number;
    /** The tolerance in seconds that applied to this comparison. */
    readonly toleranceSeconds?: number;
    /** True when every compared value is covered by a verified signature. */
    readonly protectedBySignature: boolean;
    /** Set when, and only when, the result is `not-checkable`. */
    readonly unavailable?: TimeUnavailableReason;
}

/** The answer for a whole message and every check it rests on. */
export interface TimeFinding {
    readonly result: TimeResult;
    /** True when a check that decides the result rests on values a verified signature covers. */
    readonly protectedBySignature: boolean;
    /** Every check, in {@link TIME_CHECKS} order. */
    readonly checks: readonly TimeCheck[];
}

/** What the time layer reads from one message. */
export interface TimeInput {
    /** The raw value of the `Date` header, if the message has one. */
    readonly date?: string;
    /** The raw values of the `Received` headers, topmost (last hop) first, as they sit in the file. */
    readonly received: readonly string[];
    /** Every signature of the message, as the verifier produced it. */
    readonly signatures: readonly SignatureEvidence[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The zone names RFC 5322 § 4.3 still lists, in minutes east of UTC. Anything else is unreadable. */
const ZONES: Readonly<Record<string, number>> = {
    ut: 0,
    gmt: 0,
    z: 0,
    est: -300,
    edt: -240,
    cst: -360,
    cdt: -300,
    mst: -420,
    mdt: -360,
    pst: -480,
    pdt: -420,
};

const DATE_PATTERN =
    /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([+-]\d{4}|[A-Za-z]+)$/;

/**
 * Parse an RFC 5322 date to milliseconds since the epoch, or `undefined`.
 *
 * Written out instead of `Date.parse`: the engines differ on comments, obsolete zones and two-digit
 * years, and a time check that answers differently on GJS and Node would be two different claims.
 * A date without a zone, with an unknown zone name or with an impossible calendar day (30 February)
 * is unreadable, not guessed — guessing is how a wrong answer gets a number.
 */
export function parseMailDate(value: string): number | undefined {
    const text = value
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const match = DATE_PATTERN.exec(text);
    if (!match) return undefined;
    const [, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = match;
    const month = MONTHS.indexOf(monthText!.slice(0, 3).toLowerCase());
    if (month < 0) return undefined;

    let year = Number(yearText);
    if (yearText!.length === 2) year += year < 50 ? 2000 : 1900;
    else if (yearText!.length === 3) year += 1900;
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Math.min(Number(secondText ?? 0), 59);
    if (hour > 23 || minute > 59 || Number(secondText ?? 0) > 60) return undefined;

    let offsetMinutes: number | undefined;
    if (/^[+-]\d{4}$/.test(zoneText!)) {
        const hours = Number(zoneText!.slice(1, 3));
        const minutes = Number(zoneText!.slice(3, 5));
        if (hours > 23 || minutes > 59) return undefined;
        offsetMinutes = (zoneText![0] === '-' ? -1 : 1) * (hours * 60 + minutes);
    } else {
        offsetMinutes = ZONES[zoneText!.toLowerCase()];
    }
    if (offsetMinutes === undefined) return undefined;

    const utc = Date.UTC(year, month, day, hour, minute, second);
    const check = new Date(utc);
    if (check.getUTCDate() !== day || check.getUTCMonth() !== month) return undefined;
    return utc - offsetMinutes * 60000;
}

/** The timestamp of a `Received` header: the date after its last `;` (RFC 5321 § 4.4). */
export function parseReceivedTime(value: string): number | undefined {
    const at = value.lastIndexOf(';');
    return at < 0 ? undefined : parseMailDate(value.slice(at + 1));
}

/** Did this signature verify? Only such a signature's `t=` and `x=` are evidence. */
function isVerified(signature: SignatureEvidence): boolean {
    return signature.bodyHashOk && signature.signatureOk && !signature.unverifiableBecause;
}

function notCheckable(kind: TimeCheckKind, unavailable: TimeUnavailableReason): TimeCheck {
    return { kind, result: 'not-checkable', values: [], protectedBySignature: false, unavailable };
}

/** The `Date` header as an instant, or the reason it is not one. */
function readDate(input: TimeInput): { at: number } | { unavailable: TimeUnavailableReason } {
    if (input.date === undefined || input.date.trim() === '') return { unavailable: 'no-date' };
    const at = parseMailDate(input.date);
    return at === undefined ? { unavailable: 'bad-date' } : { at };
}

function verifiedSignatures(input: TimeInput): SignatureEvidence[] {
    return input.signatures.filter(isVerified);
}

function isInstant(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** How far outside its tolerance a deviation lies; zero when inside. */
function excess(deviation: number, tolerance: number): number {
    return Math.max(0, Math.abs(deviation) - tolerance);
}

/** The first candidate with the largest excess, then a protected one, then the earliest. */
function worst<T extends { excess: number; protectedBySignature: boolean }>(candidates: T[]): T {
    return candidates.reduce((best, next) => {
        if (next.excess !== best.excess) return next.excess > best.excess ? next : best;
        if (next.protectedBySignature !== best.protectedBySignature) {
            return next.protectedBySignature ? next : best;
        }
        return best;
    });
}

function checkDateVsSignature(input: TimeInput): TimeCheck {
    const kind = 'date-vs-signature';
    const date = readDate(input);
    if ('unavailable' in date) return notCheckable(kind, date.unavailable);
    const timed = verifiedSignatures(input).filter((signature) => isInstant(signature.signedAt));
    if (timed.length === 0) return notCheckable(kind, 'no-signature-time');

    const candidates = timed.map((signature) => {
        const signedMs = signature.signedAt! * 1000;
        const deviation = (date.at - signedMs) / 1000;
        const tolerance = deviation < 0 ? TOLERANCE_DATE_BEFORE_SIGNATURE : TOLERANCE_DATE_AFTER_SIGNATURE;
        const dateProtected = signature.signedHeaders.includes('date');
        return {
            signature,
            signedMs,
            deviation,
            tolerance,
            dateProtected,
            excess: excess(deviation, tolerance),
            protectedBySignature: dateProtected,
        };
    });
    const pick = worst(candidates);
    return {
        kind,
        result: pick.excess > 0 ? 'inconsistent' : 'consistent',
        values: [
            {
                kind: 'date',
                at: date.at,
                protectedBySignature: pick.dateProtected,
                domain: pick.signature.domain,
            },
            {
                kind: 'signature-time',
                at: pick.signedMs,
                protectedBySignature: true,
                domain: pick.signature.domain,
            },
        ],
        deviationSeconds: pick.deviation,
        toleranceSeconds: pick.tolerance,
        protectedBySignature: pick.dateProtected,
    };
}

function checkSignatureLifetime(input: TimeInput): TimeCheck {
    const kind = 'signature-lifetime';
    const verified = verifiedSignatures(input);
    if (!verified.some((signature) => isInstant(signature.signedAt))) {
        return notCheckable(kind, 'no-signature-time');
    }
    const bounded = verified.filter(
        (signature) => isInstant(signature.signedAt) && isInstant(signature.expiresAt),
    );
    if (bounded.length === 0) return notCheckable(kind, 'no-expiry');

    const candidates = bounded.map((signature) => {
        const deviation = signature.expiresAt! - signature.signedAt!;
        return {
            signature,
            deviation,
            excess: Math.max(0, -deviation - TOLERANCE_EXPIRY_BEFORE_SIGNATURE),
            protectedBySignature: true,
        };
    });
    const pick = worst(candidates);
    return {
        kind,
        result: pick.excess > 0 ? 'inconsistent' : 'consistent',
        values: [
            {
                kind: 'signature-time',
                at: pick.signature.signedAt! * 1000,
                protectedBySignature: true,
                domain: pick.signature.domain,
            },
            {
                kind: 'signature-expiry',
                at: pick.signature.expiresAt! * 1000,
                protectedBySignature: true,
                domain: pick.signature.domain,
            },
        ],
        deviationSeconds: pick.deviation,
        toleranceSeconds: TOLERANCE_EXPIRY_BEFORE_SIGNATURE,
        protectedBySignature: true,
    };
}

/** The readable `Received` instants, topmost first. */
function receivedInstants(input: TimeInput): number[] {
    return input.received.map(parseReceivedTime).filter(isInstant);
}

function checkReceivedOrder(input: TimeInput): TimeCheck {
    const kind = 'received-order';
    if (input.received.length < 2) return notCheckable(kind, 'too-few-received');
    const instants = receivedInstants(input);
    if (instants.length < 2) return notCheckable(kind, 'bad-received');

    // Topmost is the LAST hop, so each step down the file should go back in time.
    let pair = { upper: instants[0]!, lower: instants[1]!, deviation: -Infinity };
    for (let i = 1; i < instants.length; i++) {
        const deviation = (instants[i]! - instants[i - 1]!) / 1000;
        if (deviation > pair.deviation) pair = { upper: instants[i - 1]!, lower: instants[i]!, deviation };
    }
    return {
        kind,
        result: pair.deviation > TOLERANCE_RECEIVED_STEP_BACK ? 'inconsistent' : 'consistent',
        values: [
            { kind: 'received', at: pair.lower, protectedBySignature: false },
            { kind: 'received', at: pair.upper, protectedBySignature: false },
        ],
        deviationSeconds: pair.deviation,
        toleranceSeconds: TOLERANCE_RECEIVED_STEP_BACK,
        protectedBySignature: false,
    };
}

function checkDateVsReceived(input: TimeInput): TimeCheck {
    const kind = 'date-vs-received';
    const date = readDate(input);
    if ('unavailable' in date) return notCheckable(kind, date.unavailable);
    if (input.received.length === 0) return notCheckable(kind, 'too-few-received');
    const instants = receivedInstants(input);
    if (instants.length === 0) return notCheckable(kind, 'bad-received');

    const first = instants[instants.length - 1]!;
    const deviation = (date.at - first) / 1000;
    const dateProtected = verifiedSignatures(input).some((signature) =>
        signature.signedHeaders.includes('date'),
    );
    return {
        kind,
        result: deviation > TOLERANCE_DATE_AFTER_FIRST_RECEIVED ? 'inconsistent' : 'consistent',
        values: [
            { kind: 'date', at: date.at, protectedBySignature: dateProtected },
            { kind: 'received', at: first, protectedBySignature: false },
        ],
        deviationSeconds: deviation,
        toleranceSeconds: TOLERANCE_DATE_AFTER_FIRST_RECEIVED,
        protectedBySignature: false,
    };
}

/**
 * Run every Stufe 1 check on one message.
 *
 * The overall result is the worst of the checks that could be made: one `inconsistent` check
 * makes the message `inconsistent`; otherwise any `consistent` check makes it `consistent`; a
 * message where nothing could be compared is `not-checkable`. A `not-checkable` check never
 * counts against a message — a missing value is the absence of a finding.
 */
export function checkTime(input: TimeInput): TimeFinding {
    const checks = [
        checkDateVsSignature(input),
        checkSignatureLifetime(input),
        checkReceivedOrder(input),
        checkDateVsReceived(input),
    ];
    const inconsistent = checks.filter((check) => check.result === 'inconsistent');
    const consistent = checks.filter((check) => check.result === 'consistent');
    const deciding = inconsistent.length > 0 ? inconsistent : consistent;
    return {
        result:
            inconsistent.length > 0 ? 'inconsistent' : consistent.length > 0 ? 'consistent' : 'not-checkable',
        protectedBySignature: deciding.some((check) => check.protectedBySignature),
        checks,
    };
}

/** The short name of a result, for a badge. */
export function timeResultLabel(result: TimeResult): string {
    switch (result) {
        case 'consistent':
            return _('Consistent');
        case 'inconsistent':
            return _('Inconsistent');
        case 'not-checkable':
            return _('Not checkable');
    }
}

/** One line for the whole layer; it names what the result does NOT say. */
export function describeTimeResult(result: TimeResult): string {
    switch (result) {
        case 'consistent':
            return _('Time: consistent. The time values of this message agree within the tolerances.');
        case 'inconsistent':
            return _(
                'Time: inconsistent. Time values of this message disagree beyond the tolerances. The signature verdict is unaffected.',
            );
        case 'not-checkable':
            return _('Time: not checkable. This message has too few usable time values.');
    }
}

/** A span in seconds as `±H:MM:SS`, hours unbounded, so it reads the same in every language. */
export function formatTimeSpan(seconds: number): string {
    const sign = seconds < 0 ? '-' : '+';
    const total = Math.round(Math.abs(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const two = (n: number) => String(n).padStart(2, '0');
    return `${sign}${hours}:${two(minutes)}:${two(rest)}`;
}

/** Why a check could not be made. */
export function describeTimeUnavailable(reason: TimeUnavailableReason): string {
    switch (reason) {
        case 'no-date':
            return _('The message has no Date header.');
        case 'bad-date':
            return _('The Date header cannot be read as a date.');
        case 'no-signature-time':
            return _('No verified signature carries a signing time (t=).');
        case 'no-expiry':
            return _('No verified signature carries both a signing time (t=) and an expiry (x=).');
        case 'too-few-received':
            return _('There are too few Received headers to compare.');
        case 'bad-received':
            return _('The Received headers carry too few readable timestamps.');
    }
}

/** What the check found, with the numbers it compared. */
export function describeTimeCheck(check: TimeCheck): string {
    if (check.result === 'not-checkable') {
        return describeTimeUnavailable(check.unavailable ?? 'no-date');
    }
    const values = {
        deviation: formatTimeSpan(check.deviationSeconds ?? 0),
        tolerance: formatTimeSpan(check.toleranceSeconds ?? 0).replace(/^\+/, ''),
    };
    const ok = check.result === 'consistent';
    switch (check.kind) {
        case 'date-vs-signature':
            return fmt(
                ok
                    ? _(
                          'The Date header agrees with the signing time (t=) of a verified signature (difference {deviation}, tolerance {tolerance}).',
                      )
                    : _(
                          'The Date header differs from the signing time (t=) of a verified signature by {deviation}, beyond the tolerance of {tolerance}.',
                      ),
                values,
            );
        case 'signature-lifetime':
            return fmt(
                ok
                    ? _('The signature expires (x=) after it was made (t=), by {deviation}.')
                    : _('The signature expires (x=) before it was made (t=): {deviation}.'),
                values,
            );
        case 'received-order':
            return fmt(
                ok
                    ? _(
                          'The Received headers run in time order (largest step backwards {deviation}, tolerance {tolerance}).',
                      )
                    : _(
                          'A lower Received header is dated {deviation} after the one above it, beyond the tolerance of {tolerance}.',
                      ),
                values,
            );
        case 'date-vs-received':
            return fmt(
                ok
                    ? _(
                          'The Date header is not later than the first Received header (difference {deviation}, tolerance {tolerance}).',
                      )
                    : _(
                          'The Date header is {deviation} later than the first Received header, beyond the tolerance of {tolerance}.',
                      ),
                values,
            );
    }
}

/** How much the result weighs, depending on whether the compared values are signed. */
export function describeTimeProtection(check: TimeCheck): string {
    return check.protectedBySignature
        ? _('Every compared value is covered by a verified signature, so this result weighs more.')
        : _(
              'At least one compared value is not covered by a verified signature and could have been written by anyone.',
          );
}
