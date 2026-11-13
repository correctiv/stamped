/**
 * The evidence chain as text, and the `--json` shape.
 *
 * Why a report gets its own suite: the verdict word is the smaller half of the product. A
 * journalist defends a claim with the facts under it, so the lines that carry those facts are
 * part of the contract — above all the body-hash line, which must print BOTH hashes on a
 * mismatch. A report saying only "differs" asks the reader to take Stamped's word for it, which
 * is the one thing this tool exists not to do.
 *
 * Assertions are on substrings and structure rather than whole lines: the wording is translated
 * and will be edited, the facts may not quietly disappear.
 */

import { classifyMessage, classifySignature, type SignatureEvidence } from '@stamped/core';
import { encodeLatin1 } from '@stamped/import';
import { describe, expect, it } from '@gjsify/unit';

import { reportJson, reportLines, signatureLines, timeLines } from '../../src/lib/report.ts';
import { timeFindingOf } from '../../src/lib/time.ts';

/** A signature that verified cleanly, as the baseline every case below varies. */
function good(overrides: Partial<SignatureEvidence> = {}): SignatureEvidence {
    return {
        domain: 'example.com',
        selector: 'sel',
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: ['from', 'to', 'subject', 'date'],
        bodyHashOk: true,
        signatureOk: true,
        authorDomain: 'example.com',
        aligned: true,
        keyBits: 2048,
        keySource: 'operator',
        bodyHash: 'AAAAhashOfTheBodyAsItStands=',
        ...overrides,
    };
}

/** The block for one signature, as one string — the shape every assertion here reads. */
function block(evidence: SignatureEvidence): string {
    return signatureLines(classifySignature(evidence), 1, 1).join('\n');
}

export default async () => {
    await describe('the evidence chain', async () => {
        await it('names every fact the verdict was reached from', async () => {
            const text = block(good());
            // Each of these is a step somebody has to be able to redo by hand.
            expect(text.includes('example.com')).toBe(true);
            expect(text.includes('sel')).toBe(true);
            expect(text.includes('rsa-sha256')).toBe(true);
            expect(text.includes('relaxed/relaxed')).toBe(true);
            expect(text.includes('2048')).toBe(true);
            expect(text.includes('from:to:subject:date')).toBe(true);
        });

        await it('says where the key came from', async () => {
            expect(block(good({ keySource: 'operator' })).includes('supplied by you')).toBe(true);
            expect(block(good({ keySource: 'archive' })).includes('from the archive itself')).toBe(true);
            expect(block(good({ keySource: 'dns' })).includes('from the DNS')).toBe(true);
        });

        await it('reports a key size of none rather than inventing one', async () => {
            // Ed25519 has no modulus: a missing size is normal, and a printed "0 bit" would be a lie.
            const text = block(good({ algorithm: 'ed25519-sha256', keyBits: undefined }));
            expect(text.includes('0 bit')).toBe(false);
            expect(text.includes('supplied by you')).toBe(true);
        });

        await it('says no key was fetched when none was', async () => {
            const text = block(
                good({
                    bodyHashOk: false,
                    signatureOk: false,
                    keyBits: undefined,
                    keySource: undefined,
                    bodyHash: undefined,
                    unverifiableBecause: 'no-key',
                }),
            );
            expect(text.includes('none fetched')).toBe(true);
            expect(text.includes('No public key for this selector and domain.')).toBe(true);
        });
    });

    await describe('the body-hash line', async () => {
        await it('prints BOTH hashes when they differ', async () => {
            // THE line of the whole report. The two strings side by side are the evidence that
            // the body changed; either one alone is a number the reader cannot check.
            const text = block(
                good({
                    bodyHashOk: false,
                    signatureOk: false,
                    bodyHash: 'bbbbMessageHashesToThis=',
                    bodyHashExpected: 'aaaaSignerCommittedToThis=',
                }),
            );
            expect(text.includes('bbbbMessageHashesToThis=')).toBe(true);
            expect(text.includes('aaaaSignerCommittedToThis=')).toBe(true);
        });

        await it('does not claim a mismatch it has no second hash for', async () => {
            const text = block(good({ bodyHashOk: false, signatureOk: false, bodyHash: undefined }));
            expect(text.includes('not checked')).toBe(true);
        });

        await it('prints the matching hash on a confirmation too', async () => {
            expect(block(good()).includes('AAAAhashOfTheBodyAsItStands=')).toBe(true);
        });
    });

    await describe('caveats and limits', async () => {
        await it('spells out what an l= limit leaves unsigned', async () => {
            const text = block(good({ lengthLimit: 120, unsignedBodyBytes: 57 }));
            expect(text.includes('120')).toBe(true);
            expect(text.includes('57')).toBe(true);
            expect(text.includes('unsigned')).toBe(true);
        });

        await it('lists one line per caveat', async () => {
            const finding = classifySignature(
                good({ algorithm: 'rsa-sha1', keyBits: 512, keySource: 'archive' }),
            );
            const lines = signatureLines(finding, 1, 1);
            const caveatLines = lines.filter((line) => line.includes('caveat:'));
            expect(caveatLines.length).toBe(finding.caveats.length);
            expect(finding.caveats.length).toBe(3);
        });

        await it('keeps the words the verifier itself used', async () => {
            const text = block(good({ note: 'body hash did not verify' }));
            expect(text.includes('body hash did not verify')).toBe(true);
        });
    });

    await describe('a whole message', async () => {
        await it('leads with the verdict sentence', async () => {
            const lines = reportLines(classifyMessage([good()]));
            expect(lines[0]?.startsWith('Unchanged since signing:')).toBe(true);
        });

        await it('numbers the signatures so two verdicts cannot read as one', async () => {
            // The multi-signature case this numbering exists for: the author domain broke, a
            // mailing list's signature still verifies. Unnumbered, the blocks merge into one claim.
            const finding = classifyMessage([
                good({ domain: 'lists.example.org', bodyHashOk: false, signatureOk: false }),
                good(),
            ]);
            const text = reportLines(finding).join('\n');
            expect(text.includes('Signature 1 of 2')).toBe(true);
            expect(text.includes('Signature 2 of 2')).toBe(true);
        });

        await it('says nothing about signatures for an unsigned message', async () => {
            const lines = reportLines(classifyMessage([]));
            expect(lines.length).toBe(1);
            expect(lines[0]?.startsWith('Unsigned:')).toBe(true);
        });
    });

    await describe('--json', async () => {
        await it('carries the verdict, the caveats and the full evidence', async () => {
            const finding = classifyMessage([good({ algorithm: 'rsa-sha1' })]);
            const parsed = JSON.parse(reportJson(finding, 'message.eml')) as {
                source: string;
                verdict: string;
                caveats: string[];
                signatures: { verdict: string; caveats: string[]; evidence: SignatureEvidence }[];
            };
            expect(parsed.source).toBe('message.eml');
            expect(parsed.verdict).toBe('confirmed-with-caveats');
            expect(parsed.caveats).toStrictEqual(['rsa-sha1']);
            expect(parsed.signatures.length).toBe(1);
            expect(parsed.signatures[0]?.evidence.domain).toBe('example.com');
            expect(parsed.signatures[0]?.evidence.signedHeaders).toStrictEqual([
                'from',
                'to',
                'subject',
                'date',
            ]);
        });

        await it('stays valid JSON for an unsigned message', async () => {
            const parsed = JSON.parse(reportJson(classifyMessage([]), '-')) as {
                verdict: string;
                signatures: unknown[];
            };
            expect(parsed.verdict).toBe('unsigned');
            expect(parsed.signatures.length).toBe(0);
        });
    });

    await describe('the time layer', async () => {
        const SIGNED = Date.UTC(2024, 2, 5, 9, 40, 0) / 1000;

        /** A synthetic message: the Date, then Received headers topmost (last hop) first. */
        function mail(date: string | undefined, received: string[]): Uint8Array {
            const lines = ['From: Ada Lovelace <ada@example.com>', 'To: Grace Hopper <grace@example.net>'];
            for (const value of received) lines.push(`Received: ${value}`);
            if (date !== undefined) lines.push(`Date: ${date}`);
            lines.push('Subject: Hello', '', 'Body', '');
            return encodeLatin1(lines.join('\r\n'));
        }

        const HOP = (time: string) => `from a.example.net by b.example.org; ${time}`;

        await it('reads the Date, the Received headers in file order and the signing time', async () => {
            const finding = classifyMessage([good({ signedAt: SIGNED })]);
            const time = timeFindingOf(
                mail('Tue, 05 Mar 2024 09:39:00 +0000', [
                    HOP('Tue, 05 Mar 2024 09:40:30 +0000'),
                    HOP('Tue, 05 Mar 2024 09:39:30 +0000'),
                ]),
                finding,
            );
            expect(time.result).toBe('consistent');
            const kinds = time.checks.filter((check) => check.result === 'consistent').map((c) => c.kind);
            expect(kinds.includes('date-vs-signature')).toBe(true);
            expect(kinds.includes('received-order')).toBe(true);
            expect(kinds.includes('date-vs-received')).toBe(true);
        });

        await it('calls a Date far after the signing time inconsistent', async () => {
            const finding = classifyMessage([good({ signedAt: SIGNED })]);
            const time = timeFindingOf(mail('Tue, 05 Mar 2024 14:00:00 +0000', []), finding);
            expect(time.result).toBe('inconsistent');
            expect(time.checks.find((check) => check.kind === 'date-vs-signature')?.result).toBe(
                'inconsistent',
            );
        });

        await it('is not checkable without usable values, and says why', async () => {
            const time = timeFindingOf(mail(undefined, []), classifyMessage([]));
            expect(time.result).toBe('not-checkable');
            const text = timeLines(time).join('\n');
            expect(text.includes('Time: not checkable')).toBe(true);
            expect(text.includes('The message has no Date header.')).toBe(true);
        });

        await it('prints the layer after the signatures, and says the verdict is unaffected', async () => {
            const finding = classifyMessage([good({ signedAt: SIGNED })]);
            const time = timeFindingOf(mail('Tue, 05 Mar 2024 14:00:00 +0000', []), finding);
            const lines = reportLines(finding, time);
            expect(lines[0]?.startsWith('Unchanged since signing:')).toBe(true);
            const text = lines.join('\n');
            expect(text.indexOf('Signature 1 of 1') < text.indexOf('Time: inconsistent')).toBe(true);
            expect(text.includes('The signature verdict is unaffected.')).toBe(true);
            expect(reportLines(finding).join('\n').includes('Time:')).toBe(false);
        });

        await it('carries the time layer in --json only when given', async () => {
            const finding = classifyMessage([good({ signedAt: SIGNED })]);
            const time = timeFindingOf(mail('Tue, 05 Mar 2024 09:39:00 +0000', []), finding);
            const parsed = JSON.parse(reportJson(finding, 'm.eml', undefined, time)) as {
                time: { result: string; checks: { kind: string; explanation: string }[] };
            };
            expect(parsed.time.result).toBe('consistent');
            expect(parsed.time.checks.length).toBe(4);
            expect('time' in JSON.parse(reportJson(finding, 'm.eml'))).toBe(false);
        });
    });
};
