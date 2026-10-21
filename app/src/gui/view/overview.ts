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
import type { CaseReport, VerdictCount } from '@stamped/store';

import { formatBytes, groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';
import { verdictLook } from './verdict.ts';

/** One `label: value` line of the overview's first group. */
export interface OverviewStat {
    readonly label: string;
    readonly value: string;
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
            })),
        });
    }
    return insights;
}
