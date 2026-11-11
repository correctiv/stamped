/**
 * Measuring a key rotation instead of guessing one.
 *
 * A pair whose vault holds two different keys is a conflict until every key carries a bounded
 * window of its own. A key recovered from signatures or read from today's DNS carries none, so a
 * real rotation (1024 bit in the old mail, 2048 bit now) stayed a permanent conflict. The case
 * itself holds the evidence: every message of the pair verifies under at most ONE of the keys,
 * and the `Date` of the messages one key alone explains is that key's era.
 *
 * Each raw message is verified under each candidate on its own. A message counts for a key only
 * when exactly that key verifies it; a message no key verifies (altered, or signed by a third key)
 * counts for none. The windows are then written for a pair only if they do not overlap. Messages
 * of both keys interleaved in time are the case that must stay a human decision: a rotation never
 * goes back, a forgery or two live signers does.
 *
 * Reads raw bytes, never the index's verdicts, and does not touch the case: the caller gets a
 * changed COPY of the vault and decides whether to keep it.
 */

import { readFileSync } from 'node:fs';

import {
    keyFingerprint,
    KeyStore,
    KeyVault,
    keyNameFor,
    keySourceOf,
    normaliseKeyName,
    pairName,
    type KeyPair,
    type VaultEntry,
} from '@stamped/core';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { openIndex } from './index-db.ts';
import { rawPath } from './raw.ts';

/** What one candidate key of a conflicted pair explains. */
export interface KeyEra {
    /** The candidate, as {@link KeyVault.distinctKeys} presents it. */
    readonly key: VaultEntry;
    /** Messages only this key verifies. */
    readonly messages: number;
    /** Of those, the ones with no readable `Date`: they say which key, not when. */
    readonly undated: number;
    /** Earliest and latest `Date` among the dated ones (ISO). Absent when there is none. */
    readonly from?: string;
    readonly to?: string;
}

/**
 * - `rotation`: every candidate explains dated messages and no two windows overlap.
 * - `interleaved`: windows overlap. Rotation or forgery; a human decides.
 * - `unproven`: a candidate explains no dated message, so it has no era to measure.
 */
export type EraOutcome = 'rotation' | 'interleaved' | 'unproven';

export interface PairEras {
    readonly pair: KeyPair;
    readonly eras: readonly KeyEra[];
    /** Signed messages of the pair that no candidate verifies. */
    readonly unexplained: number;
    readonly outcome: EraOutcome;
}

export interface EraMeasurement {
    readonly pairs: readonly PairEras[];
    /** A copy of the vault with the measured windows written for every `rotation` pair. */
    readonly vault: KeyVault;
}

function overlap(a: KeyEra, b: KeyEra): boolean {
    return (a.from as string) <= (b.to as string) && (b.from as string) <= (a.to as string);
}

function outcomeOf(eras: readonly KeyEra[]): EraOutcome {
    if (eras.some((era) => era.from === undefined)) return 'unproven';
    for (let i = 0; i < eras.length; i++) {
        for (let j = i + 1; j < eras.length; j++) {
            if (overlap(eras[i] as KeyEra, eras[j] as KeyEra)) return 'interleaved';
        }
    }
    return 'rotation';
}

/** Does `raw` carry a signature for `pair` that verifies against the one key in `keys`? */
async function verifiesUnder(raw: Uint8Array, pair: KeyPair, keys: KeyStore): Promise<boolean> {
    const domain = normaliseKeyName(pair.domain);
    const selector = pair.selector.toLowerCase();
    const evidence = await verifyMessage(raw, { keys });
    return evidence.some(
        (e) =>
            normaliseKeyName(e.domain) === domain && e.selector.toLowerCase() === selector && e.signatureOk,
    );
}

/**
 * Measure every conflicted pair of `vault` against the messages of the case.
 *
 * `yieldTurn` is awaited before each message, like {@link reverifyPairs}; `onProgress` hears
 * `(done, total)` over the messages, known after one pass over the signatures.
 */
export async function measureKeyEras(
    paths: CasePaths,
    vault: KeyVault,
    yieldTurn?: () => Promise<void>,
    onProgress?: (done: number, total: number) => void,
): Promise<EraMeasurement> {
    const conflicted = vault.conflicts();
    const result = KeyVault.fromJson(vault.toJson());
    if (conflicted.length === 0) return { pairs: [], vault: result };

    const byPair = new Map<string, { pair: KeyPair; hashes: Set<string> }>();
    for (const pair of conflicted) {
        byPair.set(pairName(pair), { pair, hashes: new Set() });
    }

    const db = openIndex(paths);
    const sentAt = new Map<string, number | undefined>();
    try {
        const rows = db.prepare('SELECT DISTINCT hash, domain, selector FROM signatures').all() as {
            hash?: string;
            domain?: string;
            selector?: string;
        }[];
        for (const row of rows) {
            if (typeof row.hash !== 'string') continue;
            byPair.get(keyNameFor(row.domain ?? '', row.selector ?? ''))?.hashes.add(row.hash);
        }
        const time = db.prepare('SELECT sent_at FROM messages WHERE hash = ?');
        for (const { hashes } of byPair.values()) {
            for (const hash of hashes) {
                const row = time.get(hash) as { sent_at?: number | null } | undefined;
                sentAt.set(
                    hash,
                    row?.sent_at === null || row?.sent_at === undefined ? undefined : Number(row.sent_at),
                );
            }
        }
    } finally {
        db.close();
    }

    let total = 0;
    for (const { hashes } of byPair.values()) total += hashes.size;
    let done = 0;
    onProgress?.(0, total);

    const pairs: PairEras[] = [];
    for (const { pair, hashes } of byPair.values()) {
        const candidates = vault.distinctKeys(pair);
        const stores = candidates.map((candidate) => {
            const store = new KeyStore();
            store.add(pairName(pair), candidate.record, keySourceOf(candidate.origin));
            return store;
        });
        const stats = candidates.map(() => ({ messages: 0, undated: 0, from: NaN, to: NaN }));
        let unexplained = 0;
        for (const hash of [...hashes].sort()) {
            await yieldTurn?.();
            let explained = -1;
            let ambiguous = false;
            try {
                const raw = new Uint8Array(readFileSync(rawPath(paths, hash)));
                for (let i = 0; i < stores.length; i++) {
                    if (!(await verifiesUnder(raw, pair, stores[i] as KeyStore))) continue;
                    if (explained >= 0) ambiguous = true;
                    explained = i;
                }
            } catch {
                explained = -1;
            }
            if (explained < 0 || ambiguous) {
                unexplained++;
            } else {
                const stat = stats[explained] as (typeof stats)[number];
                stat.messages++;
                const when = sentAt.get(hash);
                if (when === undefined) {
                    stat.undated++;
                } else {
                    stat.from = Number.isNaN(stat.from) ? when : Math.min(stat.from, when);
                    stat.to = Number.isNaN(stat.to) ? when : Math.max(stat.to, when);
                }
            }
            onProgress?.(++done, total);
        }
        const eras: KeyEra[] = candidates.map((key, i) => {
            const stat = stats[i] as (typeof stats)[number];
            return {
                key,
                messages: stat.messages,
                undated: stat.undated,
                ...(Number.isNaN(stat.from) ? {} : { from: new Date(stat.from).toISOString() }),
                ...(Number.isNaN(stat.to) ? {} : { to: new Date(stat.to).toISOString() }),
            };
        });
        const outcome = outcomeOf(eras);
        pairs.push({ pair, eras, unexplained, outcome });

        if (outcome === 'rotation') {
            // The copy's candidates may come in another order: match them by the key itself.
            const copies = result.distinctKeys(pair);
            for (const era of eras) {
                const fingerprint = keyFingerprint(era.key.record);
                const copy = copies.find((c) => keyFingerprint(c.record) === fingerprint);
                if (copy !== undefined && era.from !== undefined && era.to !== undefined) {
                    result.widen(copy, era.from, era.to);
                }
            }
        }
    }
    return { pairs, vault: result };
}
