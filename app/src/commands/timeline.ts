/**
 * `stamped timeline <case>` — mails per month (per day for a short period), by verdict.
 *
 * Buckets are the UTC calendar of the sending instant. Mail without a readable date is counted
 * on its own line and never placed at 1970.
 */

import { fmt, _ } from '@stamped/core';
import { openIndex, timeline } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';

interface TimelineArgs {
    case?: string;
    folder?: string;
    unit?: 'month' | 'day';
    json?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function timelineCommand(): CommandModule<unknown, TimelineArgs> {
    return {
        command: 'timeline [folder]',
        describe: _('Count the mail of a case folder per month or day'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .option('case', { describe: _('The case folder'), type: 'string' })
                .option('unit', {
                    describe: _('Bucket size; by default per day for spans of two months or less'),
                    choices: ['month', 'day'] as const,
                })
                .option('json', {
                    describe: _('Print the timeline as JSON'),
                    type: 'boolean',
                    default: false,
                }),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('timeline', args.case, [args.folder]).root);
            const db = openIndex(paths);
            try {
                const result = timeline(db, args.unit);
                if (args.json) {
                    console.log(JSON.stringify(result, undefined, 2));
                    return;
                }
                for (const bucket of result.buckets) {
                    console.log(`${bucket.key}  ${String(bucket.messages).padStart(7)}`);
                }
                if (result.undated > 0) {
                    console.log(fmt(_('No date: {n}'), { n: String(result.undated) }));
                }
            } finally {
                db.close();
            }
        },
    };
}
