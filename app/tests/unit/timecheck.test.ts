/**
 * The time layer, on hand-built headers and evidence.
 *
 * Every value is synthetic (reserved example domains, invented instants). The cases that matter
 * most are the ones that must NOT read as `inconsistent`: ordinary delay, ordinary clock drift,
 * a missing header. A flood of false "inconsistent" is the failure this suite guards against.
 */

import {
    checkTime,
    formatTimeSpan,
    parseMailDate,
    parseReceivedTime,
    type SignatureEvidence,
    TIME_CHECKS,
    TIME_RESULTS,
    TIME_TOLERANCES,
    type TimeCheck,
    type TimeInput,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';

const BASE = Date.UTC(2024, 2, 10, 12, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);

function signature(overrides: Partial<SignatureEvidence> = {}): SignatureEvidence {
    return {
        domain: 'example.com',
        selector: 'sel',
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: ['from', 'to', 'subject', 'date'],
        bodyHashOk: true,
        signatureOk: true,
        aligned: true,
        signedAt: seconds(BASE),
        ...overrides,
    };
}

function input(overrides: Partial<TimeInput> = {}): TimeInput {
    return { date: 'Sun, 10 Mar 2024 12:00:00 +0000', received: [], signatures: [], ...overrides };
}

function check(finding: ReturnType<typeof checkTime>, kind: (typeof TIME_CHECKS)[number]): TimeCheck {
    return finding.checks.find((c) => c.kind === kind)!;
}

export default async () => {
    await describe('parseMailDate', async () => {
        await it('applies the zone offset', async () => {
            expect(parseMailDate('Sun, 10 Mar 2024 13:00:00 +0100')).toBe(BASE);
            expect(parseMailDate('Sun, 10 Mar 2024 07:00:00 -0500')).toBe(BASE);
            expect(parseMailDate('10 Mar 2024 12:00 GMT')).toBe(BASE);
        });

        await it('ignores a trailing comment and reads obsolete zone names', async () => {
            expect(parseMailDate('Sun, 10 Mar 2024 04:00:00 -0800 (PST)')).toBe(BASE);
            expect(parseMailDate('Sun, 10 Mar 2024 07:00:00 EST')).toBe(BASE);
        });

        await it('does not guess', async () => {
            expect(parseMailDate('')).toBe(undefined);
            expect(parseMailDate('yesterday')).toBe(undefined);
            expect(parseMailDate('Sun, 10 Mar 2024 12:00:00')).toBe(undefined);
            expect(parseMailDate('Sun, 10 Mar 2024 12:00:00 XYZ')).toBe(undefined);
            expect(parseMailDate('Fri, 30 Feb 2024 12:00:00 +0000')).toBe(undefined);
            expect(parseMailDate('Sun, 10 Mar 2024 25:00:00 +0000')).toBe(undefined);
        });

        await it('reads the timestamp of a Received header after the last semicolon', async () => {
            expect(
                parseReceivedTime(
                    'from a.example.net by b.example.org with ESMTP id x; Sun, 10 Mar 2024 12:00:00 +0000',
                ),
            ).toBe(BASE);
            expect(parseReceivedTime('from a.example.net by b.example.org')).toBe(undefined);
        });
    });

    await describe('date against the signing time', async () => {
        await it('is consistent for a Date equal to t=, and protected when h= lists Date', async () => {
            const finding = checkTime(input({ signatures: [signature()] }));
            const c = check(finding, 'date-vs-signature');
            expect(c.result).toBe('consistent');
            expect(c.protectedBySignature).toBe(true);
            expect(c.deviationSeconds).toBe(0);
            expect(c.toleranceSeconds).toBe(TIME_TOLERANCES.dateAfterSignature);
            expect(c.values.map((v) => v.kind)).toStrictEqual(['date', 'signature-time']);
            expect(finding.result).toBe('consistent');
            expect(finding.protectedBySignature).toBe(true);
        });

        await it('is not protected when Date is not in h=', async () => {
            const finding = checkTime(
                input({ signatures: [signature({ signedHeaders: ['from', 'subject'] })] }),
            );
            const c = check(finding, 'date-vs-signature');
            expect(c.result).toBe('consistent');
            expect(c.protectedBySignature).toBe(false);
            expect(finding.protectedBySignature).toBe(false);
        });

        await it('flags a Date well after t=', async () => {
            const date = 'Sun, 10 Mar 2024 14:00:00 +0000';
            const finding = checkTime(input({ date, signatures: [signature()] }));
            const c = check(finding, 'date-vs-signature');
            expect(c.result).toBe('inconsistent');
            expect(c.deviationSeconds).toBe(7200);
            expect(finding.result).toBe('inconsistent');
        });

        await it('tolerates a Date just inside the hour after t=', async () => {
            const date = 'Sun, 10 Mar 2024 12:59:00 +0000';
            const c = check(checkTime(input({ date, signatures: [signature()] })), 'date-vs-signature');
            expect(c.result).toBe('consistent');
        });

        await it('tolerates a Date days before t= (draft, queue) and flags more than a week', async () => {
            const days = (n: number) => seconds(BASE) + n * 86400;
            const date = 'Sun, 10 Mar 2024 12:00:00 +0000';
            const three = check(
                checkTime(input({ date, signatures: [signature({ signedAt: days(3) })] })),
                'date-vs-signature',
            );
            expect(three.result).toBe('consistent');
            expect(three.toleranceSeconds).toBe(TIME_TOLERANCES.dateBeforeSignature);
            const nine = check(
                checkTime(input({ date, signatures: [signature({ signedAt: days(9) })] })),
                'date-vs-signature',
            );
            expect(nine.result).toBe('inconsistent');
        });

        await it('is not confused by the zone label: the same instant in another zone agrees', async () => {
            const date = 'Sun, 10 Mar 2024 21:00:00 +0900';
            const c = check(checkTime(input({ date, signatures: [signature()] })), 'date-vs-signature');
            expect(c.result).toBe('consistent');
            expect(c.deviationSeconds).toBe(0);
        });

        await it('does not count the t= of an unverified signature', async () => {
            const bad = signature({ signatureOk: false });
            const finding = checkTime(input({ date: 'Sun, 10 Mar 2024 20:00:00 +0000', signatures: [bad] }));
            const c = check(finding, 'date-vs-signature');
            expect(c.result).toBe('not-checkable');
            expect(c.unavailable).toBe('no-signature-time');
            expect(c.protectedBySignature).toBe(false);
            expect(finding.result).toBe('not-checkable');
        });

        await it('does not count an unverifiable or body-altered signature', async () => {
            const sigs = [
                signature({ unverifiableBecause: 'no-key', signatureOk: false }),
                signature({ bodyHashOk: false, signatureOk: false }),
            ];
            const c = check(checkTime(input({ signatures: sigs })), 'date-vs-signature');
            expect(c.result).toBe('not-checkable');
        });

        await it('reports the worst of several verified signatures, ignoring unverified ones', async () => {
            const late = signature({ domain: 'lists.example.org', signedAt: seconds(BASE) - 4 * 3600 });
            const unverified = signature({ domain: 'example.net', signatureOk: false, signedAt: 0 });
            const finding = checkTime(input({ signatures: [signature(), late, unverified] }));
            const c = check(finding, 'date-vs-signature');
            expect(c.result).toBe('inconsistent');
            expect(c.values[0]!.domain).toBe('lists.example.org');
            expect(c.deviationSeconds).toBe(4 * 3600);
        });

        await it('is not checkable without a Date, and with an unreadable one', async () => {
            const sigs = [signature()];
            const missing = check(checkTime({ received: [], signatures: sigs }), 'date-vs-signature');
            expect(missing.unavailable).toBe('no-date');
            const blank = check(checkTime(input({ date: '  ', signatures: sigs })), 'date-vs-signature');
            expect(blank.unavailable).toBe('no-date');
            const garbage = check(checkTime(input({ date: 'soon', signatures: sigs })), 'date-vs-signature');
            expect(garbage.unavailable).toBe('bad-date');
        });
    });

    await describe('signature lifetime', async () => {
        await it('is consistent when x= is after t=', async () => {
            const sig = signature({ expiresAt: seconds(BASE) + 86400 });
            const c = check(checkTime(input({ signatures: [sig] })), 'signature-lifetime');
            expect(c.result).toBe('consistent');
            expect(c.protectedBySignature).toBe(true);
            expect(c.deviationSeconds).toBe(86400);
        });

        await it('is inconsistent when x= is before t=', async () => {
            const sig = signature({ expiresAt: seconds(BASE) - 60 });
            const finding = checkTime(input({ signatures: [sig] }));
            const c = check(finding, 'signature-lifetime');
            expect(c.result).toBe('inconsistent');
            expect(c.deviationSeconds).toBe(-60);
            expect(c.toleranceSeconds).toBe(0);
            expect(finding.result).toBe('inconsistent');
            expect(finding.protectedBySignature).toBe(true);
        });

        await it('is consistent when x= equals t=', async () => {
            const sig = signature({ expiresAt: seconds(BASE) });
            expect(check(checkTime(input({ signatures: [sig] })), 'signature-lifetime').result).toBe(
                'consistent',
            );
        });

        await it('is not checkable without x=, and without t=', async () => {
            const noExpiry = check(checkTime(input({ signatures: [signature()] })), 'signature-lifetime');
            expect(noExpiry.unavailable).toBe('no-expiry');
            const noTime = check(
                checkTime(input({ signatures: [signature({ signedAt: undefined, expiresAt: 5 })] })),
                'signature-lifetime',
            );
            expect(noTime.unavailable).toBe('no-signature-time');
        });

        await it('ignores the x= of an unverified signature', async () => {
            const sig = signature({ signatureOk: false, expiresAt: 1 });
            expect(check(checkTime(input({ signatures: [sig] })), 'signature-lifetime').result).toBe(
                'not-checkable',
            );
        });
    });

    await describe('Received headers', async () => {
        const hop = (minutes: number) =>
            `from a.example.net by b.example.org with ESMTP; ${new Date(BASE + minutes * 60000)
                .toUTCString()
                .replace('GMT', '+0000')}`;

        await it('is consistent when the topmost hop is the latest', async () => {
            const finding = checkTime(input({ received: [hop(5), hop(2), hop(0)] }));
            const order = check(finding, 'received-order');
            expect(order.result).toBe('consistent');
            expect(order.protectedBySignature).toBe(false);
            expect(check(finding, 'date-vs-received').result).toBe('consistent');
            expect(finding.result).toBe('consistent');
            expect(finding.protectedBySignature).toBe(false);
        });

        await it('tolerates a few minutes of drift between hops', async () => {
            const order = check(checkTime(input({ received: [hop(0), hop(10)] })), 'received-order');
            expect(order.result).toBe('consistent');
            expect(order.deviationSeconds).toBe(600);
        });

        await it('flags a lower hop dated well after the one above', async () => {
            const finding = checkTime(input({ received: [hop(0), hop(60)] }));
            const order = check(finding, 'received-order');
            expect(order.result).toBe('inconsistent');
            expect(order.deviationSeconds).toBe(3600);
            expect(finding.result).toBe('inconsistent');
        });

        await it('flags a Date far after the first Received, not one far before it', async () => {
            const after = checkTime(
                input({ date: 'Sun, 10 Mar 2024 15:00:00 +0000', received: [hop(-120), hop(-180)] }),
            );
            expect(check(after, 'date-vs-received').result).toBe('inconsistent');
            const before = checkTime(
                input({ date: 'Sat, 09 Mar 2024 12:00:00 +0000', received: [hop(5), hop(0)] }),
            );
            expect(check(before, 'date-vs-received').result).toBe('consistent');
        });

        await it('needs two hops for the order and one for the Date', async () => {
            const one = checkTime(input({ received: [hop(0)] }));
            expect(check(one, 'received-order').unavailable).toBe('too-few-received');
            expect(check(one, 'date-vs-received').result).toBe('consistent');
            const none = checkTime(input());
            expect(check(none, 'date-vs-received').unavailable).toBe('too-few-received');
        });

        await it('skips an unreadable hop instead of failing on it', async () => {
            const finding = checkTime(input({ received: [hop(5), 'from broken', hop(0)] }));
            expect(check(finding, 'received-order').result).toBe('consistent');
            const allBad = checkTime(input({ received: ['x', 'y'] }));
            expect(check(allBad, 'received-order').unavailable).toBe('bad-received');
            expect(check(allBad, 'date-vs-received').unavailable).toBe('bad-received');
        });
    });

    await describe('the whole layer', async () => {
        await it('is not checkable for a bare message', async () => {
            const finding = checkTime({ received: [], signatures: [] });
            expect(finding.result).toBe('not-checkable');
            expect(finding.protectedBySignature).toBe(false);
            expect(finding.checks.map((c) => c.kind)).toStrictEqual([...TIME_CHECKS]);
        });

        await it('lets one inconsistent check outweigh consistent ones', async () => {
            const sig = signature({ expiresAt: seconds(BASE) - 1 });
            const finding = checkTime(input({ signatures: [sig] }));
            expect(check(finding, 'date-vs-signature').result).toBe('consistent');
            expect(finding.result).toBe('inconsistent');
        });

        await it('is deterministic and leaves its input alone', async () => {
            const data = input({ signatures: [signature()] });
            const before = JSON.stringify(data);
            expect(JSON.stringify(checkTime(data))).toBe(JSON.stringify(checkTime(data)));
            expect(JSON.stringify(data)).toBe(before);
        });

        await it('has exactly three results and never the word forged', async () => {
            expect([...TIME_RESULTS]).toStrictEqual(['consistent', 'inconsistent', 'not-checkable']);
            expect(
                /forg|fake|genuine|proven|gefälscht|echt|bewiesen/i.test(JSON.stringify(checkTime(input()))),
            ).toBe(false);
        });

        await it('formats a span without a locale', async () => {
            expect(formatTimeSpan(0)).toBe('+0:00:00');
            expect(formatTimeSpan(-3725)).toBe('-1:02:05');
            expect(formatTimeSpan(90000)).toBe('+25:00:00');
        });
    });
};
