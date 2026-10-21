/**
 * The result overview: what the whole case adds up to.
 *
 * The pane a journalist opens to answer "where does this archive stand" and, just as often, to
 * paste the numbers into a story memo. So it is built from `caseReport` — the same query
 * `stamped report` prints — and it keeps the six verdicts as six lines, zeroes included.
 *
 * A MEASURED ZERO IS A RESULT. The line most often at zero is `body-altered`, and that zero is
 * the sentence "we checked every message and found no tampering". An overview that dropped empty
 * rows would turn that finding into silence.
 */

import { VERDICTS, describeUnverifiableReason, fmt, _, _n, type Verdict } from '@stamped/core';
import type { AlterationCount, CaseReport, MailboxReport, VerdictCount } from '@stamped/store';

import type { ScopeRef } from '../session.ts';
import { formatBytes, groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';
import { verdictLook } from './verdict.ts';

/**
 * What tapping an overview row does to the message list.
 *
 * The rule behind the fields: a tapped number shows the messages it counted. So a row clears
 * whichever OTHER axis of the filter it did not name — a verdict row that kept a mailbox scope
 * would show fewer messages than its own number, and a scope row that kept a verdict the same.
 * The sidebar's own composition (a verdict within a chosen archive) is untouched.
 */
export interface OverviewFilter {
    /** The verdict axis — the sidebar's verdict selection. */
    readonly verdict?: Verdict;
    /** The "which messages" set, by what is true of them rather than by a verdict. */
    readonly scope?: ScopeRef;
    /** Clear every filter but the search term. */
    readonly all?: boolean;
}

/** The three filters of the message list, as a tap leaves them. The search term is not one of them. */
export interface FilterState {
    readonly verdict?: Verdict;
    /** The archive path the sidebar's list is on. */
    readonly source?: string;
    readonly scope?: ScopeRef;
}

/**
 * The filters after a tap — the rule behind every `filter` field of this module, as data.
 *
 * The window owns the widgets, so this is where the rule can be tested: a tap SHOWS THE MESSAGES
 * ITS NUMBER COUNTED, and that number is always a count over the whole case. So a row clears the
 * axis it did not name — a verdict row that kept a mailbox scope would show fewer messages than
 * its own number, and the mailbox's "All 412 messages" row has to mean all of them. Only a row
 * that names both axes (one mailbox's verdict lines) sets both.
 *
 * A returned object simply holds the axes the tap keeps or sets; an axis left out is an axis
 * cleared. The archive (`source`) survives a verdict tap because the sidebar composes exactly
 * that pair — it is replaced by a scope, which answers the same "which messages" question.
 */
export function tappedFilter(current: FilterState, filter: OverviewFilter): FilterState {
    if (filter.all === true) return {};
    if (filter.scope !== undefined) {
        return filter.verdict !== undefined
            ? { scope: filter.scope, verdict: filter.verdict }
            : { scope: filter.scope };
    }
    if (filter.verdict !== undefined) {
        return current.source !== undefined
            ? { verdict: filter.verdict, source: current.source }
            : { verdict: filter.verdict };
    }
    return { ...current };
}

/** One `label: value` line of the overview's first group. */
export interface OverviewStat {
    readonly label: string;
    /** Empty for a row with no subtitle — a child line under an expander. */
    readonly value: string;
    /** Set when the number is a filter: tapping the row shows those messages. */
    readonly filter?: OverviewFilter;
    /** Sub-rows, rendered as an expander: the verdicts behind one mailbox. */
    readonly rows?: readonly OverviewStat[];
}

/** One verdict's line, with the share that drives its bar. */
export interface VerdictShare {
    readonly verdict: Verdict;
    readonly label: string;
    /**
     * `describeVerdict`, escaped: the line under the label that says what the verdict means.
     *
     * Shown as the row's subtitle rather than behind the `?` alone: a counted badge a reader has
     * to look up is a badge that gets read as pass/fail, which is the collapse the six verdicts
     * exist to prevent. The `?` still carries the longer paragraph.
     */
    readonly sentence: string;
    readonly count: string;
    /** 0 … 1, for an `Adw.Bin` width or a `Gtk.LevelBar`. Zero when the case is empty. */
    readonly share: number;
    readonly cssClass: string;
    readonly icon: string;
}

/** How big the case is, over what period, out of how many bytes. */
export function overviewStats(report: CaseReport): OverviewStat[] {
    const stats: OverviewStat[] = [
        {
            label: escapeLine(_('Messages')),
            value: escapeLine(groupDigits(report.messages)),
            // The one line of the group whose number is a message count: it clears the filters
            // and shows the whole case. The other two lines are bytes and dates, not messages,
            // and a row that silently emptied the list would be a wrong answer to a tap.
            filter: { all: true },
        },
        {
            label: escapeLine(_('Raw mail stored')),
            value: escapeLine(formatBytes(report.bytes)),
        },
        {
            label: escapeLine(_('Period')),
            value: escapeLine(periodLine(report)),
        },
    ];
    return stats;
}

/**
 * The span the mail covers, from the dates that could be READ.
 *
 * Said as "the dates in the messages" rather than as a plain range, because both ends come from
 * `Date` headers — which are unsigned in many messages and can simply be wrong. The period is a
 * property of what the archive claims, not of when anything was really sent.
 */
function periodLine(report: CaseReport): string {
    if (report.earliest === undefined || report.latest === undefined) {
        return _('no readable dates');
    }
    return fmt(_('{from} to {to}, by the dates in the messages'), {
        from: isoDay(report.earliest),
        to: isoDay(report.latest),
    });
}

/** UTC, and only ever for a span: a single message's day comes from its own header (`shortDate`). */
function isoDay(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 10);
}

/** One line per verdict, in {@link VERDICTS} order, zeroes included. */
export function verdictShares(counts: readonly VerdictCount[]): VerdictShare[] {
    const counted = new Map<Verdict, number>();
    let total = 0;
    for (const count of counts) {
        counted.set(count.verdict, count.messages);
        total += count.messages;
    }
    return VERDICTS.map((verdict) => {
        const look = verdictLook(verdict);
        const messages = counted.get(verdict) ?? 0;
        return {
            verdict,
            label: escapeLine(look.label),
            sentence: escapeLine(look.sentence),
            count: escapeLine(groupDigits(messages)),
            share: total === 0 ? 0 : messages / total,
            cssClass: look.cssClass,
            icon: look.icon,
        };
    });
}

/**
 * The overview in one sentence, in the four groups a story memo needs.
 *
 * The groups merge `confirmed` with `confirmed-with-caveats` and the two tampering verdicts with
 * each other, which is a summary and is allowed to be one — but ONLY here, beside the six exact
 * lines, never instead of them. The sentence says "with caveats" and "altered" out loud so that
 * neither group can be read as a plain pass or a plain fail, and the per-verdict rows directly
 * below it hold the detail the merge left out.
 */
export function overviewHeadline(report: CaseReport): string {
    if (report.messages === 0) {
        return escapeLine(_('This case is empty. Import a mailbox to get started.'));
    }
    const counted = new Map<Verdict, number>();
    for (const count of report.verdicts) counted.set(count.verdict, count.messages);
    const of = (verdict: Verdict) => counted.get(verdict) ?? 0;

    const confirmed = of('confirmed') + of('confirmed-with-caveats');
    const altered = of('body-altered') + of('headers-altered');
    const sentence = fmt(
        _(
            '{total} messages: {confirmed} confirmed (of those {caveats} with caveats), {altered} altered, {unverifiable} without a verdict for want of a key, {unsigned} never signed.',
        ),
        {
            total: groupDigits(report.messages),
            confirmed: groupDigits(confirmed),
            caveats: groupDigits(of('confirmed-with-caveats')),
            altered: groupDigits(altered),
            unverifiable: groupDigits(of('unverifiable')),
            unsigned: groupDigits(of('unsigned')),
        },
    );
    return escapeLine(sentence);
}

/** The work still open, as the overview's call to action. */
export function overviewNextStep(report: CaseReport): string | undefined {
    const unverifiable = report.verdicts.find((count) => count.verdict === 'unverifiable')?.messages ?? 0;
    if (unverifiable === 0) return undefined;
    const pairs = report.keys.filter((key) => key.unverifiable > 0).length;
    // Two sentences, each inflected on its own count: one sentence carrying both counts can only
    // agree with one of them.
    const waiting = fmt(
        _n(
            '{messages} message has no verdict yet.',
            '{messages} messages have no verdict yet.',
            unverifiable,
        ),
        { messages: groupDigits(unverifiable) },
    );
    const collect = fmt(
        _n(
            'Collect the {pairs} signing key it needs in the Keys view.',
            'Collect the {pairs} signing keys they need in the Keys view.',
            pairs,
        ),
        { pairs: groupDigits(pairs) },
    );
    return escapeLine(`${waiting} ${collect}`);
}

/** The before/now, confirmation-share and missing-key lines of the overview. */
export interface OverviewInsight {
    readonly title: string;
    /** The group's own sentence of context, when the rows alone could be misread. */
    readonly description?: string;
    readonly rows: readonly OverviewStat[];
}

/**
 * Why messages here have no verdict, what changed since first indexing, how much signed mail is
 * confirmed, and which keys are missing most. Rows are omitted when there is nothing honest to
 * say (no history, no signed mail, nothing unverifiable).
 */
export function overviewInsights(report: CaseReport): OverviewInsight[] {
    const insights: OverviewInsight[] = [];
    const mailboxes = mailboxInsights(report);
    if (mailboxes) insights.push(mailboxes);
    const alterations = alterationInsights(report);
    if (alterations) insights.push(alterations);
    if (report.reasons.length > 0) {
        insights.push({
            title: escapeLine(_('Why messages have no verdict')),
            // The one sentence a reader must not miss about this group: summed reasons are not
            // summed findings of tampering, and a case summary that reads otherwise would spike
            // a true story.
            description: escapeLine(
                _('No verdict is possible for these messages. This is not evidence of tampering.'),
            ),
            rows: report.reasons.map((reason) => ({
                label: escapeLine(describeUnverifiableReason(reason.reason)),
                value: escapeLine(
                    fmt(_n('{n} message', '{n} messages', reason.messages), {
                        n: groupDigits(reason.messages),
                    }),
                ),
                filter: { scope: { kind: 'reason', reason: reason.reason } },
            })),
        });
    }
    if (report.before) {
        const rows: OverviewStat[] = [];
        for (const now of report.verdicts) {
            const was = report.before.find((b) => b.verdict === now.verdict)?.messages ?? 0;
            if (was === 0 && now.messages === 0) continue;
            rows.push({
                label: escapeLine(verdictLook(now.verdict).label),
                value: escapeLine(
                    fmt(_('{was} before, {now} now'), {
                        was: groupDigits(was),
                        now: groupDigits(now.messages),
                    }),
                ),
                // The NOW number is the one the row is about, so the row filters on the current
                // verdict — not on the pair, which is a comparison and not a set of messages.
                filter: { verdict: now.verdict },
            });
        }
        if (rows.length > 0) insights.push({ title: escapeLine(_('Before and now')), rows });
    }
    const { signed, clean, withCaveats } = report.confirmation;
    if (signed > 0) {
        const pct = (n: number) => `${Math.round((n / signed) * 100)}%`;
        insights.push({
            title: escapeLine(_('Signed mail confirmed')),
            rows: [
                {
                    label: escapeLine(_('Including caveats')),
                    value: escapeLine(
                        fmt(_('{n} of {signed} ({pct})'), {
                            n: groupDigits(clean + withCaveats),
                            signed: groupDigits(signed),
                            pct: pct(clean + withCaveats),
                        }),
                    ),
                    // Both confirmation verdicts as one scope: the verdict axis is single, and
                    // this row counts the two of them together.
                    filter: {
                        scope: { kind: 'verdicts', verdicts: ['confirmed', 'confirmed-with-caveats'] },
                    },
                },
                {
                    label: escapeLine(_('Without caveats')),
                    value: escapeLine(
                        fmt(_('{n} of {signed} ({pct})'), {
                            n: groupDigits(clean),
                            signed: groupDigits(signed),
                            pct: pct(clean),
                        }),
                    ),
                    filter: { verdict: 'confirmed' },
                },
            ],
        });
    }
    if (report.missing.length > 0) {
        insights.push({
            title: escapeLine(_('Most missing keys')),
            rows: report.missing.map((m) => ({
                label: escapeLine(`${m.selector}._domainkey.${m.domain}`),
                value: escapeLine(
                    fmt(_n('{n} message', '{n} messages', m.messages), { n: groupDigits(m.messages) }),
                ),
                // `missingOnly`: the number counts the no-key signatures, so the list must be the
                // same set — a message this pair already confirmed belongs to it as well.
                filter: {
                    scope: { kind: 'key', domain: m.domain, selector: m.selector, missingOnly: true },
                },
            })),
        });
    }
    const domains = domainInsights(report);
    if (domains) insights.push(domains);
    return insights;
}

/**
 * The mailboxes a folder import read from, each expandable to the verdicts behind it.
 *
 * Absent for a plain import — the index does not know a mailbox, so a case imported as files has
 * no breakdown to show and the group simply is not there (see {@link MailboxReport}).
 */
export function mailboxInsights(report: CaseReport): OverviewInsight | undefined {
    const mailboxes = report.mailboxes;
    if (mailboxes === undefined || mailboxes.length === 0) return undefined;
    return {
        title: escapeLine(_('Mailboxes')),
        description: escapeLine(
            _(
                'Which mailbox a message came out of is provenance from the import, not something the message says.',
            ),
        ),
        rows: mailboxes.map(mailboxStat),
    };
}

/** One mailbox as an expander: everything in it, then one line per verdict, zeroes included. */
function mailboxStat(mailbox: MailboxReport): OverviewStat {
    const scope: ScopeRef = { kind: 'mailbox', mailbox: mailbox.mailbox };
    return {
        label: escapeLine(mailbox.mailbox),
        value: messageCountLine(mailbox.messages),
        filter: { scope },
        rows: [
            {
                label: escapeLine(
                    fmt(_('All {n} messages of {mailbox}'), {
                        n: groupDigits(mailbox.messages),
                        mailbox: mailbox.mailbox,
                    }),
                ),
                value: '',
                filter: { scope },
            },
            ...mailbox.verdicts.map((count) => ({
                label: escapeLine(verdictLook(count.verdict).label),
                value: messageCountLine(count.messages),
                filter: { scope, verdict: count.verdict },
            })),
        ],
    };
}

/**
 * The two alterations as sums, each with the keys that stand behind it.
 *
 * The group is absent when nothing was altered — a group of zeroes would say "we looked" only by
 * having been built, and the six verdicts above already carry the measured zero. What is NOT
 * hidden is the newer-key count: an alteration summed over a rotated key is an accusation, and
 * the row it gets of its own is what keeps the sum honest.
 */
export function alterationInsights(report: CaseReport): OverviewInsight | undefined {
    const altered = report.alterations.reduce((sum, count) => sum + count.messages, 0);
    if (altered === 0) return undefined;
    const rotation = report.alterations.reduce((sum, count) => sum + count.possiblyWrongKey, 0);
    const rows: OverviewStat[] = [];
    for (const count of report.alterations) {
        if (count.messages === 0) continue;
        rows.push(alterationKindStat(count));
        rows.push(...alterationReasonStats(count));
    }
    return {
        title: escapeLine(_('Altered messages')),
        description: escapeLine(
            rotation > 0
                ? fmt(
                      _(
                          'The body hash of a body-altered message does not match what was signed. {n} of these failures are equally explained by a key that was created after the message was sent.',
                      ),
                      { n: groupDigits(rotation) },
                  )
                : _('The body hash of a body-altered message does not match what was signed.'),
        ),
        rows,
    };
}

/** One kind of alteration: the count, which filters the list to exactly that verdict. */
function alterationKindStat(count: AlterationCount): OverviewStat {
    return {
        label: escapeLine(verdictLook(count.verdict).label),
        value: messageCountLine(count.messages),
        filter: { verdict: count.verdict },
    };
}

/** The keys behind one alteration kind, and the newer-key count that bounds what it means. */
function alterationReasonStats(count: AlterationCount): OverviewStat[] {
    const rows: OverviewStat[] = [];
    if (count.possiblyWrongKey > 0) {
        rows.push({
            label: escapeLine(_('Equally explained by a newer key')),
            value: messageCountLine(count.possiblyWrongKey),
        });
    }
    for (const reason of count.reasons) {
        rows.push({
            label: escapeLine(`${reason.selector}._domainkey.${reason.domain}`),
            value: messageCountLine(reason.messages),
            filter: {
                scope: { kind: 'key', domain: reason.domain, selector: reason.selector },
                verdict: count.verdict,
            },
        });
    }
    return rows;
}

/** The signing domains the case carries, most mail first. */
export function domainInsights(report: CaseReport): OverviewInsight | undefined {
    if (report.domains.length === 0) return undefined;
    return {
        title: escapeLine(_('Top signing domains')),
        rows: report.domains.map((domain) => ({
            label: escapeLine(domain.domain),
            value: messageCountLine(domain.messages),
            filter: { scope: { kind: 'signer', domain: domain.domain } },
        })),
    };
}

/** `3 messages` — the plural rule belongs to gettext, not to an `n === 1` check here. */
function messageCountLine(messages: number): string {
    return escapeLine(fmt(_n('{n} message', '{n} messages', messages), { n: groupDigits(messages) }));
}

/**
 * What the filter banner says about a scope, in one sentence.
 *
 * Shown above the message list whenever a scope is on, because a scope has no row of its own
 * anywhere else — the sidebar knows verdicts and archives, and a mailbox, a signer or a single
 * key is none of those. Without this sentence a list narrowed by an overview tap reads as an
 * unexplained subset of the case.
 */
export function filterBannerText(scope: ScopeRef): string {
    switch (scope.kind) {
        case 'mailbox':
            return escapeLine(fmt(_('Only the mailbox {mailbox}'), { mailbox: scope.mailbox }));
        case 'verdicts':
            return escapeLine(
                fmt(_('Only these verdicts: {verdicts}'), {
                    verdicts: scope.verdicts.map((verdict) => verdictLook(verdict).label).join(', '),
                }),
            );
        case 'signer':
            return escapeLine(fmt(_('Only mail signed by {domain}'), { domain: scope.domain }));
        case 'key': {
            const name = `${scope.selector}._domainkey.${scope.domain}`;
            return escapeLine(
                scope.missingOnly === true
                    ? fmt(_('Only mail waiting for the key {name}'), { name })
                    : fmt(_('Only mail signed by the key {name}'), { name }),
            );
        }
        case 'reason':
            return escapeLine(
                fmt(_('Only mail with no verdict: {reason}'), {
                    reason: describeUnverifiableReason(scope.reason),
                }),
            );
    }
}
