/**
 * The classification rules, on hand-built evidence.
 *
 * No cryptography here on purpose. `verify.test.ts` proves that real signatures produce the right
 * evidence; this suite proves what is CLAIMED from evidence, including shapes no fixture can
 * produce conveniently (a key one bit under the floor, every caveat at once, a signature that is
 * both unverifiable and has a mismatching hash). Those are the cases where a plausible reordering
 * of the rules would accuse somebody of forgery, so they are pinned here rather than hoped for.
 */

import {
    caveatsFor,
    classifyMessage,
    classifySignature,
    hashAlgorithmOf,
    isConfirmed,
    type SignatureEvidence,
    VERDICTS,
    verdictRank,
    WEAK_RSA_BITS,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';

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
        keyBits: 2048,
        keySource: 'operator',
        ...overrides,
    };
}

export default async () => {
    await describe('one signature', async () => {
        await it('confirms a clean signature with no caveats', async () => {
            const finding = classifySignature(good());
            expect(finding.verdict).toBe('confirmed');
            expect(finding.caveats.length).toBe(0);
        });

        await it('reports a body-hash mismatch as body-altered', async () => {
            expect(classifySignature(good({ bodyHashOk: false, signatureOk: false })).verdict).toBe(
                'body-altered',
            );
        });

        await it('reports an intact body with a broken signature as headers-altered', async () => {
            expect(classifySignature(good({ signatureOk: false })).verdict).toBe('headers-altered');
        });

        await it('puts `unverifiable` ahead of the hash check', async () => {
            // THE ordering that matters. A missing key leaves no computed hash to compare, so the
            // evidence looks exactly like a mismatch — and reading it as one would accuse
            // somebody of tampering on the strength of a key the operator happens not to have.
            const finding = classifySignature(
                good({ bodyHashOk: false, signatureOk: false, unverifiableBecause: 'no-key' }),
            );
            expect(finding.verdict).toBe('unverifiable');
        });

        await it('reports no caveats on a signature that did not verify', async () => {
            // A caveat on a broken signature is noise: nobody needs to hear the key was short as
            // well as that the body was changed.
            const finding = classifySignature(
                good({ algorithm: 'rsa-sha1', keyBits: 512, bodyHashOk: false, signatureOk: false }),
            );
            expect(finding.verdict).toBe('body-altered');
            expect(finding.caveats.length).toBe(0);
        });
    });

    await describe('caveats', async () => {
        await it('catches rsa-sha1 from the a= tag alone', async () => {
            expect(caveatsFor(good({ algorithm: 'rsa-sha1' }))).toStrictEqual(['rsa-sha1']);
        });

        await it('treats the bit floor as exclusive', async () => {
            expect(caveatsFor(good({ keyBits: WEAK_RSA_BITS }))).toStrictEqual([]);
            expect(caveatsFor(good({ keyBits: WEAK_RSA_BITS - 1 }))).toStrictEqual(['weak-key']);
        });

        await it('does not caveat a key with no bit count', async () => {
            // Ed25519: absent, not zero. `undefined < 1024` is false, which is the right answer
            // by accident — so the explicit check is pinned here.
            expect(caveatsFor(good({ keyBits: undefined }))).toStrictEqual([]);
        });

        await it('caveats an l= limit even when it covers the whole body', async () => {
            // `l=` is reportable whatever its value: the signature covers a PREFIX, so anything
            // appended later is unsigned and still arrives under a valid signature.
            expect(caveatsFor(good({ lengthLimit: 512 }))).toStrictEqual(['length-limited']);
        });

        await it('names each unsigned header field it knows about', async () => {
            expect(caveatsFor(good({ signedHeaders: ['from', 'date'] }))).toStrictEqual([
                'unsigned-subject',
                'unsigned-to',
            ]);
            expect(caveatsFor(good({ signedHeaders: [] }))).toStrictEqual([
                'unsigned-subject',
                'unsigned-to',
                'unsigned-date',
            ]);
        });

        await it('reads h= case-insensitively', async () => {
            expect(caveatsFor(good({ signedHeaders: ['From', 'TO', 'Subject', 'DATE'] }))).toStrictEqual([]);
        });

        await it('caveats a key that came from the archive', async () => {
            expect(caveatsFor(good({ keySource: 'archive' }))).toStrictEqual(['archive-key']);
        });

        await it('reports every caveat at once, in declaration order', async () => {
            const finding = classifySignature(
                good({
                    algorithm: 'rsa-sha1',
                    keyBits: 512,
                    lengthLimit: 10,
                    signedHeaders: [],
                    keySource: 'archive',
                }),
            );
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual([
                'rsa-sha1',
                'weak-key',
                'length-limited',
                'unsigned-subject',
                'unsigned-to',
                'unsigned-date',
                'archive-key',
            ]);
        });
    });

    await describe('a= parsing', async () => {
        await it('splits the hash off the key type', async () => {
            expect(hashAlgorithmOf('rsa-sha256')).toBe('sha256');
            expect(hashAlgorithmOf('ed25519-sha256')).toBe('sha256');
            expect(hashAlgorithmOf('RSA-SHA1')).toBe('sha1');
        });

        await it('does not confuse a longer hash name for sha1', async () => {
            // A substring test would fire on this, and a hypothetical `sha1024` signature would
            // be reported as using a broken hash.
            expect(hashAlgorithmOf('rsa-sha1024')).toBe('sha1024');
            expect(caveatsFor(good({ algorithm: 'rsa-sha1024' }))).toStrictEqual([]);
        });

        await it('yields nothing for an a= tag with no dash', async () => {
            expect(hashAlgorithmOf('nonsense')).toBe('');
        });
    });

    await describe('a whole message', async () => {
        await it('is unsigned when there are no signatures', async () => {
            const finding = classifyMessage([]);
            expect(finding.verdict).toBe('unsigned');
            expect(finding.signatures.length).toBe(0);
        });

        await it('takes the strongest verdict and that signature`s caveats', async () => {
            const finding = classifyMessage([
                good({ bodyHashOk: false, signatureOk: false }),
                good({ algorithm: 'rsa-sha1' }),
            ]);
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual(['rsa-sha1']);
            // The weaker finding is kept: a broken signature next to a good one is reportable.
            expect(finding.signatures.map((signature) => signature.verdict)).toStrictEqual([
                'body-altered',
                'confirmed-with-caveats',
            ]);
        });

        await it('prefers evidence of tampering over the absence of evidence', async () => {
            // `body-altered` outranks `unverifiable` because a hash mismatch is a POSITIVE
            // finding, while `unverifiable` is the lack of one. Reporting the lack would hide it.
            const finding = classifyMessage([
                good({ unverifiableBecause: 'no-key' }),
                good({ bodyHashOk: false, signatureOk: false }),
            ]);
            expect(finding.verdict).toBe('body-altered');
        });

        await it('ranks the six verdicts in declaration order', async () => {
            expect(VERDICTS.map(verdictRank)).toStrictEqual([0, 1, 2, 3, 4, 5]);
        });
    });

    await describe('what a reader may rely on', async () => {
        await it('counts both confirmations and nothing else', async () => {
            expect(VERDICTS.filter(isConfirmed)).toStrictEqual(['confirmed', 'confirmed-with-caveats']);
        });
    });
};
