/**
 * `stamped tag list | add | remove | bookmark` — the tags and bookmarks of a case, for scripts.
 *
 * The window sets them with a click; this is the same `marks.json` from the terminal, so a
 * hundred messages found by a search can be tagged without a hundred clicks. They stay a working
 * note: nothing here touches the import log or a report.
 *
 * A message is named by the start of its hash, as `stamped search` prints it. An ambiguous or
 * unknown start is an error and never a guess: the wrong message carrying a tag is worse than none.
 */

import { fmt, _, _n } from '@stamped/core';
import {
    addTag,
    marksOf,
    normaliseTag,
    openIndex,
    removeTag,
    resolveHash,
    setBookmark,
    summariseMarks,
    type CasePaths,
} from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';

interface TagArgs {
    case?: string;
    first?: string;
    tags?: (string | number)[];
    json?: boolean;
    off?: boolean;
    hash?: string;
}

/** The hash a prefix names, resolved against the index and closed again. */
function resolveIn(paths: CasePaths, prefix: string): string {
    const db = openIndex(paths);
    try {
        return resolveHash(db, prefix);
    } finally {
        db.close();
    }
}

function describeMark(hash: string, tags: readonly string[], bookmark: boolean): string {
    const parts = [...tags];
    if (bookmark) parts.push(_('bookmarked'));
    return `${hash.slice(0, 12)}  ${parts.length === 0 ? _('(no marks)') : parts.join(', ')}`;
}

function listCommand(): CommandModule<unknown, TagArgs> {
    return {
        command: 'list [first]',
        describe: _('List the tags of a case, or the marks of one message'),
        builder: (yargs) =>
            yargs
                .positional('first', { describe: _('The case folder'), type: 'string' })
                .option('case', { describe: _('The case folder (default: .stamped)'), type: 'string' })
                .option('hash', {
                    describe: _('Show the marks of this message (the start of its hash)'),
                    type: 'string',
                })
                .option('json', { describe: _('Print the result as JSON'), type: 'boolean', default: false }),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('tag list', args.case, [args.first], '.stamped').root);
            if (args.hash !== undefined) {
                const hash = resolveIn(paths, args.hash);
                const mark = marksOf(paths, hash);
                if (args.json) {
                    console.log(
                        JSON.stringify({ hash, tags: mark.tags, bookmark: mark.bookmark }, undefined, 2),
                    );
                } else {
                    console.log(describeMark(hash, mark.tags, mark.bookmark));
                }
                return;
            }
            const summary = summariseMarks(paths);
            if (args.json) {
                console.log(JSON.stringify(summary, undefined, 2));
                return;
            }
            if (summary.tags.length === 0 && summary.bookmarks === 0) {
                console.log(_('Nothing is tagged or bookmarked.'));
                return;
            }
            for (const { tag, count } of summary.tags) {
                console.log(
                    fmt(_n('{tag}  {count} message', '{tag}  {count} messages', count), { tag, count }),
                );
            }
            console.log(
                fmt(_n('{count} bookmark', '{count} bookmarks', summary.bookmarks), {
                    count: summary.bookmarks,
                }),
            );
        },
    };
}

/** `add` and `remove` share everything but the verb. */
function changeCommand(verb: 'add' | 'remove'): CommandModule<unknown, TagArgs> {
    return {
        command: `${verb} <hash> <tags..>`,
        describe: verb === 'add' ? _('Tag a message') : _('Remove tags from a message'),
        builder: (yargs) =>
            yargs
                .positional('hash', { describe: _('The message (the start of its hash)'), type: 'string' })
                .positional('tags', { describe: _('One or more tags'), type: 'string', array: true })
                .option('case', { describe: _('The case folder (default: .stamped)'), type: 'string' }),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot(`tag ${verb}`, args.case, [], '.stamped').root);
            const hash = resolveIn(paths, String(args.hash));
            // Every tag is checked before the first is written: half a command applied is a
            // message tagged in a way nobody asked for.
            const tags = (args.tags ?? []).map((tag) => normaliseTag(String(tag)));
            let mark = marksOf(paths, hash);
            for (const tag of tags) {
                mark = verb === 'add' ? addTag(paths, hash, tag) : removeTag(paths, hash, tag);
            }
            console.log(describeMark(hash, mark.tags, mark.bookmark));
        },
    };
}

function bookmarkCommand(): CommandModule<unknown, TagArgs> {
    return {
        command: 'bookmark <hash>',
        describe: _('Bookmark a message, or with --off remove the bookmark'),
        builder: (yargs) =>
            yargs
                .positional('hash', { describe: _('The message (the start of its hash)'), type: 'string' })
                .option('case', { describe: _('The case folder (default: .stamped)'), type: 'string' })
                .option('off', { describe: _('Remove the bookmark'), type: 'boolean', default: false }),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('tag bookmark', args.case, [], '.stamped').root);
            const hash = resolveIn(paths, String(args.hash));
            const mark = setBookmark(paths, hash, args.off !== true);
            console.log(describeMark(hash, mark.tags, mark.bookmark));
        },
    };
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function tagCommand(): CommandModule<unknown, unknown> {
    return {
        command: 'tag',
        describe: _('Tags and bookmarks of a case'),
        builder: (yargs) =>
            yargs
                .command(listCommand())
                .command(changeCommand('add'))
                .command(changeCommand('remove'))
                .command(bookmarkCommand())
                .demandCommand(1, _('Pick a subcommand. Try `stamped tag --help`.'))
                .epilog(
                    _(
                        'Search them with tag:<name> and is:bookmarked. They are a working note kept in marks.json: not provenance, and not in a report.',
                    ),
                ),
        handler: () => undefined,
    };
}
