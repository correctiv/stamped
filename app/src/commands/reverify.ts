/**
 * `stamped reverify --case <dir>` — apply the keys the case holds to the messages that lacked them.
 *
 * Offline: nothing is looked up. Reads `keys.json`, re-verifies from `raw/`, updates the index.
 */

import { _ } from '@stamped/core';
import type { CommandModule } from 'yargs';

import { reverifyApplicable } from '../lib/autofetch.ts';
import { caseOrThrow } from '../lib/case.ts';

interface ReverifyArgs {
    case: string;
}

export function reverifyCommand(): CommandModule<unknown, ReverifyArgs> {
    return {
        command: 'reverify',
        describe: _('Re-verify messages with the keys the case now holds (offline)'),
        builder: (yargs) =>
            yargs.option('case', {
                describe: _('The case folder'),
                type: 'string',
                default: '.stamped',
            }),
        handler: async (args) => {
            const paths = caseOrThrow(args.case);
            if (!(await reverifyApplicable(paths)))
                console.log(_('No stored key applies to an unverified message.'));
        },
    };
}
