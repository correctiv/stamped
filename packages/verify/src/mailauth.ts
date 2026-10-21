/**
 * The one module that knows mailauth exists.
 *
 * WHY MAILAUTH AND NOT OUR OWN VERIFIER, measured rather than assumed (`docs/spikes.md`): DKIM
 * verification is not the hard part — canonicalization is. `relaxed` header folding, `simple`
 * body CRLF handling, `l=` counted in canonicalized bytes, the MIME-structure start, a `b=` that
 * must be stripped from the very header it signs: each of those is a place where a
 * from-scratch verifier is subtly wrong and still returns `true` on well-formed mail, which is
 * the worst possible failure mode for a tool whose output might be quoted in print. mailauth is
 * MIT, has run in production as part of ZoneMTA for years, and exposes every intermediate fact
 * Stamped needs to classify (body hash computed vs expected, modulus length, the `h=` list, the
 * `l=` limit). It runs under GJS once `self` is defined — see {@link loadMailauth}.
 *
 * It is kept LENIENT on purpose. `strict: true` would short-circuit exactly the cases Stamped
 * exists to report: an rsa-sha1 signature becomes `dkim=policy` and is never verified at all,
 * and a key under `minBitLength` throws before the signature is checked. Stamped wants the
 * crypto verdict AND the caveat, so it asks for the verdict and applies the caveats itself
 * (`@stamped/core`'s `caveatsFor`).
 */

import type { KeyStore } from '@stamped/core';
import { keyNameFor, _ } from '@stamped/core';
import type { DKIMResult, DNSResolver } from 'mailauth/lib/types';

import { evidenceFrom, type RawSignatureResult } from './evidence.ts';
import { explainBodyByRetry } from './retry.ts';

/** What `dkimVerify` is, as this module uses it. */
type DkimVerify = (
    input: string | Uint8Array,
    options: {
        resolver?: DNSResolver;
        minBitLength?: number;
        rejectRsaSha1?: boolean;
        strict?: boolean;
    },
) => Promise<{
    results?: DKIMResult[];
    headerFrom?: string[];
    fromFields?: number;
    fromSyntax?: 'valid' | 'lax' | 'invalid';
}>;

/** mailauth's Author Domain rules, as this module uses them. */
type AuthorDomainOf = (
    headerFrom: string[],
    fromFields: number,
    options: { fromSyntax?: 'valid' | 'lax' | 'invalid'; strict?: boolean },
) => { authorDomain?: string };

/**
 * mailauth, loaded once, lazily, and AFTER `self` exists.
 *
 * `--app gjs` resolves the `browser` export condition (gjsify's `app/gjs.ts`: `conditionNames:
 * ['browser']`), and mailauth's validation layer is joi, whose `browser` field points at
 * `dist/joi-browser.min.js` — a UMD bundle that passes `self` as its global root. GJS defines
 * `window` and `globalThis` but not `self`, so the bundle died at load with `ReferenceError: self
 * is not defined` before any Stamped code ran (measured; `docs/spikes.md`).
 *
 * The assignment below is the consumer-side shim. A dynamic import rather than a static one
 * because the fix has to be a STATEMENT that runs before joi's module body: static imports are
 * hoisted and joi would initialise first, which is the bug.
 *
 * Fixed upstream in gjsify: `self` belongs in the GJS globals model next to `window` (ADR 0079),
 * so a bundle gets it without every consumer knowing about joi. Remove this block and make the
 * import static once that lands.
 */
let mailauthPromise: Promise<{ dkimVerify: DkimVerify; getAuthorDomain: AuthorDomainOf }> | undefined;

function loadMailauth(): Promise<{ dkimVerify: DkimVerify; getAuthorDomain: AuthorDomainOf }> {
    if (!mailauthPromise) {
        const host = globalThis as Record<string, unknown>;
        if (typeof host.self === 'undefined') host.self = globalThis;
        mailauthPromise = Promise.all([
            import('mailauth/lib/dkim/verify'),
            import('mailauth/lib/dmarc/author-domain'),
        ]).then(([verify, author]) => ({
            dkimVerify: (verify as { dkimVerify: DkimVerify }).dkimVerify,
            getAuthorDomain: (author as { getAuthorDomain: AuthorDomainOf }).getAuthorDomain,
        }));
    }
    return mailauthPromise;
}

/** How Stamped drives a verification. */
export interface VerifyOptions {
    /** The keys to verify against. A store with no entry for a selector yields `no-key`. */
    readonly keys: KeyStore;
    /**
     * Asked only when the store has no entry — the seam a future `--dns` flag plugs into.
     *
     * Absent by default, and that default is the source-protection decision documented in
     * `@stamped/core`'s `keys.ts`: a DNS lookup for a leaked message's selector tells the signing
     * domain that somebody is reading its mail.
     */
    readonly fallbackResolver?: DNSResolver;
    /**
     * Key names (`<selector>._domainkey.<domain>`) whose key is known to have confirmed other
     * messages of the same case. A header failure under such a key is much more likely an edit
     * than a wrong key, so the `key-newer-than-message` caveat must not soften it.
     *
     * Only a caller that classifies a whole case can know this. A single-message `stamped
     * verify` has no siblings and leaves it unset, which keeps the caveat.
     */
    readonly confirmedPairs?: ReadonlySet<string>;
}

/** One verified signature: the facts, with the key's provenance already attached. */
export interface VerifiedSignature {
    readonly raw: RawSignatureResult;
    readonly evidence: ReturnType<typeof evidenceFrom>;
}

/**
 * Verify every DKIM signature on one raw message.
 *
 * Returns the evidence, not a verdict: classification is `@stamped/core`'s, so that the rules
 * stay testable without a verifier and the verifier stays replaceable without touching a rule.
 * An empty array means the message carries no DKIM signature.
 */
export async function verifyMessage(
    raw: string | Uint8Array,
    options: VerifyOptions,
): Promise<ReturnType<typeof evidenceFrom>[]> {
    // No DKIM-Signature in the header block: mailauth would answer with its one synthetic `none`
    // result, which is filtered out below anyway. Skipping the call is the same answer without
    // ~16 ms of parsing and canonicalisation per message — most of an archive is unsigned.
    if (!hasSignatureHeader(raw)) return [];

    const { dkimVerify, getAuthorDomain } = await loadMailauth();

    // Which names were answered from where, filled by the resolver below and read back per
    // signature. mailauth reports the key record it used but not its provenance — it has no
    // reason to care, and the `archive-key` caveat is exactly that provenance.
    const sources = new Map<string, { source: 'dns' | 'operator' | 'archive'; since?: string }>();

    const resolver: DNSResolver = async (name, rrtype) => {
        const entry = options.keys.lookup(name);
        if (entry) {
            sources.set(name.toLowerCase().replace(/\.$/, ''), {
                source: entry.source,
                ...(entry.since ? { since: entry.since } : {}),
            });
            return [[entry.record]];
        }
        if (options.fallbackResolver) {
            const answer = await options.fallbackResolver(name, rrtype);
            // A live answer is published as of now, which is when Stamped first saw it.
            sources.set(name.toLowerCase().replace(/\.$/, ''), {
                source: 'dns',
                since: new Date().toISOString(),
            });
            return answer;
        }
        // `ENOTFOUND` is mailauth's "there is no key, now or later" (its `KEY_ERROR_COMMENTS`),
        // which becomes `status.comment = 'no key'` and then Stamped's `no-key`. A plain Error
        // would land in the `temperror` branch and read as a transient network fault — telling
        // the operator to retry a lookup that was never going to happen.
        throw Object.assign(new Error(_('no key in the store')), { code: 'ENOTFOUND' });
    };

    const messageDate = messageDateOf(raw);

    const result = await dkimVerify(withCrlf(raw), {
        resolver,
        // Low enough that a 512-bit key is VERIFIED rather than refused: mailauth throws
        // `ESHORTKEY` before checking the signature once the key is under this, and a refused
        // signature in a 2009 archive destroys the only evidence there is. Stamped reports the
        // short key as the `weak-key` caveat instead.
        //
        // ONE and not zero. mailauth's `getPublicKey` does `minBitLength = minBitLength || 1024`,
        // so a zero is falsy and silently becomes the default — measured: a 512-bit fixture came
        // back `dkim=policy` with `minBitLength: 0` and `pass` with `1` (`docs/spikes.md`).
        minBitLength: 1,
        // Same reasoning for rsa-sha1: `true` makes it `dkim=policy` with no crypto run at all.
        rejectRsaSha1: false,
        strict: false,
    });

    // The same Author Domain rules mailauth aligned the signatures against, so the domain printed
    // is the domain compared. Absent when the From field yields no single domain.
    const author = getAuthorDomain(result.headerFrom ?? [], result.fromFields ?? 0, {
        fromSyntax: result.fromSyntax,
        strict: false,
    });

    return (
        (result.results ?? [])
            // mailauth reports an UNSIGNED message as one synthetic result with `result: 'none'` and
            // no signing domain, because a mail server wants an `Authentication-Results` line either
            // way. For Stamped a signature that does not exist must not become a `SignatureEvidence`:
            // `classifyMessage` reads an empty list as `unsigned`, and an entry here would make it
            // classify the absence of a signature as a broken one.
            .filter((signature) => signature.status.result !== 'none')
            .map((signature) => {
                const name = keyNameFor(signature.signingDomain ?? '', signature.selector ?? '');
                const key = sources.get(name);
                const evidence = evidenceFrom(signature as RawSignatureResult, {
                    keyConfirmsOthers: options.confirmedPairs?.has(name) ?? false,
                    authorDomain: author.authorDomain,
                    source: key?.source,
                    keySince: key?.since,
                    messageDate,
                });
                return withRetry(raw, evidence);
            })
    );
}

/**
 * For a body-hash mismatch, record whether undoing a common export artefact brings the signed
 * hash back. Adds an explanation to the evidence; `bodyHashOk` and the verdict are untouched.
 */
function withRetry(raw: string | Uint8Array, evidence: ReturnType<typeof evidenceFrom>) {
    if (evidence.bodyHashOk || evidence.unverifiableBecause || !evidence.bodyHashExpected) return evidence;
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const exportArtefact = explainBodyByRetry(bytes, {
        canonicalization: evidence.canonicalization,
        algorithm: evidence.algorithm,
        bodyHashExpected: evidence.bodyHashExpected,
        ...(evidence.lengthLimit !== undefined ? { lengthLimit: evidence.lengthLimit } : {}),
    });
    return { ...evidence, exportRetried: true, ...(exportArtefact ? { exportArtefact } : {}) };
}

/**
 * The message with every bare LF turned into CRLF, which is the rewrite mailauth's message parser
 * performs itself — but there it costs one Buffer, one `await` and one stream hop PER LINE, and on
 * an LF-only archive (every mbox from a Unix MTA) that was 90 % of the verify time. Doing it once
 * here hands the parser a message it passes through whole; the bytes mailauth hashes are the same.
 */
function withCrlf(raw: string | Uint8Array): string | Uint8Array {
    if (typeof raw === 'string') return raw;
    let bare = 0;
    for (let i = raw.indexOf(10); i !== -1; i = raw.indexOf(10, i + 1)) {
        if (i === 0 || raw[i - 1] !== 13) bare++;
    }
    if (bare === 0) return raw;
    const out = new Uint8Array(raw.length + bare);
    let from = 0;
    let to = 0;
    for (let i = raw.indexOf(10); i !== -1; i = raw.indexOf(10, i + 1)) {
        if (i !== 0 && raw[i - 1] === 13) continue;
        out.set(raw.subarray(from, i), to);
        to += i - from;
        out[to++] = 13;
        out[to++] = 10;
        from = i + 1;
    }
    out.set(raw.subarray(from), to);
    return out;
}

/** Whether the header block (never the body) has a `DKIM-Signature` field. */
function hasSignatureHeader(raw: string | Uint8Array): boolean {
    let head: string;
    if (typeof raw === 'string') {
        const end = raw.search(/\r?\n\r?\n/);
        head = end === -1 ? raw : raw.slice(0, end);
    } else {
        // Header names are ASCII, so a byte-wise Latin-1 view is enough and avoids decoding the body.
        let text = '';
        for (let i = 0; i < raw.length; i++) {
            text += String.fromCharCode(raw[i] as number);
            if (i > 3 && raw[i] === 10 && (raw[i - 1] === 10 || (raw[i - 1] === 13 && raw[i - 2] === 10)))
                break;
        }
        head = text;
    }
    return /^dkim-signature[ \t]*:/im.test(head);
}

/** The `Date:` header as ISO, read from the header block alone; undefined if absent or unparseable. */
function messageDateOf(raw: string | Uint8Array): string | undefined {
    let head = '';
    if (typeof raw === 'string') {
        head = raw.slice(0, 65536);
    } else {
        for (const byte of raw.subarray(0, 65536)) head += String.fromCharCode(byte);
    }
    const end = head.search(/\r?\n\r?\n/);
    const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
    const value = /^date:[ \t]*(.*)$/im.exec(block)?.[1]?.trim();
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
