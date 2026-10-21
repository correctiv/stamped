/**
 * The public keys Stamped verifies against, and where each came from.
 *
 * STAMPED IS OFFLINE BY DEFAULT, and that is a source-protection decision rather than a
 * preference. Verifying a leaked message by looking its selector up in the public DNS tells the
 * signing domain's operator — and whoever watches that resolver — the selector, the timing, and
 * by inference that somebody is examining mail from that domain. For a document whose existence
 * is the story, the lookup IS the leak. So the key comes from a store the operator fills, no
 * query leaves the machine unless they ask for one, and every key records its {@link KeySource}
 * because a key found inside the archive proves something much weaker than one from the DNS.
 *
 * Pure: a store is a map plus the RFC 6376 § 3.6.1 record format. Reading a key FILE is the
 * app's job.
 */

import { fmt, _ } from './i18n.ts';
import type { KeySource } from './verdict.ts';

/** One public key record, as it would appear in the DNS, plus where it actually came from. */
export interface KeyEntry {
    /** The TXT record, e.g. `v=DKIM1; k=rsa; p=MIIBIjANBg…`. */
    readonly record: string;
    /** Where it came from — the `archive-key` caveat is this field and nothing else. */
    readonly source: KeySource;
    /** ISO time the key was first seen or obtained, when known. */
    readonly since?: string;
}

/**
 * A lookup table from `<selector>._domainkey.<domain>` to a key record.
 *
 * The key of the map is the full DNS name, not a `(domain, selector)` pair, because that is what
 * a DKIM verifier asks for and what an operator pastes from a `dig` output.
 */
export class KeyStore {
    private readonly entries = new Map<string, KeyEntry>();

    /**
     * Add one key. The name is normalised (lowercased, a trailing dot dropped), so a record
     * copied from `dig`'s output and one typed by hand land on the same entry.
     *
     * A later `add` for the same name REPLACES the earlier one: the operator's `--key` flag is
     * meant to beat whatever a key file or the archive supplied, and the call order is what
     * expresses that.
     */
    add(name: string, record: string, source: KeySource, since?: string): void {
        this.entries.set(normaliseKeyName(name), { record, source, ...(since ? { since } : {}) });
    }

    /** The entry for a name, or `undefined` — which is `no-key`, not an error. */
    lookup(name: string): KeyEntry | undefined {
        return this.entries.get(normaliseKeyName(name));
    }

    /** How many keys are in the store, for the diagnostics line. */
    get size(): number {
        return this.entries.size;
    }

    /** Every name in the store, for `--json` and for tests. */
    names(): string[] {
        return [...this.entries.keys()];
    }
}

/** Lowercase, no trailing dot: DNS names are case-insensitive and `dig` prints the root dot. */
export function normaliseKeyName(name: string): string {
    return name.trim().toLowerCase().replace(/\.$/, '');
}

/** The DNS name a signature's `d=` and `s=` resolve to (RFC 6376 § 3.6.1). */
export function keyNameFor(domain: string, selector: string): string {
    return normaliseKeyName(`${selector}._domainkey.${domain}`);
}

/** A `--key name=value` argument, split but not yet interpreted. */
export interface KeyArgument {
    /** The DNS name, normalised. */
    readonly name: string;
    /** The right-hand side verbatim: a TXT record, or a path to a file holding one. */
    readonly value: string;
}

/**
 * Split one `--key <name>=<value>` argument.
 *
 * The FIRST `=` separates them, never the last: a DKIM TXT record is itself full of `=`
 * (`v=DKIM1; k=rsa; p=…`), so splitting on the last one would cut the record in half and
 * produce an error message about a name nobody typed.
 */
export function parseKeyArgument(argument: string): KeyArgument {
    const eq = argument.indexOf('=');
    if (eq <= 0) {
        throw new Error(
            fmt(_('--key needs <selector>._domainkey.<domain>=<record or file>, got: {argument}'), {
                argument,
            }),
        );
    }
    return {
        name: normaliseKeyName(argument.slice(0, eq)),
        value: argument.slice(eq + 1).trim(),
    };
}

/** Does this text look like a DKIM TXT record rather than a file path or a PEM block? */
export function looksLikeKeyRecord(text: string): boolean {
    return /(^|;)\s*(v\s*=\s*DKIM1|p\s*=)/i.test(text);
}

/** Does this text look like a PEM public key block? */
export function looksLikePem(text: string): boolean {
    return text.includes('-----BEGIN') && text.includes('PUBLIC KEY-----');
}

/**
 * The base64 prefix of an Ed25519 SubjectPublicKeyInfo.
 *
 * An Ed25519 SPKI is 44 bytes: a 12-byte header (`SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT
 * STRING`) then the 32-byte key. 12 bytes is exactly 16 base64 characters with no padding
 * carried over, so the key's own base64 is the remainder of the string — which is why this
 * conversion needs no DER parser and stays in a package that may not have one.
 */
export const ED25519_SPKI_PREFIX = 'MCowBQYDK2VwAyEA';

/**
 * Build a DKIM TXT record from a PEM public key.
 *
 * `--key …=key.pub.pem` is the form an operator has on disk; `p=` wants base64 and a `k=` tag
 * that says which kind. The two key types differ in WHAT goes into `p=`, and getting it wrong
 * fails as "invalid public key" rather than as a wrong answer:
 *
 * - RSA: the SubjectPublicKeyInfo DER, base64 — exactly the PEM body (RFC 6376 § 3.6.1).
 * - Ed25519: the RAW 32-byte key, base64 — NOT the SPKI (RFC 8463 § 3). Verifiers that accept
 *   the SPKI form do so as a concession and flag it.
 */
export function recordFromPem(pem: string): string {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    if (body.length === 0) {
        throw new Error(_('That PEM block holds no key data.'));
    }
    if (body.startsWith(ED25519_SPKI_PREFIX)) {
        return `v=DKIM1; k=ed25519; p=${body.slice(ED25519_SPKI_PREFIX.length)}`;
    }
    return `v=DKIM1; k=rsa; p=${body}`;
}
