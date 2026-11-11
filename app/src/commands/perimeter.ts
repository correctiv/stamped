/**
 * `stamped perimeter [folder] [--set <domain>…] [--clear]` — name the domains a case examines.
 *
 * A valid signature from one of them gets the `self-signed-perimeter` caveat: the key was
 * operated by the party under examination. The setting is the operator's; nothing is inferred.
 * Naming it re-classifies the messages it bears on from `raw/`, offline.
 */

import { fmt, _, _n } from '@stamped/core';
import { applyPerimeter, readPerimeter } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { trackActivity } from '../lib/autofetch.ts';
import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';
import { loadVault } from '../lib/vault.ts';

interface PerimeterArgs {
    case?: string;
    folder?: string;
    set?: (string | number)[];
    clear?: boolean;
}

export function perimeterCommand(): CommandModule<unknown, PerimeterArgs> {
    return {
        command: 'perimeter [folder]',
        describe: _('Show or set the domains this case examines'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .option('case', {
                    describe: _('The case folder (default: .stamped)'),
                    type: 'string',
                })
                .option('set', {
                    describe: _(
                        'A domain the case examines. Repeatable. Replaces the perimeter that was there.',
                    ),
                    type: 'array',
                })
                .option('clear', {
                    describe: _('Remove the perimeter'),
                    type: 'boolean',
                })
                .conflicts('set', 'clear')
                .epilog(
                    _(
                        'A valid signature from a perimeter domain proves the message is unchanged, not that the party would not have signed something else: the key was theirs. Stamped says so as a caveat, and only for domains you name here.',
                    ),
                ),
        handler: async (args) => {
            const startedAt = Date.now();
            const root = caseRoot('perimeter', args.case, [args.folder], '.stamped').root;
            const paths = caseOrThrow(root);
            const wanted = (args.set ?? []).map(String);
            if (wanted.length === 0 && !args.clear) {
                const current = readPerimeter(paths);
                console.log(current.length === 0 ? _('No perimeter is set.') : current.join('\n'));
                return;
            }
            const { perimeter, result } = await trackActivity(paths, 'keys', (activity) =>
                applyPerimeter(paths, wanted, loadVault(root), undefined, (done, total) =>
                    activity.update(done, total),
                ),
            );
            console.log(perimeter.length === 0 ? _('The perimeter is removed.') : perimeter.join('\n'));
            console.log(
                fmt(_n('{count} message re-checked.', '{count} messages re-checked.', result.checked), {
                    count: result.checked,
                }),
            );
            console.log(durationLine(startedAt));
        },
    };
}
