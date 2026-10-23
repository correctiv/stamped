/**
 * mailauth's per-signature result, translated into the facts `@stamped/core` classifies.
 *
 * The translation is the interesting part of this package, because mailauth answers a DIFFERENT
 * question from Stamped's. A mail server asks "do I accept this?" and one keyword is enough;
 * Stamped asks "what happened to this message?", and the keyword throws away what distinguishes
 * a forgery from a missing key.
 *
 * Two readings, both measured (`docs/spikes.md`), neither guessable from the keyword:
 *
 * - In lenient mode a BODY HASH MISMATCH is `status.result === 'neutral'`, not `'fail'` — only
 *   `strict: true` makes it `'fail'`, and strict mode is unusable here for other reasons. The
 *   fact lives in `status.comment === 'body hash did not verify'`.
 * - A HEADER SIGNATURE failure is `'fail'` with `comment === 'bad signature'`.
 *
 * So the one thing that separates "somebody edited the body" from "somebody edited a header" is
 * the comment string, and a classifier reading `status.result` alone would merge them. Hence this
 * module: the comments are read in ONE place, pinned by fixtures, and nothing downstream knows
 * the word "neutral".
 */

import type { KeySource, SignatureEvidence, UnverifiableReason } from '@stamped/core';
import type { DKIMResult } from 'mailauth/lib/types';

/** One signature result exactly as mailauth 8.0.1 returns it. */
export type RawSignatureResult = DKIMResult;

/** What the verifier knows that mailauth does not: where the key came from. */
export interface EvidenceContext {
    readonly source?: KeySource;
    /** The From domain, which mailauth reports once per message rather than per signature. */
    readonly authorDomain?: string;
    /** When the key was first seen or obtained (ISO). */
    readonly keySince?: string;
    /** The message's `Date:` header as ISO, if present and parseable. */
    readonly messageDate?: string;
    /** This key verified other messages of the same pair; see `VerifyOptions.confirmedPairs`. */
    readonly keyConfirmsOthers?: boolean;
}

/** mailauth's key-error comments, from its `KEY_ERROR_COMMENTS` table, to Stamped's reasons. */
const REASON_BY_COMMENT: ReadonlyMap<string, UnverifiableReason> = new Map<string, UnverifiableReason>([
    ['no key', 'no-key'],
    ['unknown key version', 'bad-key'],
    ['unknown key type', 'bad-key'],
    ['invalid public key', 'bad-key'],
    ['inappropriate hash algorithm', 'key-rejects-signature'],
    ['key not for email', 'key-rejects-signature'],
    ['inappropriate key algorithm', 'key-rejects-signature'],
    ['domain mismatch', 'key-rejects-signature'],
    ['signature syntax error', 'malformed-signature'],
]);

/** Normalise one mailauth result into the evidence the classifier reads. */
export function evidenceFrom(raw: RawSignatureResult, context: EvidenceContext = {}): SignatureEvidence {
    const status = raw.status;
    // `comment` is typed `string | undefined` but mailauth initialises it to `false` and only
    // ever overwrites it with a string, so a bare truthiness test would read `false` as a
    // missing comment on a PASS — correct by accident. Checked by type.
    const comment = typeof status.comment === 'string' ? status.comment : undefined;
    // mailauth sets these two comments only AFTER the body hash matched and `crypto.verify`
    // returned true, and only because `x=` lies before now (`expired`) or before `t=`
    // (`invalid expiration`; `expired` wins when both hold). The signature is genuine: `x=` is a
    // replay limit for live delivery, no statement about an archived message. A `t=` in the
    // future never comes through here — mailauth reports that in `signatureTimeValid` only.
    const lifetimeOnly = comment === 'expired' || comment === 'invalid expiration';
    const passed = status.result === 'pass' || (status.result === 'neutral' && lifetimeOnly);
    const bodyHashMismatch = comment === 'body hash did not verify';
    const badSignature = comment === 'bad signature';

    const evidence: Mutable<SignatureEvidence> = {
        domain: raw.signingDomain ?? '',
        selector: raw.selector ?? '',
        algorithm: raw.algo ?? '',
        canonicalization: raw.format ?? '',
        signedHeaders: signedHeadersOf(raw),
        // mailauth's `status.aligned` is the signing domain when it shares the author's
        // ORGANIZATIONAL domain (relaxed alignment, as DMARC defaults to), else false. Relaxed and
        // not strict: `mail.example.com` signing for `example.com` is the same operator, and
        // calling that a foreign signer would cry wolf on every mail system that signs from a
        // subdomain. A different organization is exactly what must not align.
        aligned: typeof status.aligned === 'string' && status.aligned.length > 0,
        // A PASS and a `bad signature` both mean the body hash matched — mailauth checks it
        // first and never reaches the key otherwise. Everything else means nothing was hashed
        // or the hashes differed, and neither is an intact body.
        bodyHashOk: passed || badSignature || (!bodyHashMismatch && hashesAgree(raw)),
        signatureOk: passed,
    };

    const signedAt = secondsOf(raw.signTime);
    const expiresAt = secondsOf(raw.expiresAfter);
    if (signedAt !== undefined) evidence.signedAt = signedAt;
    if (expiresAt !== undefined) evidence.expiresAt = expiresAt;
    if (comment === 'expired') evidence.expired = true;
    if (typeof raw.modulusLength === 'number') evidence.keyBits = raw.modulusLength;
    if (context.authorDomain) evidence.authorDomain = context.authorDomain;
    if (context.source) evidence.keySource = context.source;
    if (context.keySince) evidence.keySince = context.keySince;
    if (context.messageDate) evidence.messageDate = context.messageDate;
    if (context.keyConfirmsOthers) evidence.keyConfirmsOthers = true;
    if (raw.rr) {
        evidence.keyRecord = raw.rr;
        evidence.keyAlgorithm = keyAlgorithmOf(raw.rr);
    }
    if (typeof raw.signature === 'string') {
        const bits = signatureBitsOf(raw.signature);
        if (bits > 0) evidence.signatureBits = bits;
    }
    if (raw.bodyHash) evidence.bodyHash = raw.bodyHash;
    if (raw.bodyHashExpecting) evidence.bodyHashExpected = raw.bodyHashExpecting;
    if (raw.canonBodyLengthLimited && typeof raw.canonBodyLengthLimit === 'number') {
        evidence.lengthLimit = raw.canonBodyLengthLimit;
    }
    if (typeof status.underSized === 'number') evidence.unsignedBodyBytes = status.underSized;
    if (comment) evidence.note = comment;

    // Set LAST and only for the residual case: a signature that neither verified nor produced a
    // tampering finding. `classifySignature` reads this field first, so setting it on a
    // body-hash mismatch would report "unverifiable" for a message we can prove was edited.
    if (!passed && !bodyHashMismatch && !badSignature) {
        evidence.unverifiableBecause = reasonFor(raw, comment);
    }

    return evidence;
}

/** mailauth's ISO instant (`signTime`, `expiresAfter`) as whole seconds since the epoch. */
function secondsOf(iso: string | null | undefined): number | undefined {
    if (typeof iso !== 'string') return undefined;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** `k=` of a key record; RFC 6376 defaults it to rsa. */
export function keyAlgorithmOf(record: string): 'rsa' | 'ed25519' | undefined {
    const kind = /(?:^|;)\s*k\s*=\s*([A-Za-z0-9]+)/.exec(record)?.[1]?.toLowerCase() ?? 'rsa';
    return kind === 'rsa' || kind === 'ed25519' ? kind : undefined;
}

/** Decoded length of a base64 `b=` in bits. */
function signatureBitsOf(b: string): number {
    const chars = b.replace(/[\s=]+/g, '').length;
    return Math.floor((chars * 6) / 8) * 8;
}

/** Make the readonly evidence writable while it is being assembled, and nowhere else. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Do the computed and the claimed body hash agree? False when either is missing. */
function hashesAgree(raw: RawSignatureResult): boolean {
    return (
        typeof raw.bodyHash === 'string' &&
        typeof raw.bodyHashExpecting === 'string' &&
        raw.bodyHash === raw.bodyHashExpecting
    );
}

/**
 * The `h=` list, lowercased, in signing order.
 *
 * `signingHeaders.keys` IS the `h=` tag value, which is what the caveat rules ask about — a
 * header field is unsigned when it is not named there, whether or not the message carries it.
 * The sibling `headers` array holds the canonicalized LINES, so it would answer the different
 * question "which headers were present".
 */
function signedHeadersOf(raw: RawSignatureResult): string[] {
    const keys = raw.signingHeaders?.keys;
    if (!keys) return [];
    return keys
        .split(':')
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key.length > 0);
}

/** Why nothing could be checked, from mailauth's result keyword and comment. */
function reasonFor(raw: RawSignatureResult, comment: string | undefined): UnverifiableReason {
    if (raw.status.result === 'temperror') return 'lookup-failed';
    if (raw.status.result === 'policy') {
        // Reachable only if a caller overrides the lenient options this package passes:
        // `weak-key` is `minBitLength` rejecting the key before the signature is checked, and
        // `weak-algorithm` is `rejectRsaSha1` doing the same for rsa-sha1. Stamped asks for
        // neither, because both discard the crypto verdict it wants to report with a caveat.
        return raw.status.policy?.['dkim-rules'] === 'weak-key' ? 'bad-key' : 'unsupported';
    }
    const mapped = comment ? REASON_BY_COMMENT.get(comment) : undefined;
    if (mapped) return mapped;
    // mailauth puts the parser's own words in `comment` for a `DKIM-Signature` it cannot read,
    // and those strings are free text. What distinguishes that case from an unsupported
    // algorithm is whether a body hash was computed at all: no hasher means the signature never
    // parsed far enough to say which body it covers.
    return raw.bodyHash === undefined ? 'malformed-signature' : 'unsupported';
}
