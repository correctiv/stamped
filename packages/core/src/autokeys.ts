/**
 * Fetching every missing key of a case on ONE consent.
 *
 * After an import most messages are `unverifiable` for want of a key. The person is asked once,
 * with the whole list of (domain, selector) pairs and how many messages each one affects, and
 * the answer covers exactly that list: archive.prove.email first, then the public DNS for what
 * the archive did not have. Nothing outside the listed pairs is ever asked, because each lookup
 * runs against a {@link LookupConsent} naming those pairs and refuses any other.
 *
 * Pure: transport (`fetch`, a TXT resolver) and the question to the person are parameters, and
 * the vault is changed in memory — saving it is the caller's job.
 */

import { describeConsent, type ConsentText, type LookupChannel, type LookupConsent } from './keyconsent.ts';
import {
    lookupArchive,
    lookupDns,
    type FetchLike,
    type LookupResult,
    type TxtResolver,
} from './keylookup.ts';
import { fmt, _, _n } from './i18n.ts';
import {
    missingPairs,
    pairName,
    type KeyOrigin,
    type KeyPair,
    type KeyVault,
    type PairCount,
} from './keyvault.ts';

/** The one prompt: every pair, its message count, and what each channel discloses. */
export function describeAutoConsent(
    channels: readonly LookupChannel[],
    pairs: readonly PairCount[],
): ConsentText {
    const count = pairs.length;
    const warnings = channels.map((channel) => describeConsent(channel, pairs).warning);
    if (channels.length > 1) {
        warnings.push(_('The archive is asked first; the DNS only for the keys it does not have.'));
    }
    return {
        title: fmt(_n('Look up {count} missing key?', 'Look up {count} missing keys?', count), { count }),
        warning: warnings.join(' '),
        items: pairs.map((pair) =>
            pair.mails === undefined
                ? pairName(pair)
                : fmt(_n('{name}, {count} message', '{name}, {count} messages', pair.mails), {
                      name: pairName(pair),
                      count: pair.mails,
                  }),
        ),
    };
}

export interface AutoFetchOptions {
    /** In the order they are tried. */
    readonly channels: readonly LookupChannel[];
    /** Shows the consent text; anything but `true` sends nothing. */
    readonly confirm: (text: ConsentText) => Promise<boolean>;
    readonly fetch: FetchLike;
    readonly resolveTxt: TxtResolver;
    readonly now?: () => string;
}

export interface StoredKey {
    readonly pair: KeyPair;
    readonly origin: KeyOrigin;
    /** The pair already held a different record: both are kept, neither is trusted. */
    readonly conflict: boolean;
}

export interface AutoFetchSummary {
    /** The pairs the consent listed. Empty when there was nothing to ask. */
    readonly asked: readonly PairCount[];
    readonly consented: boolean;
    readonly stored: readonly StoredKey[];
    /** Pairs still without a key, with the last reason. */
    readonly misses: readonly { readonly pair: KeyPair; readonly reason: string }[];
    /** Pairs a channel could not answer for (rate limit, outage): unknown, not absent. */
    readonly errors: readonly { readonly pair: KeyPair; readonly reason: string }[];
}

export async function fetchKeys(
    vault: KeyVault,
    pairs: readonly PairCount[],
    options: AutoFetchOptions,
): Promise<AutoFetchSummary> {
    const todo = options.channels.length === 0 ? [] : missingPairs(pairs, vault);
    if (todo.length === 0) return { asked: [], consented: false, stored: [], misses: [], errors: [] };
    if (!(await options.confirm(describeAutoConsent(options.channels, todo)))) {
        return { asked: todo, consented: false, stored: [], misses: [], errors: [] };
    }

    const stored: StoredKey[] = [];
    const reasons = new Map<string, string>();
    const errored = new Set<string>();
    let remaining: PairCount[] = todo;
    for (const channel of options.channels) {
        if (remaining.length === 0) break;
        const consent: LookupConsent = { channel, pairs: todo };
        const result: LookupResult =
            channel === 'dns'
                ? await lookupDns(consent, remaining, options.resolveTxt)
                : await lookupArchive(consent, remaining, options.fetch);
        const fetchedAt = options.now?.() ?? new Date().toISOString();
        for (const found of result.found) {
            const outcome = vault.add({
                ...found.pair,
                key: found.key,
                origin: found.origin,
                fetchedAt,
                ...(found.seenFrom ? { seenFrom: found.seenFrom } : {}),
                ...(found.seenTo ? { seenTo: found.seenTo } : {}),
            });
            stored.push({ pair: found.pair, origin: found.origin, conflict: outcome.status === 'conflict' });
        }
        for (const miss of result.misses) reasons.set(pairName(miss.pair), miss.reason);
        for (const error of result.errors) {
            reasons.set(pairName(error.pair), error.reason);
            errored.add(pairName(error.pair));
        }
        remaining = missingPairs(remaining, vault);
    }
    return {
        asked: todo,
        consented: true,
        stored,
        misses: remaining
            .filter((pair) => !errored.has(pairName(pair)))
            .map((pair) => ({ pair, reason: reasons.get(pairName(pair)) ?? '' })),
        errors: remaining
            .filter((pair) => errored.has(pairName(pair)))
            .map((pair) => ({ pair, reason: reasons.get(pairName(pair)) ?? '' })),
    };
}
