#!/usr/bin/env node
// Generates the archive fixtures: `node tools/make-archive-fixtures.mjs`.
//
// SEPARATE FROM make-fixtures.mjs ON PURPOSE. That script mints fresh keys on every run, so every
// .eml it writes changes together and the whole tree is reviewed and committed in one go. These
// fixtures are about mbox and Maildir QUIRKS, carry no signature at all, and are byte-stable
// across runs — folding them into the signing generator would make a `From `-quoting fixture
// churn every time a key is regenerated, and a churning fixture is one nobody reads the diff of.
//
// WHAT IS IN HERE. One archive per thing that goes wrong when an mbox is read naively:
//
//   inbox.mbox      a body line starting `From ` (must survive unquoting byte for byte), a line
//                   that was already `>From ` (mboxrd adds a second `>`), a multipart with
//                   quoted-printable and base64 parts, an RFC 2047 subject split across two
//                   encoded words, and the same message twice.
//   not-a-separator.mbox  a body paragraph beginning "From the desk of …" with no ctime date —
//                   the line a too-eager splitter cuts a message in half on.
//   maildir/        new/ and cur/ hold a message each; tmp/ holds one that must NOT be imported.
//   leak/           the shape a leaked archive is handed over in: a folder per account, each
//                   holding its mailbox in pieces (`part-01.mbox`, `part-02.mbox`), with the
//                   paperwork of the disk it came from next to it.
//
// `inbox.mbox` is written with LF line endings and the Maildir with CRLF, because real archives
// are both and the splitters have a separate path for each.
//
// NOTHING REAL IS IN HERE. Reserved example domains (RFC 2606), invented bodies. Stamped is a
// tool for leaked mail, so a real message committed as a fixture could burn a source.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const archiveDir = join(repoRoot, 'app', 'tests', 'fixtures', 'archives');

/** One message, assembled from header pairs and a body, with the end-of-line the archive uses. */
function message({ headers, body }, eol) {
    const head = headers.map(([name, value]) => `${name}: ${value}`).join(eol);
    return `${head}${eol}${eol}${body.split('\n').join(eol)}`;
}

/**
 * mboxrd quoting (§ the one convention that is reversible): any run of `>` before `From ` gets
 * one more `>`. This is the WRITER's half of the rule the importer has to undo; having both in
 * the repo is what makes the round trip testable rather than asserted.
 */
function quoteBody(text) {
    return text
        .split('\n')
        .map((line) => (/^>*From /.test(line) ? `>${line}` : line))
        .join('\n');
}

/** An mbox entry: the `From ` separator line, the quoted message, and the blank line after it. */
function entry(raw, { sender = 'ada@example.com', date = 'Tue Mar  5 09:41:00 2024' } = {}) {
    return `From ${sender} ${date}\n${quoteBody(raw)}\n\n`;
}

function headersFor({ subject, from = 'Ada Lovelace <ada@example.com>', messageId, extra = [] }) {
    return [
        ['From', from],
        ['To', 'Grace Hopper <grace@example.net>'],
        ['Subject', subject],
        ['Date', 'Tue, 05 Mar 2024 09:40:00 +0000'],
        ['Message-ID', messageId],
        ...extra,
    ];
}

mkdirSync(archiveDir, { recursive: true });
console.log('archives:');

function write(name, content) {
    const path = join(archiveDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'binary');
    console.log(`  ${name}`);
}

// ── inbox.mbox ──────────────────────────────────────────────────────────────────────────────

/** The plain one, and the duplicate at the end of the archive: byte-identical, one hash. */
const plain = message(
    {
        headers: headersFor({ subject: 'Harbour contract', messageId: '<arch-01@example.com>' }),
        body: 'The harbour contract is signed.\n\nThe lighthouse survey follows next week.\n',
    },
    '\n',
);

// The one that breaks a naive reader. Both lines come back exactly as written here, or the body
// is not the body the sender sent — and for a signed message that reads as `body-altered`,
// Stamped's strongest accusation, produced by its own reader.
const quoted = message(
    {
        headers: headersFor({ subject: 'Quoting', messageId: '<arch-02@example.com>' }),
        body: [
            'From the harbourmaster, a note about the survey.',
            '',
            '>From a previous mail, quoted:',
            '>> the tender closes on Friday',
            '',
            'Regards',
            '',
        ].join('\n'),
    },
    '\n',
);

const multipart = message(
    {
        headers: headersFor({
            subject: 'Tender documents',
            messageId: '<arch-03@example.com>',
            extra: [
                ['MIME-Version', '1.0'],
                ['Content-Type', 'multipart/alternative; boundary="sep-42"'],
            ],
        }),
        body: [
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
            Buffer.from(
                // `scarlet` and `pierhead` are each in exactly one place: the first inside the
                // <style> block, which must NOT reach the index, the second in the prose, which
                // must. Searching for either is how a test tells the two apart.
                '<html><head><style>p { color: scarlet }</style></head><body><p>The tender for the <b>pierhead</b> closes on Friday.</p></body></html>',
                'utf8',
            ).toString('base64'),
            '',
            '--sep-42--',
            '',
        ].join('\n'),
    },
    '\n',
);

// `=?utf-8?Q?...?=` twice, with only whitespace between: RFC 2047 § 6.2 says that whitespace is
// the encoder's separator and not part of the text, so the compound must come back unbroken.
const encoded = message(
    {
        headers: headersFor({
            subject: '=?utf-8?Q?Hafen=C3=BCberwachungs?= =?utf-8?Q?beh=C3=B6rde?=',
            from: '=?utf-8?B?QsO8cm8gQmVybGlu?= <buero@example.com>',
            messageId: '<arch-04@example.com>',
        }),
        body: 'Die Unterlagen liegen bei.\n',
    },
    '\n',
);

write(
    'inbox.mbox',
    [
        entry(plain),
        entry(quoted, { date: 'Wed Mar  6 11:02:13 2024' }),
        entry(multipart, { sender: '-', date: 'Thu Mar  7 08:15:00 2024' }),
        entry(encoded, { sender: 'buero@example.com', date: 'Fri Mar  8 16:30:45 2024' }),
        // The same bytes as the first message. Four separators above, five here: the import must
        // report five messages read and four stored.
        entry(plain, { date: 'Fri Mar  8 17:00:00 2024' }),
    ].join(''),
);

// ── not-a-separator.mbox ────────────────────────────────────────────────────────────────────

// One message whose body has a paragraph beginning `From the desk of …`. It is NOT quoted here,
// because a writer that only escapes real separators is exactly the archive this has to survive:
// the line has no ctime date after the address, so the strict separator rule leaves it alone. A
// reader that split on `From ` alone would report two messages, the second of them headerless.
write(
    'not-a-separator.mbox',
    `From ada@example.com Tue Mar  5 09:41:00 2024\n${message(
        {
            headers: headersFor({ subject: 'Desk note', messageId: '<arch-05@example.com>' }),
            body: 'From the desk of the harbourmaster:\n\nthe survey is approved.\n',
        },
        '\n',
    )}\n`,
);

// ── maildir/ ────────────────────────────────────────────────────────────────────────────────

// Rebuilt rather than merged: a stale message left in `tmp/` from an earlier layout would quietly
// turn the "tmp is never read" assertion into a test of nothing.
rmSync(join(archiveDir, 'maildir'), { recursive: true, force: true });

write(
    join('maildir', 'new', '1709631660.M1P1000.example,S=512'),
    message(
        {
            headers: headersFor({ subject: 'Survey schedule', messageId: '<arch-06@example.com>' }),
            body: 'The survey runs from Monday to Thursday.\n',
        },
        '\r\n',
    ),
);

write(
    join('maildir', 'cur', '1709631661.M2P1000.example,S=498:2,S'),
    message(
        {
            headers: headersFor({ subject: 'Survey results', messageId: '<arch-07@example.com>' }),
            body: 'The results are attached to the next mail.\n',
        },
        '\r\n',
    ),
);

// NEVER IMPORTED. `tmp/` is where a delivery agent writes a message it has not finished writing,
// so importing one puts half a message in the case folder under a hash that will never match the
// finished file. This one is whole and says so in its subject, so a test that finds it can name
// what went wrong.
write(
    join('maildir', 'tmp', '1709631662.M3P1000.example'),
    message(
        {
            headers: headersFor({
                subject: 'Half written, must not be imported',
                messageId: '<arch-08@example.com>',
            }),
            body: 'A delivery agent is still writing this.\n',
        },
        '\r\n',
    ),
);

// ── leak/ ────────────────────────────────────────────────────────────────────────────────────

// The shape a leaked archive is handed over in: a folder per account, each holding its mailbox
// in pieces, and the paperwork of the disk it came from next to them.
//
// The numbers in the file names are NOT what makes the mailbox — the parts are read one file at
// a time, and the order between them decides nothing. The names are what a reader recognises,
// and the split is what a leak actually looks like.
//
// `broken@example.org/part-01.mbox` is not an mbox at all. A part that holds no message is a
// damaged archive, and the import has to say so — turning the fragments into a mail nobody sent
// would put a message in the case folder that no one ever wrote.
rmSync(join(archiveDir, 'leak'), { recursive: true, force: true });

write(
    join('leak', 'README.txt'),
    [
        'This archive was handed over as a folder: one folder per account, each holding its',
        'mailbox in pieces. The files that are not mail are not part of any mailbox.',
        '',
    ].join('\n'),
);

write(
    join('leak', 'ada@example.com', 'part-01.mbox'),
    [
        entry(
            message(
                {
                    headers: headersFor({
                        subject: 'Harbour contract',
                        messageId: '<leak-01@example.com>',
                    }),
                    body: 'The harbour contract is signed.\n',
                },
                '\n',
            ),
        ),
        entry(
            message(
                {
                    headers: headersFor({
                        subject: 'Survey schedule',
                        messageId: '<leak-02@example.com>',
                    }),
                    body: 'The survey runs from Monday to Thursday.\n',
                },
                '\n',
            ),
            { date: 'Wed Mar  6 11:02:13 2024' },
        ),
    ].join(''),
);

write(
    join('leak', 'ada@example.com', 'part-02.mbox'),
    entry(
        message(
            {
                headers: headersFor({
                    subject: 'Survey results',
                    messageId: '<leak-03@example.com>',
                }),
                body: 'The results are attached to the next mail.\n',
            },
            '\n',
        ),
        { date: 'Thu Mar  7 08:15:00 2024' },
    ),
);

write(
    join('leak', 'grace@example.net', 'part-01.mbox'),
    entry(
        message(
            {
                headers: headersFor({
                    subject: 'Tender documents',
                    messageId: '<leak-04@example.com>',
                }),
                body: 'The tender for the crossing closes on Friday.\n',
            },
            '\n',
        ),
        { date: 'Fri Mar  8 16:30:45 2024' },
    ),
);

write(
    join('leak', 'grace@example.net', 'notes.md'),
    ['# Notes', '', 'Nothing in this file is mail.', ''].join('\n'),
);

write(
    join('leak', 'broken@example.org', 'part-01.mbox'),
    [
        'This part was never filled in. It is not an mbox, and reading it as one message',
        'would put a fragment of a mailbox into the case folder as a mail nobody sent.',
        '',
    ].join('\n'),
);

console.log(`archives:\n  ${archiveDir}`);
