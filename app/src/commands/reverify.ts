/**
 * `stamped reverify --case <dir> [--all]` — apply the keys the case holds to the messages that lacked
 * them, or with `--all` re-verify every signed message (after the verifier itself changed).
 *
 * Offline: nothing is looked up. Reads `keys.json`, re-verifies from `raw/`, updates the index.
 */

import { _ } from '@stamped/core';
import type { CommandModule } from 'yargs';

import { reverifyApplicable } from '../lib/autofetch.ts';
import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';

interface ReverifyArgs {
    case?: string;
    folder?: string;
    all?: boolean;
}

export function reverifyCommand(): CommandModule<unknown, ReverifyArgs> {
    return {
        command: 'reverify [folder]',
        describe: _('Re-verify messages with the keys the case now holds (offline)'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .option('case', {
                    describe: _('The case folder (default: .stamped)'),
                    type: 'string',
                })
                .option('all', {
                    describe: _('Re-verify every signed message, not only those a new key bears on'),
                    type: 'boolean',
                    default: false,
                }),
        handler: async (args) => {
            const startedAt = Date.now();
            const paths = caseOrThrow(caseRoot('reverify', args.case, [args.folder], '.stamped').root);
            if (!(await reverifyApplicable(paths, args.all)))
                console.log(_('No stored key applies to an unverified message.'));
            console.log(durationLine(startedAt));
        },
    };
}
