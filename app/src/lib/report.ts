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
    explainSignature,
    fmt,
    type MessageFinding,
    type SignatureFinding,
    _,
} from '@stamped/core';

import { caveatTexts, evidenceFields, signatureHeading } from './evidence.ts';

/**
 * The least width at which the column still reads as a column.
 *
 * The real width is measured from the labels of the block being printed, because the labels are
 * TRANSLATED: a constant wide enough for "Signed headers" leaves the German "Signierte
 * Kopfzeilen" touching its own value, and nothing in the English test run would show it.
 */
const MIN_LABEL_WIDTH = 18;

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
    const why = explainSignature(finding);
    if (why) {
        lines.push(`  ${why.sentence}`);
        for (const { label, value } of why.details) lines.push(`    ${label}: ${value}`);
    }
    const fields = evidenceFields(finding);
    const width = Math.max(MIN_LABEL_WIDTH, ...fields.map((field) => field.label.length + 2));
    for (const { label, value } of fields) {
        lines.push(`  ${label.padEnd(width)}${value}`);
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
                reason: explainSignature(signature)?.code,
                explanation: explainSignature(signature)?.sentence,
                caveats: signature.caveats,
                evidence: signature.evidence,
            })),
        },
        undefined,
        2,
    );
}
