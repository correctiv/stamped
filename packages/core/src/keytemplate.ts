/**
 * The request a journalist can send to a mail provider asking for a historical DKIM key.
 *
 * Plain text, translated with the rest of the UI. It deliberately says nothing about the case:
 * a provider's support desk needs the selector and the period, not the story.
 */

import { fmt, _ } from './i18n.ts';

export interface KeyRequest {
    readonly domain: string;
    readonly selectors: readonly string[];
    /** The period the messages were sent in, as free text ("March 2019") or ISO dates. */
    readonly period?: string;
}

export function requestTemplate(request: KeyRequest): string {
    const names = request.selectors.map((s) => `  ${s}._domainkey.${request.domain}`).join('\n');
    const period = request.period?.trim()
        ? fmt(_('The messages in question were sent around {period}.'), {
              period: request.period.trim(),
          })
        : _('The messages in question were sent some time ago.');
    return [
        fmt(_('Subject: Request for historical DKIM public keys for {domain}'), {
            domain: request.domain,
        }),
        '',
        _('Hello,'),
        '',
        fmt(
            _(
                'I am verifying the authenticity of email messages that were signed with DKIM by {domain}. The signing keys have since been rotated or removed from the DNS, so I cannot check the signatures against the current records.',
            ),
            { domain: request.domain },
        ),
        '',
        _('Could you send me the public key records (the DNS TXT values) that were published for these selectors:'),
        '',
        names,
        '',
        period,
        '',
        _(
            'If a selector was never used or the key cannot be disclosed, a short note saying so helps just as much. Public keys are not secret, and I only need the TXT record text, ideally with the dates it was published and withdrawn.',
        ),
        '',
        _('Thank you,'),
    ].join('\n');
}
