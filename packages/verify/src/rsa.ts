/**
 * Did THIS key make THIS signature, and are the signed headers still the ones it signed?
 *
 * Two questions mailauth does not answer separately. It reports one `bad signature` for both
 * "somebody edited a header" and "the key is not the one that signed", and it reports nothing
 * about the key at all once the body hash already differs, because it never fetches the key
 * then. Both are reconstructible from the public key alone: raising `b=` to the public exponent
 * gives back the PKCS#1 v1.5 block the signer built (RFC 8017 § 8.2.2), and a block that is not
 * well formed can only come from another key. A well formed one carries the digest the signer
 * hashed, which can be set against the header hash computed here.
 *
 * Written out independently of mailauth like `retry.ts`: a second opinion on the bytes. Run only
 * for a signature that FAILED — a modular exponentiation per message is wasted on the common
 * case of a pass.
 */

import { createHash } from 'node:crypto';

/** `DigestInfo` prefixes (RFC 8017 § 9.2 note 1), by hash. */
const DIGEST_INFO: Readonly<Record<'sha256' | 'sha1', string>> = {
    sha256: '3031300d060960864801650304020105000420',
    sha1: '3021300906052b0e03021a05000414',
};

const DIGEST_LENGTH: Readonly<Record<'sha256' | 'sha1', number>> = { sha256: 32, sha1: 20 };

export type DkimHash = 'sha256' | 'sha1';

/** What raising the signature to the public exponent showed. */
export interface RsaProof {
    /** Modulus size in bits. */
    readonly bits: number;
    /** Is the result a well-formed EMSA-PKCS1-v1_5 block for sha256 or sha1? */
    readonly signed: boolean;
    /** The digest inside the block, when it was built for the hash `a=` names. */
    readonly digest?: Uint8Array;
}

interface RsaKey {
    readonly n: bigint;
    readonly e: bigint;
    readonly bits: number;
}

/** The `p=` of a key record as bytes; undefined when absent or revoked (empty). */
function keyBytesOf(record: string): Uint8Array | undefined {
    const match = /(?:^|;)\s*p\s*=\s*([^;]*)/.exec(record);
    const text = match?.[1]?.replace(/\s+/g, '') ?? '';
    return text.length === 0 ? undefined : new Uint8Array(Buffer.from(text, 'base64'));
}

interface Tlv {
    readonly tag: number;
    readonly start: number;
    readonly end: number;
}

function readTlv(bytes: Uint8Array, position: number): Tlv | undefined {
    const tag = bytes[position];
    const first = bytes[position + 1];
    if (tag === undefined || first === undefined) return undefined;
    let length = first;
    let start = position + 2;
    if (first >= 0x80) {
        const count = first & 0x7f;
        if (count === 0 || count > 4) return undefined;
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + (bytes[start + i] ?? 0);
        start += count;
    }
    const end = start + length;
    return end > bytes.length ? undefined : { tag, start, end };
}

function bigFrom(bytes: Uint8Array, start: number, end: number): bigint {
    let value = 0n;
    for (let i = start; i < end; i++) value = (value << 8n) | BigInt(bytes[i] as number);
    return value;
}

function bitLength(value: bigint): number {
    return value === 0n ? 0 : value.toString(2).length;
}

/** `RSAPublicKey ::= SEQUENCE { n INTEGER, e INTEGER }` at `position`. */
function readRsaPublicKey(bytes: Uint8Array, position: number): RsaKey | undefined {
    const sequence = readTlv(bytes, position);
    if (!sequence || sequence.tag !== 0x30) return undefined;
    const n = readTlv(bytes, sequence.start);
    if (!n || n.tag !== 0x02) return undefined;
    const e = readTlv(bytes, n.end);
    if (!e || e.tag !== 0x02) return undefined;
    const modulus = bigFrom(bytes, n.start, n.end);
    return { n: modulus, e: bigFrom(bytes, e.start, e.end), bits: bitLength(modulus) };
}

/** An RSA key from a DKIM `p=`: SubjectPublicKeyInfo normally, a bare RSAPublicKey in the wild. */
function parseRsaKey(record: string): RsaKey | undefined {
    const bytes = keyBytesOf(record);
    if (!bytes) return undefined;
    const outer = readTlv(bytes, 0);
    if (!outer || outer.tag !== 0x30) return undefined;
    const inner = readTlv(bytes, outer.start);
    if (!inner) return undefined;
    if (inner.tag === 0x02) return readRsaPublicKey(bytes, 0);
    // SPKI: SEQUENCE { AlgorithmIdentifier, BIT STRING { 0x00, RSAPublicKey } }
    const bits = readTlv(bytes, inner.end);
    if (!bits || bits.tag !== 0x03) return undefined;
    return readRsaPublicKey(bytes, bits.start + 1);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    let b = base % modulus;
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % modulus;
        b = (b * b) % modulus;
        e >>= 1n;
    }
    return result;
}

function toBytes(value: bigint, length: number): Uint8Array {
    const hex = value.toString(16).padStart(length * 2, '0');
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function hexOf(bytes: Uint8Array, start: number, end: number): string {
    let text = '';
    for (let i = start; i < end; i++) text += (bytes[i] as number).toString(16).padStart(2, '0');
    return text;
}

/** Parse `00 01 FF.. 00 || DigestInfo || digest`; the digest and its hash, or undefined. */
function readBlock(block: Uint8Array): { hash: DkimHash; digest: Uint8Array } | undefined {
    if (block[0] !== 0 || block[1] !== 1) return undefined;
    let i = 2;
    while (block[i] === 0xff) i++;
    if (i < 10 || block[i] !== 0) return undefined;
    i++;
    for (const hash of ['sha256', 'sha1'] as const) {
        const prefix = DIGEST_INFO[hash];
        if (hexOf(block, i, i + prefix.length / 2) !== prefix) continue;
        const start = i + prefix.length / 2;
        if (block.length - start !== DIGEST_LENGTH[hash]) continue;
        return { hash, digest: block.subarray(start) };
    }
    return undefined;
}

/**
 * Raise `b=` to the key's public exponent and read the block.
 *
 * `undefined` when nothing can be said: not an RSA key we can parse. A signature of another
 * LENGTH than the modulus is a plain `signed: false`.
 */
export function proveRsa(record: string, signature: string, hash: DkimHash): RsaProof | undefined {
    const key = parseRsaKey(record);
    if (!key || key.n < 3n) return undefined;
    const sig = new Uint8Array(Buffer.from(signature.replace(/\s+/g, ''), 'base64'));
    const size = Math.ceil(key.bits / 8);
    if (sig.length !== size) return { bits: key.bits, signed: false };
    const value = bigFrom(sig, 0, sig.length);
    if (value >= key.n) return { bits: key.bits, signed: false };
    const block = readBlock(toBytes(modPow(value, key.e, key.n), size));
    if (!block) return { bits: key.bits, signed: false };
    return block.hash === hash
        ? { bits: key.bits, signed: true, digest: block.digest }
        : { bits: key.bits, signed: true };
}

interface Field {
    readonly name: string;
    /** The field as written, folds included, without the closing CRLF. */
    readonly text: string;
}

function headerFields(raw: Uint8Array | string): Field[] {
    let text = '';
    if (typeof raw === 'string') {
        text = raw;
    } else {
        for (let i = 0; i < raw.length; i++) {
            text += String.fromCharCode(raw[i] as number);
            if (i > 3 && raw[i] === 10 && (raw[i - 1] === 10 || (raw[i - 1] === 13 && raw[i - 2] === 10)))
                break;
        }
    }
    const end = text.search(/\r?\n\r?\n/);
    const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n/g, '\r\n');
    const fields: { name: string; text: string }[] = [];
    for (const line of block.split('\r\n')) {
        if (/^[ \t]/.test(line) && fields.length > 0) {
            (fields[fields.length - 1] as { text: string }).text += `\r\n${line}`;
            continue;
        }
        const colon = line.indexOf(':');
        if (colon > 0) fields.push({ name: line.slice(0, colon).trim().toLowerCase(), text: line });
    }
    return fields;
}

function tagB(field: string): string {
    return (/(?:^|;)\s*b\s*=\s*([^;]*)/.exec(field.slice(field.indexOf(':') + 1))?.[1] ?? '').replace(
        /\s+/g,
        '',
    );
}

function relaxedField(field: string): string {
    const colon = field.indexOf(':');
    const value = field
        .slice(colon + 1)
        .replace(/\r\n(?=[ \t])/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/^ | $/g, '');
    return `${field.slice(0, colon).trim().toLowerCase()}:${value}`;
}

/**
 * The digest a verifier hashes for the header signature (RFC 6376 § 3.7): the `h=` fields,
 * each name taking the last not-yet-used instance from the bottom, then the `DKIM-Signature`
 * itself with an empty `b=` and no closing CRLF. Undefined when the signature header cannot be
 * found among the fields.
 */
export function headerDigest(
    raw: Uint8Array | string,
    signedHeaders: readonly string[],
    canonicalization: string,
    signature: string,
    hash: DkimHash,
): Uint8Array | undefined {
    const fields = headerFields(raw);
    const wanted = signature.replace(/\s+/g, '');
    let own: Field | undefined;
    for (const field of fields) {
        if (field.name === 'dkim-signature' && tagB(field.text) === wanted) own = field;
    }
    if (!own) return undefined;
    const relaxed = (canonicalization.split('/')[0] ?? 'simple').toLowerCase() === 'relaxed';
    const render = (field: string) => (relaxed ? relaxedField(field) : field);

    const used = new Map<string, number>();
    let data = '';
    for (const name of signedHeaders) {
        let skip = used.get(name) ?? 0;
        let found: Field | undefined;
        for (let i = fields.length - 1; i >= 0; i--) {
            const field = fields[i] as Field;
            if (field.name !== name) continue;
            if (skip === 0) {
                found = field;
                break;
            }
            skip--;
        }
        if (!found) continue;
        used.set(name, (used.get(name) ?? 0) + 1);
        data += `${render(found.text)}\r\n`;
    }
    const emptied = own.text.replace(
        /^([^:]*:)([\s\S]*)$/,
        (_all, name: string, value: string) => `${name}${value.replace(/((?:^|;)\s*b\s*=)[^;]*/, '$1')}`,
    );
    data += render(emptied);
    return new Uint8Array(createHash(hash).update(Buffer.from(data, 'latin1')).digest());
}

/** Do two digests hold the same bytes? */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
