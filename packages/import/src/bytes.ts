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
 * Bytes to a string, one character per octet.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte onto the call stack, and a
 * header block of a few hundred kilobytes — a long `References` chain, a big `Received` trail —
 * overflows it. The chunk size is small enough that no engine refuses the call and large enough
 * that the loop is not the bottleneck.
 */
export function decodeLatin1(bytes: Uint8Array): string {
    const CHUNK = 0x1000;
    if (bytes.length <= CHUNK) return String.fromCharCode(...bytes);
    let text = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return text;
}

/** The inverse of {@link decodeLatin1}: the low octet of each code unit. */
export function encodeLatin1(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

/** Is this line empty — just its end-of-line, or nothing at all? */
export function isBlankLine(line: Uint8Array): boolean {
    if (line.length === 0) return true;
    if (line.length === 1) return line[0] === LF;
    return line.length === 2 && line[0] === CR && line[1] === LF;
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
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== LF) continue;
        if (raw[i + 1] === LF) return { header: raw.subarray(0, i + 1), body: raw.subarray(i + 2) };
        if (raw[i + 1] === CR && raw[i + 2] === LF) {
            return { header: raw.subarray(0, i + 1), body: raw.subarray(i + 3) };
        }
    }
    return { header: raw, body: EMPTY };
}
