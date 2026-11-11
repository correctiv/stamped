/**
 * The sentence a newsroom can quote for one message: what is established, by what, and with which
 * limit.
 *
 * One pure function for the terminal, the window and the PDF, so the three cannot word the same
 * finding differently. It adds no claim of its own: every sentence either states the verdict or
 * repeats what `describeCaveat` and `explainSignature` already say about it.
 *
 * WHOLE SENTENCES, NOT FRAGMENTS. Where the wording depends on a fact (the key's origin), each
 * variant is a complete sentence with placeholders for the names. Fragments glued together read
 * as grammar in English and as errors in a language with cases.
 */

import { describeCaveat } from './verdict.ts';
import { explainSignature } from './explain.ts';
import { fmt, _ } from './i18n.ts';
import type { Caveat, KeySource, MessageFinding } from './verdict.ts';

export interface CitationOptions {
    /** When the message was checked, already formatted. Left out of the sentence when absent. */
    readonly verifiedOn?: string;
    /**
     * The receiving server recorded `dkim=pass` for the signing domain. Only said for a signature
     * that carries no proof of its own (unverifiable, or a recovered key): everywhere else the
     * line would add nothing the signature has not already shown.
     */
    readonly receiverPass?: boolean;
}

/** Caveats the explanation sentence of a failed signature already says. */
const COVERED_BY_EXPLANATION: readonly Caveat[] = ['key-newer-than-message'];

function validSignature(domain: string, source: KeySource | undefined): string {
    switch (source) {
        case 'dns':
            return fmt(
                _(
                    'The message carries a valid DKIM signature of {domain}, checked against a key published in the public DNS.',
                ),
                { domain },
            );
        case 'operator':
            return fmt(
                _(
                    'The message carries a valid DKIM signature of {domain}, checked against a key supplied by the examiner.',
                ),
                { domain },
            );
        case 'archive':
            return fmt(
                _(
                    'The message carries a valid DKIM signature of {domain}, checked against a key found in the archive itself.',
                ),
                { domain },
            );
        case 'recovered':
            return fmt(
                _(
                    'The message carries a valid DKIM signature of {domain}, checked against a key recovered from other signatures.',
                ),
                { domain },
            );
        default:
            return fmt(_('The message carries a valid DKIM signature of {domain}.'), { domain });
    }
}

function signaturePresent(domain: string): string {
    return fmt(_('A DKIM signature of {domain} is present.'), { domain });
}

/** The caveat as a sentence of the citation. `recovered-key` is worded for a quote, not a manual. */
function caveatSentence(caveat: Caveat, finding: MessageFinding): string {
    if (caveat === 'recovered-key') {
        return _(
            'The key was recovered from other signatures: it shows that the same key signed these messages, not that it ever belonged to the domain.',
        );
    }
    return describeCaveat(caveat, finding.basis?.evidence);
}

/**
 * The citation sentence for a message, as one paragraph.
 *
 * Call after `initI18n()`.
 */
export function citationFor(finding: MessageFinding, options: CitationOptions = {}): string {
    if (finding.verdict === 'unsigned') {
        return _('The message carries no DKIM signature. That says nothing about it either way.');
    }

    const basis = finding.basis;
    const domain = basis?.evidence.domain ?? finding.signatures[0]?.evidence.domain ?? _('(unknown domain)');
    const why = basis ? explainSignature(basis) : undefined;
    const sentences: string[] = [];
    let notAlone = false;

    switch (finding.verdict) {
        case 'confirmed':
            sentences.push(
                validSignature(domain, basis?.evidence.keySource),
                _('The signed headers and body are unchanged since signing.'),
            );
            break;
        case 'confirmed-with-caveats':
            sentences.push(
                validSignature(domain, basis?.evidence.keySource),
                _('What the signature covers is unchanged since signing, with the following limits.'),
            );
            break;
        case 'body-altered': {
            // An export artefact is explained AWAY from the claim, so the lead has to make it; any
            // other explanation makes the claim itself and a lead would only say it twice.
            const artefact = basis?.evidence.exportArtefact !== undefined;
            sentences.push(
                !artefact && why !== undefined
                    ? signaturePresent(domain)
                    : fmt(
                          _(
                              'A DKIM signature of {domain} is present, but the body of this message is not the body that was signed.',
                          ),
                          { domain },
                      ),
            );
            notAlone = !artefact;
            break;
        }
        case 'headers-altered':
            sentences.push(
                why !== undefined
                    ? signaturePresent(domain)
                    : fmt(
                          _(
                              'A DKIM signature of {domain} is present, but a header field it covers is not what was signed.',
                          ),
                          { domain },
                      ),
            );
            notAlone = !finding.caveats.includes('key-newer-than-message');
            break;
        case 'unverifiable':
            sentences.push(
                fmt(_('A DKIM signature of {domain} is present, but it could not be checked.'), { domain }),
            );
            if (why === undefined) {
                sentences.push(_('This is not evidence of tampering; it only means no verdict is possible.'));
            }
            break;
    }

    if (why !== undefined) sentences.push(why.sentence);
    if (notAlone) sentences.push(_('That alone does not show manipulation.'));
    for (const caveat of finding.caveats) {
        if (COVERED_BY_EXPLANATION.includes(caveat)) continue;
        sentences.push(caveatSentence(caveat, finding));
    }

    const withoutProof = finding.verdict === 'unverifiable' || finding.caveats.includes('recovered-key');
    if (options.receiverPass === true && withoutProof) {
        sentences.push(
            _(
                'The receiving server recorded dkim=pass for this signature at delivery. That line is not signed: it is a claim of the archive and an indication, not proof.',
            ),
        );
    }
    if (options.verifiedOn !== undefined) {
        sentences.push(fmt(_('Checked on {date}.'), { date: options.verifiedOn }));
    }
    return sentences.join(' ');
}
