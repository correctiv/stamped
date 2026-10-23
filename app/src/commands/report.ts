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
import {
    bodyAlteredBreakdown,
    caseReport,
    domainsByVerdict,
    openIndex,
    periodBreakdown,
    rawSetDigest,
    unsignedBreakdown,
} from '@stamped/store';
import { basename, resolve } from 'node:path';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { bodyAlteredSection } from '../lib/body-altered.ts';
import { buildPdfModel } from '../lib/pdf-report-model.ts';
import { loadVault } from '../lib/vault.ts';
import { VERSION } from '../lib/version.ts';

interface ReportArgs {
    case?: string;
    folder?: string;
    keys?: number;
    json?: boolean;
    pdf?: string;
    unsignedBreakdown?: boolean;
    anonymizeMailboxes?: boolean;
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
                .option('pdf', {
                    describe: _('Write a verification report for journalists as a PDF to this file'),
                    type: 'string',
                })
                .option('unsigned-breakdown', {
                    describe: _(
                        'With --pdf: add why messages are unsigned (reads one raw file per unsigned message)',
                    ),
                    type: 'boolean',
                    default: false,
                })
                .option('anonymize-mailboxes', {
                    describe: _('With --pdf: replace mailbox names by M1, M2, …'),
                    type: 'boolean',
                    default: false,
                })
                .example(
                    'stamped report ./case',
                    _('See how much of the case is still unverifiable, and which key would change that'),
                ),
        handler: async (args) => {
            const paths = caseOrThrow(caseRoot('report', args.case, [args.folder]).root);
            const db = openIndex(paths);
            try {
                const report = caseReport(db, { keyLimit: args.keys ?? 20, paths });

                if (args.pdf !== undefined) {
                    // Imported here: the GI modules are GJS-only and the other paths need none.
                    const { renderPdfReport } = await import('../lib/pdf-report.ts');
                    const model = buildPdfModel({
                        caseName: basename(resolve(paths.root)),
                        checkedAt: new Date(),
                        version: VERSION,
                        report,
                        periods: periodBreakdown(db, paths),
                        domains: domainsByVerdict(db, 15),
                        digest: rawSetDigest(db),
                        keys: loadVault(paths.root).all(),
                        bodyAltered: bodyAlteredBreakdown(db, paths),
                        ...(args.unsignedBreakdown ? { unsigned: unsignedBreakdown(db, paths) } : {}),
                        anonymizeMailboxes: args.anonymizeMailboxes === true,
                    });
                    const { pages } = await renderPdfReport(model, args.pdf);
                    console.log(
                        fmt(_n('Wrote {file} ({pages} page).', 'Wrote {file} ({pages} pages).', pages), {
                            file: args.pdf,
                            pages: String(pages),
                        }),
                    );
                    return;
                }

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

                if (report.mailboxes !== undefined) {
                    console.log('');
                    console.log(_('Mailboxes'));
                    for (const mailbox of report.mailboxes) {
                        console.log(`  ${String(mailbox.messages).padStart(8)}  ${mailbox.mailbox}`);
                        // The verdict spread as one line: the breakdown of a case is the same six
                        // verdicts everywhere, and a table per mailbox would push the work list
                        // off the screen.
                        const spread = mailbox.verdicts.filter((count) => count.messages > 0);
                        if (spread.length > 0) {
                            console.log(
                                `            ${spread.map((count) => `${count.messages} ${count.verdict}`).join(', ')}`,
                            );
                        }
                    }
                }

                const altered = report.alterations.filter((count) => count.messages > 0);
                if (altered.length > 0) {
                    console.log('');
                    console.log(_('Altered messages, and the keys behind them'));
                    for (const count of altered) {
                        console.log(`  ${String(count.messages).padStart(8)}  ${count.verdict}`);
                        if (count.possiblyWrongKey > 0) {
                            // The line that keeps a sum from being read as an accusation: a key
                            // created after the message explains the failure without tampering.
                            console.log(
                                `            ${fmt(
                                    _('{n} of them equally explained by a key newer than the message'),
                                    { n: String(count.possiblyWrongKey) },
                                )}`,
                            );
                        }
                        for (const reason of count.reasons) {
                            console.log(
                                `            ${String(reason.messages).padStart(6)}  ${reason.selector}._domainkey.${reason.domain}`,
                            );
                        }
                    }
                }

                const bodySection = bodyAlteredSection(bodyAlteredBreakdown(db, paths));
                if (bodySection !== undefined) {
                    console.log('');
                    console.log(_('Body altered: export artefacts and indications'));
                    console.log(`  ${bodySection.basis}`);
                    console.log(`  ${bodySection.explainedNote}`);
                    for (const [label, messages] of bodySection.explained) {
                        console.log(`  ${String(messages).padStart(8)}  ${label}`);
                    }
                    if (bodySection.unexplained > 0) {
                        console.log(`  ${bodySection.indicatorNote}`);
                        console.log(
                            `  ${String(bodySection.unexplained).padStart(8)}  ${_('Not explained')}`,
                        );
                        for (const [label, messages] of bodySection.indicators) {
                            console.log(
                                `            ${String(messages).padStart(6)}  ${label} (${_('Indication, not proof')})`,
                            );
                        }
                    }
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

                const conflicts = loadVault(paths.root).conflicts();
                if (conflicts.length > 0) {
                    // Era selection already resolved every pair it safely could; a name still
                    // listed here holds two live keys neither era nor formatting tells apart —
                    // the rotation-or-forgery question a human has to answer.
                    console.log('');
                    console.log(_('Keys needing a human decision'));
                    for (const pair of conflicts) {
                        console.log(`  ${pair.selector}._domainkey.${pair.domain}`);
                    }
                    console.log(_('Hint: stamped keys resolve <selector>._domainkey.<domain>'));
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
                if (report.domains.length > 0) {
                    console.log(_('Signing domains, by how much mail they signed'));
                    for (const domain of report.domains) {
                        console.log(`  ${String(domain.messages).padStart(8)}  ${domain.domain}`);
                    }
                    console.log('');
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
