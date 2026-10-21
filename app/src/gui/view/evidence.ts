/**
 * The right pane: the verdict in one card, then the evidence chain of every signature.
 *
 * The shape of the pane is the argument it makes. The card says what Stamped claims, in the one
 * sentence `@stamped/core` declares for that verdict — and directly beneath it, not behind a
 * menu, stands every fact the claim rests on. A reader who disagrees with the verdict must be
 * able to see what to disagree with.
 *
 * The facts come from [`../../lib/evidence.ts`](../../lib/evidence.ts), the same list the CLI
 * prints, so the window and a printed report cannot say different things about one message. This
 * module adds only presentation: escaping, badges, and the grouping into cards.
 */

import {
    describeCaveat,
    describeVerdict,
    fmt,
    _,
    _n,
    type MessageFinding,
    type Verdict,
} from '@stamped/core';

import { caveatTexts, evidenceFields, signatureHeading } from '../../lib/evidence.ts';
import { escapeLine } from './markup.ts';
import { verdictLook } from './verdict.ts';

/** One fact, escaped and ready for a row. */
export interface FactRow {
    readonly label: string;
    readonly value: string;
}

/** One caveat, escaped, with its identifier kept for tests and for an icon. */
export interface CaveatRow {
    readonly caveat: string;
    readonly text: string;
}

/** The card at the top of the reader: what Stamped says about this message. */
export interface VerdictCard {
    readonly verdict: Verdict;
    readonly badge: string;
    readonly cssClass: string;
    readonly icon: string;
    /** `describeVerdict`, never rephrased. */
    readonly sentence: string;
    /**
     * The `signer-not-author` sentence, when the message verdict rests on a signature from
     * another domain. Present on the CARD rather than only in the signature block, because it is
     * the caveat that decides whether the CEO's mail reads as the CEO's.
     */
    readonly note?: string;
    /** `2 signatures examined`, or the sentence for an unsigned message. */
    readonly summary: string;
}

export function verdictCard(finding: MessageFinding): VerdictCard {
    const look = verdictLook(finding.verdict);
    const count = finding.signatures.length;
    const note =
        finding.basis && finding.caveats.includes('signer-not-author')
            ? escapeLine(describeCaveat('signer-not-author', finding.basis.evidence))
            : undefined;
    return {
        verdict: finding.verdict,
        badge: escapeLine(look.label),
        cssClass: look.cssClass,
        icon: look.icon,
        sentence: escapeLine(describeVerdict(finding.verdict)),
        ...(note !== undefined ? { note } : {}),
        summary: escapeLine(
            count === 0
                ? _('No DKIM signature was found in this message.')
                : fmt(_n('{count} signature examined.', '{count} signatures examined.', count), {
                      count: String(count),
                  }),
        ),
    };
}

/**
 * The title of the expander that holds a signature's caveats.
 *
 * Counted, and never phrased as a warning. A caveat is a limit on what a verified signature
 * proves, not a defect — "2 caveats" invites reading them, where "problems" would invite
 * discarding a message that may be perfectly genuine. The count is in the title so a collapsed
 * expander still says there is something under it.
 */
export function caveatsHeading(count: number): string {
    return escapeLine(fmt(_n('{count} caveat', '{count} caveats', count), { count: String(count) }));
}

/** One signature's block: its own verdict, its facts, its caveats. */
export interface SignatureCard {
    readonly heading: string;
    readonly verdict: Verdict;
    readonly badge: string;
    readonly cssClass: string;
    readonly icon: string;
    readonly sentence: string;
    readonly facts: readonly FactRow[];
    readonly caveats: readonly CaveatRow[];
}

/**
 * One card per signature, each with its OWN verdict.
 *
 * Not folded into the message verdict: a forwarder's passing signature says nothing about the
 * originator's, and a message whose author-domain signature broke while a mailing list's still
 * verifies is the finding the journalist came for. The heading numbers them even when there is
 * one, so a single block cannot read as "the" verdict.
 */
export function signatureCards(finding: MessageFinding): SignatureCard[] {
    const total = finding.signatures.length;
    return finding.signatures.map((signature, index) => {
        const look = verdictLook(signature.verdict);
        return {
            heading: escapeLine(signatureHeading(signature, index + 1, total)),
            verdict: signature.verdict,
            badge: escapeLine(look.label),
            cssClass: look.cssClass,
            icon: look.icon,
            sentence: escapeLine(look.sentence),
            facts: evidenceFields(signature).map((field) => ({
                label: escapeLine(field.label),
                value: escapeLine(field.value),
            })),
            caveats: caveatTexts(signature).map((caveat) => ({
                caveat: caveat.caveat,
                text: escapeLine(caveat.text),
            })),
        };
    });
}
