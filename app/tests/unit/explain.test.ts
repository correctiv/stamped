/**
 * Why a message got its verdict, in a sentence.
 *
 * Over the generated fixtures, so the retry runs on real bytes. The rule under test: "likely
 * changed by the export, not by a person" is said ONLY when the retry reproduced the signed
 * hash, and no explanation ever changes the verdict.
 */

import { classifyMessage, explainMessage, type ReasonCode } from '@stamped/core';
import { verifyMessage } from '@stamped/verify';
import { describe, expect, it } from '@gjsify/unit';

import { fixture, fixtureKeys } from './fixtures.ts';

const EXPORT_SENTENCE = 'not by a person';

async function explain(file: string, since?: string) {
    const keys = since ? fixtureKeys('operator', since) : fixtureKeys();
    const finding = classifyMessage(await verifyMessage(fixture(file), { keys }));
    return { finding, explanation: explainMessage(finding) };
}

const EXPECTED: ReadonlyArray<{ file: string; verdict: string; code: ReasonCode }> = [
    { file: 'export-dot-stuffed.eml', verdict: 'body-altered', code: 'body-export-dot-stuffing' },
    { file: 'export-both.eml', verdict: 'body-altered', code: 'body-export-both' },
    { file: 'body-altered.eml', verdict: 'body-altered', code: 'body-changed' },
    { file: 'body-altered-length-limited.eml', verdict: 'body-altered', code: 'body-signed-part-changed' },
    { file: 'headers-altered.eml', verdict: 'headers-altered', code: 'headers-changed' },
    { file: 'unverifiable-no-key.eml', verdict: 'unverifiable', code: 'unverifiable-no-key' },
    { file: 'unverifiable-key-mismatch.eml', verdict: 'unverifiable', code: 'unverifiable-key-mismatch' },
];

export default async () => {
    await describe('reason codes', async () => {
        for (const expected of EXPECTED) {
            await it(`${expected.file} is ${expected.code}, verdict ${expected.verdict}`, async () => {
                const { finding, explanation } = await explain(expected.file);
                expect(finding.verdict).toBe(expected.verdict);
                expect(explanation?.code).toBe(expected.code);
                expect((explanation?.sentence.length ?? 0) > 0).toBe(true);
            });
        }

        await it('says nothing about a confirmed message', async () => {
            expect((await explain('confirmed.eml')).explanation).toBe(undefined);
        });

        await it('blames a possibly rotated key when the key is newer than the message', async () => {
            const { finding, explanation } = await explain('headers-altered.eml', '2025-01-01T00:00:00Z');
            expect(finding.verdict).toBe('headers-altered');
            expect(explanation?.code).toBe('headers-key-maybe-rotated');
        });
    });

    await describe('the export retry', async () => {
        for (const file of ['export-dot-stuffed.eml', 'export-both.eml']) {
            await it(`${file}: explained, verdict untouched`, async () => {
                const { finding, explanation } = await explain(file);
                const evidence = finding.signatures[0].evidence;
                expect(evidence.bodyHashOk).toBe(false);
                expect(finding.verdict).toBe('body-altered');
                expect(explanation?.sentence.includes(EXPORT_SENTENCE)).toBe(true);
            });
        }

        await it('does NOT explain an altered body', async () => {
            const { finding, explanation } = await explain('body-altered.eml');
            const evidence = finding.signatures[0].evidence;
            expect(evidence.exportRetried).toBe(true);
            expect(evidence.exportArtefact).toBe(undefined);
            expect(explanation?.sentence.includes(EXPORT_SENTENCE)).toBe(false);
        });

        await it('does NOT explain a changed word inside an l= limit', async () => {
            const { explanation } = await explain('body-altered-length-limited.eml');
            expect(explanation?.sentence.includes(EXPORT_SENTENCE)).toBe(false);
        });

        await it('does not run on a confirmed message', async () => {
            const { finding } = await explain('confirmed.eml');
            expect(finding.signatures[0].evidence.exportRetried).toBe(undefined);
        });
    });
};
