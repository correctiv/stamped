/**
 * A message as a person reads it: the text, and the list of what is attached.
 *
 * NOT {@link messageText}. That one feeds the index and wants every `text/*` part concatenated;
 * this one feeds the reader pane and has to answer what a mail program answers — which text is
 * THE body, and what else came with it. Neither can affect a verdict: the raw octets are what is
 * stored and verified, and this only decodes them for display.
 *
 * HTML is never rendered. It is turned into text by {@link stripHtml}, so there is no image to
 * fetch and no tracking pixel to load: opening a message here tells nobody anything. `fromHtml`
 * says that the text is a reduction, so the pane can say so instead of passing it off as the
 * sender's own words.
 */

import { decodeLatin1, splitMessage } from './bytes.ts';
import { decodeCharset, decodeEncodedWords } from './codec.ts';
import { type HeaderField, headerValue, parseHeaderFields } from './headers.ts';
import { contentType, decodeBody, parameter, splitParts, stripHtml, transferEncoding } from './mime.ts';

/** How many characters of body the reader keeps: a megabyte of prose is far more than is read. */
const MAX_CHARS = 1_048_576;

/** How deep a `multipart` / `message/rfc822` nest may go before the walk stops. */
const MAX_DEPTH = 12;

/** One attached file: what it says it is called, its type, and its decoded size. */
export interface Attachment {
    /** As the sender named it, encoded words decoded; empty when the part carried no name. */
    readonly name: string;
    readonly type: string;
    /** The size of the decoded content in bytes. */
    readonly bytes: number;
}

/** What {@link readableBody} found. */
export interface ReadableBody {
    /** The body as text, LF line endings. */
    readonly text: string;
    /** True when the text is a reduction of an HTML part, so the pane can say so. */
    readonly fromHtml: boolean;
    readonly attachments: Attachment[];
    /** True when the text was cut at the cap. */
    readonly truncated: boolean;
}

interface Walked {
    readonly pieces: string[];
    readonly attachments: Attachment[];
    /** Some piece is `text/plain` (or an unstructured body). */
    plain: boolean;
    /** Some piece was reduced from HTML. */
    html: boolean;
}

function empty(): Walked {
    return { pieces: [], attachments: [], plain: false, html: false };
}

function merge(into: Walked, from: Walked): void {
    into.pieces.push(...from.pieces);
    into.attachments.push(...from.attachments);
    into.plain ||= from.plain;
    into.html ||= from.html;
}

/** The readable text and the attachments of one raw message. */
export function readableBody(raw: Uint8Array): ReadableBody {
    const { header, body } = splitMessage(raw);
    const walked = walk(body, parseHeaderFields(header), 0);
    const text = walked.pieces
        .map((piece) => piece.replace(/\r\n?/g, '\n').replace(/\s+$/, ''))
        .filter((piece) => piece.trim() !== '')
        .join('\n\n')
        .replace(/^\n+/, '');
    const truncated = text.length > MAX_CHARS;
    return {
        text: truncated ? text.slice(0, MAX_CHARS) : text,
        fromHtml: walked.html,
        attachments: walked.attachments,
        truncated,
    };
}

function walk(body: Uint8Array, fields: HeaderField[], depth: number): Walked {
    const out = empty();
    if (depth > MAX_DEPTH) return out;

    const type = contentType(fields);
    const encoding = transferEncoding(fields);
    const disposition = dispositionOf(fields);

    if (type.type.startsWith('multipart/')) {
        if (!type.boundary) {
            out.pieces.push(decodeCharset(body, type.charset));
            out.plain = true;
            return out;
        }
        const branches = splitParts(body, type.boundary).map((part) => {
            const split = splitMessage(part);
            return walk(split.body, parseHeaderFields(split.header), depth + 1);
        });
        if (type.type === 'multipart/alternative') {
            // The branch with real text wins over one reduced from HTML; among equals the last,
            // which is what RFC 2046 § 5.1.4 calls the richest and a client would show.
            const withText = branches.filter((branch) => branch.pieces.some((p) => p.trim() !== ''));
            const chosen =
                [...withText].reverse().find((branch) => branch.plain) ??
                withText[withText.length - 1] ??
                branches[0];
            if (chosen) merge(out, chosen);
            return out;
        }
        for (const branch of branches) merge(out, branch);
        return out;
    }

    if (disposition === 'attachment' || !isBody(type.type)) {
        if (type.type === 'message/rfc822' && disposition !== 'attachment') {
            return embedded(body, encoding, depth);
        }
        out.attachments.push({
            name: attachmentName(fields),
            type: type.type,
            bytes: decodeBody(body, encoding).length,
        });
        return out;
    }

    const text = decodeCharset(decodeBody(body, encoding), type.charset);
    if (type.type === 'text/html') {
        out.pieces.push(stripHtml(text));
        out.html = true;
    } else {
        out.pieces.push(text);
        out.plain = true;
    }
    return out;
}

/** An embedded message: its headline lines as written, then whatever its own body reads as. */
function embedded(body: Uint8Array, encoding: string, depth: number): Walked {
    const { header, body: inner } = splitMessage(decodeBody(body, encoding));
    const fields = parseHeaderFields(header);
    const lines: string[] = [];
    for (const name of ['From', 'To', 'Date', 'Subject']) {
        const value = headerValue(fields, name);
        if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    const out = walk(inner, fields, depth + 1);
    out.pieces.unshift(lines.join('\n'));
    return out;
}

function isBody(type: string): boolean {
    return type === 'text/plain' || type === 'text/html';
}

function rawField(fields: readonly HeaderField[], lower: string): string {
    return fields.find((field) => field.lower === lower)?.value ?? '';
}

function dispositionOf(fields: readonly HeaderField[]): string {
    return (rawField(fields, 'content-disposition').split(';')[0] ?? '').trim().toLowerCase();
}

/** `filename` of the disposition, else `name` of the type; RFC 2231 `filename*=` read simply. */
function attachmentName(fields: readonly HeaderField[]): string {
    const disposition = rawField(fields, 'content-disposition');
    const type = rawField(fields, 'content-type');
    const extended = /;\s*(?:file)?name\*\s*=\s*([^;\s]+)/i.exec(`${disposition};${type}`)?.[1];
    const plain = parameter(disposition, 'filename') ?? parameter(type, 'name');
    if (plain !== undefined && plain !== '') return decodeEncodedWords(plain);
    if (extended !== undefined) {
        const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
        const charset = match?.[1] || 'utf-8';
        const encoded = match?.[2] ?? extended;
        try {
            const bytes = Uint8Array.from(
                decodeLatin1(new TextEncoder().encode(encoded)).replace(
                    /%([0-9a-f]{2})|(.)/gi,
                    (_all, hex: string | undefined, char: string | undefined) =>
                        hex ? String.fromCharCode(parseInt(hex, 16)) : (char ?? ''),
                ),
                (char) => char.charCodeAt(0),
            );
            return decodeCharset(bytes, charset);
        } catch {
            return encoded;
        }
    }
    return '';
}
