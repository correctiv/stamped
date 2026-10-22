/**
 * The evidence chain as label/value pairs — the facts, before anyone decides how to lay them out.
 *
 * WHY A SEAM HERE. The CLI prints the chain as padded lines and the GUI puts it in rows of an
 * `Adw.ExpanderRow`, and those are two renderings of ONE set of facts. Two independent lists
 * would drift the moment a field is added, and a journalist comparing the window against a
 * printed report would find the window quietly missing a line — in a tool whose whole claim is
 * "here is why", a field that exists in one frontend and not the other is a defect of the
 * evidence, not of the layout. So the facts are assembled once, here, and
 * [`report.ts`](report.ts) pads them while `gui/view/evidence.ts` escapes them.
 *
 * Pure string assembly: no I/O, so the whole chain is unit-testable from one evidence object.
 */

import {
    describeCaveat,
    describeUnverifiableReason,
    fmt,
    type Caveat,
    type KeySource,
    type SignatureEvidence,
    type SignatureFinding,
    verdictLabel,
    _,
} from '@stamped/core';

/**
 * Which fact of the chain a row is, independent of what it is called.
 *
 * The label is translated and the GUI hangs an explanation on every row, so matching a row by its
 * label would mean matching on German in a German window. These identifiers are what the
 * explanation, a test and a filter all agree on.
 */
export const EVIDENCE_KEYS = [
    'domain',
    'author-domain',
    'aligned',
    'selector',
    'algorithm',
    'canonicalization',
    'key',
    'signed-headers',
    'body-hash',
    'signature',
    'length-limit',
    'reason',
    'verifier-note',
] as const;

export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

/** One fact of the chain: what it is, and what it was. */
export interface EvidenceField {
    readonly key: EvidenceKey;
    /** Lower case, so it reads as a label and not as a heading. Translated. */
    readonly label: string;
    readonly value: string;
}

/** One caveat, with the identifier a filter or a test can match on. */
export interface CaveatText {
    readonly caveat: Caveat;
    readonly text: string;
}

/**
 * `Signature 2 of 3, Body altered`.
 *
 * Numbered even when there is only one, because "Signature 1 of 2" is the thing a reader must not
 * miss: signatures are evaluated individually, and a message whose author-domain signature broke
 * while a mailing list's still verifies is a FINDING. One unnumbered block would let the
 * per-signature verdicts read as one.
 *
 * The verdict goes in by its LABEL, never by `finding.verdict`: the identifier is English in every
 * language, and a German window used to head a translated block with "confirmed".
 */
export function signatureHeading(finding: SignatureFinding, position: number, total: number): string {
    return fmt(_('Signature {position} of {total}, {verdict}'), {
        position: String(position),
        total: String(total),
        verdict: verdictLabel(finding.verdict),
    });
}

/**
 * Every fact that produced one signature's verdict, in the order a reader checks them.
 *
 * The order is the argument: who claims to have signed, whether that is the author's own domain,
 * which key, what the key covers, and only then the two cryptographic outcomes. Somebody else
 * with the same message and the same key must be able to arrive at the same sentence, by hand if
 * need be.
 */
export function evidenceFields(finding: SignatureFinding): EvidenceField[] {
    const evidence = finding.evidence;
    const fields: EvidenceField[] = [
        { key: 'domain', label: _('domain'), value: evidence.domain || _('(none)') },
        {
            key: 'author-domain',
            label: _('author domain'),
            value: evidence.authorDomain || _('(unknown)'),
        },
        { key: 'aligned', label: _('aligned'), value: evidence.aligned ? _('yes') : _('no') },
        { key: 'selector', label: _('selector'), value: evidence.selector || _('(none)') },
        { key: 'algorithm', label: _('algorithm'), value: evidence.algorithm || _('(none)') },
        {
            key: 'canonicalization',
            label: _('canonicalization'),
            value: evidence.canonicalization || _('(none)'),
        },
        { key: 'key', label: _('key'), value: keyLine(evidence) },
        {
            key: 'signed-headers',
            label: _('signed headers'),
            value: evidence.signedHeaders.join(':') || _('(none)'),
        },
        { key: 'body-hash', label: _('body hash'), value: bodyHashLine(evidence) },
        {
            key: 'signature',
            label: _('signature'),
            value: evidence.signatureOk ? _('verified') : _('not verified'),
        },
    ];

    if (evidence.lengthLimit !== undefined) {
        fields.push({ key: 'length-limit', label: _('l= limit'), value: lengthLimitLine(evidence) });
    }
    if (evidence.unverifiableBecause) {
        fields.push({
            key: 'reason',
            label: _('reason'),
            value: describeUnverifiableReason(evidence.unverifiableBecause),
        });
    }
    // The verifier's own wording, kept for the record: it is the one line that distinguishes two
    // findings this tool maps onto the same reason, and a bug report without it is unactionable.
    if (evidence.note) {
        fields.push({ key: 'verifier-note', label: _('verifier says'), value: evidence.note });
    }
    return fields;
}

/** One signature's caveats, each as the sentence `@stamped/core` declares for it. */
export function caveatTexts(finding: SignatureFinding): CaveatText[] {
    return finding.caveats.map((caveat) => ({
        caveat,
        text: describeCaveat(caveat, finding.evidence),
    }));
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
export function describeKeySource(source: KeySource): string {
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
        return fmt(_('differs. Signed {expected}, message hashes to {actual}'), {
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
