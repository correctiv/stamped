/**
 * `stamped search <case> <query>` — finding one message in a few hundred thousand.
 *
 * The query goes to FTS5 as written, which is a decision rather than laziness: `harbour AND
 * contract`, `subject : invoice`, `"exact phrase"` and `near(x y)` are all things a journalist
 * doing archive work will want, and a layer that "helpfully" escaped them would take the
 * capability away while looking like it worked. The cost is that a stray `"` is a syntax error;
 * the handler says so and names the column syntax, rather than reporting zero results.
 *
 * ZERO RESULTS IS THE DANGEROUS ANSWER in this tool — it reads as "the mail is not in the leak" —
 * so the command prints how many messages the case holds whenever it finds nothing. A search of
 * an empty case then says so instead of implying an answer about the archive.
 */

import { fmt, _, _n } from '@stamped/core';
import { messageCount, openIndex, searchMessages } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';

interface SearchArgs {
    case?: string;
    first?: string;
    second?: string;
    limit?: number;
    json?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function searchCommand(): CommandModule<unknown, SearchArgs> {
    return {
        command: 'search [first] [second]',
        describe: _('Search the messages in a case folder'),
        builder: (yargs) =>
            yargs
                .positional('first', {
                    describe: _('The case folder, or the query when --case is given'),
                    type: 'string',
                })
                .positional('second', {
                    describe: _(
                        'What to look for. Full-text syntax: a word, "a phrase", a AND b, or subject : word',
                    ),
                    type: 'string',
                })
                .option('case', { describe: _('The case folder to search'), type: 'string' })
                .option('limit', {
                    describe: _('How many matches to print'),
                    type: 'number',
                    default: 20,
                })
                .option('json', {
                    describe: _('Print the matches as JSON'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped search ./case "subject : invoice"',
                    _('Find messages with "invoice" in the subject'),
                ),
        handler: (args) => {
            const { root, rest } = caseRoot('search', args.case, [args.first, args.second]);
            const query = rest[0];
            if (query === undefined) {
                throw new Error(_('No search query given. Use `stamped search <case> <query>`.'));
            }
            const paths = caseOrThrow(root);
            const db = openIndex(paths);
            try {
                const hits = search(db, query, args.limit ?? 20);

                if (args.json) {
                    console.log(JSON.stringify({ query, hits }, undefined, 2));
                    return;
                }
                if (hits.length === 0) {
                    const total = messageCount(db);
                    console.log(_('No match.'));
                    // The number that keeps "no match" from reading as "not in the archive".
                    console.log(
                        fmt(
                            _n('The case holds {total} message.', 'The case holds {total} messages.', total),
                            { total: String(total) },
                        ),
                    );
                    return;
                }
                for (const hit of hits) {
                    console.log(`${hit.hash.slice(0, 12)}  ${hit.verdict}`);
                    console.log(fmt(_('  from    {from}'), { from: hit.from || _('(none)') }));
                    console.log(fmt(_('  date    {date}'), { date: hit.date || _('(none)') }));
                    console.log(fmt(_('  subject {subject}'), { subject: hit.subject || _('(none)') }));
                    console.log('');
                }
                console.log(
                    fmt(_n('{count} match.', '{count} matches.', hits.length), {
                        count: String(hits.length),
                    }),
                );
            } finally {
                db.close();
            }
        },
    };
}

/**
 * Run the query, turning an FTS5 syntax error into a sentence about the query.
 *
 * SQLite says `fts5: syntax error near "…"`, which names the character but not what the syntax
 * IS. Somebody searching for `O'Brien & Co.` needs to be told that quoting it works, not handed
 * a parser message.
 */
function search(db: ReturnType<typeof openIndex>, query: string, limit: number) {
    try {
        return searchMessages(db, query, limit);
    } catch {
        throw new Error(
            fmt(
                _(
                    'Cannot read the search {query}. Put a phrase in double quotes, and use `column : word` to search one field.',
                ),
                { query },
            ),
        );
    }
}
