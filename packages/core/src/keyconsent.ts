/**
 * The consent a network lookup needs, and the text that asks for it.
 *
 * Stamped is offline by default. A lookup is a disclosure, so it happens only against a
 * {@link LookupConsent}: a value that names the channel and EXACTLY the pairs it covers. The CLI
 * builds one after a prompt (or `--yes`); the later GUI builds the same object from a dialog
 * showing {@link describeConsent}. A lookup function refuses any pair the consent does not list,
 * so the text a person agreed to and the requests that leave the machine cannot drift apart.
 */

import { fmt, _, _n } from './i18n.ts';
import { pairName, type KeyPair } from './keyvault.ts';

export type LookupChannel = 'dns' | 'archive.prove.email';

export interface LookupConsent {
    readonly channel: LookupChannel;
    readonly pairs: readonly KeyPair[];
}

/** What the person is told before agreeing. */
export interface ConsentText {
    readonly title: string;
    readonly warning: string;
    /** One `<selector>._domainkey.<domain>` per pair. */
    readonly items: readonly string[];
}

export function describeConsent(channel: LookupChannel, pairs: readonly KeyPair[]): ConsentText {
    const count = pairs.length;
    const items = pairs.map(pairName);
    if (channel === 'dns') {
        return {
            title: fmt(
                _n(
                    'Look up {count} key in the public DNS?',
                    'Look up {count} keys in the public DNS?',
                    count,
                ),
                { count },
            ),
            warning: _(
                'The query goes to the signing domain’s own name servers, so the domain’s operator — and anyone watching your resolver — can see which selector you asked for and when. That reveals interest in that domain.',
            ),
            items,
        };
    }
    return {
        title: fmt(
            _n(
                'Ask archive.prove.email for {count} key?',
                'Ask archive.prove.email for {count} keys?',
                count,
            ),
            { count },
        ),
        warning: _(
            'The domain and selector are sent to archive.prove.email (a third-party service run by the Proof of Email project). It does not tell the signing domain, but it learns which domains you are examining.',
        ),
        items,
    };
}

/** Does the consent cover this pair on this channel? */
export function consentCovers(consent: LookupConsent, channel: LookupChannel, pair: KeyPair): boolean {
    const name = pairName(pair);
    return consent.channel === channel && consent.pairs.some((p) => pairName(p) === name);
}
