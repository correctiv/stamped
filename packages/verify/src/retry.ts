/**
 * Re-canonicalise a body the way a mail export may have damaged it, and see if the signed hash
 * comes back.
 *
 * An EXPLANATION, never a verdict: the caller records the result next to the evidence and the
 * verdict stays `body-altered`. A candidate counts only when its hash equals the `bh=` the signer
 * committed to, so "likely changed by the export" is never said on a guess.
 *
 * Independent of mailauth on purpose (RFC 6376 § 3.4.3 / § 3.4.4 written out below): the result
 * is a second opinion on the bytes, not a reading of the first verifier's output.
 */

import { createHash } from 'node:crypto';

import type { ExportArtefact } from '@stamped/core';

/** What the retry needs to know about one signature. */
export interface RetryInput {
    /** `c=`, e.g. `relaxed/relaxed`. The body half decides the body canonicalization. */
    readonly canonicalization: string;
    /** `a=`, e.g. `rsa-sha256`. */
    readonly algorithm: string;
    /** `bh=` as signed (base64). */
    readonly bodyHashExpected: string;
    /** `l=`, when present. */
    readonly lengthLimit?: number;
}

/** Header block and body of a raw message, as Latin-1 strings (one char per byte). */
function splitMessage(raw: Uint8Array): { head: string; body: string } {
    let text = '';
    for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i] as number);
    const match = /\r?\n\r?\n/.exec(text);
    return match
        ? { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) }
        : { head: text, body: '' };
}

/** Line widths mail software commonly wraps base64 at: RFC 2045's 76, then the usual others. */
const BASE64_WIDTHS = [76, 72, 64, 60];

function headerValue(head: string, name: string): string | undefined {
    const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
    return new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(unfolded)?.[1];
}

/**
 * Join the base64 lines of one body and wrap them again at `width`. `edge` toggles the CRLF that
 * sits between the last base64 line and the boundary: one is added when there is none, one is
 * taken away when there is.
 */
function rewrapBase64(body: string, width: number, edge = false): string {
    const trailing = /(\r\n)*$/.exec(body)?.[0] ?? '';
    const data = body.slice(0, body.length - trailing.length).replace(/[ \t\r\n]+/g, '');
    if (data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return body;
    const lines: string[] = [];
    for (let at = 0; at < data.length; at += width) lines.push(data.slice(at, at + width));
    return lines.join('\r\n') + (edge ? (trailing === '' ? '\r\n' : trailing.slice(2)) : trailing);
}

/** One quoted-printable line: uppercase hex, soft breaks (`=` CRLF) so no line passes 76 characters. */
function encodeQpLine(line: string): string {
    const tokens: string[] = [];
    for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        const blankAtEnd = (code === 32 || code === 9) && i === line.length - 1;
        const plain = code !== 0x3d && code <= 126 && (code >= 32 || code === 9) && !blankAtEnd;
        tokens.push(plain ? (line[i] as string) : `=${code.toString(16).toUpperCase().padStart(2, '0')}`);
    }
    let out = '';
    let width = 0;
    for (const [i, token] of tokens.entries()) {
        if (width + token.length > (i === tokens.length - 1 ? 76 : 75)) {
            out += '=\r\n';
            width = 0;
        }
        out += token;
        width += token.length;
    }
    return out;
}

function encodeQp(text: string): string {
    return text.split('\r\n').map(encodeQpLine).join('\r\n');
}

/** What a transform does with one non-multipart entity. `top` is true for the message's own body. */
type Leaf = (head: string, body: string, top: boolean) => { head: string; body: string };

function encodingOf(head: string): string {
    return (headerValue(head, 'content-transfer-encoding') ?? '').trim().toLowerCase();
}

function base64Leaf(width: number, edge: boolean): Leaf {
    return (head, body) => ({
        head,
        body: encodingOf(head) === 'base64' ? rewrapBase64(body, width, edge) : body,
    });
}

/**
 * Reverse an export that stored a quoted-printable text part decoded. `kept`: the part still
 * says quoted-printable. `changed`: the export wrote 8bit/7bit there, so the header goes back too
 * (the part headers are inside the body hash; the message's own header block is not).
 */
function qpLeaf(variant: 'kept' | 'changed'): Leaf {
    return (head, body, top) => {
        const type = (headerValue(head, 'content-type') ?? 'text/plain').trim().toLowerCase();
        const encoding = encodingOf(head);
        if (!type.startsWith('text/')) return { head, body };
        if (variant === 'kept') {
            return { head, body: encoding === 'quoted-printable' ? encodeQp(body) : body };
        }
        if (encoding !== '8bit' && encoding !== '7bit') return { head, body };
        if (top) return { head, body: encodeQp(body) };
        return {
            head: head.replace(/^(content-transfer-encoding:[ \t]*).*$/im, '$1quoted-printable'),
            body: encodeQp(body),
        };
    };
}

/**
 * One MIME entity with `leaf` applied to every non-multipart entity inside it (nested
 * multiparts included). `head` is the entity's own header block, `body` its body with CRLF line
 * ends. The returned head differs from `head` only for a leaf that rewrites it.
 */
function mapEntity(head: string, body: string, leaf: Leaf, top = false): { head: string; body: string } {
    const type = headerValue(head, 'content-type') ?? '';
    const boundary = /^\s*multipart\/.*?boundary\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1];
    if (!boundary) return leaf(head, body, top);
    const delimiter = `\r\n--${boundary}`;
    const pieces = `\r\n${body}`.split(delimiter);
    let out = pieces[0] as string;
    for (let i = 1; i < pieces.length; i++) {
        const piece = pieces[i] as string;
        const lineEnd = piece.indexOf('\r\n');
        if (piece.startsWith('--') || lineEnd === -1) {
            out += delimiter + piece;
            continue;
        }
        const padding = piece.slice(0, lineEnd + 2);
        const part = piece.slice(lineEnd + 2);
        let rebuilt: string;
        if (part.startsWith('\r\n')) {
            rebuilt = `\r\n${mapEntity('', part.slice(2), leaf).body}`;
        } else {
            const gap = part.indexOf('\r\n\r\n');
            if (gap === -1) {
                rebuilt = part;
            } else {
                const mapped = mapEntity(part.slice(0, gap), part.slice(gap + 4), leaf);
                rebuilt = `${mapped.head}\r\n\r\n${mapped.body}`;
            }
        }
        out += delimiter + padding + rebuilt;
    }
    return { head, body: out.slice(2) };
}

function toggleFinalCrlf(text: string): string {
    return text.endsWith('\r\n') ? text.slice(0, -2) : `${text}\r\n`;
}

function canonBody(body: string, mode: string): string {
    if (mode === 'relaxed') {
        const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
        const text = lines.join('\r\n').replace(/(\r\n)+$/, '');
        return text.length === 0 ? '' : `${text}\r\n`;
    }
    const text = body.replace(/(\r\n)+$/, '');
    return text.length === 0 ? '\r\n' : `${text}\r\n`;
}

function hashOf(canon: string, input: RetryInput): string {
    const name = input.algorithm.toLowerCase().endsWith('sha1') ? 'sha1' : 'sha256';
    let bytes = Buffer.from(canon, 'binary');
    if (input.lengthLimit !== undefined) bytes = bytes.subarray(0, input.lengthLimit);
    return createHash(name).update(bytes).digest('base64');
}

/**
 * Which export artefact, if any, explains the body-hash mismatch.
 *
 * Tries, in order: doubled leading dots undone, line endings converted to CRLF, both, base64
 * lines re-wrapped at 76, 72, 64 or 60 characters, base64 at 76 with the CRLF before the boundary
 * toggled, quoted-printable text parts re-encoded after an export stored them decoded. The first
 * candidate whose hash equals the signed one wins. `undefined` means none did.
 */
export function explainBodyByRetry(raw: Uint8Array, input: RetryInput): ExportArtefact | undefined {
    const mode = input.canonicalization.split('/')[1] ?? 'simple';
    const { head, body } = splitMessage(raw);
    const undot = (text: string) => text.replace(/(^|\n)\.\./g, '$1.');
    const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
    const candidates: [ExportArtefact, string][] = [
        ['dot-stuffing', undot(body)],
        ['line-endings', crlf(body)],
        ['dot-stuffing-and-line-endings', crlf(undot(body))],
        // The last line's CRLF is the first thing an export adds or drops.
        ['line-endings', toggleFinalCrlf(crlf(body))],
    ];
    for (const [artefact, text] of candidates) {
        if (text === body) continue;
        if (hashOf(canonBody(text, mode), input) === input.bodyHashExpected) return artefact;
    }
    // The verifier hashes the CRLF form, so the reversals start from it too.
    const wire = crlf(body);
    const reversals: [ExportArtefact, Leaf][] = [
        ...BASE64_WIDTHS.map((width): [ExportArtefact, Leaf] => [
            'base64-rewrapped',
            base64Leaf(width, false),
        ]),
        ['base64-trailing-newline', base64Leaf(76, true)],
        ['quoted-printable-decoded', qpLeaf('kept')],
        ['quoted-printable-decoded', qpLeaf('changed')],
    ];
    for (const [artefact, leaf] of reversals) {
        const text = mapEntity(head, wire, leaf, true).body;
        if (text === wire) continue;
        if (hashOf(canonBody(text, mode), input) === input.bodyHashExpected) return artefact;
    }
    return undefined;
}
