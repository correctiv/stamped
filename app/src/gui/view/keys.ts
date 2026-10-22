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
    /**
     * Where this pair stands, in as few words as fit beside the name.
     *
     * The row's one visible line. {@link KeyRow.subtitle} is the paragraph behind the expander —
     * a screenshot showed why the two are separate: with the full demand sentence in the
     * subtitle, seven rows of two-line prose filled the pane and the ranking the list exists for
     * could not be read off it.
     */
    readonly status: string;
    /** How much of the case hangs on this pair. Behind the row's expander, not in it. */
    readonly subtitle: string;
    /** Is a key for this pair already in the case's store? */
    readonly have: boolean;
    /**
     * Does the case still want this key — are there messages it cannot give a verdict for?
     *
     * NOT the same question as {@link have}, and reading the work list off the store instead was
     * a bug a screenshot caught: a case imported with `--key` verifies every message without
     * putting anything in the store, so all seven pairs showed as missing while six of them had
     * nothing left to answer. What a key is still WANTED for is a property of the verdicts, so it
     * is counted from them.
     */
    readonly wanted: boolean;
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
        const wanted = demand.unverifiable > 0;
        return {
            domain: demand.domain,
            selector: demand.selector,
            name: escapeLine(name),
            status: escapeLine(statusLine(demand, have, wanted)),
            subtitle: escapeLine(demandLine(demand, have)),
            have,
            wanted,
            cssClass: wanted ? 'warning' : have ? 'success' : 'dimmed',
            // `object-select-symbolic`, not the `emblem-ok-symbolic` that was here: Adwaita has
            // no such name and an icon it lacks draws nothing — see the note on `verdictIcon`.
            icon: wanted ? 'dialog-password-symbolic' : 'object-select-symbolic',
            messages: demand.messages,
            unverifiable: demand.unverifiable,
        };
    });
    return rows.sort((a, b) => {
        if (a.wanted !== b.wanted) return a.wanted ? -1 : 1;
        return b.unverifiable - a.unverifiable || b.messages - a.messages || a.name.localeCompare(b.name);
    });
}

/**
 * The row's one visible line: where this pair stands, in three or four words.
 *
 * THE COUNT THAT DECIDES THE RANKING is the only number in it. The list is sorted by how much
 * mail a key would answer, and a row whose line led with the total it signed would read as if
 * the order were wrong — so a wanted pair says what is waiting, and a pair with nothing waiting
 * says that instead of a number nobody has to act on. The full sentence, both counts and where
 * the key came from, is one expander away in {@link KeyRow.subtitle}.
 */
function statusLine(demand: KeyDemand, have: boolean, wanted: boolean): string {
    if (wanted) {
        return fmt(_n('{count} message waiting', '{count} messages waiting', demand.unverifiable), {
            count: groupDigits(demand.unverifiable),
        });
    }
    return have ? _('Key stored') : _('Nothing waiting');
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

/**
 * The one line above the list: how much of the case is waiting on a key.
 *
 * TWO SENTENCES, not one, and that is the whole reason this reads the way it does. A single
 * sentence carrying both counts can only agree with one of them, and the version that did it
 * shipped as far as a screenshot reading "7 of 7 keys are missing, and 1 messages wait for one."
 * Each count now inflects its own sentence, and neither refers to the other by a pronoun, so a
 * translator never has to make one number agree with a word governed by the other.
 */
export function keySummary(rows: readonly KeyRow[]): string {
    if (rows.length === 0) return escapeLine(_('No signatures in this case, so no keys are needed.'));
    const wanted = rows.filter((row) => row.wanted);
    if (wanted.length === 0) {
        return escapeLine(_('Every signature in this case has the key it needs.'));
    }
    let waiting = 0;
    for (const row of wanted) waiting += row.unverifiable;
    const missing = fmt(
        _n(
            '{missing} of {total} signing key is missing.',
            '{missing} of {total} signing keys are missing.',
            wanted.length,
        ),
        { missing: groupDigits(wanted.length), total: groupDigits(rows.length) },
    );
    const without = fmt(
        _n(
            '{waiting} message has no verdict without a key.',
            '{waiting} messages have no verdict without a key.',
            waiting,
        ),
        { waiting: groupDigits(waiting) },
    );
    return escapeLine(`${missing} ${without}`);
}

/**
 * What a key is and where it comes from, behind the row's `?`.
 *
 * Written for someone who has never heard of a selector, because that is who has to decide
 * whether to send a DNS query that tells a domain's operator they are being examined.
 *
 * The name is re-derived from the pair rather than taken from {@link KeyRow.name}, which is
 * already escaped: escaping the finished paragraph is what keeps this function like every other
 * one here, and interpolating an escaped value into it would escape that value twice.
 */
export function explainKey(row: KeyRow): string {
    return escapeLine(
        fmt(
            _(
                'A DKIM public key, published by the signing domain as the DNS TXT record {name}. Anyone may read it. It is the public half, and it only ever lets you check a signature, never make one. The catch is time. Operators rotate selectors and delete the old record, so the key that signed a message from 2019 is usually gone from today’s DNS. Then it has to come from the operator, from a third-party archive of old records, or from the archive under examination, and where it came from is part of the verdict.',
            ),
            { name: pairName({ domain: row.domain, selector: row.selector }) },
        ),
    );
}

/**
 * The pairs a lookup would cover — the exact list the consent dialog must show.
 *
 * A pair the case has no verdict waiting on is left out even when the store holds no key for it,
 * because asking for it would disclose a domain for nothing: the messages it signed already have
 * their answer. The smallest request that does the work is the only one worth consenting to.
 */
export function lookupPairs(rows: readonly KeyRow[]): KeyPair[] {
    return rows
        .filter((row) => row.wanted && !row.have)
        .map((row) => ({ domain: row.domain, selector: row.selector }));
}

/**
 * What one lookup run produced, for the toast after it.
 *
 * A MISS IS REPORTED, not swallowed. "Nothing found" is the normal outcome for an old selector —
 * operators rotate keys and delete the record — and a toast that said only "0 keys stored" would
 * leave the reader wondering whether the request went out at all. The distinction matters because
 * the request DID go out: the disclosure has happened, and the person who agreed to it is owed
 * the result.
 *
 * A conflict is called out separately and in the strongest terms this module uses. The case
 * already held a different key for that pair, which is either a rotation the archive predates or
 * a key somebody substituted — and the second is the finding the tool exists for, so it may never
 * be summarised as a successful fetch.
 */
export function lookupSummary(stored: number, missed: number, conflicts: number, errors = 0): string {
    const parts: string[] = [];
    if (stored > 0) {
        parts.push(
            fmt(_n('{count} key stored', '{count} keys stored', stored), {
                count: groupDigits(stored),
            }),
        );
    }
    if (missed > 0) {
        parts.push(
            fmt(_n('{count} had no published record', '{count} had no published record', missed), {
                count: groupDigits(missed),
            }),
        );
    }
    if (errors > 0) {
        parts.push(
            fmt(
                _n(
                    '{count} could not be asked. Retry later.',
                    '{count} could not be asked. Retry later.',
                    errors,
                ),
                { count: groupDigits(errors) },
            ),
        );
    }
    if (parts.length === 0) parts.push(_('nothing was found'));
    const line = fmt(_('Lookup done: {results}.'), { results: parts.join(', ') });
    if (conflicts === 0) return escapeLine(line);
    return escapeLine(
        `${line} ${fmt(
            _n(
                '{count} key differs from one this case already held. Check which is the real one.',
                '{count} keys differ from ones this case already held. Check which are the real ones.',
                conflicts,
            ),
            { count: groupDigits(conflicts) },
        )}`,
    );
}

/**
 * What re-verifying after a new key did, appended to the toast that announced the key.
 *
 * The unchanged case is SAID, not left silent. A key that produces no new verdict is a real
 * result and usually an unwelcome one — the record found was not the one that signed these
 * messages — and a toast that stopped at "key stored" would read as success while the sidebar
 * still showed every message unverified. Nothing re-verified at all (a conflicting pair, which
 * `reverifyPairs` leaves alone) yields an empty string instead: the sentence about the conflict
 * has already been said in stronger words, and counting zero messages here would only soften it.
 */
export function reverifySummary(checked: number, changed: number): string {
    if (checked === 0) return '';
    if (changed === 0) {
        return escapeLine(
            fmt(
                _n(
                    '{count} message re-verified; its verdict is unchanged.',
                    '{count} messages re-verified; no verdict changed.',
                    checked,
                ),
                { count: groupDigits(checked) },
            ),
        );
    }
    return escapeLine(
        fmt(_n('{count} verdict changed.', '{count} verdicts changed.', changed), {
            count: groupDigits(changed),
        }),
    );
}
