/**
 * `stamped report <case>` — what the case adds up to, and what to fetch next.
 *
 * Two tables. The verdict counts say what the case is worth as it stands. The
 * `(domain, selector)` table is the WORK LIST: an archive imported offline is mostly
 * `unverifiable`, because the mail arrived without the DNS records that would check it, and this
 * table answers "which single key, fetched once, turns the most of these into a verdict".
 *
 * The aggregation is `@stamped/store`'s, not this command's. Stage 2's key collection reads the
 * same function, so the table a journalist is looking at and the list the collector works through
 * can never be two different things.
 */

import { describeUnverifiableReason, describeVerdict, fmt, _, _n } from '@stamped/core';
import { caseReport, openIndex } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';

interface ReportArgs {
    case?: string;
    folder?: string;
    keys?: number;
    json?: boolean;
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function reportCommand(): CommandModule<unknown, ReportArgs> {
    return {
        command: 'report [folder]',
        describe: _('Summarise a case folder: verdicts, and which keys would answer the most mail'),
        builder: (yargs) =>
            yargs
                .positional('folder', { describe: _('The case folder to report on'), type: 'string' })
                .option('case', { describe: _('The case folder to report on'), type: 'string' })
                .option('keys', {
                    describe: _('How many (domain, selector) pairs to list'),
                    type: 'number',
                    default: 20,
                })
                .option('json', {
                    describe: _('Print the report as JSON'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped report ./case',
                    _('See how much of the case is still unverifiable, and which key would change that'),
                ),
        handler: (args) => {
            const paths = caseOrThrow(caseRoot('report', args.case, [args.folder]).root);
            const db = openIndex(paths);
            try {
                const report = caseReport(db, args.keys ?? 20);

                if (args.json) {
                    console.log(JSON.stringify(report, undefined, 2));
                    return;
                }

                console.log(paths.root);
                console.log(
                    fmt(
                        _n(
                            '{count} message, {bytes} bytes.',
                            '{count} messages, {bytes} bytes.',
                            report.messages,
                        ),
                        { count: String(report.messages), bytes: String(report.bytes) },
                    ),
                );
                if (report.earliest !== undefined && report.latest !== undefined) {
                    console.log(
                        fmt(_('Dated {earliest} to {latest}.'), {
                            earliest: isoDay(report.earliest),
                            latest: isoDay(report.latest),
                        }),
                    );
                }

                console.log('');
                console.log(_('Verdicts'));
                for (const count of report.verdicts) {
                    // Every verdict, including the zeroes: a table showing four of the six would
                    // read as if the other two had not been looked for.
                    console.log(`  ${String(count.messages).padStart(8)}  ${count.verdict}`);
                    if (count.messages > 0) console.log(`            ${describeVerdict(count.verdict)}`);
                }

                if (report.before) {
                    console.log('');
                    console.log(_('Before and now (verdict at first indexing, verdict today)'));
                    for (const now of report.verdicts) {
                        const was = report.before.find((b) => b.verdict === now.verdict)?.messages ?? 0;
                        if (was === 0 && now.messages === 0) continue;
                        console.log(
                            `  ${String(was).padStart(8)}  ${String(now.messages).padStart(8)}  ${now.verdict}`,
                        );
                    }
                }

                if (report.confirmation.signed > 0) {
                    const { signed, clean, withCaveats } = report.confirmation;
                    const pct = (n: number) => `${Math.round((n / signed) * 100)}%`;
                    console.log('');
                    console.log(
                        fmt(
                            _(
                                'Signed mail confirmed: {all} of {signed} ({allPct}) including caveats, {clean} ({cleanPct}) without.',
                            ),
                            {
                                all: String(clean + withCaveats),
                                signed: String(signed),
                                allPct: pct(clean + withCaveats),
                                clean: String(clean),
                                cleanPct: pct(clean),
                            },
                        ),
                    );
                }

                if (report.missing.length > 0) {
                    console.log('');
                    console.log(_('Most missing keys'));
                    for (const m of report.missing) {
                        console.log(
                            `  ${String(m.messages).padStart(8)}  ${m.selector}._domainkey.${m.domain}`,
                        );
                    }
                    const top = report.missing[0];
                    console.log(
                        fmt(_('Hint: stamped keys template {domain} {selector}'), {
                            domain: top.domain,
                            selector: top.selector,
                        }),
                    );
                }

                const caveats = report.caveats.filter((c) => c.messages > 0);
                if (caveats.length > 0) {
                    console.log('');
                    console.log(_('Caveats'));
                    for (const c of caveats) {
                        console.log(`  ${String(c.messages).padStart(8)}  ${c.caveat}`);
                    }
                }

                if (report.reasons.length > 0) {
                    // The reasons under the `unverifiable` line: a count of 389 is the question,
                    // "no key for 3 selectors" is the answer.
                    console.log('');
                    console.log(_('No verdict, by reason'));
                    for (const reason of report.reasons) {
                        console.log(`  ${String(reason.messages).padStart(8)}  ${reason.reason}`);
                        console.log(`            ${describeUnverifiableReason(reason.reason)}`);
                    }
                }

                console.log('');
                if (report.keys.length === 0) {
                    console.log(_('No DKIM signatures in this case, so no keys are needed.'));
                    return;
                }
                console.log(_('Keys, by how much mail depends on them'));
                console.log(
                    `  ${_('messages').padStart(8)}  ${_('unverifiable').padStart(12)}  ${_('confirmed').padStart(9)}  ${_('w/ caveats').padStart(10)}  ${_('selector._domainkey.domain')}`,
                );
                for (const key of report.keys) {
                    console.log(
                        `  ${String(key.messages).padStart(8)}  ${String(key.unverifiable).padStart(12)}  ${String(key.confirmed).padStart(9)}  ${String(key.withCaveats).padStart(10)}  ${key.selector}._domainkey.${key.domain}`,
                    );
                }
            } finally {
                db.close();
            }
        },
    };
}

/**
 * An epoch millisecond as a plain date.
 *
 * The day and not the time: these are the sender's own `Date` headers, an unsigned one of which
 * can say anything, and a to-the-second range would suggest a precision the evidence does not
 * have.
 */
function isoDay(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}
