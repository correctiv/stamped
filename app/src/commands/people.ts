/**
 * `stamped people <case>` — who wrote to whom: every address with its mail count.
 *
 * One address is one person. Display names are listed beside the address, never used to merge
 * two addresses. A case opened before the address table existed is filled here first (resumable,
 * in batches), so the numbers are complete before they are printed.
 */

import { fmt, _, _n } from '@stamped/core';
import { addressesComplete, backfillAll, openIndex, peopleList } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';

interface PeopleArgs {
    case?: string;
    folder?: string;
    search?: string;
    limit?: number;
    json?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function peopleCommand(): CommandModule<unknown, PeopleArgs> {
    return {
        command: 'people [folder]',
        describe: _('List the addresses of a case folder by how much mail they sent and received'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder'), type: 'string' })
                .option('case', { describe: _('The case folder'), type: 'string' })
                .option('search', {
                    describe: _('Only addresses or names containing this text'),
                    type: 'string',
                })
                .option('limit', { describe: _('How many addresses to list'), type: 'number', default: 50 })
                .option('json', { describe: _('Print the list as JSON'), type: 'boolean', default: false }),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('people', args.case, [args.folder]).root);
            const db = openIndex(paths);
            try {
                if (!addressesComplete(db)) backfillAll(db);
                const people = peopleList(db, {
                    limit: args.limit ?? 50,
                    ...(args.search !== undefined ? { search: args.search } : {}),
                });
                if (args.json) {
                    console.log(JSON.stringify(people, undefined, 2));
                    return;
                }
                for (const person of people) {
                    const name = person.names[0]?.name;
                    console.log(
                        fmt(_('{count} {address}{name} ({sent} sent, {received} received)'), {
                            count: String(person.messages).padStart(7),
                            address: person.address,
                            name: name !== undefined ? ` ${name}` : '',
                            sent: String(person.sent),
                            received: String(person.received),
                        }),
                    );
                }
                console.log(
                    fmt(_n('{n} address listed.', '{n} addresses listed.', people.length), {
                        n: String(people.length),
                    }),
                );
            } finally {
                db.close();
            }
        },
    };
}
