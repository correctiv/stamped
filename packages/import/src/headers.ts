/**
 * The header block as fields, and the handful of them the index stores.
 *
 * Unfolding, not parsing: this module turns the bytes into `name` / `value` pairs and decodes
 * encoded words. It does NOT parse an address list into mailboxes, because the index searches
 * what the message says — `"Büro Berlin" <presse@example.com>` is findable by the name, by the
 * address, and by the domain, and a parser that kept only the address would lose two of the three.
 *
 * Nothing here feeds a verdict. `@stamped/verify` reads the raw octets; this is the searchable
 * surface beside them.
 */

import { CR, decodeLatin1, LF } from './bytes.ts';
import { decodeEncodedWords } from './codec.ts';

/** One header field, unfolded. */
export interface HeaderField {
    /** The field name as written, e.g. `Message-ID`. */
    readonly name: string;
    /** The same name lowercased — field names are case-insensitive (RFC 5322 § 1.2.2). */
    readonly lower: string;
    /** The value, unfolded and trimmed, still in its on-the-wire encoding. */
    readonly value: string;
}

/**
 * Split a header block into fields.
 *
 * A line that is neither a field nor a continuation (a surviving mbox separator, a damaged line)
 * ends the current field and is dropped. Appending it to the previous field instead would put
 * text into, say, a `Subject` that the sender never wrote.
 */
export function parseHeaderFields(header: Uint8Array): HeaderField[] {
    const fields: HeaderField[] = [];
    let name = '';
    let parts: string[] = [];

    const flush = (): void => {
        if (name !== '') fields.push({ name, lower: name.toLowerCase(), value: parts.join('').trim() });
        name = '';
        parts = [];
    };

    for (const line of headerLines(header)) {
        const text = decodeLatin1(line);
        if (text.length === 0) continue;
        if (text[0] === ' ' || text[0] === '\t') {
            // RFC 5322 § 2.2.3: unfolding removes the CRLF and KEEPS the whitespace, which is
            // what holds two words apart when a long value was folded between them.
            if (name !== '') parts.push(text);
            continue;
        }
        const colon = text.indexOf(':');
        flush();
        if (colon <= 0) continue;
        name = text.slice(0, colon);
        parts.push(text.slice(colon + 1));
    }
    flush();
    return fields;
}

/** Lines of the header block, each without its end-of-line. */
function* headerLines(block: Uint8Array): Generator<Uint8Array> {
    let from = 0;
    for (let i = 0; i < block.length; i++) {
        if (block[i] !== LF) continue;
        let end = i;
        if (end > from && block[end - 1] === CR) end--;
        yield block.subarray(from, end);
        from = i + 1;
    }
    if (from < block.length) yield block.subarray(from);
}

/** The first field with this name, decoded. The first, because that is the one a reader sees. */
export function headerValue(fields: readonly HeaderField[], name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const field of fields) {
        if (field.lower === lower) return decodeEncodedWords(field.value);
    }
    return undefined;
}

/** Every field with this name, decoded, in the order they appear. */
export function headerValues(fields: readonly HeaderField[], name: string): string[] {
    const lower = name.toLowerCase();
    const found: string[] = [];
    for (const field of fields) {
        if (field.lower === lower) found.push(decodeEncodedWords(field.value));
    }
    return found;
}

/**
 * The same field's occurrences joined, for the fields a message may legitimately repeat.
 *
 * `Received` is the obvious one; a mailing list that adds a second `To` is the one that matters
 * here, because searching for a recipient must find the message whichever hop added them.
 */
export function joinedHeader(fields: readonly HeaderField[], name: string): string {
    return headerValues(fields, name).join(', ');
}

/**
 * The domain of the first address in a `From`-shaped value, lowercased.
 *
 * Deliberately crude — the last `@` of the first angle-addressed or bare address. A full RFC 5322
 * address parser belongs where a VERDICT depends on it, and there it already exists: mailauth
 * determines the author domain for the alignment rules. This one only groups the report.
 */
export function addressDomain(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const angled = /<([^>]*)>/.exec(value);
    const address = (angled?.[1] ?? value.split(',')[0] ?? '').trim();
    const at = address.lastIndexOf('@');
    if (at < 0) return undefined;
    const domain = address
        .slice(at + 1)
        .trim()
        .replace(/[>;,\s].*$/, '')
        .toLowerCase();
    return domain.length > 0 ? domain : undefined;
}
