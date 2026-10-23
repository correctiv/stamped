/**
 * The rules that turn evidence into one of the six verdicts.
 *
 * Pure and total: same evidence in, same verdict out, on any runtime, with no clock, no network
 * and no filesystem anywhere near it. That is the point — the claim Stamped makes about a leaked
 * message has to be reproducible by somebody else, including by a court, and a rule that reads
 * the world is not reproducible.
 *
 * The verifier decides FACTS (did the body hash match, did the signature verify, how long is the
 * key); this module decides what may be SAID about them. Keeping the two apart is what lets the
 * verifier be swapped — mailauth today, an own one on `@gjsify/crypto` if it ever has to be —
 * without a single verdict changing.
 */

import {
    CAVEAT_BY_UNSIGNED_HEADER,
    type Caveat,
    type MessageFinding,
    type SignatureEvidence,
    type SignatureFinding,
    type Verdict,
    verdictRank,
} from './verdict.ts';

/**
 * Below this many bits an RSA key earns the `weak-key` caveat.
 *
 * RFC 8301 § 3.2 sets 1024 as the floor for signers. Stamped does not REFUSE a shorter key the
 * way a mail server would: refusing would turn a verifiable 512-bit signature into
 * `unverifiable`, and in an archive from 2009 that signature is often the only evidence there
 * is. It verifies it and says what it is worth.
 */
export const WEAK_RSA_BITS = 1024;

/**
 * Classify one signature.
 *
 * The order of the branches is the whole algorithm, and it is not interchangeable:
 *
 *  1. `unverifiableBecause` first — set only when nothing was checked at all (no key, a
 *     signature that does not parse). Without it, a missing key would fall through to
 *     "body hash did not match", which would accuse somebody of tampering on no evidence.
 *  2. The body hash next. It is computed from the message alone, so it is known even when no key
 *     was ever fetched, and it answers a different question from the signature: the BYTES of the
 *     body are not the bytes that were signed. But `bh=` is only as good as the signature that
 *     covers it: a key that cannot have made the signature turns this into `unverifiable`, and
 *     no key at all leaves `body-altered` with the `body-hash-unauthenticated` caveat.
 *  3. The signature last. The body hash matched, so the body is intact and what changed is one
 *     of the header fields in `h=`.
 */
export function classifySignature(evidence: SignatureEvidence): SignatureFinding {
    if (evidence.unverifiableBecause) {
        return { verdict: 'unverifiable', caveats: [], evidence };
    }
    if (!evidence.bodyHashOk) {
        // The same wrong-key test as below: a `bh=` that no key of the signer vouches for must
        // not be reported as "the body was altered" — the key may simply be another one.
        if (keyCannotHaveSigned(evidence)) return keyMismatch(evidence);
        // Without any key the claimed `bh=` is unauthenticated: it differs from the body, but
        // whoever changed the body could have rewritten the hash as well.
        const noKey = evidence.keyRecord === undefined && evidence.keySource === undefined;
        return { verdict: 'body-altered', caveats: noKey ? ['body-hash-unauthenticated'] : [], evidence };
    }
    if (!evidence.signatureOk) {
        // A key that cannot have produced the signature says nothing about the headers.
        if (keyCannotHaveSigned(evidence)) return keyMismatch(evidence);
        return {
            verdict: 'headers-altered',
            caveats: keyPostdatesMessage(evidence) ? ['key-newer-than-message'] : [],
            evidence,
        };
    }
    const caveats = caveatsFor(evidence);
    return {
        verdict: caveats.length > 0 ? 'confirmed-with-caveats' : 'confirmed',
        caveats,
        evidence,
    };
}

function keyMismatch(evidence: SignatureEvidence): SignatureFinding {
    return {
        verdict: 'unverifiable',
        caveats: [],
        evidence: { ...evidence, unverifiableBecause: 'key-mismatch' },
    };
}

/**
 * Is it certain that the key did not make this signature?
 *
 * Deterministic: `keySigned === false` is the verifier's proof (the signature, raised to the
 * public exponent, is no well-formed block), and beyond it sizes and types alone — an RSA
 * signature is exactly as long as the modulus, and an ed25519 key cannot sign an `rsa-`
 * signature. Missing facts never answer yes.
 */
export function keyCannotHaveSigned(evidence: SignatureEvidence): boolean {
    if (evidence.keySigned === false) return true;
    const type = evidence.algorithm.split('-')[0]?.toLowerCase();
    if (evidence.keyAlgorithm !== undefined && (type === 'rsa' || type === 'ed25519')) {
        if (type !== evidence.keyAlgorithm) return true;
    }
    return (
        type === 'rsa' &&
        evidence.keyBits !== undefined &&
        evidence.signatureBits !== undefined &&
        evidence.signatureBits !== Math.ceil(evidence.keyBits / 8) * 8
    );
}

/** Was the key first seen after the message was sent, without another mail vouching for it? */
function keyPostdatesMessage(evidence: SignatureEvidence): boolean {
    if (evidence.keyConfirmsOthers) return false;
    if (evidence.keySince === undefined || evidence.messageDate === undefined) return false;
    const since = Date.parse(evidence.keySince);
    const sent = Date.parse(evidence.messageDate);
    return !Number.isNaN(since) && !Number.isNaN(sent) && since > sent;
}

/**
 * Every caveat a verified signature carries, in the order of {@link CAVEATS}.
 *
 * Only ever called for a signature that verified. A caveat on a broken signature would be noise:
 * nobody needs to hear that the key was short as well.
 */
export function caveatsFor(evidence: SignatureEvidence): Caveat[] {
    const caveats: Caveat[] = [];

    // The `a=` tag, not a warning flag: this has to hold for a verifier that reports no
    // warnings at all. `rsa-sha1` is the only hash RFC 8301 forbids outright.
    if (hashAlgorithmOf(evidence.algorithm) === 'sha1') caveats.push('rsa-sha1');

    // Ed25519 has no modulus, so `keyBits` is absent there and the comparison must not run on
    // `undefined` — which would be `false`, i.e. silently no caveat, the right answer by accident.
    if (evidence.keyBits !== undefined && evidence.keyBits < WEAK_RSA_BITS) caveats.push('weak-key');

    if (evidence.lengthLimit !== undefined) caveats.push('length-limited');

    const signed = new Set(evidence.signedHeaders.map((h) => h.toLowerCase()));
    for (const [header, caveat] of CAVEAT_BY_UNSIGNED_HEADER) {
        if (!signed.has(header)) caveats.push(caveat);
    }

    if (evidence.keySource === 'archive') caveats.push('archive-key');

    if (evidence.expired) caveats.push('signature-expired');
    if (
        evidence.expiresAt !== undefined &&
        evidence.signedAt !== undefined &&
        evidence.expiresAt < evidence.signedAt
    ) {
        caveats.push('signature-lifetime-invalid');
    }

    // A valid signature from a domain other than the author's vouches for the signer only.
    if (!evidence.aligned) caveats.push('signer-not-author');

    return caveats;
}

/**
 * The hash half of an `a=` tag (`rsa-sha256` → `sha256`), lowercased.
 *
 * Split rather than matched: `a=` is `<key-type>-<hash>` per RFC 6376 § 3.5, and a substring test
 * for `sha1` would also fire on a hypothetical `sha1024`.
 */
export function hashAlgorithmOf(algorithm: string): string {
    const dash = algorithm.indexOf('-');
    return (dash === -1 ? '' : algorithm.slice(dash + 1)).toLowerCase();
}

/**
 * Classify a whole message from the signatures found on it.
 *
 * A message may carry several signatures, and they are evaluated INDIVIDUALLY — a mailing list
 * adds its own, a forwarder re-signs, and the author domain's signature breaking while the
 * list's holds is a finding, not an inconvenience. The per-signature findings stay in
 * `signatures` so the weaker ones are reportable.
 *
 * The message verdict is the strongest signature that speaks for the AUTHOR: one whose `d=`
 * aligns with the From domain. A signature from anybody else verifies just as well and says
 * nothing about who wrote the message — `From: ceo@example.com` signed by `d=attacker.example`
 * is a flawless signature on a forgery. So the best-ranked ALIGNED signature wins when one
 * verifies; only when none does is the best signature overall used, and that one carries
 * `signer-not-author`. Consequence: a broken author signature next to a verifying list
 * signature is never plain `confirmed`.
 *
 * No signature at all is `unsigned`, which is not a negative result. Most mail before ~2015 and
 * plenty since carries no DKIM; an archive full of unsigned mail is an ordinary archive.
 */
export function classifyMessage(signatures: readonly SignatureEvidence[]): MessageFinding {
    if (signatures.length === 0) {
        return { verdict: 'unsigned', caveats: [], signatures: [] };
    }
    const findings = signatures.map(classifySignature);
    const alignedVerified = findings.filter((f) => f.evidence.aligned && isConfirmed(f.verdict));
    const pool = alignedVerified.length > 0 ? alignedVerified : findings;
    const basis = pool.reduce((best, finding) =>
        verdictRank(finding.verdict) < verdictRank(best.verdict) ? finding : best,
    );
    return {
        verdict: basis.verdict,
        caveats: basis.caveats,
        basis,
        signatures: findings,
    };
}

/** Whether a verdict is one a reader may rely on. Both confirmations count; nothing else does. */
export function isConfirmed(verdict: Verdict): boolean {
    return verdict === 'confirmed' || verdict === 'confirmed-with-caveats';
}
