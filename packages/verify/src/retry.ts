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

/** The body of a raw message, as a Latin-1 string (one char per byte), or undefined if none. */
function bodyOf(raw: Uint8Array): string {
    let text = '';
    for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i] as number);
    const match = /\r?\n\r?\n/.exec(text);
    return match ? text.slice(match.index + match[0].length) : '';
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
 * Tries, in order: doubled leading dots undone, line endings converted to CRLF, both. The first
 * candidate whose hash equals the signed one wins. `undefined` means none did.
 */
export function explainBodyByRetry(raw: Uint8Array, input: RetryInput): ExportArtefact | undefined {
    const mode = input.canonicalization.split('/')[1] ?? 'simple';
    const body = bodyOf(raw);
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
    return undefined;
}
