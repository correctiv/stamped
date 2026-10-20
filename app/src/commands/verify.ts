/**
 * `stamped verify <file.eml>` — the whole tool, for one message at a time.
 *
 * The command reads a file, collects the keys the operator supplied, asks `@stamped/verify` what
 * the facts are, asks `@stamped/core` what may be said about them, and prints that. It decides
 * nothing itself; everything it knows about DKIM is which argument carries a key.
 */

import { readFileSync } from 'node:fs';

import { classifyMessage, fmt, _ } from '@stamped/core';
import { verifyMessage } from '@stamped/verify';
import type { CommandModule } from 'yargs';

import { keyStoreFrom } from '../lib/keys.ts';
import { reportJson, reportLines } from '../lib/report.ts';

interface VerifyArgs {
    file: string;
    key?: (string | number)[];
    json?: boolean;
}

/**
 * The command, built on call rather than exported as a literal.
 *
 * A function because the strings are translated: a module-level object would evaluate every `_()`
 * while this module is IMPORTED, and ESM evaluates imports before the first statement of the
 * importing module — so the catalogue `initI18n()` installs would arrive after the help text had
 * already been built in English.
 */
export function verifyCommand(): CommandModule<unknown, VerifyArgs> {
    return {
        command: 'verify <file>',
        describe: _('Check the DKIM signatures of one message and report what they cover'),
        builder: (yargs) =>
            yargs
                .positional('file', {
                    describe: _('The message to check, as RFC 5322 bytes (.eml)'),
                    type: 'string',
                    demandOption: true,
                })
                .option('key', {
                    describe: _(
                        'A public key: <selector>._domainkey.<domain>=<TXT record, or a path to a .pem or .txt file holding one>. Repeatable.',
                    ),
                    type: 'array',
                    default: [] as string[],
                })
                .option('json', {
                    describe: _('Print the finding and the full evidence as JSON'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped verify mail.eml --key sel._domainkey.example.com=sel.pub.pem',
                    _('Check one message against a key you have on disk'),
                ),
        handler: async (args) => {
            // Bytes, not a string: canonicalization is defined on octets, and decoding an 8-bit
            // body as UTF-8 would silently replace whatever is not valid UTF-8 — changing exactly
            // the bytes whose hash is the finding.
            const raw = readMessage(args.file);
            const keys = keyStoreFrom((args.key ?? []).map(String));

            const finding = classifyMessage(await verifyMessage(raw, { keys }));

            if (args.json) {
                console.log(reportJson(finding, args.file));
                return;
            }
            console.log(args.file);
            for (const line of reportLines(finding)) console.log(line);
        },
    };
}

/** Read the message, naming the path: an unreadable file is a typo, not a verification result. */
function readMessage(path: string): Uint8Array {
    try {
        return new Uint8Array(readFileSync(path));
    } catch {
        throw new Error(fmt(_('Cannot read {path}.'), { path }));
    }
}
