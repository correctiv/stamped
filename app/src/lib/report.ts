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
 * Pure string assembly: no I/O, so the whole report is unit-testable from one evidence object.
 */

import {
    describeCaveat,
    describeUnverifiableReason,
    describeVerdict,
    fmt,
    type KeySource,
    type MessageFinding,
    type SignatureEvidence,
    type SignatureFinding,
    _,
} from '@stamped/core';

/** How wide the label column is. Wide enough for the longest label below, plus a space. */
const LABEL_WIDTH = 17;

/** The whole report for one message: the verdict, then one block per signature. */
export function reportLines(finding: MessageFinding): string[] {
    const lines = [describeVerdict(finding.verdict)];
    for (const [index, signature] of finding.signatures.entries()) {
        lines.push('');
        lines.push(...signatureLines(signature, index + 1, finding.signatures.length));
    }
    return lines;
}

/**
 * One signature's block.
 *
 * Numbered even when there is only one, because "Signature 1 of 2" is the thing a reader must
 * not miss: signatures are evaluated individually, and a message whose author-domain signature
 * broke while a mailing list's still verifies is a FINDING. A single unnumbered block would let
 * the per-signature verdicts read as one.
 */
export function signatureLines(finding: SignatureFinding, position: number, total: number): string[] {
    const evidence = finding.evidence;
    const lines = [
        fmt(_('Signature {position} of {total} — {verdict}'), {
            position: String(position),
            total: String(total),
            verdict: finding.verdict,
        }),
        field(_('domain'), evidence.domain || _('(none)')),
        field(_('selector'), evidence.selector || _('(none)')),
        field(_('algorithm'), evidence.algorithm || _('(none)')),
        field(_('canonicalization'), evidence.canonicalization || _('(none)')),
        field(_('key'), keyLine(evidence)),
        field(_('signed headers'), evidence.signedHeaders.join(':') || _('(none)')),
        field(_('body hash'), bodyHashLine(evidence)),
        field(_('signature'), evidence.signatureOk ? _('verified') : _('not verified')),
    ];

    if (evidence.lengthLimit !== undefined) {
        lines.push(field(_('l= limit'), lengthLimitLine(evidence)));
    }
    if (evidence.unverifiableBecause) {
        lines.push(field(_('reason'), describeUnverifiableReason(evidence.unverifiableBecause)));
    }
    // The verifier's own wording, kept for the record: it is the one line that distinguishes two
    // findings this tool maps onto the same reason, and a bug report without it is unactionable.
    if (evidence.note) {
        lines.push(field(_('verifier says'), evidence.note));
    }
    for (const caveat of finding.caveats) {
        lines.push(fmt(_('  caveat: {text}'), { text: describeCaveat(caveat) }));
    }
    return lines;
}

/** `  label            value`, with the label padded into its column. */
function field(label: string, value: string): string {
    return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** The key's size and provenance, or the fact that no key was ever fetched. */
function keyLine(evidence: SignatureEvidence): string {
    if (evidence.keySource === undefined) return _('none fetched');
    const source = describeKeySource(evidence.keySource);
    if (evidence.keyBits === undefined) {
        // Ed25519 has no modulus, so a missing size is normal rather than missing information.
        return source;
    }
    return fmt(_('{bits} bit, {source}'), { bits: String(evidence.keyBits), source });
}

/** Where a key came from, in the words the `archive-key` caveat uses. */
function describeKeySource(source: KeySource): string {
    switch (source) {
        case 'dns':
            return _('from the DNS');
        case 'operator':
            return _('supplied by you');
        case 'archive':
            return _('from the archive itself');
    }
}

/**
 * The body hash line, with both hashes whenever they differ.
 *
 * Printing both is the point: `bh=` is what the signer committed to and the other is what this
 * message actually hashes to, so the two strings together are the evidence that the body changed.
 * One of them alone is a number nobody can check.
 */
function bodyHashLine(evidence: SignatureEvidence): string {
    if (evidence.bodyHashOk) {
        return evidence.bodyHash
            ? fmt(_('matches ({hash})'), { hash: evidence.bodyHash })
            : _('matches');
    }
    if (evidence.bodyHash && evidence.bodyHashExpected) {
        return fmt(_('differs — signed {expected}, message hashes to {actual}'), {
            expected: evidence.bodyHashExpected,
            actual: evidence.bodyHash,
        });
    }
    return _('not checked');
}

/** How much of the body `l=` leaves out, in canonicalized bytes. */
function lengthLimitLine(evidence: SignatureEvidence): string {
    const limit = String(evidence.lengthLimit ?? 0);
    if (evidence.unsignedBodyBytes === undefined) {
        return fmt(_('{limit} bytes of the body are signed'), { limit });
    }
    return fmt(_('{limit} bytes of the body are signed, {unsigned} are not'), {
        limit,
        unsigned: String(evidence.unsignedBodyBytes),
    });
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
