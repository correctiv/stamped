/**
 * How a verdict looks: a short badge, a colour, and the one sentence that may be shown beside it.
 *
 * The six verdicts are the product, so their presentation is a decision about the product rather
 * than about styling. Two rules hold this module together:
 *
 * - **The sentence is never rewritten here.** It comes from `describeVerdict` in `@stamped/core`,
 *   the same text the CLI prints. A GUI that paraphrased it would be a second claim about the
 *   same message, and the AGENTS.md note on `describeVerdict` says why that is not allowed.
 * - **`body-altered` and `headers-altered` keep different badges.** They share a colour because
 *   both are positive findings of tampering, but a reader must be able to tell at a glance which
 *   one was found: the body-hash mismatch and the header mismatch are the distinction the whole
 *   vocabulary exists for.
 *
 * `unverifiable` is deliberately NOT red. It is the absence of a finding, and a red badge would
 * read as "forged" — the mistake that gets a true story spiked.
 */

import { describeVerdict, type Verdict, VERDICTS, fmt, _ } from '@stamped/core';
import type { VerdictCount } from '@stamped/store';

import { escapeLine } from './markup.ts';

/** Everything a badge, a filter row or a verdict card needs for one verdict. */
export interface VerdictLook {
    readonly verdict: Verdict;
    /** Two or three words for a badge beside a subject line. */
    readonly label: string;
    /** The libadwaita style class the badge carries — `success`, `warning`, `error`, `dimmed`. */
    readonly cssClass: string;
    /** Symbolic icon name, for the card header and the filter row. */
    readonly icon: string;
    /** The full finding, from `@stamped/core`. Never rephrased. */
    readonly sentence: string;
}

/**
 * The badge label for a verdict.
 *
 * Short on purpose: it sits in a list row next to a subject, where the sentence would not fit.
 * The sentence is always one `?`-popover or one pane away, never replaced by the badge.
 */
function verdictLabel(verdict: Verdict): string {
    switch (verdict) {
        case 'confirmed':
            return _('Confirmed');
        case 'confirmed-with-caveats':
            return _('With caveats');
        case 'body-altered':
            return _('Body altered');
        case 'headers-altered':
            return _('Headers altered');
        case 'unverifiable':
            return _('Unverifiable');
        case 'unsigned':
            return _('Unsigned');
    }
}

/** The style class. See the module note on why `unverifiable` is not an error colour. */
function verdictCssClass(verdict: Verdict): string {
    switch (verdict) {
        case 'confirmed':
            return 'success';
        case 'confirmed-with-caveats':
            return 'warning';
        case 'body-altered':
        case 'headers-altered':
            return 'error';
        case 'unverifiable':
            return 'accent';
        case 'unsigned':
            return 'dimmed';
    }
}

/** Distinct icons for the two tampering verdicts: the badge colour alone does not separate them. */
function verdictIcon(verdict: Verdict): string {
    switch (verdict) {
        case 'confirmed':
            return 'emblem-ok-symbolic';
        case 'confirmed-with-caveats':
            return 'dialog-warning-symbolic';
        case 'body-altered':
            return 'edit-paste-symbolic';
        case 'headers-altered':
            return 'format-justify-left-symbolic';
        case 'unverifiable':
            return 'dialog-question-symbolic';
        case 'unsigned':
            return 'mail-unread-symbolic';
    }
}

export function verdictLook(verdict: Verdict): VerdictLook {
    return {
        verdict,
        label: verdictLabel(verdict),
        cssClass: verdictCssClass(verdict),
        icon: verdictIcon(verdict),
        sentence: describeVerdict(verdict),
    };
}

/**
 * What a verdict means, in one paragraph behind the `?` next to its filter row.
 *
 * Longer than the sentence and aimed at the question the sentence provokes — "so can I use it?".
 * Plain text, no markup: it goes into a popover label.
 */
export function explainVerdict(verdict: Verdict): string {
    switch (verdict) {
        case 'confirmed':
            return _(
                'A signature from the sender’s own domain verified against a key you trust, and it covers the fields that matter. The message is byte for byte what was signed.',
            );
        case 'confirmed-with-caveats':
            return _(
                'The cryptography checked out, but something limits what that proves — a weak algorithm, an unsigned Subject, or a key that came from the archive itself. Read the caveats before you quote the message.',
            );
        case 'body-altered':
            return _(
                'The signature is intact and the body does not match the hash it committed to. Somebody changed the text after it was signed. This is a finding, not a failure of the check.',
            );
        case 'headers-altered':
            return _(
                'The body is as signed, but one of the signed header fields is not. A changed Subject, From or Date — which can matter more than the body does.',
            );
        case 'unverifiable':
            return _(
                'A signature is present and nothing here could check it, almost always because the public key is missing. This says nothing against the message: fetch the key and it will get a verdict.',
            );
        case 'unsigned':
            return _(
                'The message carries no DKIM signature at all. Most mail before the mid-2010s does not. It is neither evidence for nor against authenticity.',
            );
    }
}

/** One row of the verdict filter list in the sidebar. */
export interface VerdictFilter {
    /** `undefined` for the "all messages" row. */
    readonly verdict?: Verdict;
    /** Escaped and ready for an `Adw.ActionRow` title. */
    readonly title: string;
    readonly count: number;
    readonly cssClass: string;
    readonly icon: string;
    /** The paragraph behind the row's `?`. Absent on the "all" row. */
    readonly explanation?: string;
}

/**
 * The sidebar filters: "all", then one row per verdict in {@link VERDICTS} order.
 *
 * EVERY VERDICT IS LISTED, including the ones at zero, and that is the same rule
 * `verdictCounts` follows for the printed report. A sidebar that hid the empty rows would read as
 * if those verdicts had not been looked for — and the row most often at zero is `body-altered`,
 * which is exactly the one whose absence must be visible as a measured zero.
 */
export function verdictFilters(counts: readonly VerdictCount[]): VerdictFilter[] {
    const counted = new Map<Verdict, number>();
    for (const count of counts) counted.set(count.verdict, count.messages);
    let total = 0;
    for (const count of counts) total += count.messages;

    const rows: VerdictFilter[] = [
        {
            title: escapeLine(_('All messages')),
            count: total,
            cssClass: 'dimmed',
            icon: 'mail-mark-important-symbolic',
        },
    ];
    for (const verdict of VERDICTS) {
        const look = verdictLook(verdict);
        rows.push({
            verdict,
            title: escapeLine(look.label),
            count: counted.get(verdict) ?? 0,
            cssClass: look.cssClass,
            icon: look.icon,
            explanation: explainVerdict(verdict),
        });
    }
    return rows;
}

/** `3 of 1,204 messages` for the message list's header — the denominator keeps a filter honest. */
export function filterSummary(shown: number, total: number): string {
    return fmt(_('{shown} of {total} shown'), { shown: String(shown), total: String(total) });
}
