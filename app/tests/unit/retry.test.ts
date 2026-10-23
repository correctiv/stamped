/**
 * The export retry's candidates, on synthetic bodies. Each one is signed as it was ORIGINALLY
 * (the hash is computed here, independently of retry.ts), damaged the way an export does, and
 * must come back only when the reversal reproduces that hash.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from '@gjsify/unit';
import { explainBodyByRetry } from '@stamped/verify';

const HEAD = 'Subject: synthetic\r\nContent-Type: multipart/mixed; boundary="B"';

/** The `bh=` of a body under simple canonicalization, written out once more here. */
function signedHash(body: string): string {
    const canon = `${body.replace(/(\r\n)*$/, '')}\r\n`;
    return createHash('sha256').update(Buffer.from(canon, 'binary')).digest('base64');
}

function retry(original: string, exported: Uint8Array, canonicalization = 'simple/simple') {
    const raw = Buffer.concat([Buffer.from(`${HEAD}\r\n\r\n`), exported]);
    return explainBodyByRetry(raw, {
        canonicalization,
        algorithm: 'rsa-sha256',
        bodyHashExpected: signedHash(original),
    });
}

const PART = (encoding: string, text: string) =>
    `--B\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${text}\r\n--B--\r\n`;

const LONG = 'x'.repeat(100);
const QP = `Gr=C3=BC=C3=9Fe aus M=C3=BCnchen\r\n${'x'.repeat(75)}=\r\n${'x'.repeat(25)}\r\ntrailing=20`;
const DECODED = `Grüße aus München\r\n${LONG}\r\ntrailing `;

const B64 = Buffer.from('synthetic attachment '.repeat(30)).toString('base64');
const wrap = (text: string, width: number) =>
    text.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? '';
const FILE = (data: string) =>
    `--B\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}\r\n--B--\r\n`;

export default async () => {
    await describe('retry candidates', async () => {
        await it('bare LF over the whole body, final newline missing', async () => {
            const original = PART('7bit', 'one\r\ntwo');
            const exported = Buffer.from(PART('7bit', 'one\ntwo').replace(/\r\n/g, '\n').replace(/\n$/, ''));
            expect(retry(original, exported)).toBe('line-endings');
        });

        await it('quoted-printable stored as 8bit, header kept', async () => {
            const original = PART('quoted-printable', QP);
            const exported = Buffer.from(PART('quoted-printable', DECODED));
            expect(retry(original, exported)).toBe('quoted-printable-decoded');
        });

        await it('quoted-printable stored as 8bit, header changed too', async () => {
            const original = PART('quoted-printable', QP);
            const exported = Buffer.from(PART('8bit', DECODED));
            expect(retry(original, exported)).toBe('quoted-printable-decoded');
        });

        await it('base64 at 76 with a blank line before the boundary', async () => {
            const original = FILE(`${wrap(B64, 76)}\r\n`);
            expect(retry(original, Buffer.from(FILE(wrap(B64, 76))))).toBe('base64-trailing-newline');
        });

        await it('base64 at 76 where the export added the blank line', async () => {
            const original = FILE(wrap(B64, 76));
            expect(retry(original, Buffer.from(FILE(`${wrap(B64, 76)}\r\n`)))).toBe(
                'base64-trailing-newline',
            );
        });
    });

    await describe('retry negatives', async () => {
        await it('a changed word in a quoted-printable part is not explained', async () => {
            const original = PART('quoted-printable', QP);
            const exported = Buffer.from(PART('8bit', DECODED.replace('aus', 'ohne')));
            expect(retry(original, exported)).toBe(undefined);
        });

        await it('a changed base64 payload is not explained', async () => {
            const original = FILE(`${wrap(B64, 76)}\r\n`);
            const tampered = `A${B64.slice(1)}`;
            expect(retry(original, Buffer.from(FILE(wrap(tampered, 76))))).toBe(undefined);
        });

        await it('an unrelated body is not explained', async () => {
            const original = PART('quoted-printable', QP);
            expect(retry(original, Buffer.from(PART('8bit', 'something else entirely')))).toBe(undefined);
        });
    });
};
