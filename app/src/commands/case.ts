/**
 * `stamped case pack|unpack|verify` — a case as one file, and the check that it is the one that
 * was sealed.
 *
 * `pack` is an export: the folder stays the live case. `unpack` refuses a file that does not
 * match its manifest and leaves nothing behind. `verify` lists every problem and exits non-zero.
 * The format and its limits (integrity, not a signature): `docs/case-file.md`.
 */

import { basename, join, resolve } from 'node:path';

import { fmt, _, _n } from '@stamped/core';
import { CASE_FILE_EXTENSION, checkCaseFile, describeCounts, packCase, unpackCaseFile } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { refuseBusyCase } from '../lib/case-busy.ts';
import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { throttledProgress } from '../lib/case-file-progress.ts';
import { durationLine } from '../lib/duration.ts';

const PROGRESS_SECONDS = 5;

/** A progress callback that speaks at most every few seconds, on stderr, and never at the end. */
function progressEvery(label: string): (done: number, total: number) => void {
    let last = Date.now();
    return (done, total) => {
        const now = Date.now();
        if (now - last < PROGRESS_SECONDS * 1000 || total === 0) return;
        last = now;
        console.error(
            fmt(_('{label}: {percent} % ({done} of {total} MiB)'), {
                label,
                percent: Math.floor((done / total) * 100),
                done: Math.floor(done / 1048576),
                total: Math.floor(total / 1048576),
            }),
        );
    };
}

/** Progress lines on stdout for the window, or the slow human line on stderr for a person. */
function progressFor(jsonl: boolean, label: string): (done: number, total: number) => void {
    if (!jsonl) return progressEvery(label);
    return throttledProgress((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
}

function emitDone(path: string, members: number, bytes: number): void {
    process.stdout.write(`${JSON.stringify({ phase: 'done', path, members, bytes })}\n`);
}

interface PackArgs {
    folder?: string;
    file?: string;
    force?: boolean;
    progress?: string;
}

/** `<folder>.stamped` in the working directory; leading dots go, so `.stamped` is not `..stamped`. */
function defaultFile(root: string): string {
    const name = basename(resolve(root)).replace(/^\.+/, '') || 'case';
    return join(process.cwd(), `${name}${CASE_FILE_EXTENSION}`);
}

function packCommand(): CommandModule<unknown, PackArgs> {
    return {
        command: 'pack <folder> [file]',
        describe: _('Seal a case folder into one file (the folder stays as it is)'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .positional('file', {
                    describe: _('The case file to write (default: <folder name>.stamped here)'),
                    type: 'string',
                })
                .option('force', { describe: _('Replace the file when it exists'), type: 'boolean' })
                .option('progress', {
                    describe: _(
                        'Machine-readable progress: jsonl prints one JSON object per step on stdout, then a final one',
                    ),
                    type: 'string',
                    choices: ['jsonl'],
                })
                .epilog(
                    _(
                        'The file carries what the case is made of: the messages, the import log (with the paths of the source files on this machine), the index, the key vault and the settings. Treat it like the case.',
                    ),
                ),
        handler: (args) => {
            const startedAt = Date.now();
            const { root, rest } = caseRoot('case pack', undefined, [args.folder, args.file]);
            const paths = caseOrThrow(root);
            refuseBusyCase(paths);
            const jsonl = args.progress === 'jsonl';
            const done = packCase(paths, rest[0] ?? defaultFile(root), {
                force: args.force,
                onProgress: progressFor(jsonl, _('Packing')),
            });
            if (jsonl) {
                emitDone(done.path, done.members, done.bytes);
                return;
            }
            console.log(done.path);
            console.log(describeCounts(done.members, done.bytes));
            console.log(fmt(_('Manifest SHA-256: {hash}'), { hash: done.sha256 }));
            if (done.skippedCount > 0) {
                console.log(
                    fmt(
                        _n(
                            '{count} file was left out, as it is not part of a case file:',
                            '{count} files were left out, as they are not part of a case file:',
                            done.skippedCount,
                        ),
                        { count: done.skippedCount },
                    ),
                );
                for (const name of done.skipped.slice(0, 20)) console.log(`  ${name}`);
            }
            console.log(durationLine(startedAt));
        },
    };
}

interface UnpackArgs {
    file: string;
    folder?: string;
    progress?: string;
}

/** The file's name without `.stamped`, in the working directory — never the file's own name. */
function defaultFolder(file: string): string {
    const name = basename(file);
    const bare = name.endsWith(CASE_FILE_EXTENSION)
        ? name.slice(0, -CASE_FILE_EXTENSION.length)
        : `${name}.case`;
    return join(process.cwd(), bare || 'case');
}

function unpackCommand(): CommandModule<unknown, UnpackArgs> {
    return {
        command: 'unpack <file> [folder]',
        describe: _('Unpack a case file into a case folder, after checking it'),
        builder: (yargs) =>
            yargs
                .positional('file', { describe: _('The case file'), type: 'string', demandOption: true })
                .positional('folder', {
                    describe: _('The folder to create (default: the file name without .stamped, here)'),
                    type: 'string',
                })
                .option('progress', {
                    describe: _(
                        'Machine-readable progress: jsonl prints one JSON object per step on stdout, then a final one',
                    ),
                    type: 'string',
                    choices: ['jsonl'],
                })
                .epilog(
                    _(
                        'A file that does not match its manifest is not unpacked, and nothing is left behind. Run `stamped case verify` to see every problem.',
                    ),
                ),
        handler: (args) => {
            const startedAt = Date.now();
            const jsonl = args.progress === 'jsonl';
            const done = unpackCaseFile(args.file, args.folder ?? defaultFolder(args.file), {
                onProgress: progressFor(jsonl, _('Unpacking')),
            });
            if (jsonl) {
                emitDone(done.path, done.members, done.bytes);
                return;
            }
            console.log(done.path);
            console.log(describeCounts(done.members, done.bytes));
            console.log(durationLine(startedAt));
        },
    };
}

interface VerifyArgs {
    file: string;
}

function verifyFileCommand(): CommandModule<unknown, VerifyArgs> {
    return {
        command: 'verify <file>',
        describe: _('Check a case file against its manifest'),
        builder: (yargs) =>
            yargs.positional('file', { describe: _('The case file'), type: 'string', demandOption: true }),
        handler: (args) => {
            const startedAt = Date.now();
            const checked = checkCaseFile(args.file, { onProgress: progressEvery(_('Checking')) });
            if (!checked.ok) {
                for (const problem of checked.problems) console.error(`- ${problem}`);
                if (checked.moreProblems > 0) {
                    console.error(
                        fmt(
                            _n(
                                '… and {count} more problem.',
                                '… and {count} more problems.',
                                checked.moreProblems,
                            ),
                            {
                                count: checked.moreProblems,
                            },
                        ),
                    );
                }
                throw new Error(fmt(_('{file} failed its integrity check.'), { file: args.file }));
            }
            console.log(fmt(_('{file} matches its manifest.'), { file: args.file }));
            console.log(describeCounts(checked.members, checked.bytes));
            console.log(fmt(_('Manifest SHA-256: {hash}'), { hash: checked.sha256 ?? '' }));
            console.log(_('This shows the file is the one that was sealed, not who sealed it.'));
            console.log(durationLine(startedAt));
        },
    };
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function caseCommand(): CommandModule<unknown, unknown> {
    return {
        command: 'case',
        describe: _('Pack a case into one file, unpack it, or check it'),
        builder: (yargs) =>
            yargs
                .command(packCommand())
                .command(unpackCommand())
                .command(verifyFileCommand())
                .demandCommand(1, _('Pick a subcommand. Try `stamped case --help`.')),
        handler: () => undefined,
    };
}
