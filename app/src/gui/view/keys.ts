/**
 * The key view: which keys are missing, what each one is, and how to get it.
 *
 * WHY THIS IS A VIEW OF ITS OWN and not a column in a report. A case imported offline is mostly
 * `unverifiable`, because an archive arrives without the DNS records that would check it. The
 * question "which key, fetched once, turns the most of these messages into a verdict" is the
 * question that decides where an hour of work goes, so the work list gets a pane, a ranking, and
 * a button — and `@stamped/store`'s `keyDemand` is the one place the numbers come from.
 *
 * The button never acts on its own: a lookup is a disclosure, and the consent dialog is built
 * from `describeConsent` over exactly these pairs. See [`consent.ts`](consent.ts).
 */

import { fmt, pairName, _, _n, type KeyPair } from '@stamped/core';
import type { KeyDemand } from '@stamped/store';

import { groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';

/** One `(domain, selector)` pair as the key list shows it. */
export interface KeyRow {
    readonly domain: string;
    readonly selector: string;
    /** `<selector>._domainkey.<domain>` — the DNS name, which is also how a provider knows it. */
    readonly name: string;
    /** How much of the case hangs on this pair. */
    readonly subtitle: string;
    /** Is a key for this pair already in the case's store? */
    readonly have: boolean;
    readonly cssClass: string;
    readonly icon: string;
    readonly messages: number;
    readonly unverifiable: number;
}

/**
 * The work list: pairs still needed first, ranked by how many messages they would answer.
 *
 * `keyDemand` ranks by total mail, which is the size of the prize; this pane ranks by the
 * UNCLAIMED part of it. A pair with four thousand messages that are all confirmed already needs
 * nothing, and putting it at the top of a list headed "missing keys" would send the next hour of
 * work to the one domain where there is none to do.
 *
 * Pairs whose key is already in the store stay in the list rather than disappearing: seeing that
 * a domain is done is the other half of knowing what is left.
 */
export function keyRows(demands: readonly KeyDemand[], known: ReadonlySet<string>): KeyRow[] {
    const rows = demands.map((demand) => {
        const name = pairName({ domain: demand.domain, selector: demand.selector });
        const have = known.has(name);
        return {
            domain: demand.domain,
            selector: demand.selector,
            name: escapeLine(name),
            subtitle: escapeLine(demandLine(demand, have)),
            have,
            cssClass: have ? 'success' : demand.unverifiable > 0 ? 'warning' : 'dimmed',
            icon: have ? 'emblem-ok-symbolic' : 'dialog-password-symbolic',
            messages: demand.messages,
            unverifiable: demand.unverifiable,
        };
    });
    return rows.sort((a, b) => {
        if (a.have !== b.have) return a.have ? 1 : -1;
        return b.unverifiable - a.unverifiable || b.messages - a.messages || a.name.localeCompare(b.name);
    });
}

/** What this pair is worth, in messages. */
function demandLine(demand: KeyDemand, have: boolean): string {
    const signed = fmt(
        _n('{messages} message signed with it', '{messages} messages signed with it', demand.messages),
        { messages: groupDigits(demand.messages) },
    );
    if (demand.unverifiable === 0) {
        return have
            ? fmt(_('{signed}; the key is in this case’s store.'), { signed })
            : fmt(_('{signed}; none of them are waiting for this key.'), { signed });
    }
    const waiting = fmt(
        _n('{count} has no verdict without it', '{count} have no verdict without it', demand.unverifiable),
        { count: groupDigits(demand.unverifiable) },
    );
    return `${signed}, ${waiting}.`;
}

/** The one line above the list: how much of the case is waiting on a key. */
export function keySummary(rows: readonly KeyRow[]): string {
    const missing = rows.filter((row) => !row.have);
    if (rows.length === 0) return escapeLine(_('No signatures in this case, so no keys are needed.'));
    if (missing.length === 0) {
        return escapeLine(_('Every signing key this case needs is in its store.'));
    }
    let waiting = 0;
    for (const row of missing) waiting += row.unverifiable;
    return escapeLine(
        fmt(
            _n(
                '{missing} of {total} key is missing, and {waiting} messages wait for one.',
                '{missing} of {total} keys are missing, and {waiting} messages wait for one.',
                missing.length,
            ),
            {
                missing: groupDigits(missing.length),
                total: groupDigits(rows.length),
                waiting: groupDigits(waiting),
            },
        ),
    );
}

/**
 * What a key is and where it comes from, behind the row's `?`.
 *
 * Written for someone who has never heard of a selector, because that is who has to decide
 * whether to send a DNS query that tells a domain's operator they are being examined.
 */
export function explainKey(row: KeyRow): string {
    return fmt(
        _(
            'A DKIM public key, published by the signing domain as the DNS TXT record {name}. Anyone may read it — it is the public half, and it only ever lets you check a signature, never make one. The catch is time: operators rotate selectors and delete the old record, so the key that signed a message from 2019 is usually gone from today’s DNS. Then it has to come from the operator, from a third-party archive of old records, or from the archive under examination — and where it came from is part of the verdict.',
        ),
        { name: row.name },
    );
}

/** The pairs a lookup would cover — the exact list the consent dialog must show. */
export function lookupPairs(rows: readonly KeyRow[]): KeyPair[] {
    return rows.filter((row) => !row.have).map((row) => ({ domain: row.domain, selector: row.selector }));
}
