/**
 * Why a message got the verdict it got, in a sentence a journalist can repeat to an editor.
 *
 * The verdict says WHAT was found; this module says WHY, from facts the evidence already holds:
 * the two body hashes, `l=`, the key's age and size, the `h=` list, and the result of a retry
 * that undoes common export damage. It never changes a verdict. A retry that matches is an
 * EXPLANATION ("likely changed by the export, not by a person") and is only worded that way when
 * the retry really produced the signed hash.
 *
 * Pure like the classifier: evidence in, sentence out.
 */

import { fmt, _ } from './i18n.ts';
import type { MessageFinding, SignatureFinding, UnverifiableReason } from './verdict.ts';

/** Every specific reason, stable identifiers for tests, JSON and filters. */
export const REASON_CODES = [
    'body-export-dot-stuffing',
    'body-export-line-endings',
    'body-export-both',
    'body-signed-part-changed',
    'body-changed',
    'headers-key-maybe-rotated',
    'headers-changed',
    'unverifiable-no-key',
    'unverifiable-key-mismatch',
    'unverifiable-bad-key',
    'unverifiable-malformed-signature',
    'unverifiable-key-rejects-signature',
    'unverifiable-expired',
    'unverifiable-lookup-failed',
    'unverifiable-unsupported',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** One fact behind the sentence: shown behind an expander, never as the headline. */
export interface ReasonDetail {
    readonly label: string;
    readonly value: string;
}

/** The sentence, its identifier, and the facts it rests on. */
export interface Explanation {
    readonly code: ReasonCode;
    readonly sentence: string;
    readonly details: readonly ReasonDetail[];
}

/** Explain one signature. `undefined` for a confirmed or unsigned one: nothing to explain. */
export function explainSignature(finding: SignatureFinding): Explanation | undefined {
    const evidence = finding.evidence;
    switch (finding.verdict) {
        case 'body-altered':
            return explainBody(finding);
        case 'headers-altered': {
            const details: ReasonDetail[] = [
                { label: _('Signed header fields'), value: evidence.signedHeaders.join(', ') || _('(none)') },
                {
                    label: _('Which one changed'),
                    value: _('not determinable: a signature only says that the set as a whole differs'),
                },
            ];
            if (finding.caveats.includes('key-newer-than-message')) {
                if (evidence.keySince) details.push({ label: _('Key first seen'), value: evidence.keySince });
                if (evidence.messageDate)
                    details.push({ label: _('Message date'), value: evidence.messageDate });
                return {
                    code: 'headers-key-maybe-rotated',
                    sentence: _(
                        'The body is intact, but the header signature does not verify. The key we hold was first seen after this message was sent, so the sender may have replaced it since: this may be a wrong key rather than an edit.',
                    ),
                    details,
                };
            }
            return {
                code: 'headers-changed',
                sentence: _(
                    'The body is intact, but at least one header field covered by the signature (such as From, Subject or Date) is not what was signed. The signature cannot say which one.',
                ),
                details,
            };
        }
        case 'unverifiable':
            return evidence.unverifiableBecause
                ? explainUnverifiable(finding, evidence.unverifiableBecause)
                : undefined;
        default:
            return undefined;
    }
}

/** Explain the signature the message verdict rests on. */
export function explainMessage(finding: MessageFinding): Explanation | undefined {
    return finding.basis ? explainSignature(finding.basis) : undefined;
}

function explainBody(finding: SignatureFinding): Explanation {
    const evidence = finding.evidence;
    const details: ReasonDetail[] = [];
    if (evidence.bodyHashExpected)
        details.push({ label: _('Signed body hash'), value: evidence.bodyHashExpected });
    if (evidence.bodyHash) details.push({ label: _('Body hash of this message'), value: evidence.bodyHash });
    if (evidence.lengthLimit !== undefined) {
        details.push({ label: _('l= limit'), value: String(evidence.lengthLimit) });
    }
    const artefact = evidence.exportArtefact;
    if (artefact) {
        details.push({
            label: _('Retry'),
            value:
                artefact === 'dot-stuffing'
                    ? _('undoing doubled leading dots makes the hash match')
                    : artefact === 'line-endings'
                      ? _('converting line endings to CRLF makes the hash match')
                      : _('undoing doubled leading dots and converting line endings makes the hash match'),
        });
        const how =
            artefact === 'dot-stuffing'
                ? _('Lines that start with a dot were written with two dots')
                : artefact === 'line-endings'
                  ? _('The line endings were converted')
                  : _('Lines that start with a dot were doubled and the line endings were converted');
        return {
            code:
                artefact === 'dot-stuffing'
                    ? 'body-export-dot-stuffing'
                    : artefact === 'line-endings'
                      ? 'body-export-line-endings'
                      : 'body-export-both',
            sentence: fmt(
                _(
                    '{how}, and with that undone the signature matches. The body was most likely changed by the export, not by a person. The verdict stays body altered: this is an explanation, not a confirmation.',
                ),
                { how },
            ),
            details,
        };
    }
    if (evidence.exportRetried) {
        details.push({
            label: _('Retry'),
            value: _('undoing doubled leading dots and converting line endings does not make the hash match'),
        });
    }
    if (evidence.lengthLimit !== undefined) {
        return {
            code: 'body-signed-part-changed',
            sentence: fmt(
                _(
                    'The signature covers only the first {limit} bytes of the body, and even those are not what was signed. Text inside the signed part was added, removed or changed.',
                ),
                { limit: String(evidence.lengthLimit) },
            ),
            details,
        };
    }
    return {
        code: 'body-changed',
        sentence: evidence.exportRetried
            ? _(
                  'The text of the body is not the text that was signed: something was added, removed or changed after signing. Two harmless export effects (doubled leading dots, converted line endings) were tested and do not explain it.',
              )
            : _(
                  'The text of the body is not the text that was signed: something was added, removed or changed after signing.',
              ),
        details,
    };
}

function explainUnverifiable(finding: SignatureFinding, reason: UnverifiableReason): Explanation {
    const evidence = finding.evidence;
    const name = `${evidence.selector}._domainkey.${evidence.domain}`;
    const details: ReasonDetail[] = [{ label: _('Key name'), value: name }];
    if (evidence.note) details.push({ label: _('Verifier says'), value: evidence.note });
    const nothing = _('This is not evidence of tampering; it only means no verdict is possible.');
    switch (reason) {
        case 'no-key':
            return {
                code: 'unverifiable-no-key',
                sentence: fmt(
                    _(
                        'The message is signed, but the public key {name} that checks the signature is not in this case. {nothing}',
                    ),
                    { name, nothing },
                ),
                details,
            };
        case 'key-mismatch':
            return {
                code: 'unverifiable-key-mismatch',
                sentence: fmt(
                    _(
                        'The key we hold for {name} cannot have made this signature (different size or type). The sender probably replaced the key since. {nothing}',
                    ),
                    { name, nothing },
                ),
                details: [
                    ...details,
                    ...(evidence.keyBits !== undefined
                        ? [
                              {
                                  label: _('Key size'),
                                  value: fmt(_('{bits} bit'), { bits: String(evidence.keyBits) }),
                              },
                          ]
                        : []),
                    ...(evidence.signatureBits !== undefined
                        ? [
                              {
                                  label: _('Signature size'),
                                  value: fmt(_('{bits} bit'), { bits: String(evidence.signatureBits) }),
                              },
                          ]
                        : []),
                ],
            };
        case 'bad-key':
            return {
                code: 'unverifiable-bad-key',
                sentence: fmt(_('The key record for {name} is unusable. {nothing}'), { name, nothing }),
                details,
            };
        case 'malformed-signature':
            return {
                code: 'unverifiable-malformed-signature',
                sentence: fmt(_('The signature header itself is malformed and cannot be read. {nothing}'), {
                    nothing,
                }),
                details,
            };
        case 'key-rejects-signature':
            return {
                code: 'unverifiable-key-rejects-signature',
                sentence: fmt(
                    _('The key record for {name} does not allow this kind of signature. {nothing}'),
                    { name, nothing },
                ),
                details,
            };
        case 'expired':
            return {
                code: 'unverifiable-expired',
                sentence: fmt(
                    _('The signature has an expiry time that has passed or lies in the future. {nothing}'),
                    {
                        nothing,
                    },
                ),
                details,
            };
        case 'lookup-failed':
            return {
                code: 'unverifiable-lookup-failed',
                sentence: fmt(_('The key lookup failed and may work later. {nothing}'), { nothing }),
                details,
            };
        case 'unsupported':
            return {
                code: 'unverifiable-unsupported',
                sentence: fmt(
                    _('The signature algorithm or key type is not supported by this tool. {nothing}'),
                    {
                        nothing,
                    },
                ),
                details,
            };
    }
}
