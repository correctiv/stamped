/**
 * The byte helpers the splitters and the decoders share.
 *
 * WHY LATIN-1 AND NOT UTF-8 for anything structural: RFC 5322 structure — the header block, the
 * field names, the MIME boundaries — is ASCII, but the bytes AROUND it are whatever the sender
 * sent, and a lot of real mail is neither UTF-8 nor labelled. Decoding the raw message as UTF-8
 * to find a boundary replaces every invalid sequence with U+FFFD, which changes the length of
 * the string and therefore every offset computed from it. Latin-1 is the one decoding that is
 * total and byte-for-byte reversible, so a string decoded this way can be measured, sliced and
 * re-encoded without losing a single octet. The CHARSET decoding happens later, per MIME part,
 * where a charset is actually declared.
 */

/** Shared empty view, so the hot paths do not allocate one per call. */
export const EMPTY: Uint8Array = new Uint8Array(0);

export const LF = 0x0a;
export const CR = 0x0d;

/** One buffer holding `parts` end to end. `length` is a hint; it is computed when omitted. */
export function concat(parts: readonly Uint8Array[], length?: number): Uint8Array {
    let total = length;
    if (total === undefined) {
        total = 0;
        for (const part of parts) total += part.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * A UTF-8 decoder that refuses anything invalid. Shared: constructing one per call is the cost
 * the fast path of {@link decodeLatin1} exists to avoid.
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Below this many octets the fast path is not worth a native call. */
const NATIVE_FROM = 256;

/**
 * Bytes to a string, one character per octet.
 *
 * Two paths, both measured on GJS (SpiderMonkey):
 *
 * - **Pure ASCII — the overwhelming majority of what this decodes** (headers, MIME structure,
 *   base64 bodies) — goes through the native UTF-8 decoder at several GiB/s. A STRICT decoder
 *   whose output is as long as its input proves the input was ASCII: a multi-byte sequence yields
 *   fewer characters than bytes, an invalid one throws, and a byte-order mark is stripped (so it
 *   is shorter too). The result is then exactly the Latin-1 reading.
 * - Everything else is assembled in chunks of `String.fromCharCode.apply`. NOT the spread form
 *   `fromCharCode(...bytes)` it used to be: spreading puts every byte on the call stack one by
 *   one and ran at ~37 MiB/s, against ~400 MiB/s for `apply`. Chunked because a call with
 *   hundreds of kilobytes of arguments overflows the stack.
 */
export function decodeLatin1(bytes: Uint8Array): string {
    if (bytes.length >= NATIVE_FROM) {
        try {
            const text = STRICT_UTF8.decode(bytes);
            if (text.length === bytes.length) return text;
        } catch {
            // not UTF-8, so not ASCII either: the chunked path below
        }
    }
    const CHUNK = 0x2000;
    if (bytes.length <= CHUNK) return String.fromCharCode.apply(null, bytes as unknown as number[]);
    let text = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    return text;
}

/** The inverse of {@link decodeLatin1}: the low octet of each code unit. */
export function encodeLatin1(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

/** The line without its trailing CRLF or LF. */
export function stripEol(line: Uint8Array): Uint8Array {
    let end = line.length;
    if (end > 0 && line[end - 1] === LF) end--;
    if (end > 0 && line[end - 1] === CR) end--;
    return line.subarray(0, end);
}

/**
 * Where the header block ends and the body begins.
 *
 * The returned `header` KEEPS its final end-of-line, so the last field looks exactly like every
 * other one and the field parser needs no special case. A message with no empty line at all is
 * all header and an empty body — which is what a truncated message in an archive looks like, and
 * reporting it as a header-only message is more honest than guessing where a body would have been.
 */
export function splitMessage(raw: Uint8Array): { header: Uint8Array; body: Uint8Array } {
    // `indexOf` is a native scan; a loop over the octets in script is ~20x slower on GJS.
    for (let i = raw.indexOf(LF); i >= 0; i = raw.indexOf(LF, i + 1)) {
        if (raw[i + 1] === LF) return { header: raw.subarray(0, i + 1), body: raw.subarray(i + 2) };
        if (raw[i + 1] === CR && raw[i + 2] === LF) {
            return { header: raw.subarray(0, i + 1), body: raw.subarray(i + 3) };
        }
    }
    return { header: raw, body: EMPTY };
}
