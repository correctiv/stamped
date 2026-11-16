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
    type TimeParent,
} from '@stamped/core';
import { encodeLatin1 } from '@stamped/import';
import type { Thread, ThreadEntry } from '@stamped/store';
import { describe, expect, it } from '@gjsify/unit';

import { timeFindingOf } from '../../src/lib/time.ts';

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

    await describe('a reply against the message it answers', async () => {
        /** A held parent with the `Date` it was written with. */
        const held = (date: string): TimeParent => ({ candidates: [{ held: true, date }] });
        const parent = (finding: ReturnType<typeof checkTime>) => check(finding, 'date-vs-parent');

        await it('is consistent for a reply dated after what it answers', async () => {
            const finding = checkTime(input({ parent: held('Sun, 10 Mar 2024 11:00:00 +0000') }));
            const c = parent(finding);
            expect(c.result).toBe('consistent');
            expect(c.deviationSeconds).toBe(3600);
            expect(c.toleranceSeconds).toBe(TIME_TOLERANCES.replyBeforeParent);
            expect(c.values.map((v) => v.kind)).toStrictEqual(['date', 'parent-date']);
        });

        await it('is consistent for a reply a month later: a late answer is ordinary', async () => {
            const c = parent(checkTime(input({ parent: held('Sat, 10 Feb 2024 12:00:00 +0000') })));
            expect(c.result).toBe('consistent');
        });

        await it('flags a reply dated well before what it answers', async () => {
            const finding = checkTime(input({ parent: held('Sun, 10 Mar 2024 15:00:00 +0000') }));
            const c = parent(finding);
            expect(c.result).toBe('inconsistent');
            expect(c.deviationSeconds).toBe(-10800);
            expect(finding.result).toBe('inconsistent');
        });

        await it('tolerates two hours of inversion: two client clocks and a DST slip', async () => {
            const inside = parent(checkTime(input({ parent: held('Sun, 10 Mar 2024 13:30:00 +0000') })));
            expect(inside.result).toBe('consistent');
            const edge = parent(checkTime(input({ parent: held('Sun, 10 Mar 2024 14:00:00 +0000') })));
            expect(edge.result).toBe('consistent');
            expect(edge.deviationSeconds).toBe(-7200);
        });

        await it('reads the zone of the other message rather than its clock face', async () => {
            const c = parent(checkTime(input({ parent: held('Sun, 10 Mar 2024 20:00:00 +0900') })));
            expect(c.result).toBe('consistent');
            expect(c.deviationSeconds).toBe(3600);
        });

        await it('is NEVER protected, whatever the signatures cover', async () => {
            const finding = checkTime(
                input({
                    date: 'Sun, 10 Mar 2024 09:00:00 +0000',
                    signatures: [signature({ signedAt: seconds(Date.UTC(2024, 2, 10, 9, 0, 0)) })],
                    parent: held('Sun, 10 Mar 2024 15:00:00 +0000'),
                }),
            );
            const c = parent(finding);
            expect(c.result).toBe('inconsistent');
            // `Date` sits in `h=` and the signature verified, so the value is covered — the check
            // is not, because the link to the other message is an unsigned header.
            expect(c.values[0]!.protectedBySignature).toBe(true);
            expect(c.values[1]!.protectedBySignature).toBe(false);
            expect(c.protectedBySignature).toBe(false);
            expect(finding.protectedBySignature).toBe(false);
        });

        await it('is not checkable when the caller looked up no conversation', async () => {
            expect(parent(checkTime(input())).unavailable).toBe('no-parent');
        });

        await it('is not checkable when the archive holds no message this one names', async () => {
            const none = checkTime(input({ parent: { candidates: [] } }));
            expect(parent(none).unavailable).toBe('no-parent');
            const gap = checkTime(input({ parent: { candidates: [{ held: false }] } }));
            expect(parent(gap).unavailable).toBe('no-parent');
            expect(parent(gap).values).toStrictEqual([]);
        });

        await it('is not checkable when the message it answers has no readable Date', async () => {
            const undated = checkTime(input({ parent: { candidates: [{ held: true }] } }));
            expect(parent(undated).unavailable).toBe('no-parent-date');
            const blank = checkTime(input({ parent: held('  ') }));
            expect(parent(blank).unavailable).toBe('no-parent-date');
            // No zone, so unreadable rather than guessed — the same rule as the message's own Date.
            const unzoned = checkTime(input({ parent: held('Sun, 10 Mar 2024 11:00:00') }));
            expect(parent(unzoned).unavailable).toBe('bad-parent-date');
        });

        await it('needs the reply to have a readable Date of its own', async () => {
            const missing = checkTime({
                received: [],
                signatures: [],
                parent: held('Sun, 10 Mar 2024 11:00:00 +0000'),
            });
            expect(parent(missing).unavailable).toBe('no-date');
        });

        await it('refuses to pick when the reply names two messages that disagree', async () => {
            const disagree = checkTime(
                input({
                    parent: {
                        candidates: [
                            { held: true, date: 'Sun, 10 Mar 2024 11:00:00 +0000' },
                            { held: true, date: 'Sun, 10 Mar 2024 15:00:00 +0000' },
                        ],
                    },
                }),
            );
            // The later one would be a finding, the earlier one would not. Which was answered is
            // unknown, so neither is reported.
            expect(parent(disagree).unavailable).toBe('ambiguous-parent');
            expect(disagree.result).toBe('not-checkable');
        });

        await it('compares two messages that agree on the instant', async () => {
            const agree = checkTime(
                input({
                    parent: {
                        candidates: [
                            { held: true, date: 'Sun, 10 Mar 2024 11:00:00 +0000' },
                            { held: true, date: 'Sun, 10 Mar 2024 12:00:00 +0100' },
                        ],
                    },
                }),
            );
            expect(parent(agree).result).toBe('consistent');
            expect(parent(agree).deviationSeconds).toBe(3600);
        });

        await it('stops rather than comparing against the one candidate it can date', async () => {
            const halfHeld = checkTime(
                input({
                    parent: {
                        candidates: [
                            { held: true, date: 'Sun, 10 Mar 2024 11:00:00 +0000' },
                            { held: false },
                        ],
                    },
                }),
            );
            // The id nobody holds could be the later one, which is the case that would be a finding.
            expect(parent(halfHeld).unavailable).toBe('ambiguous-parent');
            const halfDated = checkTime(
                input({
                    parent: {
                        candidates: [{ held: true, date: 'Sun, 10 Mar 2024 11:00:00 +0000' }, { held: true }],
                    },
                }),
            );
            expect(parent(halfDated).unavailable).toBe('ambiguous-parent');
            const halfReadable = checkTime(
                input({
                    parent: {
                        candidates: [
                            { held: true, date: 'Sun, 10 Mar 2024 11:00:00 +0000' },
                            { held: true, date: 'whenever' },
                        ],
                    },
                }),
            );
            expect(parent(halfReadable).unavailable).toBe('ambiguous-parent');
        });
    });

    await describe('the seam that finds the other message', async () => {
        /** A reply, built from headers: the ids it names and the Date it carries. */
        function reply(headers: { replyTo?: string; references?: string; date?: string }): Uint8Array {
            const lines = ['From: Ada Lovelace <ada@example.com>', 'To: Grace Hopper <grace@example.net>'];
            lines.push('Message-ID: <reply@example.com>');
            if (headers.replyTo !== undefined) lines.push(`In-Reply-To: ${headers.replyTo}`);
            if (headers.references !== undefined) lines.push(`References: ${headers.references}`);
            lines.push(`Date: ${headers.date ?? 'Sun, 10 Mar 2024 12:00:00 +0000'}`);
            lines.push('Subject: Re: Hello', '', 'Body', '');
            return encodeLatin1(lines.join('\r\n'));
        }

        /** One line of a conversation, named by id and dated, as `threadOf` hands it over. */
        function entry(overrides: Partial<ThreadEntry> & { messageId: string }): ThreadEntry {
            return {
                hash: `h-${overrides.messageId}`,
                depth: 0,
                missing: false,
                focus: false,
                subject: 'Hello',
                sender: 'grace@example.net',
                date: 'Sun, 10 Mar 2024 11:00:00 +0000',
                verdict: 'unsigned',
                ...overrides,
            };
        }

        const thread = (entries: readonly ThreadEntry[]): Thread => ({ entries, truncated: false });
        const unsigned = { verdict: 'unsigned', caveats: [], signatures: [] } as const;
        const seam = (raw: Uint8Array, conversation?: Thread): TimeCheck =>
            check(timeFindingOf(raw, unsigned, conversation), 'date-vs-parent');

        await it('reads In-Reply-To and dates the reply against that message', async () => {
            const c = seam(
                reply({ replyTo: '<first@example.com>' }),
                thread([
                    entry({ messageId: '<first@example.com>' }),
                    entry({ messageId: '<reply@example.com>', focus: true }),
                ]),
            );
            expect(c.result).toBe('consistent');
            expect(c.deviationSeconds).toBe(3600);
        });

        await it('flags a reply the headers place before what it answers', async () => {
            const c = seam(
                reply({ replyTo: '<first@example.com>', date: 'Sun, 10 Mar 2024 08:00:00 +0000' }),
                thread([entry({ messageId: '<first@example.com>' })]),
            );
            expect(c.result).toBe('inconsistent');
            expect(c.protectedBySignature).toBe(false);
        });

        await it('falls back to the last References id when there is no In-Reply-To', async () => {
            const c = seam(
                reply({ references: '<older@example.com> <first@example.com>' }),
                thread([
                    entry({ messageId: '<older@example.com>', date: 'Sun, 10 Mar 2024 15:00:00 +0000' }),
                    entry({ messageId: '<first@example.com>' }),
                ]),
            );
            // The one it answers is the last of the chain; the earlier ancestor is not compared,
            // or this would flag every reply to a long thread whose top is dated oddly.
            expect(c.result).toBe('consistent');
            expect(c.deviationSeconds).toBe(3600);
        });

        await it('is not checkable without a conversation: the CLI on one file', async () => {
            expect(seam(reply({ replyTo: '<first@example.com>' })).unavailable).toBe('no-parent');
        });

        await it('is not checkable when the named message is only a gap in the archive', async () => {
            const missing = seam(
                reply({ replyTo: '<first@example.com>' }),
                thread([entry({ messageId: '<first@example.com>', missing: true, date: '' })]),
            );
            expect(missing.unavailable).toBe('no-parent');
            const absent = seam(reply({ replyTo: '<first@example.com>' }), thread([]));
            expect(absent.unavailable).toBe('no-parent');
            const none = seam(reply({}), thread([entry({ messageId: '<first@example.com>' })]));
            expect(none.unavailable).toBe('no-parent');
        });

        await it('never answers a message against itself', async () => {
            // A self-referencing In-Reply-To would otherwise compare the Date with itself and
            // come out `consistent` by arithmetic — a check reported as made when none was.
            const c = seam(
                reply({ replyTo: '<reply@example.com>' }),
                thread([
                    entry({
                        messageId: '<reply@example.com>',
                        focus: true,
                        date: 'Sun, 10 Mar 2024 12:00:00 +0000',
                    }),
                ]),
            );
            expect(c.unavailable).toBe('no-parent');
        });

        await it('stops when two messages in the archive carry the named id', async () => {
            const c = seam(
                reply({ replyTo: '<first@example.com>' }),
                thread([
                    entry({ messageId: '<first@example.com>', hash: 'h-a' }),
                    entry({
                        messageId: '<first@example.com>',
                        hash: 'h-b',
                        date: 'Sun, 10 Mar 2024 15:00:00 +0000',
                    }),
                ]),
            );
            expect(c.unavailable).toBe('ambiguous-parent');
        });

        await it('stops when the reply names two different messages', async () => {
            const c = seam(
                reply({ replyTo: '<first@example.com> <other@example.org>' }),
                thread([
                    entry({ messageId: '<first@example.com>' }),
                    entry({ messageId: '<other@example.org>', date: 'Sun, 10 Mar 2024 15:00:00 +0000' }),
                ]),
            );
            expect(c.unavailable).toBe('ambiguous-parent');
        });

        await it('does not throw on a conversation that loops back on itself', async () => {
            // `buildThread` drops a link that would close a loop, so a cycle reaches here as two
            // entries naming each other. The seam reads ids, never walks, so there is nothing to
            // loop in — the assertion is that it answers at all.
            const c = seam(
                reply({ replyTo: '<first@example.com>' }),
                thread([
                    entry({ messageId: '<first@example.com>', depth: 0 }),
                    entry({ messageId: '<reply@example.com>', depth: 1, focus: true }),
                ]),
            );
            expect(TIME_RESULTS.includes(c.result)).toBe(true);
        });

        await it('is not checkable when the message it answers carries no Date', async () => {
            const c = seam(
                reply({ replyTo: '<first@example.com>' }),
                thread([entry({ messageId: '<first@example.com>', date: '' })]),
            );
            expect(c.unavailable).toBe('no-parent-date');
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
