/**
 * The reader's body: which text is THE body, what is attached, and the sheet header above it.
 *
 * Every message is a synthetic literal on `example.*` domains. Nothing here reads a verdict: the
 * decoding is for display, the raw octets stay what is stored and verified.
 */

import { describe, expect, it } from '@gjsify/unit';
import { encodeLatin1, readableBody } from '@stamped/import';
import type { IndexedMessage } from '@stamped/store';

import { mailHead } from '../../src/gui/view/message.ts';

function mail(lines: string[]): Uint8Array {
    return encodeLatin1(lines.join('\r\n'));
}

function indexed(overrides: Partial<IndexedMessage> = {}): IndexedMessage {
    return {
        hash: 'b'.repeat(64),
        bytes: 4096,
        from: '"Lovelace, Ada" <Ada@Example.com>',
        to: 'Grace Hopper <grace@example.net>',
        cc: '',
        subject: 'Harbour <contract> & more',
        date: 'Tue, 05 Mar 2024 09:40:00 +0000',
        sentAt: Date.UTC(2024, 2, 5, 9, 40),
        verdict: 'confirmed',
        caveats: [],
        ...overrides,
    };
}

export default async () => {
    await describe('readableBody', async () => {
        await it('reads a plain message as it is, with LF line endings', async () => {
            const body = readableBody(mail(['Subject: Hi', '', 'line one', 'line two', '']));
            expect(body.text).toBe('line one\nline two');
            expect(body.fromHtml).toBe(false);
            expect(body.truncated).toBe(false);
            expect(body.attachments).toStrictEqual([]);
        });

        await it('prefers text/plain in multipart/alternative', async () => {
            const body = readableBody(
                mail([
                    'Content-Type: multipart/alternative; boundary="b1"',
                    '',
                    '--b1',
                    'Content-Type: text/plain; charset=utf-8',
                    '',
                    'plain words',
                    '--b1',
                    'Content-Type: text/html; charset=utf-8',
                    '',
                    '<p>html <b>words</b></p>',
                    '--b1--',
                    '',
                ]),
            );
            expect(body.text).toBe('plain words');
            expect(body.fromHtml).toBe(false);
        });

        await it('reduces an HTML-only message to text and says so', async () => {
            const body = readableBody(
                mail([
                    'Content-Type: text/html; charset=utf-8',
                    '',
                    '<style>p{color:red}</style><p>Hello &amp; welcome</p><img src="http://tracker.example/p.gif">',
                ]),
            );
            expect(body.text).toBe('Hello & welcome');
            expect(body.fromHtml).toBe(true);
        });

        await it('lists attachments with name and decoded size, and keeps them out of the text', async () => {
            const body = readableBody(
                mail([
                    'Content-Type: multipart/mixed; boundary="m1"',
                    '',
                    '--m1',
                    'Content-Type: text/plain',
                    '',
                    'see attached',
                    '--m1',
                    'Content-Type: application/pdf; name="=?utf-8?Q?Gr=C3=BC=C3=9Fe.pdf?="',
                    'Content-Disposition: attachment; filename="=?utf-8?Q?Gr=C3=BC=C3=9Fe.pdf?="',
                    'Content-Transfer-Encoding: base64',
                    '',
                    'SGVsbG8gV29ybGQ=',
                    '--m1',
                    'Content-Type: text/plain',
                    'Content-Disposition: attachment; filename="notes.txt"',
                    '',
                    'not the body',
                    '--m1--',
                    '',
                ]),
            );
            expect(body.text).toBe('see attached');
            expect(body.attachments).toStrictEqual([
                { name: 'Grüße.pdf', type: 'application/pdf', bytes: 11 },
                { name: 'notes.txt', type: 'text/plain', bytes: 12 },
            ]);
        });

        await it('shows an embedded message headline as written, then its body', async () => {
            const body = readableBody(
                mail([
                    'Content-Type: multipart/mixed; boundary="m1"',
                    '',
                    '--m1',
                    'Content-Type: text/plain',
                    '',
                    'forwarded below',
                    '--m1',
                    'Content-Type: message/rfc822',
                    '',
                    'From: Bob <bob@example.org>',
                    'To: ada@example.com',
                    'Date: Mon, 04 Mar 2024 08:00:00 +0000',
                    'Subject: Original',
                    'X-Other: dropped',
                    '',
                    'inner body',
                    '--m1--',
                    '',
                ]),
            );
            expect(body.text).toBe(
                'forwarded below\n\nFrom: Bob <bob@example.org>\nTo: ada@example.com\nDate: Mon, 04 Mar 2024 08:00:00 +0000\nSubject: Original\n\ninner body',
            );
            expect(body.attachments).toStrictEqual([]);
        });

        await it('decodes charset, quoted-printable and base64', async () => {
            const qp = readableBody(
                mail([
                    'Content-Type: text/plain; charset=iso-8859-1',
                    'Content-Transfer-Encoding: quoted-printable',
                    '',
                    'Gr=FC=DFe =',
                    'zusammen',
                ]),
            );
            expect(qp.text).toBe('Grüße zusammen');
            const b64 = readableBody(
                mail([
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: base64',
                    '',
                    // "Grüße" in UTF-8
                    'R3LDvMOfZQ==',
                ]),
            );
            expect(b64.text).toBe('Grüße');
        });

        await it('cuts a huge body at the cap and says so', async () => {
            const body = readableBody(mail(['Subject: big', '', 'a'.repeat(1_100_000)]));
            expect(body.truncated).toBe(true);
            expect(body.text.length).toBe(1_048_576);
        });
    });

    await describe('mailHead', async () => {
        await it('splits the sender, escapes everything and formats the date for the locale', async () => {
            const head = mailHead(indexed({ cc: 'x@example.org' }), { locale: 'en-GB', timeZone: 'UTC' });
            expect(head).toStrictEqual({
                subject: 'Harbour &lt;contract&gt; &amp; more',
                fromName: 'Lovelace, Ada',
                fromAddress: 'ada@example.com',
                to: 'Grace Hopper &lt;grace@example.net&gt;',
                cc: 'x@example.org',
                date: head.date,
            });
            expect(head.date.includes('2024')).toBe(true);
            expect(head.date.includes('09:40')).toBe(true);
        });

        await it('falls back to the raw date and a placeholder subject', async () => {
            const head = mailHead(indexed({ sentAt: undefined, subject: '' }));
            expect(head.date).toBe('Tue, 05 Mar 2024 09:40:00 +0000');
            expect(head.subject).toBe('(no subject)');
        });
    });
};
