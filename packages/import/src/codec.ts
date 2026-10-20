/**
 * The decoders: base64, quoted-printable, charsets, and RFC 2047 encoded words.
 *
 * All of them exist for ONE purpose — producing text a journalist can search for. None of them
 * is ever applied to bytes a verdict depends on: the raw store keeps the message octet for
 * octet, and `@stamped/verify` reads those octets, so nothing here can move a body hash. That
 * separation is why these may be lenient. A truncated base64 block, a `=` with no hex digits
 * after it, a charset nobody has heard of: each gives back the best text available instead of
 * throwing, because a message that cannot be fully decoded must still be FINDABLE. An archive
 * where one malformed attachment aborts the import is an archive with a hole in it, and the hole
 * is invisible.
 *
 * No `node:*` and no `gi://`: the decoding rules are the part that has to be testable on both
 * runtimes without a toolchain between the test and the rule.
 */

import { decodeLatin1 } from './bytes.ts';

/** Value of each base64 character, `-1` for everything else. Index by code unit. */
const BASE64_VALUE = (() => {
    const table = new Int8Array(256).fill(-1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
    // URL-safe base64 is not legal in MIME, but it turns up in headers written by web tooling,
    // and reading it costs two entries.
    table['-'.charCodeAt(0)] = 62;
    table['_'.charCodeAt(0)] = 63;
    return table;
})();

/**
 * Base64 to bytes, skipping anything that is not an alphabet character.
 *
 * Skipping rather than rejecting is the whole leniency: line breaks, padding and the stray
 * space a mail client inserted all land in the same branch, and a block that ends mid-group
 * yields the bytes that were complete.
 */
export function decodeBase64(text: string): Uint8Array {
    const out = new Uint8Array(((text.length >> 2) + 1) * 3);
    let length = 0;
    let accumulator = 0;
    let bits = 0;
    for (let i = 0; i < text.length; i++) {
        const value = BASE64_VALUE[text.charCodeAt(i) & 0xff];
        if (value === undefined || value < 0) continue;
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits < 8) continue;
        bits -= 8;
        out[length++] = (accumulator >> bits) & 0xff;
    }
    return out.subarray(0, length);
}

/**
 * Quoted-printable to bytes (RFC 2045 § 6.7).
 *
 * `underscoreIsSpace` is the one difference between the body encoding and the `Q` encoding of
 * RFC 2047: inside an encoded word `_` means a space, in a body it means an underscore. Passing
 * the wrong one turns every underscore in a German subject line into a space, which reads as a
 * typo rather than as a decoding bug.
 */
export function decodeQuotedPrintable(text: string, underscoreIsSpace = false): Uint8Array {
    const out = new Uint8Array(text.length);
    let length = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '_' && underscoreIsSpace) {
            out[length++] = 0x20;
            continue;
        }
        if (char !== '=') {
            out[length++] = text.charCodeAt(i) & 0xff;
            continue;
        }
        // A soft line break: `=` at the end of a line, joining it to the next.
        if (text[i + 1] === '\n') {
            i += 1;
            continue;
        }
        if (text[i + 1] === '\r' && text[i + 2] === '\n') {
            i += 2;
            continue;
        }
        const hex = text.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            out[length++] = Number.parseInt(hex, 16);
            i += 2;
            continue;
        }
        // A lone `=`. Encoders produce them; keeping it is what every mail client shows.
        out[length++] = 0x3d;
    }
    return out.subarray(0, length);
}

/**
 * Bytes to text in the charset the message declared.
 *
 * An unknown or missing charset falls back to Latin-1, which decodes every byte sequence to
 * SOMETHING — mojibake in the worst case, never an exception and never an empty field. The index
 * would otherwise lose the whole message over one unrecognised label.
 */
export function decodeCharset(bytes: Uint8Array, charset?: string): string {
    const label = (charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (label === '' || LATIN1_LABELS.has(label)) return decodeLatin1(bytes);
    try {
        return new TextDecoder(label).decode(bytes);
    } catch {
        return decodeLatin1(bytes);
    }
}

/**
 * The labels answered without a `TextDecoder`.
 *
 * `us-ascii` is here because a message labelled ASCII that carries 8-bit bytes anyway is
 * commonplace, and a strict ASCII decoder would drop exactly the characters that distinguish one
 * name from another.
 */
const LATIN1_LABELS = new Set(['us-ascii', 'ascii', 'iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'binary']);

/** One `=?charset?B?text?=`, anchored so a `?` inside the payload cannot end it early. */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * RFC 2047 encoded words in a header value, turned into text.
 *
 * The rule that is easy to miss: whitespace BETWEEN two encoded words is a separator the encoder
 * had to insert (a word may not exceed 75 characters), not a space in the text — § 6.2. Keeping
 * it puts a space in the middle of a long German compound every time one is split across two
 * words, which looks like the sender's typo and makes the subject unsearchable.
 */
export function decodeEncodedWords(text: string): string {
    if (!text.includes('=?')) return text;
    let out = '';
    let at = 0;
    let afterWord = false;
    ENCODED_WORD.lastIndex = 0;
    for (let match = ENCODED_WORD.exec(text); match; match = ENCODED_WORD.exec(text)) {
        const gap = text.slice(at, match.index);
        if (!(afterWord && gap.trim() === '')) out += gap;
        out += decodeWord(match[1] ?? '', match[2] ?? 'q', match[3] ?? '');
        at = match.index + match[0].length;
        afterWord = true;
    }
    return out + text.slice(at);
}

/** One encoded word's payload. The `*language` suffix of RFC 2231 is dropped, not parsed. */
function decodeWord(charset: string, encoding: string, payload: string): string {
    const bytes =
        encoding.toLowerCase() === 'b'
            ? decodeBase64(payload)
            : decodeQuotedPrintable(payload, true);
    return decodeCharset(bytes, charset.split('*')[0]);
}
