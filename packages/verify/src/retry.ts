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

/** Join the base64 lines of one body and wrap them again at `width`. */
function rewrapBase64(body: string, width: number): string {
    const trailing = /(\r\n)*$/.exec(body)?.[0] ?? '';
    const data = body.slice(0, body.length - trailing.length).replace(/[ \t\r\n]+/g, '');
    if (data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return body;
    const lines: string[] = [];
    for (let at = 0; at < data.length; at += width) lines.push(data.slice(at, at + width));
    return lines.join('\r\n') + trailing;
}

/**
 * One MIME entity with every base64 body inside it (nested multiparts included) re-wrapped.
 * `head` is the entity's own header block, `body` its body with CRLF line ends.
 */
function rewrapEntity(head: string, body: string, width: number): string {
    const type = headerValue(head, 'content-type') ?? '';
    const boundary = /^\s*multipart\/.*?boundary\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1];
    if (boundary) {
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
                rebuilt = `\r\n${rewrapEntity('', part.slice(2), width)}`;
            } else {
                const gap = part.indexOf('\r\n\r\n');
                rebuilt =
                    gap === -1
                        ? part
                        : `${part.slice(0, gap)}\r\n\r\n${rewrapEntity(part.slice(0, gap), part.slice(gap + 4), width)}`;
            }
            out += delimiter + padding + rebuilt;
        }
        return out.slice(2);
    }
    const encoding = (headerValue(head, 'content-transfer-encoding') ?? '').trim().toLowerCase();
    return encoding === 'base64' ? rewrapBase64(body, width) : body;
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
 * lines re-wrapped at 76, 72, 64 or 60 characters. The first
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
    ];
    for (const [artefact, text] of candidates) {
        if (text === body) continue;
        if (hashOf(canonBody(text, mode), input) === input.bodyHashExpected) return artefact;
    }
    // The verifier hashes the CRLF form, so the re-wrap starts from it too.
    const wire = crlf(body);
    for (const width of BASE64_WIDTHS) {
        const text = rewrapEntity(head, wire, width);
        if (text === wire) continue;
        if (hashOf(canonBody(text, mode), input) === input.bodyHashExpected) return 'base64-rewrapped';
    }
    return undefined;
}
