/**
 * Walking a message's MIME structure far enough to get its readable text.
 *
 * WHAT "FAR ENOUGH" MEANS. The index needs one string per message: the words a journalist would
 * type. So this walks the part tree, decodes the parts that are text, and concatenates them. It
 * does NOT reassemble attachments, follow `message/external-body`, or keep a part tree — stage 2
 * will want those, and a structure invented before its consumer exists is a structure that fits
 * nothing.
 *
 * `text/html` is included, tags stripped. Dropping it would lose every message whose sender wrote
 * HTML only, which in a corporate archive is most of them; keeping the tags would fill the index
 * with `div` and `span` and let a search for `style` match half the archive.
 *
 * Nothing here can affect a verdict: the raw octets are stored and verified separately. A message
 * whose structure is too broken to walk still gets indexed — by its headers, and by whatever text
 * the fallback finds.
 */

import { decodeLatin1, EMPTY, splitMessage } from './bytes.ts';
import { decodeBase64, decodeCharset, decodeQuotedPrintable } from './codec.ts';
import { headerValue, parseHeaderFields } from './headers.ts';

/** How deep a `multipart` nest may go before the walk stops. */
const MAX_DEPTH = 12;

/** How many characters of body text one message contributes to the index. */
const MAX_TEXT = 1_000_000;

/**
 * The readable text of one message: every `text/*` part, decoded and joined.
 *
 * The cap is a real limit, not a round number: FTS5 indexes every token, and a single message
 * carrying a megabyte of base64 that claimed to be text would cost more index than the rest of
 * the archive. A message truncated here is still found by anything in its first megabyte, which
 * is everything anyone writes.
 */
export function messageText(raw: Uint8Array): string {
    const { header, body } = splitMessage(raw);
    const fields = parseHeaderFields(header);
    const pieces: string[] = [];
    collectText(body, contentType(fields), transferEncoding(fields), 0, pieces);
    const text = pieces.join('\n').trim();
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/** `Content-Type`, with its parameters, lowercased type and all. */
interface ContentType {
    readonly type: string;
    readonly boundary?: string;
    readonly charset?: string;
}

function contentType(fields: ReturnType<typeof parseHeaderFields>): ContentType {
    // The RAW value, not the encoded-word-decoded one: a boundary is never an encoded word, and
    // decoding first could alter the delimiter the body is actually split on.
    const raw = fields.find((field) => field.lower === 'content-type')?.value ?? '';
    const type = (raw.split(';')[0] ?? '').trim().toLowerCase() || 'text/plain';
    return { type, boundary: parameter(raw, 'boundary'), charset: parameter(raw, 'charset') };
}

/**
 * One `; name=value` parameter, quoted or bare.
 *
 * RFC 2231 continuations (`name*0=`, `name*=utf-8''…`) are not reassembled. For `boundary` they
 * are vanishingly rare and for `charset` the fallback is Latin-1, which still yields text.
 */
function parameter(value: string, name: string): string | undefined {
    const match = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value);
    const found = match?.[2] ?? match?.[1];
    return found === undefined ? undefined : found.trim();
}

function transferEncoding(fields: ReturnType<typeof parseHeaderFields>): string {
    return (headerValue(fields, 'content-transfer-encoding') ?? '').trim().toLowerCase();
}

/** Walk one part, appending whatever text it contributes. */
function collectText(
    body: Uint8Array,
    type: ContentType,
    encoding: string,
    depth: number,
    out: string[],
): void {
    if (depth > MAX_DEPTH) return;

    if (type.type.startsWith('multipart/')) {
        if (!type.boundary) {
            // A multipart without a boundary cannot be split. Reading it as one flat text part is
            // what keeps the message searchable — the delimiters become a few junk tokens, and
            // the actual prose is indexed.
            out.push(decodeCharset(body, type.charset));
            return;
        }
        for (const part of splitParts(body, type.boundary)) {
            const { header, body: inner } = splitMessage(part);
            const fields = parseHeaderFields(header);
            collectText(inner, contentType(fields), transferEncoding(fields), depth + 1, out);
        }
        return;
    }

    // An embedded message: its own headers are worth indexing too — a forwarded mail's subject
    // is exactly what someone searches for.
    if (type.type === 'message/rfc822') {
        const { header, body: inner } = splitMessage(decodeBody(body, encoding));
        const fields = parseHeaderFields(header);
        for (const field of fields) out.push(`${field.name}: ${field.value}`);
        collectText(inner, contentType(fields), transferEncoding(fields), depth + 1, out);
        return;
    }

    if (!type.type.startsWith('text/')) return;

    const text = decodeCharset(decodeBody(body, encoding), type.charset);
    out.push(type.type === 'text/html' ? stripHtml(text) : text);
}

/** Undo the content-transfer-encoding. Anything unrecognised is already bytes. */
function decodeBody(body: Uint8Array, encoding: string): Uint8Array {
    if (encoding === 'base64') return decodeBase64(decodeLatin1(body));
    if (encoding === 'quoted-printable') return decodeQuotedPrintable(decodeLatin1(body));
    return body;
}

/**
 * The parts between `--boundary` lines.
 *
 * The preamble (before the first delimiter) and the epilogue (after `--boundary--`) are dropped:
 * both are text for clients that cannot read MIME, and "This is a multi-part message in MIME
 * format." in every message would be a token in every message.
 */
function splitParts(body: Uint8Array, boundary: string): Uint8Array[] {
    const text = decodeLatin1(body);
    const delimiter = `--${boundary}`;
    const parts: Uint8Array[] = [];
    let at = text.indexOf(delimiter);
    if (at < 0) return [body];

    while (at >= 0) {
        const afterDelimiter = at + delimiter.length;
        if (text.startsWith('--', afterDelimiter)) break;
        const from = skipEol(text, afterDelimiter);
        const next = text.indexOf(delimiter, from);
        const to = next < 0 ? text.length : trimEol(text, next);
        if (to > from) parts.push(body.subarray(from, to));
        if (next < 0) break;
        at = next;
    }
    return parts.length > 0 ? parts : [EMPTY];
}

/** Past the end-of-line that follows a delimiter, ignoring the transport padding before it. */
function skipEol(text: string, at: number): number {
    let i = at;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    return i;
}

/**
 * Back over the CRLF that belongs to the NEXT delimiter.
 *
 * RFC 2046 § 5.1.1: the line break before a boundary is part of the delimiter, not of the part.
 * Keeping it would add a blank line to every part — invisible in the index, and wrong in the one
 * place it could matter later, when stage 2 extracts a part byte-exactly.
 */
function trimEol(text: string, at: number): number {
    let end = at;
    if (end > 0 && text[end - 1] === '\n') end--;
    if (end > 0 && text[end - 1] === '\r') end--;
    return end;
}

/**
 * HTML to something searchable.
 *
 * Not a parser and not sanitisation — nothing is rendered, so there is nothing to sanitise. Tags
 * go, `script` and `style` CONTENTS go with them (CSS selectors and JavaScript identifiers are
 * tokens nobody searches for and they drown the prose), and the five entities that actually occur
 * in text come back. An unknown entity is left as written, because `&foo;` in a search index is
 * harmless and guessing at it is not.
 */
export function stripHtml(html: string): string {
    return html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|h[1-6]|li)\s*>/gi, '\n')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
