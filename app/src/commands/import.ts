/**
 * `stamped import <case> <source…>` — an archive becomes a case folder.
 *
 * The command owns no rules: it turns arguments into a {@link KeyStore} and a list of paths,
 * hands them to `@stamped/store`, and prints the counts that come back. Everything about mbox
 * quirks, hashing, the import log and the index lives in the packages, because the planned
 * desktop frontend imports the same archives and must not re-derive any of it.
 *
 * WHY THE COUNTS ARE PRINTED AND NOT JUST "done": an import that read 40,000 messages and stored
 * 12,000 has told the operator something important — the archive is three-quarters duplicates, or
 * three-quarters of it failed to split. Those two look identical from a progress bar and are
 * distinguishable from the numbers.
 *
 * A FOLDER OF MAILBOXES IS A SOURCE TOO. A leaked archive arrives as a tree: one folder per
 * account, each holding its mailbox in pieces. `--folders` says that is what the source is, and
 * without it a folder that holds `.mbox` files is read that way anyway — because the layout
 * says what the files are, and the operator should not have to walk the tree with a shell to
 * find out. A folder import names every mailbox after the folder it came from, and it does not
 * stop at the first damaged file: the failures are collected, listed at the end, and the run
 * ends with a non-zero exit code so that a script cannot read a partial import as a clean one.
 */

import { fmt, _, _n } from '@stamped/core';
import type { MboxFlavour } from '@stamped/import';
import {
    beginImportStatus,
    type ImportMode,
    type ImportProgress,
    type ImportResult,
    importSources,
    openCase,
} from '@stamped/store';
import type { CommandModule } from 'yargs';

import { fetchMissingAndReverify } from '../lib/autofetch.ts';
import { caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';
import { failureHeadline, failureLines, folderSummary } from '../lib/import-summary.ts';
import { keyStoreFrom } from '../lib/keys.ts';
import { progressLine } from '../lib/progress.ts';

interface ImportArgs {
    case?: string;
    paths?: (string | number)[];
    key?: (string | number)[];
    flavour?: string;
    quiet?: boolean;
    progress?: string;
    lookup?: boolean;
    yes?: boolean;
    folders?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function importCommand(): CommandModule<unknown, ImportArgs> {
    return {
        command: 'import [paths..]',
        describe: _('Read mail archives into a case folder and index them'),
        builder: (yargs) =>
            yargs
                .positional('paths', {
                    describe: _(
                        'The case folder (created when it does not exist), then the sources: an mbox file, a Maildir, a single .eml, or a directory of those. With --case, only the sources.',
                    ),
                    type: 'string',
                    array: true,
                })
                .option('case', {
                    describe: _('The case folder to import into, instead of the first argument'),
                    type: 'string',
                })
                .option('folders', {
                    describe: _(
                        'Read the source as a folder tree of mailboxes: every folder that holds mail files is one mailbox, named after the folder. A folder that holds .mbox files is read that way anyway; --no-folders reads it as a plain folder of files.',
                    ),
                    type: 'boolean',
                })
                .option('key', {
                    describe: _(
                        'A public key to verify against: <selector>._domainkey.<domain>=<TXT record, or a path to a .pem or .txt file holding one>. Repeatable.',
                    ),
                    type: 'array',
                    default: [] as string[],
                })
                .option('flavour', {
                    describe: _('Which "From " quoting the mbox files use: mboxrd (the default) or mboxo'),
                    choices: ['mboxrd', 'mboxo'],
                    default: 'mboxrd',
                })
                .option('lookup', {
                    describe: _('Look up missing keys after the import (asks first); --no-lookup skips it'),
                    type: 'boolean',
                    default: true,
                })
                .option('yes', {
                    describe: _('Accept the key lookup without asking'),
                    type: 'boolean',
                    default: false,
                })
                .option('progress', {
                    describe: _(
                        'Machine-readable progress: jsonl prints one JSON object per indexed batch on stdout, then a final one',
                    ),
                    choices: ['jsonl'],
                })
                .option('quiet', {
                    describe: _('Print only the summary, no progress'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped import ./case ~/archive/inbox.mbox',
                    _('Import one mbox, with no keys yet. Run `stamped report` to see which are needed.'),
                )
                .example(
                    'stamped import --case ./case ~/leak',
                    _('Import a folder of mailboxes: one folder per account, each holding its mbox parts'),
                ),
        handler: async (args) => {
            const startedAt = Date.now();
            const { root, rest: sources } = caseRoot('import', args.case, args.paths ?? []);
            if (sources.length === 0) {
                throw new Error(_('No source given. Use `stamped import <case> <source…>`.'));
            }
            const paths = openCase(root);
            const keys = keyStoreFrom((args.key ?? []).map(String));

            // `--folders` says the source IS a tree of mailboxes; `--no-folders` says it is not;
            // without either, a folder that holds .mbox files is read as a tree and everything
            // else as it is.
            const mode: ImportMode =
                args.folders === true ? 'folders' : args.folders === false ? 'sources' : 'auto';

            const jsonl = args.progress === 'jsonl';
            const emit = (progress: ImportProgress, final: boolean): void => {
                const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
                process.stdout.write(`${JSON.stringify(progressLine(progress, final, seconds))}\n`);
            };

            // The status file in the case folder, so the run is visible to `stamped status` and
            // to the window — a 200 GB import on a command line is otherwise invisible to
            // everything but the terminal it was started in.
            const status = beginImportStatus(paths, sources, { mode });
            let result: ImportResult;
            try {
                result = await importSources(paths, sources, {
                    keys,
                    flavour: args.flavour as MboxFlavour,
                    mode,
                    onProgress: (progress) => {
                        status.update(progress);
                        if (args.quiet || !process.stdout.isTTY) return;
                        // Overwritten in place rather than scrolled: an import of a large archive
                        // would otherwise bury its own summary under tens of thousands of lines.
                        // Only when stdout is a terminal — a redirected log gets the summary and
                        // nothing else.
                        process.stdout.write(
                            `\r${fmt(_('{read} read, {stored} stored, {duplicates} duplicates'), {
                                read: String(progress.read),
                                stored: String(progress.stored),
                                duplicates: String(progress.duplicates),
                            })}   `,
                        );
                    },
                    onBatch: jsonl ? (progress) => emit(progress, false) : undefined,
                });
                status.finish(result);
            } catch (error) {
                // The file must not be left saying `running` for a process that threw — the next
                // reader would call it orphaned, which is a different statement than "it failed".
                status.fail();
                throw error;
            }
            if (!args.quiet && process.stdout.isTTY) process.stdout.write('\n');
            if (jsonl) {
                emit(
                    {
                        read: result.read,
                        stored: result.stored,
                        duplicates: result.duplicates,
                        indexed: result.indexed,
                        failed: result.failed,
                        total: result.indexed + result.failed,
                        done: result.indexed + result.failed,
                        // The closing line is about the whole run, and a run has no single
                        // mailbox — but it ended in one, and that is where a watcher looking for
                        // the stall wants to look.
                        ...(result.lastMailbox === undefined ? {} : { mailbox: result.lastMailbox }),
                    },
                    true,
                );
            }

            // Inflected on the messages, and the number of sources left out: a sentence carrying
            // two counts can only agree with one of them, and the other count is the argument
            // list the operator just typed.
            console.log(
                fmt(_n('{read} message read.', '{read} messages read.', result.read), {
                    read: String(result.read),
                }),
            );
            console.log(
                fmt(_('{stored} newly stored, {duplicates} already in the case.'), {
                    stored: String(result.stored),
                    duplicates: String(result.duplicates),
                }),
            );
            console.log(fmt(_('{indexed} indexed.'), { indexed: String(result.indexed) }));
            if (result.failed > 0) {
                // Never silent. These messages ARE in the raw store and in the log — only their
                // verdict is missing — and an operator who does not know they exist would read
                // the report as covering the whole archive.
                console.log(
                    fmt(
                        _n(
                            '{failed} message could not be verified; it is stored but has no verdict.',
                            '{failed} messages could not be verified; they are stored but have no verdict.',
                            result.failed,
                        ),
                        { failed: String(result.failed) },
                    ),
                );
            }
            console.log(fmt(_('Case folder: {path}'), { path: paths.root }));

            // What the tree held: how many mailboxes, how many files, and how many files were
            // not mail. The last number is the one that says whether the operator pointed Stamped
            // at the right folder.
            for (const line of folderSummary(result)) console.log(line);

            // The files that could not be read, one per line, on stderr — they are errors and
            // not counts, and they are the reason the run ends with a non-zero exit code.
            for (const line of failureLines(result)) console.error(line);

            if (args.lookup !== false) {
                await fetchMissingAndReverify(paths, { yes: args.yes === true });
            }
            console.log(durationLine(startedAt));

            // Thrown LAST, so that everything the run had to say is said first. An import that
            // could not read every file is a partial import, and a script that reads the exit
            // code must not read it as a clean run.
            if (result.failures.length > 0) throw new Error(failureHeadline(result));
        },
    };
}
