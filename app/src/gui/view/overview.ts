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

import { VERDICTS, fmt, _, _n, type Verdict } from '@stamped/core';
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
    return escapeLine(
        fmt(
            _n(
                '{messages} messages are waiting on {pairs} signing key. Collect it in the Keys view.',
                '{messages} messages are waiting on {pairs} signing keys. Collect them in the Keys view.',
                pairs,
            ),
            { messages: groupDigits(unverifiable), pairs: groupDigits(pairs) },
        ),
    );
}
