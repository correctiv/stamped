/**
 * The end-to-end suite: a signed message in, one of the six verdicts out.
 *
 * This is the only test that proves the whole claim, because it is the only one with real
 * cryptography in it. The classification rules are checked on hand-built evidence elsewhere
 * (`classify.test.ts`); here every byte went through an independent signer — `tools/
 * make-fixtures.mjs` implements RFC 6376 canonicalization a second time, on purpose — and
 * through mailauth's verifier. Both agreeing on eleven messages is the evidence that the
 * canonicalization worry in `packages/verify/src/mailauth.ts` is handled, rather than assumed.
 *
 * The expectations live HERE and not in a generated manifest: a fixture whose expected verdict
 * ships next to it would be the generator grading its own work.
 */

import { type Caveat, classifyMessage, KeyStore, type Verdict } from '@stamped/core';
import { verifyMessage } from '@stamped/verify';
import { describe, expect, it } from '@gjsify/unit';

import { fixture, fixtureKeys } from './fixtures.ts';

/** What each fixture must come back as: the message verdict and the caveats that go with it. */
const EXPECTED: ReadonlyArray<{ file: string; verdict: Verdict; caveats: Caveat[] }> = [
    { file: 'confirmed.eml', verdict: 'confirmed', caveats: [] },
    { file: 'confirmed-ed25519.eml', verdict: 'confirmed', caveats: [] },
    { file: 'caveat-rsa-sha1.eml', verdict: 'confirmed-with-caveats', caveats: ['rsa-sha1'] },
    { file: 'caveat-weak-key.eml', verdict: 'confirmed-with-caveats', caveats: ['weak-key'] },
    {
        file: 'caveat-length-limited.eml',
        verdict: 'confirmed-with-caveats',
        caveats: ['length-limited'],
    },
    {
        file: 'caveat-unsigned-headers.eml',
        verdict: 'confirmed-with-caveats',
        caveats: ['unsigned-subject', 'unsigned-to', 'unsigned-date'],
    },
    { file: 'caveat-expired.eml', verdict: 'confirmed-with-caveats', caveats: ['signature-expired'] },
    // x= before t=: mailauth reports `invalid expiration`, then `expired` as well, since x is past.
    {
        file: 'caveat-lifetime-invalid.eml',
        verdict: 'confirmed-with-caveats',
        caveats: ['signature-expired', 'signature-lifetime-invalid'],
    },
    {
        file: 'caveat-lifetime-invalid-future.eml',
        verdict: 'confirmed-with-caveats',
        caveats: ['signature-lifetime-invalid'],
    },
    { file: 'body-altered-expired.eml', verdict: 'body-altered', caveats: [] },
    { file: 'body-altered.eml', verdict: 'body-altered', caveats: [] },
    { file: 'headers-altered.eml', verdict: 'headers-altered', caveats: [] },
    { file: 'unverifiable-no-key.eml', verdict: 'unverifiable', caveats: [] },
    { file: 'unverifiable-key-mismatch.eml', verdict: 'unverifiable', caveats: [] },
    { file: 'unverifiable-key-swapped.eml', verdict: 'unverifiable', caveats: [] },
    { file: 'body-altered-key-swapped.eml', verdict: 'unverifiable', caveats: [] },
    { file: 'body-altered-no-key.eml', verdict: 'body-altered', caveats: ['body-hash-unauthenticated'] },
    { file: 'export-base64-single.eml', verdict: 'body-altered', caveats: [] },
    { file: 'export-base64-multipart.eml', verdict: 'body-altered', caveats: [] },
    { file: 'unsigned.eml', verdict: 'unsigned', caveats: [] },
    // The message verdict is the STRONGEST of the two signatures; the per-signature findings are
    // asserted in their own test below.
    { file: 'multi-signature.eml', verdict: 'confirmed', caveats: [] },
    { file: 'signer-not-author.eml', verdict: 'confirmed-with-caveats', caveats: ['signer-not-author'] },
    { file: 'aligned-subdomain.eml', verdict: 'confirmed', caveats: [] },
];

/** The message with every CRLF turned into a bare LF, as an mbox from a Unix MTA stores it. */
function withBareLf(raw: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === 13 && raw[i + 1] === 10) continue;
        out.push(raw[i] as number);
    }
    return Uint8Array.from(out);
}

async function classify(file: string, keys = fixtureKeys()) {
    return classifyMessage(await verifyMessage(fixture(file), { keys }));
}

export default async () => {
    await describe('line ends', async () => {
        for (const expected of EXPECTED) {
            await it(`reads ${expected.file} the same with bare LF line ends`, async () => {
                const keys = fixtureKeys();
                const lf = classifyMessage(await verifyMessage(withBareLf(fixture(expected.file)), { keys }));
                const crlf = await classify(expected.file);
                expect(lf.verdict).toBe(crlf.verdict);
                expect([...lf.caveats].sort().join(',')).toBe([...crlf.caveats].sort().join(','));
            });
        }
    });

    await describe('verdicts over signed fixtures', async () => {
        for (const expected of EXPECTED) {
            await it(`reads ${expected.file} as ${expected.verdict}`, async () => {
                const finding = await classify(expected.file);
                expect(`${expected.file}: ${finding.verdict}`).toBe(`${expected.file}: ${expected.verdict}`);
                expect(`${expected.file}: ${[...finding.caveats].sort().join(',')}`).toBe(
                    `${expected.file}: ${[...expected.caveats].sort().join(',')}`,
                );
            });
        }
    });

    await describe('the evidence behind a confirmation', async () => {
        await it('names the domain, selector, algorithm, key size and signed headers', async () => {
            const [signature] = (await classify('confirmed.eml')).signatures;
            const evidence = signature.evidence;
            expect(evidence.domain).toBe('example.com');
            expect(evidence.selector).toBe('t2048');
            expect(evidence.algorithm).toBe('rsa-sha256');
            expect(evidence.canonicalization).toBe('relaxed/relaxed');
            expect(evidence.keyBits).toBe(2048);
            expect(evidence.keySource).toBe('operator');
            expect(evidence.signedHeaders.join(':')).toBe('from:to:subject:date');
            expect(evidence.bodyHashOk).toBe(true);
            expect(evidence.signatureOk).toBe(true);
        });

        await it('reports an Ed25519 key with no bit count rather than a wrong one', async () => {
            // Ed25519 has no modulus, so `keyBits` must be ABSENT and not zero: the `weak-key`
            // caveat compares against it, and a zero would caveat every Ed25519 signature.
            const [signature] = (await classify('confirmed-ed25519.eml')).signatures;
            expect(signature.evidence.algorithm).toBe('ed25519-sha256');
            expect(signature.evidence.keyBits).toBe(undefined);
            expect(signature.caveats.length).toBe(0);
        });

        await it('verifies a 512-bit key instead of refusing it', async () => {
            // mailauth's `minBitLength` defaults to 1024 through a falsy check, so a zero there
            // silently refuses this key and the verdict becomes `unverifiable` — the measurement
            // behind the `minBitLength: 1` in `mailauth.ts`. A caveat is the answer; a refusal
            // would throw away the only evidence a 2009 archive has.
            const [signature] = (await classify('caveat-weak-key.eml')).signatures;
            expect(signature.evidence.keyBits).toBe(512);
            expect(signature.evidence.signatureOk).toBe(true);
            expect(signature.verdict).toBe('confirmed-with-caveats');
        });
    });

    await describe('tampering, told apart', async () => {
        await it('shows both hashes when the body was altered', async () => {
            const [signature] = (await classify('body-altered.eml')).signatures;
            // Both hashes present and DIFFERENT is the evidence itself. One of them alone, or a
            // bare "invalid", is a claim a reader cannot check.
            expect(typeof signature.evidence.bodyHash).toBe('string');
            expect(typeof signature.evidence.bodyHashExpected).toBe('string');
            expect(signature.evidence.bodyHash === signature.evidence.bodyHashExpected).toBe(false);
            expect(signature.evidence.bodyHashOk).toBe(false);
            expect(signature.verdict).toBe('body-altered');
        });

        await it('reports an altered signed header with the body hash still matching', async () => {
            const [signature] = (await classify('headers-altered.eml')).signatures;
            // The distinction the six verdicts exist for: the body is untouched, so what changed
            // is a header field in `h=`. Both would be "invalid" to a mail server.
            expect(signature.evidence.bodyHashOk).toBe(true);
            expect(signature.evidence.signatureOk).toBe(false);
            expect(signature.verdict).toBe('headers-altered');
        });
    });

    await describe('nothing to check against', async () => {
        await it('calls a missing key `no-key`, not tampering', async () => {
            const [signature] = (await classify('unverifiable-no-key.eml')).signatures;
            expect(signature.verdict).toBe('unverifiable');
            expect(signature.evidence.unverifiableBecause).toBe('no-key');
            // The accusation that must NOT be made: no key was fetched, so nothing is known
            // about the body either way.
            expect(signature.evidence.keySource).toBe(undefined);
        });

        await it('stays offline — an empty store yields no-key, never a lookup', async () => {
            // The source-protection default (`@stamped/core`'s `keys.ts`): without a
            // `fallbackResolver` no query may leave the machine, and the only observable proof
            // from here is that a message whose key IS in the public DNS still comes back
            // unverifiable.
            const finding = await classify('confirmed.eml', new KeyStore());
            expect(finding.verdict).toBe('unverifiable');
            expect(finding.signatures[0].evidence.unverifiableBecause).toBe('no-key');
        });

        await it('reports an unsigned message as unsigned, with no signatures', async () => {
            const finding = await classify('unsigned.eml');
            // mailauth returns one synthetic `result: 'none'` entry for an unsigned message, and
            // passing that through would classify the ABSENCE of a signature as a broken one.
            expect(finding.signatures.length).toBe(0);
            expect(finding.verdict).toBe('unsigned');
        });
    });

    await describe('several signatures on one message', async () => {
        await it('evaluates each on its own and reports the strongest as the message verdict', async () => {
            const finding = await classify('multi-signature.eml');
            expect(finding.signatures.length).toBe(2);
            const byDomain = new Map(
                finding.signatures.map((signature) => [signature.evidence.domain, signature.verdict]),
            );
            // The list re-signed a body with its footer; what was delivered has the author's
            // body. So the list signature is broken and the author's holds — and a tool with one
            // verdict per message would have to pick one of those and be wrong either way.
            expect(byDomain.get('lists.example.org')).toBe('body-altered');
            expect(byDomain.get('example.com')).toBe('confirmed');
            expect(finding.verdict).toBe('confirmed');
        });
    });

    await describe('who signed, versus who wrote', async () => {
        await it('names both domains and marks a foreign signer as not aligned', async () => {
            const finding = await classify('signer-not-author.eml');
            const evidence = finding.signatures[0].evidence;
            expect(evidence.domain).toBe('other.example');
            expect(evidence.authorDomain).toBe('example.com');
            expect(evidence.aligned).toBe(false);
            expect(evidence.signatureOk).toBe(true);
        });

        await it('aligns a subdomain signer with its parent (relaxed alignment)', async () => {
            const evidence = (await classify('aligned-subdomain.eml')).signatures[0].evidence;
            expect(evidence.domain).toBe('mail.example.com');
            expect(evidence.authorDomain).toBe('example.com');
            expect(evidence.aligned).toBe(true);
        });

        await it('does not let a verifying list signature confirm a broken author signature', async () => {
            const finding = await classify('multi-signature-author-broken.eml');
            const byDomain = new Map(
                finding.signatures.map((signature) => [signature.evidence.domain, signature.verdict]),
            );
            expect(byDomain.get('example.com')).toBe('body-altered');
            expect(byDomain.get('lists.example.org')).toBe('confirmed-with-caveats');
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual(['signer-not-author']);
        });
    });

    await describe('a wrong key is not tampering', async () => {
        await it('reports a key of another size as key-mismatch', async () => {
            const [signature] = (await classify('unverifiable-key-mismatch.eml')).signatures;
            expect(signature.verdict).toBe('unverifiable');
            expect(signature.evidence.unverifiableBecause).toBe('key-mismatch');
        });

        await it('reports a same-size key that did not sign as key-mismatch', async () => {
            const [signature] = (await classify('unverifiable-key-swapped.eml')).signatures;
            expect(signature.verdict).toBe('unverifiable');
            expect(signature.evidence.keySigned).toBe(false);
            expect(signature.evidence.unverifiableBecause).toBe('key-mismatch');
        });

        await it('does not call a body hash edited when the key is another one', async () => {
            const [signature] = (await classify('body-altered-key-swapped.eml')).signatures;
            expect(signature.verdict).toBe('unverifiable');
            expect(signature.evidence.unverifiableBecause).toBe('key-mismatch');
        });

        await it('keeps headers-altered for an edited header under the right key', async () => {
            const [signature] = (await classify('headers-altered.eml')).signatures;
            expect(signature.verdict).toBe('headers-altered');
            expect(signature.evidence.keySigned).toBe(true);
            expect(signature.evidence.signedHeadersIntact).toBe(false);
        });

        await it('shows the signed header is intact when only the body was edited', async () => {
            const [signature] = (await classify('body-altered.eml')).signatures;
            expect(signature.verdict).toBe('body-altered');
            expect(signature.evidence.keySigned).toBe(true);
            expect(signature.evidence.signedHeadersIntact).toBe(true);
            expect([...signature.caveats]).toStrictEqual([]);
        });

        await it('marks a body hash without any key as unauthenticated', async () => {
            const [signature] = (await classify('body-altered-no-key.eml')).signatures;
            expect(signature.verdict).toBe('body-altered');
            expect([...signature.caveats]).toStrictEqual(['body-hash-unauthenticated']);
            expect(signature.evidence.keySigned).toBe(undefined);
        });

        await it('flags a failing header signature whose key postdates the message', async () => {
            const keys = new KeyStore();
            const source = fixtureKeys();
            for (const name of source.names()) {
                const entry = source.lookup(name);
                if (entry) keys.add(name, entry.record, entry.source, '2025-01-01T00:00:00.000Z');
            }
            const finding = await classify('headers-altered.eml', keys);
            expect(finding.verdict).toBe('headers-altered');
            expect([...finding.caveats]).toStrictEqual(['key-newer-than-message']);
        });
    });

    await describe('where the key came from', async () => {
        await it('caveats a key that came out of the archive itself', async () => {
            // Same message, same key, same crypto — a different CLAIM, because a key shipped
            // beside the mail it verifies proves consistency rather than authenticity.
            const finding = await classify('confirmed.eml', fixtureKeys('archive'));
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual(['archive-key']);
        });
    });
};
