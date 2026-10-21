/**
 * What Stamped is allowed to say about a message, and the facts it says it from.
 *
 * The vocabulary is the product. A journalist asks "is this real?", and the honest answers are
 * not two but six: a cryptographic confirmation, a confirmation that needs a sentence of
 * context, two different kinds of evidence that somebody changed the message, "the signature is
 * there but nothing here can check it", and "nobody signed this". Collapsing any of those into
 * "invalid" would let an unverifiable message read as a forged one, which is the mistake that
 * gets a true story spiked.
 *
 * This module is pure data and pure rules — no mailauth, no DNS, no filesystem. `@stamped/verify`
 * turns one DKIM signature into a {@link SignatureEvidence}, and everything downstream (CLI
 * output, JSON, later the UI) reads only what is declared here.
 */

import { fmt, _ } from './i18n.ts';

/**
 * The six verdicts, from the strongest claim to the weakest.
 *
 * The order is load-bearing: {@link verdictRank} reads it to pick one verdict for a message that
 * carries several signatures, so a message with one good signature and one broken one is
 * `confirmed` rather than whichever signature happened to be parsed last.
 *
 * Why tampering outranks `unverifiable` instead of the other way round: a body-hash mismatch is a
 * POSITIVE finding — the bytes are not the bytes that were signed — while `unverifiable` is the
 * absence of a finding. Reporting the absence would hide the evidence.
 */
export const VERDICTS = [
    /** A signature verified against a key we trust. The message is byte-for-byte what was signed. */
    'confirmed',
    /** Verified, but something about the signature limits what the confirmation covers. */
    'confirmed-with-caveats',
    /** The body hash does not match: the body was changed after signing. */
    'body-altered',
    /** The body hash matches but the header signature does not: a signed header was changed. */
    'headers-altered',
    /** A signature is present and no verdict could be reached — usually no key. */
    'unverifiable',
    /** No DKIM signature at all. Says nothing about the message either way. */
    'unsigned',
] as const;

/** One of the six things Stamped may claim. */
export type Verdict = (typeof VERDICTS)[number];

/**
 * Why a confirmation needs a sentence of context.
 *
 * Each of these is a real confirmation — the crypto checked out — that covers less than a reader
 * would assume from the word "confirmed". They are reported, never silently dropped, and a
 * message carrying any of them is `confirmed-with-caveats` rather than `confirmed`.
 */
export const CAVEATS = [
    /** rsa-sha1 (RFC 8301 § 3.1 forbids it): SHA-1 collisions are practical. */
    'rsa-sha1',
    /** An RSA key under 1024 bits. Factorable with ordinary resources. */
    'weak-key',
    /** `l=`: the signature covers only the first N bytes of the body — the rest is unsigned. */
    'length-limited',
    /** `Subject` is not in `h=`: the subject line could be anything. */
    'unsigned-subject',
    /** `To` is not in `h=`: the recipient could be anything. */
    'unsigned-to',
    /** `Date` is not in `h=`: the date could be anything. */
    'unsigned-date',
    /**
     * The public key came from the archive under examination rather than from DNS or the
     * operator. A key shipped alongside the mail it verifies proves internal consistency, not
     * authenticity: whoever could fabricate the message could fabricate the key with it.
     */
    'archive-key',
    /**
     * The signature verifies, but its `d=` is not the From domain. It proves that `d=` handled
     * the message, not that the author's domain sent it: anyone can sign a forged `From:` with a
     * domain they own, and the cryptography will be flawless.
     */
    'signer-not-author',
] as const;

/** One reason a confirmation covers less than it appears to. */
export type Caveat = (typeof CAVEATS)[number];

/** Why no verdict could be reached for a signature that is present. */
export type UnverifiableReason =
    /** No key record for this selector and domain, in the store or the DNS. */
    | 'no-key'
    /** The key record is there but unusable (wrong version, type, or a broken `p=`). */
    | 'bad-key'
    /** The `DKIM-Signature` header itself does not parse. */
    | 'malformed-signature'
    /** The key record's `h=` or `s=` excludes this signature's hash or email entirely. */
    | 'key-rejects-signature'
    /** The signature's `x=` has passed, or its `t=` is in the future. */
    | 'expired'
    /** The lookup failed in a way that may succeed later (a DNS error, with `--dns`). */
    | 'lookup-failed'
    /** Verification itself could not run — the algorithm or key type is not supported here. */
    | 'unsupported';

/** Where a public key came from, which is the whole of the `archive-key` caveat. */
export type KeySource =
    /** Resolved from the public DNS. Only with `--dns`; Stamped is offline by default. */
    | 'dns'
    /** Supplied by the operator — `--key`, a key file, a key store they curate. */
    | 'operator'
    /** Found inside the archive under examination. See the `archive-key` caveat. */
    | 'archive';

/**
 * Everything known about one DKIM signature after verification, and the only input the
 * classifier reads.
 *
 * This is the evidence chain the CLI prints. It is deliberately flat and free of mailauth's
 * vocabulary: the next verifier (an own one on `@gjsify/crypto`, say) fills the same shape, and
 * no rule downstream changes.
 */
export interface SignatureEvidence {
    /** `d=` — the domain that claims to have signed. */
    readonly domain: string;
    /** The domain of the `From:` address a reader sees. Absent when it cannot be determined. */
    readonly authorDomain?: string;
    /**
     * Does `d=` align with the From domain, by DMARC's relaxed rule (same organizational
     * domain)? Only an aligned signature says anything about who the AUTHOR is. False as well
     * when there is no single author domain (several `From:` fields, an unparseable one).
     */
    readonly aligned: boolean;
    /** `s=` — which of that domain's keys. */
    readonly selector: string;
    /** `a=`, e.g. `rsa-sha256` or `ed25519-sha256`. */
    readonly algorithm: string;
    /** `c=`, e.g. `relaxed/relaxed`. */
    readonly canonicalization: string;
    /** `h=` — the header fields the signature covers, in signing order. */
    readonly signedHeaders: readonly string[];
    /** Did the body hash match? The one fact that separates a changed body from a changed header. */
    readonly bodyHashOk: boolean;
    /** Did the header signature verify? False whenever `bodyHashOk` is false — nothing was checked. */
    readonly signatureOk: boolean;
    /** RSA key size in bits. Absent for Ed25519 and whenever no key was fetched. */
    readonly keyBits?: number;
    /** Where the key came from. Absent when no key was fetched at all. */
    readonly keySource?: KeySource;
    /** The key record as it was read, for the record. */
    readonly keyRecord?: string;
    /** The body hash Stamped computed (base64). */
    readonly bodyHash?: string;
    /** The body hash the signature claims (`bh=`, base64). */
    readonly bodyHashExpected?: string;
    /** `l=` — how many canonicalized body bytes the signature covers. Absent without `l=`. */
    readonly lengthLimit?: number;
    /** How many canonicalized body bytes `l=` leaves unsigned. */
    readonly unsignedBodyBytes?: number;
    /** Set when, and only when, the verdict is `unverifiable`. */
    readonly unverifiableBecause?: UnverifiableReason;
    /** The verifier's own words, kept verbatim for diagnostics. Never shown as the verdict. */
    readonly note?: string;
}

/** One signature's verdict, its caveats, and the facts both came from. */
export interface SignatureFinding {
    readonly verdict: Verdict;
    readonly caveats: readonly Caveat[];
    readonly evidence: SignatureEvidence;
}

/** The verdict for a whole message, plus every signature that was looked at. */
export interface MessageFinding {
    /**
     * The strongest verdict among the signatures that speak for the AUTHOR domain — see
     * {@link classifyMessage} (in `classify.ts`) for the rule and {@link VERDICTS} on "strongest".
     */
    readonly verdict: Verdict;
    /** The caveats of the signature the message verdict came from, not of all of them. */
    readonly caveats: readonly Caveat[];
    /** The signature the verdict and caveats came from. Absent for an unsigned message. */
    readonly basis?: SignatureFinding;
    /** Every signature, each classified on its own. Empty for an unsigned message. */
    readonly signatures: readonly SignatureFinding[];
}

/** Position in {@link VERDICTS}; lower is a stronger claim. */
export function verdictRank(verdict: Verdict): number {
    return VERDICTS.indexOf(verdict);
}

/** The headers whose absence from `h=` is worth a caveat, and which caveat that is. */
export const CAVEAT_BY_UNSIGNED_HEADER: ReadonlyMap<string, Caveat> = new Map([
    ['subject', 'unsigned-subject'],
    ['to', 'unsigned-to'],
    ['date', 'unsigned-date'],
]);

/**
 * One line a reader can act on, for each verdict.
 *
 * Translated here rather than at the frontends: the sentence IS the finding, and two frontends
 * paraphrasing it differently would be two different claims about the same message.
 */
export function describeVerdict(verdict: Verdict): string {
    switch (verdict) {
        case 'confirmed':
            return _('Confirmed: a valid signature covers this message as it stands.');
        case 'confirmed-with-caveats':
            return _('Confirmed with caveats: the signature is valid but covers less than it appears to.');
        case 'body-altered':
            return _('Body altered: the body is not the body that was signed.');
        case 'headers-altered':
            return _('Headers altered: a signed header field is not what was signed.');
        case 'unverifiable':
            return _('Unverifiable: a signature is present, but nothing here can check it.');
        case 'unsigned':
            return _('Unsigned: no DKIM signature. This says nothing about the message either way.');
    }
}

/**
 * One line for each caveat, naming what the confirmation does NOT cover.
 *
 * `evidence` lets `signer-not-author` name both domains; without it the sentence stays generic.
 */
export function describeCaveat(caveat: Caveat, evidence?: SignatureEvidence): string {
    switch (caveat) {
        case 'rsa-sha1':
            return _(
                'Signed with rsa-sha1. SHA-1 collisions are practical, so a crafted body can carry a valid signature (RFC 8301).',
            );
        case 'weak-key':
            return _('The RSA key is shorter than 1024 bits and can be factored with ordinary resources.');
        case 'length-limited':
            return _(
                'An l= tag limits the signature to the start of the body. Anything appended after that is unsigned.',
            );
        case 'unsigned-subject':
            return _('Subject is not signed: the subject line could have been changed or added.');
        case 'unsigned-to':
            return _('To is not signed: the recipient could have been changed or added.');
        case 'unsigned-date':
            return _('Date is not signed: the date could have been changed or added.');
        case 'archive-key':
            return _(
                'The public key came from the archive itself, so it proves consistency rather than authenticity.',
            );
        case 'signer-not-author':
            return evidence
                ? fmt(
                      _(
                          'The signature is from {signer}, but the message claims to be from {author}. It proves only that {signer} handled the message, not that {author} sent it.',
                      ),
                      { signer: evidence.domain, author: evidence.authorDomain ?? _('(unknown domain)') },
                  )
                : _(
                      'The signing domain is not the From domain, so the signature does not vouch for the author.',
                  );
    }
}

/** One line for each reason a present signature could not be checked. */
export function describeUnverifiableReason(reason: UnverifiableReason): string {
    switch (reason) {
        case 'no-key':
            return _('No public key for this selector and domain.');
        case 'bad-key':
            return _('The public key record is unusable.');
        case 'malformed-signature':
            return _('The DKIM-Signature header does not parse.');
        case 'key-rejects-signature':
            return _('The key record does not allow this signature (hash algorithm or service type).');
        case 'expired':
            return _('The signature is expired or its timestamp lies in the future.');
        case 'lookup-failed':
            return _('The key lookup failed and may succeed later.');
        case 'unsupported':
            return _('The signature algorithm or key type is not supported here.');
    }
}
