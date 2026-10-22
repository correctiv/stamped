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
    explainMessage,
    fmt,
    _,
    _n,
    type KeyPair,
    type MessageFinding,
    type Verdict,
} from '@stamped/core';

import { caveatTexts, evidenceFields, signatureHeading, type EvidenceKey } from '../../lib/evidence.ts';
import { escapeLine } from './markup.ts';
import { verdictLook, withoutVerdictPrefix } from './verdict.ts';

/** One fact, escaped and ready for a row. */
export interface FactRow {
    readonly label: string;
    readonly value: string;
    /** What this fact is, behind the row's ⓘ. See {@link explainEvidenceField}. */
    readonly explanation: string;
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
    /** Why the verdict is what it is, in one sentence; absent when there is nothing to explain. */
    readonly why?: string;
    /**
     * The key this message is waiting for, when that is the whole reason it has no verdict.
     *
     * The domain and the selector rather than the DNS name, because what the card does with it
     * is offer a lookup, and a lookup takes the pair. Present for `no-key` alone: every other
     * unverifiable reason is something a fetch would not fix.
     */
    readonly missingKey?: KeyPair;
}

export function verdictCard(finding: MessageFinding): VerdictCard {
    const look = verdictLook(finding.verdict);
    const count = finding.signatures.length;
    const why = explainMessage(finding);
    const note =
        finding.basis && finding.caveats.includes('signer-not-author')
            ? escapeLine(describeCaveat('signer-not-author', finding.basis.evidence))
            : undefined;
    const missingKey = missingKeyOf(finding);
    return {
        verdict: finding.verdict,
        badge: escapeLine(look.label),
        cssClass: look.cssClass,
        icon: look.icon,
        // The badge above the sentence already says `Unverifiable`, so the sentence does not say
        // it a second time. This drops a duplicate label; it never rewrites the finding.
        sentence: escapeLine(withoutVerdictPrefix(describeVerdict(finding.verdict))),
        ...(note !== undefined ? { note } : {}),
        ...(why ? { why: escapeLine(why.sentence) } : {}),
        ...(missingKey !== undefined ? { missingKey } : {}),
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
 * The pair a `no-key` verdict is waiting for, or nothing.
 *
 * Narrow on purpose. `no-key` is the one unverifiable reason a fetch can answer, so it is the one
 * that may offer a lookup. A button on `bad-key` or `unsupported` would send a query that
 * discloses the domain and changes nothing.
 */
function missingKeyOf(finding: MessageFinding): KeyPair | undefined {
    const evidence = finding.basis?.evidence;
    if (!evidence || evidence.unverifiableBecause !== 'no-key') return undefined;
    if (evidence.domain === '' || evidence.selector === '') return undefined;
    return { domain: evidence.domain, selector: evidence.selector };
}

/**
 * What one line of the evidence chain is, for the ⓘ beside it.
 *
 * WHY EVERY ROW AND NOT A TEXT BLOCK ABOVE THE LIST. The chain is ten lines of vocabulary a
 * journalist has every right not to know, and a paragraph explaining all ten is a paragraph read
 * by nobody: the reader is looking at ONE line, usually the one that broke. So the explanation
 * sits on the line it explains, and the person reads the one they are stuck on.
 *
 * Each paragraph says what the field is and what it would mean if it were wrong, because the
 * second is the reason anyone opens it. The `switch` is exhaustive over {@link EvidenceKey}, so a
 * field added to the chain does not compile until it has an explanation.
 */
export function explainEvidenceField(key: EvidenceKey): string {
    return escapeLine(evidenceExplanation(key));
}

function evidenceExplanation(key: EvidenceKey): string {
    switch (key) {
        case 'domain':
            return _(
                'The domain that signed this message, taken from the signature itself. It is the domain whose published key has to check out, and it is not necessarily the domain in the From line.',
            );
        case 'author-domain':
            return _(
                'The domain in the From line, which is what a reader sees as the sender. A signature from a different domain proves only that the other domain handled the message.',
            );
        case 'aligned':
            return _(
                'Whether the signing domain and the From domain are the same. Aligned means the sender signed for itself. Not aligned means somebody else did, such as a mailing list or a mail provider.',
            );
        case 'selector':
            return _(
                'Which of a domain’s keys signed this message. A domain publishes several and names each one, so the selector plus the domain is the address of the public key.',
            );
        case 'algorithm':
            return _(
                'The hash and the signature algorithm used, such as rsa-sha256. SHA-1 is broken, so a signature made with rsa-sha1 carries a caveat even when it verifies.',
            );
        case 'canonicalization':
            return _(
                'How much harmless reformatting the signature tolerates. Relaxed forgives rewrapped whitespace, simple forgives nothing, and mail servers reformat messages in transit all the time.',
            );
        case 'key':
            return _(
                'The public key that checked the signature: its size, and where this case got it. A key that came from the archive under examination proves the archive is consistent with itself, not that the message is genuine.',
            );
        case 'signed-headers':
            return _(
                'The header fields the signature covers. Any field not in this list could have been changed or added afterwards without breaking the signature, and Subject, To and Date are the ones that matter.',
            );
        case 'body-hash':
            return _(
                'The fingerprint of the body the sender signed, against the fingerprint this message’s body produces. Both are shown when they differ, so somebody else can repeat the comparison by hand.',
            );
        case 'signature':
            return _(
                'Whether the signature itself checks out against the public key. This covers the header fields listed above; the body is covered by the body hash.',
            );
        case 'length-limit':
            return _(
                'An l= tag, which signs only the first so many bytes of the body. Everything after that is unsigned and can be appended by anyone without breaking the signature.',
            );
        case 'reason':
            return _(
                'Why no verdict was possible. Almost always a missing public key, which says nothing against the message: fetch the key and it gets a verdict.',
            );
        case 'verifier-note':
            return _(
                'The wording of the library that did the cryptography, kept as it came. It is the line that separates two findings Stamped reports under the same reason, and a bug report without it cannot be acted on.',
            );
    }
}

/**
 * What DKIM is, for the ⓘ at the head of the evidence chain.
 *
 * ONE paragraph, above the chain rather than inside it: the per-row explanations assume the
 * reader knows roughly what a signature over a mail is, and this is where that assumption is
 * paid for. It says what a verifying signature does and does not prove, because the second half
 * is what keeps a confirmed message from being over-read.
 *
 * The button that opens it carries the question, so this is the answer alone. Escaped and
 * markup-free like every other explanation here: the help button reads the same string back as
 * its tooltip, and a tag would show up there as a tag.
 */
export function explainDkim(): string {
    return escapeLine(
        _(
            'DKIM lets a domain sign the messages it sends. The sending server hashes the body and some of the headers, signs the result with a private key, and publishes the matching public key in the DNS. Anyone holding that public key can check that the signed parts are unchanged. A signature that verifies proves the message left that domain in this form. It does not prove who wrote it, and it says nothing about the parts the signature does not cover.',
        ),
    );
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
            // Without its label, like the verdict card: the heading already numbers and names this
            // signature's verdict, and the badge beside it names it a third time.
            sentence: escapeLine(withoutVerdictPrefix(look.sentence)),
            facts: evidenceFields(signature).map((field) => ({
                label: escapeLine(field.label),
                value: escapeLine(field.value),
                explanation: explainEvidenceField(field.key),
            })),
            caveats: caveatTexts(signature).map((caveat) => ({
                caveat: caveat.caveat,
                text: escapeLine(caveat.text),
            })),
        };
    });
}
