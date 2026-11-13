/**
 * `stamped case reindex [folder]` — rebuild a case's index from the messages in `raw/`.
 *
 * For a case whose index is lost, damaged or from a build that cannot read it, and whose source
 * archives are gone: `raw/` is the evidence, the index only what was derived from it. What an
 * import would not have to redo (the log, the raw store, the vector index) is not touched. The
 * design and what is not brought back: `packages/store/src/reindex.ts`.
 */

import { fmt, _, _n } from '@stamped/core';
import { reindexCase } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { trackActivity } from '../lib/autofetch.ts';
import { refuseBusyCase } from '../lib/case-busy.ts';
import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';
import { loadVault } from '../lib/vault.ts';

const PROGRESS_SECONDS = 5;
const SHOWN_FAILURES = 20;

interface ReindexArgs {
    folder?: string;
    'accept-failures'?: boolean;
}

export function reindexCaseCommand(): CommandModule<unknown, ReindexArgs> {
    return {
        command: 'reindex [folder]',
        describe: _('Rebuild the index of a case from its messages (offline)'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .option('accept-failures', {
                    describe: _('Replace the index even when some messages could not be indexed'),
                    type: 'boolean',
                })
                .epilog(
                    _(
                        'Reads every message under raw/ and verifies it with the keys in the case, then replaces the index in one step: a run that fails leaves the old index as it was. Close the window on this case first. The import log and the messages are not changed.',
                    ),
                ),
        handler: async (args) => {
            const startedAt = Date.now();
            const { root } = caseRoot('case reindex', undefined, [args.folder]);
            const paths = caseOrThrow(root);
            refuseBusyCase(paths);
            const keys = loadVault(paths.root).toKeyStore({ skipConflicts: true });
            let last = Date.now();
            const result = await trackActivity(paths, 'reverify', (activity) =>
                reindexCase(paths, {
                    keys,
                    acceptFailures: args['accept-failures'] === true,
                    onProgress: (done, total) => {
                        activity.update(done, total);
                        const now = Date.now();
                        if (now - last < PROGRESS_SECONDS * 1000 || done === total) return;
                        last = now;
                        console.error(fmt(_('Indexing: {done} of {total} messages'), { done, total }));
                    },
                }),
            );
            for (const failure of result.failures.slice(0, SHOWN_FAILURES)) {
                console.error(`- ${failure.hash}: ${failure.reason}`);
            }
            if (result.failures.length > SHOWN_FAILURES) {
                console.error(
                    fmt(_('… and {count} more.'), { count: result.failures.length - SHOWN_FAILURES }),
                );
            }
            if (!result.replaced) {
                throw new Error(
                    fmt(
                        _n(
                            '{count} message could not be indexed, so the index was left as it is. Run it again with --accept-failures to replace it without that message.',
                            '{count} messages could not be indexed, so the index was left as it is. Run it again with --accept-failures to replace it without them.',
                            result.failures.length,
                        ),
                        { count: result.failures.length },
                    ),
                );
            }
            console.log(
                fmt(
                    _n(
                        'Index rebuilt: {count} message indexed.',
                        'Index rebuilt: {count} messages indexed.',
                        result.indexed,
                    ),
                    { count: result.indexed },
                ),
            );
            if (result.before !== undefined && result.before !== result.indexed) {
                console.log(fmt(_('The old index held {before}.'), { before: result.before }));
            }
            console.log(durationLine(startedAt));
        },
    };
}
