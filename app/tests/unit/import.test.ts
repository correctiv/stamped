/**
 * The pure half of `@stamped/import`: the mbox rules and the decoders.
 *
 * Every case here is a literal, not a file. That is the whole reason the parsing was split away
 * from `source.ts` — an mbox quirk is a statement about a byte sequence, and a test that has to
 * write a temporary file to express one ends up testing the filesystem instead of the rule.
 *
 * The cases that matter most are the ones where being wrong is SILENT: a body line starting
 * `From ` that gets cut into two messages, and a `>From ` left unquoted so the stored bytes are
 * not the bytes the sender signed. The second produces `body-altered` — Stamped's strongest
 * accusation — out of Stamped's own reader, which is the failure this suite exists for.
 */

import { describe, expect, it } from '@gjsify/unit';
import {
    addressDomain,
    decodeBase64,
    decodeEncodedWords,
    decodeQuotedPrintable,
    encodeLatin1,
    headerValue,
    joinedHeader,
    type MboxFlavour,
    MboxSplitter,
    messageText,
    parseHeaderFields,
    type RawMessage,
    splitMessage,
    stripHtml,
    summarise,
    unquote,
} from '@stamped/import';

/**
 * Run `text` through the splitter and collect the messages, as text again.
 *
 * `chunk` feeds the bytes in slices of that size, which is how the one bug a whole-buffer test
 * cannot see gets caught: a separator or an end-of-line that falls across two reads. `chunk = 1`
 * puts every single byte on its own boundary.
 */
function split(text: string, options: { flavour?: MboxFlavour; chunk?: number } = {}): RawMessage[] {
    const bytes = encodeLatin1(text);
    const found: RawMessage[] = [];
    const splitter = new MboxSplitter((message) => found.push(message), options.flavour);
    const chunk = options.chunk ?? 0;
    if (chunk <= 0) splitter.feed(bytes);
    else for (let at = 0; at < bytes.length; at += chunk) splitter.feed(bytes.subarray(at, at + chunk));
    splitter.end();
    return found;
}

/** The message bodies as text, for comparing against a literal. */
function texts(messages: readonly RawMessage[]): string[] {
    return messages.map((message) => String.fromCharCode(...message.raw));
}

const SEPARATOR = 'From ada@example.com Tue Mar  5 09:41:00 2024\n';
const SECOND = 'From grace@example.net Wed Mar  6 11:02:13 2024\n';

export default async () => {
    await describe('mbox splitting', async () => {
        await it('reads two messages and reports where each began', async () => {
            const text = `${SEPARATOR}Subject: One\n\nbody one\n\n${SECOND}Subject: Two\n\nbody two\n\n`;
            const messages = split(text);
            expect(messages.length).toBe(2);
            expect(texts(messages)).toStrictEqual([
                'Subject: One\n\nbody one\n',
                'Subject: Two\n\nbody two\n',
            ]);
            expect(messages[0]?.offset).toBe(0);
            // The offset names the separator LINE, so an auditor can seek there in the original
            // archive and see the message start. Anything else makes the import log unusable as
            // provenance.
            expect(messages[1]?.offset).toBe(text.indexOf(SECOND));
        });

        await it('gives the same messages however the bytes are chunked', async () => {
            const text = `${SEPARATOR}Subject: One\n\nbody one\n\n${SECOND}Subject: Two\n\nbody two\n\n`;
            const whole = texts(split(text));
            for (const chunk of [1, 2, 7, 13, 64]) {
                expect(texts(split(text, { chunk }))).toStrictEqual(whole);
            }
        });

        await it('does not split on a body line that merely starts "From "', async () => {
            // No ctime date after the address, so it is prose and not a separator. A reader that
            // split here would report a second, headerless message that nobody ever sent.
            const text = `${SEPARATOR}Subject: Desk note\n\nFrom the desk of the harbourmaster:\n\napproved.\n\n`;
            const messages = split(text);
            expect(messages.length).toBe(1);
            expect(texts(messages)[0]).toBe(
                'Subject: Desk note\n\nFrom the desk of the harbourmaster:\n\napproved.\n',
            );
        });

        await it('does not split on a separator that follows a non-blank line', async () => {
            const text = `${SEPARATOR}Subject: One\n\nquoting a header line:\n${SECOND}done.\n\n`;
            expect(split(text).length).toBe(1);
        });

        await it('drops exactly one trailing blank line and keeps the rest', async () => {
            // In mbox the last blank line belongs to the separator, not to the message. Every
            // further one was in the body, and the raw store is byte-exact — so the question has
            // to be answered rather than left to whichever branch ran.
            expect(texts(split(`${SEPARATOR}Subject: One\n\nbody\n\n`))[0]).toBe('Subject: One\n\nbody\n');
            expect(texts(split(`${SEPARATOR}Subject: One\n\nbody\n\n\n`))[0]).toBe(
                'Subject: One\n\nbody\n\n',
            );
        });

        await it('ignores whatever precedes the first separator', async () => {
            expect(split(`a stray note\n\n${SEPARATOR}Subject: One\n\nbody\n`).length).toBe(1);
        });

        await it('emits the last message without a trailing newline', async () => {
            expect(texts(split(`${SEPARATOR}Subject: One\n\nbody`))[0]).toBe('Subject: One\n\nbody');
        });
    });

    await describe('mbox "From " quoting', async () => {
        const quote = (line: string, flavour: MboxFlavour): string =>
            String.fromCharCode(...unquote(encodeLatin1(line), flavour));

        await it('undoes mboxrd quoting at every depth', async () => {
            expect(quote('>From here\n', 'mboxrd')).toBe('From here\n');
            expect(quote('>>From here\n', 'mboxrd')).toBe('>From here\n');
            expect(quote('>>>From here\n', 'mboxrd')).toBe('>>From here\n');
        });

        await it('undoes only the single level mboxo escapes', async () => {
            expect(quote('>From here\n', 'mboxo')).toBe('From here\n');
            // mboxo never wrote this, so removing a `>` would delete a character the sender sent.
            expect(quote('>>From here\n', 'mboxo')).toBe('>>From here\n');
        });

        await it('leaves a line that is not a quoted separator alone', async () => {
            expect(quote('> From here\n', 'mboxrd')).toBe('> From here\n');
            expect(quote('>Fromage\n', 'mboxrd')).toBe('>Fromage\n');
            expect(quote('ordinary\n', 'mboxrd')).toBe('ordinary\n');
        });

        await it('restores the body an mboxrd writer escaped', async () => {
            // The round trip that matters: what a writer put in comes back out byte for byte,
            // because anything else changes the bytes a DKIM body hash is taken over.
            const body = 'From the harbourmaster\n>From a previous mail\n>> the tender closes\n';
            const escaped = 'From the harbourmaster\n>>From a previous mail\n>> the tender closes\n';
            // Note the escaped form starts `From ` at a point the splitter must NOT believe — the
            // generator relies on the same strict rule.
            const text = `${SEPARATOR}Subject: Quoting\n\n>${escaped}\n`;
            expect(texts(split(text))[0]).toBe(`Subject: Quoting\n\n${body}`);
        });
    });

    await describe('decoders', async () => {
        await it('reads base64 across line breaks and padding', async () => {
            expect(String.fromCharCode(...decodeBase64('aGFyYm91cg=='))).toBe('harbour');
            expect(String.fromCharCode(...decodeBase64('aGFy\r\nYm91cg=='))).toBe('harbour');
        });

        await it('returns the complete bytes of a truncated base64 block', async () => {
            // Lenient on purpose: a message whose attachment cannot be fully decoded must still
            // be findable by the text that did decode.
            expect(String.fromCharCode(...decodeBase64('aGFyYm91'))).toBe('harbou');
        });

        await it('reads quoted-printable, soft line breaks included', async () => {
            expect(String.fromCharCode(...decodeQuotedPrintable('har=\nbour'))).toBe('harbour');
            expect(String.fromCharCode(...decodeQuotedPrintable('=D6resund'))).toBe('\u00d6resund');
            expect(String.fromCharCode(...decodeQuotedPrintable('5 =3D 5'))).toBe('5 = 5');
            expect(String.fromCharCode(...decodeQuotedPrintable('100=% sure'))).toBe('100=% sure');
        });

        await it('treats "_" as a space only inside an encoded word', async () => {
            expect(String.fromCharCode(...decodeQuotedPrintable('a_b'))).toBe('a_b');
            expect(String.fromCharCode(...decodeQuotedPrintable('a_b', true))).toBe('a b');
        });

        await it('joins two encoded words without the separating space', async () => {
            // RFC 2047 § 6.2: the whitespace between two encoded words is the encoder's, inserted
            // because a word may not exceed 75 characters. Keeping it breaks a German compound in
            // half, which reads as the sender's typo and makes the subject unsearchable.
            expect(decodeEncodedWords('=?utf-8?Q?Hafen=C3=BCberwachungs?= =?utf-8?Q?beh=C3=B6rde?=')).toBe(
                'Hafen\u00fcberwachungsbeh\u00f6rde',
            );
        });

        await it('keeps the space between an encoded word and ordinary text', async () => {
            expect(decodeEncodedWords('Re: =?utf-8?B?QsO8cm8=?= Berlin')).toBe('Re: B\u00fcro Berlin');
        });

        await it('leaves a value with no encoded word untouched', async () => {
            expect(decodeEncodedWords('Harbour contract')).toBe('Harbour contract');
        });
    });

    await describe('header fields', async () => {
        await it('unfolds a value and keeps the whitespace that held it apart', async () => {
            const { header } = splitMessage(encodeLatin1('Subject: the harbour\n  contract\n\nbody\n'));
            expect(headerValue(parseHeaderFields(header), 'Subject')).toBe('the harbour  contract');
        });

        await it('joins the occurrences of a field a message may repeat', async () => {
            // A list that adds a second `To` must still be findable by either recipient.
            const { header } = splitMessage(
                encodeLatin1('To: ada@example.com\nTo: grace@example.net\n\nbody\n'),
            );
            expect(joinedHeader(parseHeaderFields(header), 'to')).toBe('ada@example.com, grace@example.net');
        });

        await it('drops a line that is neither a field nor a continuation', async () => {
            // A surviving mbox separator must not be appended to the field above it, or text the
            // sender never wrote ends up inside their `Subject`.
            const { header } = splitMessage(
                encodeLatin1(`Subject: One\n${SEPARATOR}To: ada@example.com\n\nbody\n`),
            );
            const fields = parseHeaderFields(header);
            expect(headerValue(fields, 'subject')).toBe('One');
            expect(headerValue(fields, 'to')).toBe('ada@example.com');
        });

        await it('splits header from body on LF and on CRLF alike', async () => {
            expect(String.fromCharCode(...splitMessage(encodeLatin1('A: 1\r\n\r\nbody\r\n')).body)).toBe(
                'body\r\n',
            );
            expect(String.fromCharCode(...splitMessage(encodeLatin1('A: 1\n\nbody\n')).body)).toBe('body\n');
        });

        await it('reads a message with no blank line as all header', async () => {
            // What a truncated archive entry looks like. Reporting it as header-only is more
            // honest than guessing where a body would have started.
            const { header, body } = splitMessage(encodeLatin1('Subject: cut off\n'));
            expect(body.length).toBe(0);
            expect(headerValue(parseHeaderFields(header), 'subject')).toBe('cut off');
        });

        await it('finds the domain of an address however it is written', async () => {
            expect(addressDomain('Ada Lovelace <ada@Example.COM>')).toBe('example.com');
            expect(addressDomain('ada@example.com')).toBe('example.com');
            expect(addressDomain('ada@example.com, grace@example.net')).toBe('example.com');
            expect(addressDomain('undisclosed recipients')).toBe(undefined);
            expect(addressDomain(undefined)).toBe(undefined);
        });
    });

    await describe('message text', async () => {
        const MULTIPART = [
            'From: Ada Lovelace <ada@example.com>',
            'Subject: Tender documents',
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="sep-42"',
            '',
            'This is a multi-part message in MIME format.',
            '--sep-42',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'The tender for the =C3=96resund crossing closes on Friday.',
            '',
            '--sep-42',
            'Content-Type: text/html; charset=utf-8',
            'Content-Transfer-Encoding: base64',
            '',
            'PHA+VGhlIHRlbmRlciBjbG9zZXMgb24gPGI+RnJpZGF5PC9iPi48L3A+',
            '',
            '--sep-42--',
            '',
        ].join('\n');

        await it('decodes every text part of a multipart message', async () => {
            const text = messageText(encodeLatin1(MULTIPART));
            expect(text.includes('\u00d6resund')).toBe(true);
            // The html part arrives base64-encoded; its text reaches the index, its tags do not.
            expect(text.includes('The tender closes on Friday')).toBe(true);
            expect(text.includes('<b>')).toBe(false);
        });

        await it('leaves the MIME preamble out of the index', async () => {
            // "This is a multi-part message in MIME format." is in a large share of all mail, so
            // indexing it makes a token that matches half the archive.
            expect(messageText(encodeLatin1(MULTIPART)).includes('multi-part message')).toBe(false);
        });

        await it('indexes an attachment-only message by its headers alone', async () => {
            const text = messageText(
                encodeLatin1(
                    'Content-Type: application/pdf; name="tender.pdf"\nContent-Transfer-Encoding: base64\n\nJVBERi0=\n',
                ),
            );
            expect(text).toBe('');
        });

        await it('strips tags and the contents of script and style', async () => {
            expect(stripHtml('<p>harbour <b>contract</b></p>')).toBe('harbour contract');
            expect(stripHtml('<style>p { color: red }</style><p>harbour</p>')).toBe('harbour');
            expect(stripHtml('<p>5 &lt; 6 &amp; 7 &gt; 6</p>')).toBe('5 < 6 & 7 > 6');
        });
    });

    await describe('summarising a message', async () => {
        const RAW = [
            'From: =?utf-8?B?QsO8cm8gQmVybGlu?= <buero@Example.COM>',
            'To: Grace Hopper <grace@example.net>',
            'Subject: =?utf-8?Q?Hafen=C3=BCberwachungs?= =?utf-8?Q?beh=C3=B6rde?=',
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            'Message-ID: <arch-04@example.com>',
            '',
            'Die Unterlagen liegen bei.',
            '',
        ].join('\n');

        await it('decodes the fields the index searches', async () => {
            const summary = summarise(encodeLatin1(RAW));
            expect(summary.subject).toBe('Hafen\u00fcberwachungsbeh\u00f6rde');
            expect(summary.from).toBe('B\u00fcro Berlin <buero@Example.COM>');
            expect(summary.messageId).toBe('<arch-04@example.com>');
            expect(summary.fromDomain).toBe('example.com');
            expect(summary.text).toBe('Die Unterlagen liegen bei.');
        });

        await it('keeps the date as written and as a sortable number', async () => {
            const summary = summarise(encodeLatin1(RAW));
            expect(summary.date).toBe('Tue, 05 Mar 2024 09:40:00 +0000');
            expect(summary.sentAt).toBe(Date.UTC(2024, 2, 5, 9, 40, 0));
        });

        await it('leaves an unreadable date out of the sort rather than calling it 1970', async () => {
            const summary = summarise(encodeLatin1('Subject: One\nDate: whenever\n\nbody\n'));
            expect(summary.sentAt).toBe(undefined);
            // Still visible and still searchable, so the gap is a gap and not a silent fact.
            expect(summary.date).toBe('whenever');
        });

        await it('summarises a message it cannot parse instead of throwing', async () => {
            const summary = summarise(encodeLatin1('\u0000\u0001 not a message at all'));
            expect(summary.subject).toBe('');
            expect(summary.from).toBe('');
            expect(summary.fromDomain).toBe(undefined);
        });
    });
};
