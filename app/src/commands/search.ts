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
 *
 * THE SEMANTIC HALF IS OPTIONAL and never changes the answer of a search that cannot use it: no
 * model, no vectors, a half-indexed case or an embedder that fails — the text hits stand and the
 * output is the same as it has always been. What the semantic half adds is hits the query's
 * WORDS do not reach, and those are marked, because a message that was found by meaning and not
 * by a word is a different kind of answer and must be recognisable as one.
 */

import { existsSync } from 'node:fs';

import { fmt, _, _n } from '@stamped/core';
import type { Embedder } from '@stamped/semantic';
import { openVectorDb } from '@stamped/semantic';
import { messageCount, openIndex } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { createEmbedder } from '../lib/embedder.ts';
import { hybridSearch } from '../lib/hybrid-search.ts';
import type { HybridHit, MatchKind } from '../lib/hybrid-search.ts';

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
        handler: async (args) => {
            const { root, rest } = caseRoot('search', args.case, [args.first, args.second]);
            const query = rest[0];
            if (query === undefined) {
                throw new Error(_('No search query given. Use `stamped search <case> <query>`.'));
            }
            const paths = caseOrThrow(root);
            const db = openIndex(paths);
            // The embedder FIRST: without one there is nothing to search the vectors with, and
            // the vector database is not even opened — see `openVectors` for why that matters.
            // A MODEL THAT WILL NOT LOAD IS NOT A REASON TO REFUSE THE SEARCH: the text search
            // is there, and the case stays searchable.
            const embedder = await createEmbedder().catch(() => undefined);
            const vectors = embedder === undefined ? undefined : openVectors(paths.vectors, embedder);
            try {
                const hits = await runSearch(db, vectors, embedder, query, args.limit ?? 20);

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
                    // The marker, and only where it says something: a hit the semantic half
                    // found. A hit the text search found is unmarked, exactly as before.
                    const marker = matchMarker(hit.match);
                    if (marker !== undefined) console.log(marker);
                    console.log('');
                }
                console.log(
                    fmt(_n('{count} match.', '{count} matches.', hits.length), {
                        count: String(hits.length),
                    }),
                );
            } finally {
                vectors?.close();
                db.close();
            }
        },
    };
}

/**
 * The line that marks a hit the semantic half found, or nothing at all.
 *
 * A MESSAGE OF ITS OWN, and not a word appended to the subject line: the mark says HOW the
 * message was found, and the line under the subject is where the reader looks for what the
 * message is about. A hit the text search found gets no line — the output of a search without
 * a model must not change.
 *
 * A FUNCTION, so the marker can be tested without a model: the command cannot produce a
 * semantic hit until the embedder ships, and the line it prints for one must be right anyway.
 */
export function matchMarker(match: MatchKind): string | undefined {
    if (match === 'semantic') return _('  semantic match');
    if (match === 'both') return _('  text and semantic match');
    return undefined;
}

/**
 * The case's vector database, or nothing.
 *
 * A SEARCH MUST NOT CREATE ANYTHING. `openVectorDb` makes the file and lays out the table when
 * they are not there, so a search that opened a case's vectors unconditionally would leave a
 * `vectors.db` behind in every case folder it ever touched — and a folder that grows files by
 * being looked at is a folder nobody trusts. So the file has to be there already.
 *
 * The model id and the dimension count come from the embedder, because they are what the table
 * was built with: `openVectorDb` DROPS a table built by another model, and a vector from one
 * model means nothing in another. That is the right rule for the indexer — a new model means a
 * new indexing run — but it is worth knowing that a search opens the table with the model this
 * build would use, so a build whose model changed rebuilds the vectors on the next search
 * rather than silently mixing them.
 *
 * A database that will not open is not a reason to refuse the search: the text search is still
 * there, and a semantic half that cannot answer must not take the text half down with it.
 */
function openVectors(path: string, embedder: Embedder) {
    if (!existsSync(path)) return undefined;
    try {
        return openVectorDb(path, {
            modelId: embedder.modelId,
            dimensions: embedder.dimensions,
        });
    } catch {
        return undefined;
    }
}

/**
 * Run the query, turning an FTS5 syntax error into a sentence about the query.
 *
 * SQLite says `fts5: syntax error near "…"`, which names the character but not what the syntax
 * IS. Somebody searching for `O'Brien & Co.` needs to be told that quoting it works, not handed
 * a parser message.
 *
 * ONLY THE TEXT HALF CAN FAIL HERE: the semantic half swallows every failure of its own (see
 * `hybrid-search.ts`), so an error that reaches this point is the query FTS5 could not read.
 */
async function runSearch(
    db: ReturnType<typeof openIndex>,
    vectors: ReturnType<typeof openVectors>,
    embedder: Embedder | undefined,
    query: string,
    limit: number,
): Promise<HybridHit[]> {
    try {
        return await hybridSearch({ index: db, vectors, embedder, query, options: { limit } });
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
