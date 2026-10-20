/**
 * The evidence chain, as lines of text.
 *
 * WHY THE FACTS AND NOT JUST THE VERDICT: the verdict is a claim Stamped makes, and a journalist
 * has to be able to defend it to an editor, a lawyer, or the subject of the story. So every line
 * that led to it is printed — which domain, which selector, which algorithm, how long the key is,
 * where it came from, which headers the signature covers, whether the body hash matched and
 * whether the signature did. Somebody else with the same message and the same key must be able to
 * arrive at the same sentence, by hand if need be.
 *
 * The facts themselves live in [`evidence.ts`](evidence.ts), shared with the window; this module
 * is only the terminal's layout of them.
 */

import {
    describeCaveat,
    describeVerdict,
    fmt,
    type MessageFinding,
    type SignatureFinding,
    _,
} from '@stamped/core';

import { caveatTexts, evidenceFields, signatureHeading } from './evidence.ts';

/** How wide the label column is. Wide enough for the longest label in `evidenceFields`, plus a space. */
const LABEL_WIDTH = 17;

/** The whole report for one message: the verdict, then one block per signature. */
export function reportLines(finding: MessageFinding): string[] {
    const lines = [describeVerdict(finding.verdict)];
    // The message verdict cannot carry this caveat quietly: it is the one that decides whether
    // the CEO's mail reads as the CEO's.
    if (finding.basis && finding.caveats.includes('signer-not-author')) {
        lines.push(describeCaveat('signer-not-author', finding.basis.evidence));
    }
    for (const [index, signature] of finding.signatures.entries()) {
        lines.push('');
        lines.push(...signatureLines(signature, index + 1, finding.signatures.length));
    }
    return lines;
}

/** One signature's block: the numbered heading, the fields in a column, then the caveats. */
export function signatureLines(finding: SignatureFinding, position: number, total: number): string[] {
    const lines = [signatureHeading(finding, position, total)];
    for (const { label, value } of evidenceFields(finding)) {
        lines.push(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
    }
    for (const { text } of caveatTexts(finding)) {
        lines.push(fmt(_('  caveat: {text}'), { text }));
    }
    return lines;
}

/** The same finding as data, for `--json`. Keys are stable; new ones may be added. */
export function reportJson(finding: MessageFinding, source: string): string {
    return JSON.stringify(
        {
            source,
            verdict: finding.verdict,
            caveats: finding.caveats,
            signatures: finding.signatures.map((signature) => ({
                verdict: signature.verdict,
                caveats: signature.caveats,
                evidence: signature.evidence,
            })),
        },
        undefined,
        2,
    );
}
