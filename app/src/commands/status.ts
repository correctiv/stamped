/**
 * `stamped status --case <dir>` — where the case's import has got to, and what the semantic
 * layer is doing.
 *
 * The reader of this command is often NOT the terminal the import runs in: a 200 GB import is
 * started in one window and watched from another, or from the GUI, which polls the same file.
 * So the command exits 0 even when no import has run — "nothing is running" is an answer, not an
 * error — and `--json` prints the same facts in one object a script can read.
 *
 * The files it reads are written by whoever runs the work (CLI or GUI); this command never
 * starts one. An interrupted import reads as `running` but orphaned, which the headline says in
 * a sentence of its own rather than leaving a progress bar frozen at some number.
 *
 * THE SEMANTIC STATE IS A NOTE UNDER THE IMPORT'S, and it only appears when the case has a
 * setting for it: a case that never heard of semantic search has nothing to say about it, and
 * saying "off" would be an opinion the folder never gave.
 */

import { fmt, _ } from '@stamped/core';
import { readActivityStatuses, readImportStatus } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { semanticLines, semanticStatusJson } from '../lib/semantic-status.ts';
import { semanticSnapshot, semanticState } from '../lib/semantic-state.ts';
import { activityJson, activityLine, noStatusLine, statusJson, statusLines } from '../lib/status.ts';

interface StatusArgs {
    case?: string;
    folder?: string;
    json?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function statusCommand(): CommandModule<unknown, StatusArgs> {
    return {
        command: 'status [folder]',
        describe: _(
            'Show how far the last import into a case folder has got, and what the semantic search is doing',
        ),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder to report on'), type: 'string' })
                .option('case', { describe: _('The case folder to report on'), type: 'string' })
                .option('json', {
                    describe: _('Print the status as JSON'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped status --case ./case',
                    _('Watch an import that is running somewhere else, without touching it'),
                ),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('status', args.case, [args.folder]).root);
            const status = readImportStatus(paths);
            const activities = readActivityStatuses(paths);
            const snapshot = semanticSnapshot(paths);
            const semantic = snapshot === undefined ? undefined : semanticState(snapshot);

            if (args.json) {
                const json = {
                    ...(status === undefined ? { state: 'none', orphaned: false } : statusJson(status)),
                    activities: activities.map((a) => activityJson(a)),
                    ...(semantic === undefined
                        ? {}
                        : { semantic: semanticStatusJson(semantic, snapshot?.setting) }),
                };
                console.log(JSON.stringify(json, undefined, 2));
                return;
            }
            if (status === undefined) {
                console.log(noStatusLine(paths.root));
            } else {
                // The first line already says when the file is lying: `statusHeadline` turns a
                // `running` state with a dead process into a sentence of its own, so an operator
                // who reads nothing else still learns the run is not going on.
                for (const line of statusLines(status)) console.log(line);
            }
            for (const activity of activities) console.log(activityLine(activity));
            if (semantic !== undefined) {
                for (const line of semanticLines(semantic)) console.log(line);
            }
            if (status !== undefined) {
                console.log(fmt(_('Case folder: {path}'), { path: paths.root }));
            }
        },
    };
}
