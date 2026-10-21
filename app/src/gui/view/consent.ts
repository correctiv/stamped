/**
 * The dialog that asks before anything leaves the machine.
 *
 * Stamped is offline by default, and that is a privacy property rather than a convenience: a DNS
 * query for `<selector>._domainkey.<domain>` tells the signing domain's operator that someone is
 * examining a message from them, which for a leak can be the leak itself. So the window never
 * looks a key up on its own; it builds a {@link LookupConsent} from this dialog, and the lookup
 * functions refuse any pair the consent does not list.
 *
 * THE DIALOG SHOWS EXACTLY WHAT WILL BE SENT — every pair, in full, not "and 12 more". A list
 * that elided its tail would be consent to a request the person never saw. When the list is long
 * the dialog scrolls; it does not summarise.
 */

import { describeConsent, _, type KeyPair, type LookupChannel } from '@stamped/core';

import { escapeLine } from './markup.ts';

/**
 * The channels a lookup can go out over, in the order the menu offers them.
 *
 * DNS first because it is the authoritative answer, and `archive.prove.email` second because it
 * is a third party — the order is the recommendation. Listed here rather than in `window.ts` so
 * a channel added to `@stamped/core` is added to the menu by widening one array, and the
 * exhaustive `switch` in {@link channelLabel} then fails to compile until it has a name.
 */
export const LOOKUP_CHANNELS: readonly LookupChannel[] = ['dns', 'archive.prove.email'];

/**
 * What to call a channel on the button that picks it.
 *
 * ONE source for the name, shared by the menu item and by the accept button of the dialog that
 * follows it. Two literals would let the menu say "DNS" while the confirmation said something
 * else, and in a prompt about what leaves the machine the two have to be recognisably the same
 * thing.
 */
export function channelLabel(channel: LookupChannel): string {
    switch (channel) {
        case 'dns':
            return _('Query the DNS');
        case 'archive.prove.email':
            return _('Ask archive.prove.email');
    }
}

/** Everything an `Adw.AlertDialog` needs for the consent prompt. */
export interface ConsentDialog {
    readonly channel: LookupChannel;
    readonly heading: string;
    /** What the disclosure costs, in the words `@stamped/core` declares for this channel. */
    readonly body: string;
    /** One `<selector>._domainkey.<domain>` per pair, all of them. */
    readonly items: readonly string[];
    /** Label of the destructive-looking accept action. Names the channel, not just "OK". */
    readonly accept: string;
    readonly cancel: string;
    /** The pairs the resulting consent covers, unescaped, as they go to the lookup. */
    readonly pairs: readonly KeyPair[];
}

export function consentDialog(channel: LookupChannel, pairs: readonly KeyPair[]): ConsentDialog {
    const text = describeConsent(channel, pairs);
    return {
        channel,
        heading: escapeLine(text.title),
        body: escapeLine(text.warning),
        items: text.items.map(escapeLine),
        // Not "OK": the button says which network the request goes to, so the last thing read
        // before the click is the disclosure itself.
        accept: escapeLine(channelLabel(channel)),
        cancel: escapeLine(_('Stay offline')),
        pairs,
    };
}
