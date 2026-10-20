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
 *     body are not the bytes that were signed.
 *  3. The signature last. The body hash matched, so the body is intact and what changed is one
 *     of the header fields in `h=`.
 */
export function classifySignature(evidence: SignatureEvidence): SignatureFinding {
    if (evidence.unverifiableBecause) {
        return { verdict: 'unverifiable', caveats: [], evidence };
    }
    if (!evidence.bodyHashOk) {
        return { verdict: 'body-altered', caveats: [], evidence };
    }
    if (!evidence.signatureOk) {
        return { verdict: 'headers-altered', caveats: [], evidence };
    }
    const caveats = caveatsFor(evidence);
    return {
        verdict: caveats.length > 0 ? 'confirmed-with-caveats' : 'confirmed',
        caveats,
        evidence,
    };
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
 * list's holds is a finding, not an inconvenience. The message verdict is the STRONGEST of them
 * (see {@link VERDICTS}): one signature that verifies is a confirmation, whatever else is
 * attached. The per-signature findings stay in `signatures` so the weaker ones are reportable.
 *
 * No signature at all is `unsigned`, which is not a negative result. Most mail before ~2015 and
 * plenty since carries no DKIM; an archive full of unsigned mail is an ordinary archive.
 */
export function classifyMessage(signatures: readonly SignatureEvidence[]): MessageFinding {
    if (signatures.length === 0) {
        return { verdict: 'unsigned', caveats: [], signatures: [] };
    }
    const findings = signatures.map(classifySignature);
    const strongest = findings.reduce((best, finding) =>
        verdictRank(finding.verdict) < verdictRank(best.verdict) ? finding : best,
    );
    return {
        verdict: strongest.verdict,
        caveats: strongest.caveats,
        signatures: findings,
    };
}

/** Whether a verdict is one a reader may rely on. Both confirmations count; nothing else does. */
export function isConfirmed(verdict: Verdict): boolean {
    return verdict === 'confirmed' || verdict === 'confirmed-with-caveats';
}
