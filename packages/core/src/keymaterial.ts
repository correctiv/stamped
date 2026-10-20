/**
 * Reading a public key out of whatever the operator has: a PEM block, a bare `p=` value, or a DNS
 * TXT record pasted from `dig`, a registrar panel or a provider's e-mail.
 *
 * Pure, and with its own base64 and DER reader on purpose: `@stamped/core` may not touch `node:*`
 * or `Buffer`, and the only DER Stamped ever reads is the fixed shape of an RSA
 * SubjectPublicKeyInfo — a modulus length is all the key store needs from it.
 */

import { fmt, _ } from './i18n.ts';
import { ED25519_SPKI_PREFIX, looksLikeKeyRecord, looksLikePem, recordFromPem } from './keys.ts';

export type KeyAlgorithm = 'rsa' | 'ed25519';

/** A key that was read and validated. `record` is the canonical TXT form the verifier is fed. */
export interface ParsedKey {
    readonly kind: 'key';
    readonly record: string;
    readonly algorithm: KeyAlgorithm;
    /** RSA modulus length; 256 for Ed25519. */
    readonly bits: number;
}

/** `p=` is empty: the domain withdrew the key (RFC 6376 § 3.6.1). Nothing to store or verify. */
export interface RevokedKey {
    readonly kind: 'revoked';
}

export type KeyMaterial = ParsedKey | RevokedKey;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 to bytes, padding optional. */
export function decodeBase64(text: string): Uint8Array {
    const clean = text.replace(/\s+/g, '').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) {
        throw new Error(_('The key is not valid base64.'));
    }
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let acc = 0;
    let bits = 0;
    let n = 0;
    for (const ch of clean) {
        acc = (acc << 6) | BASE64.indexOf(ch);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (acc >> bits) & 0xff;
            acc &= (1 << bits) - 1;
        }
    }
    return out;
}

interface Tlv {
    readonly tag: number;
    readonly start: number;
    readonly end: number;
}

function readTlv(bytes: Uint8Array, at: number): Tlv {
    const tag = bytes[at];
    const first = bytes[at + 1];
    if (tag === undefined || first === undefined) throw notRsa();
    let length = first;
    let offset = at + 2;
    if (first & 0x80) {
        const count = first & 0x7f;
        if (count === 0 || count > 4 || offset + count > bytes.length) throw notRsa();
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + (bytes[offset++] ?? 0);
    }
    if (offset + length > bytes.length) throw notRsa();
    return { tag, start: offset, end: offset + length };
}

function notRsa(): Error {
    return new Error(
        _('That is not an RSA public key in SubjectPublicKeyInfo form (PEM header "BEGIN PUBLIC KEY").'),
    );
}

/** DER of the OID rsaEncryption, 1.2.840.113549.1.1.1. */
const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/** Bit length of the modulus of an RSA SubjectPublicKeyInfo. */
export function rsaModulusBits(spki: Uint8Array): number {
    const outer = readTlv(spki, 0);
    if (outer.tag !== 0x30) throw notRsa();
    const algorithm = readTlv(spki, outer.start);
    if (algorithm.tag !== 0x30) throw notRsa();
    const oid = spki.subarray(algorithm.start, algorithm.start + RSA_OID.length);
    if (oid.length !== RSA_OID.length || oid.some((b, i) => b !== RSA_OID[i])) throw notRsa();
    const bitString = readTlv(spki, algorithm.end);
    if (bitString.tag !== 0x03) throw notRsa();
    const sequence = readTlv(spki, bitString.start + 1);
    if (sequence.tag !== 0x30) throw notRsa();
    const modulus = readTlv(spki, sequence.start);
    if (modulus.tag !== 0x02) throw notRsa();
    let start = modulus.start;
    while (start < modulus.end - 1 && spki[start] === 0) start++;
    return (modulus.end - start - 1) * 8 + (32 - Math.clz32(spki[start] ?? 0));
}

/** The tags of a DKIM key record, lowercased by name. */
function tagsOf(record: string): Map<string, string> {
    const tags = new Map<string, string>();
    for (const part of record.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    return tags;
}

/**
 * A pasted TXT record as one line.
 *
 * `dig` prints `name. 300 IN TXT "part one" "part two"`, and a registrar panel shows the quoted
 * parts only; the verifier wants the parts joined with nothing between them, as a resolver does.
 */
function unquoteTxt(text: string): string {
    const afterType = /\bIN\s+TXT\s+([\s\S]*)$/i.exec(text);
    const body = afterType?.[1] ?? text;
    return body
        .replace(/["()]/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .join('')
        .replace(/\s+;/g, ';')
        .trim();
}

function fromRecord(record: string): KeyMaterial {
    const tags = tagsOf(record);
    const version = tags.get('v');
    if (version !== undefined && version.toUpperCase() !== 'DKIM1') {
        throw new Error(fmt(_('Unsupported DKIM record version "{version}".'), { version }));
    }
    const given = tags.get('p');
    if (given === undefined) throw new Error(_('The record has no p= tag, so it holds no key.'));
    let p = given.replace(/\s+/g, '');
    if (p === '') return { kind: 'revoked' };

    const kind = (tags.get('k') ?? '').toLowerCase();
    let bytes = decodeBase64(p);
    if (kind === 'ed25519' || (kind === '' && (bytes.length === 32 || p.startsWith(ED25519_SPKI_PREFIX)))) {
        if (p.startsWith(ED25519_SPKI_PREFIX)) {
            p = p.slice(ED25519_SPKI_PREFIX.length);
            bytes = decodeBase64(p);
        }
        if (bytes.length !== 32) throw new Error(_('An Ed25519 key must be exactly 32 bytes.'));
        return { kind: 'key', record: `v=DKIM1; k=ed25519; p=${p}`, algorithm: 'ed25519', bits: 256 };
    }
    if (kind !== '' && kind !== 'rsa') {
        throw new Error(fmt(_('Unsupported key type "{type}".'), { type: kind }));
    }
    return {
        kind: 'key',
        record: `v=DKIM1; k=rsa; p=${p}`,
        algorithm: 'rsa',
        bits: rsaModulusBits(bytes),
    };
}

/**
 * Validate key text in any of the three forms and say what it is.
 *
 * Throws with a sentence naming what is wrong when it is none of them: an operator who pasted a
 * truncated key must hear "not valid" now, not discover it as `unverifiable` on a hundred mails.
 */
export function parseKeyMaterial(text: string): KeyMaterial {
    const trimmed = text.trim();
    if (trimmed === '') throw new Error(_('Nothing to read: the key text is empty.'));
    if (looksLikePem(trimmed)) return fromRecord(recordFromPem(trimmed));
    const record = unquoteTxt(trimmed);
    if (looksLikeKeyRecord(record)) return fromRecord(record);
    if (/^[A-Za-z0-9+/\s]+=*\s*$/.test(trimmed)) {
        return fromRecord(`v=DKIM1; p=${trimmed.replace(/\s+/g, '')}`);
    }
    throw new Error(
        _('That is neither a PEM public key, a DKIM TXT record nor a base64 p= value.'),
    );
}
