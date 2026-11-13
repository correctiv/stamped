/**
 * Which keys a case is missing, and re-verifying the messages a new key bears on.
 *
 * The index says which pairs failed with `no-key`; the vault says which keys exist. Re-verifying
 * reads the RAW bytes again — never the index's copy — and runs the same verifier and classifier
 * as an import, so a verdict changed by a later key is exactly the verdict an import with that
 * key would have given. A pair whose vault holds two different records is left alone: choosing
 * one would let an unproven key upgrade a verdict.
 */

import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
    classifyMessage,
    inPerimeter,
    missingPairs,
    normaliseKeyName,
    pairName,
    type KeyPair,
    type KeyVault,
    type PairCount,
    type Verdict,
} from '@stamped/core';
import { verifyMessage } from '@stamped/verify';

import { assertWritable, type CasePaths } from './case.ts';
import { beginBatch, commitBatch, openIndex, rollbackBatch, updateFinding } from './index-db.ts';
import { writeBodyExplanations } from './body-explanations.ts';
import { writeReceiverAnchors } from './receiver-anchors.ts';
import { readPerimeter, writePerimeter } from './perimeter.ts';
import { settleSiblings } from './siblings.ts';
import { rawPath } from './raw.ts';

/** Messages per write transaction: short enough that a reader never waits long for the lock. */
const REVERIFY_BATCH = 50;

function pairKey(domain: string, selector: string): string {
    return `${normaliseKeyName(domain)}\n${selector.toLowerCase()}`;
}

/** Pairs, and how many distinct messages each affects, most first. */
function pairCounts(db: DatabaseSync, where: string): PairCount[] {
    const rows = db
        .prepare(
            `SELECT lower(domain) AS domain, lower(selector) AS selector, count(DISTINCT hash) AS messages
             FROM signatures ${where}
             GROUP BY lower(domain), lower(selector)
             ORDER BY messages DESC, domain ASC, selector ASC`,
        )
        .all() as Record<string, unknown>[];
    return rows.map((row) => ({
        domain: String(row.domain ?? ''),
        selector: String(row.selector ?? ''),
        mails: Number(row.messages ?? 0),
    }));
}

/** Pairs with `no-key` signatures. */
function noKeyPairs(db: DatabaseSync): PairCount[] {
    return pairCounts(db, "WHERE reason = 'no-key'");
}

/** The pairs the vault holds no key for, by the number of messages they leave unverifiable. */
export function missingKeyPairs(db: DatabaseSync, vault: KeyVault): PairCount[] {
    return missingPairs(noKeyPairs(db), vault);
}

/**
 * Pairs whose stored `expired` verdict predates the fix: a signature whose x= had passed used to
 * be filed as unverifiable. The verifier no longer produces that reason, so every such row is
 * stale and a plain reverify brings it up to date — no schema bump.
 */
function legacyExpiredPairs(db: DatabaseSync): PairCount[] {
    return pairCounts(db, "WHERE reason = 'expired'");
}

/**
 * Pairs a plain reverify is due for: the vault HAS a key for them but their messages still say
 * `no-key`, or their rows carry the retired `expired` reason.
 */
export function unappliedKeyPairs(db: DatabaseSync, vault: KeyVault): PairCount[] {
    const missing = new Set(missingKeyPairs(db, vault).map(pairName));
    const merged = new Map<string, PairCount>();
    for (const pair of noKeyPairs(db)) {
        if (!missing.has(pairName(pair))) merged.set(pairName(pair), pair);
    }
    for (const pair of legacyExpiredPairs(db)) {
        if (missing.has(pairName(pair))) continue;
        if (vault.recordsFor(pair).length === 0) continue;
        const known = merged.get(pairName(pair));
        merged.set(
            pairName(pair),
            known === undefined ? pair : { ...pair, mails: (known.mails ?? 0) + (pair.mails ?? 0) },
        );
    }
    return [...merged.values()];
}

/**
 * Every pair that signed a message in the case. Re-verifying all of them re-reads every signed
 * message: the way to bring a case up to a newer verifier, since the index stores verdicts, not
 * the evidence behind them.
 */
export function signedPairs(db: DatabaseSync): PairCount[] {
    return pairCounts(db, '');
}

/**
 * Name the perimeter and re-classify the messages it bears on.
 *
 * Only signatures whose `d=` lies in the OLD or the NEW perimeter can change: the first lose the
 * caveat, the second gain it. The verdict itself never moves, so the report says how many
 * messages were looked at, not how many changed. Pairs the vault holds conflicting keys for are
 * left alone, as in {@link reverifyPairs}, and come back in `skippedConflicts`.
 */
export async function applyPerimeter(
    paths: CasePaths,
    domains: readonly string[],
    vault: KeyVault,
    yieldTurn?: () => Promise<void>,
    onProgress?: (checked: number, total: number) => void,
): Promise<{ perimeter: string[]; result: ReverifyResult }> {
    assertWritable(paths);
    const before = readPerimeter(paths);
    const perimeter = writePerimeter(paths, domains);
    const bearing = [...before, ...perimeter];
    const db = openIndex(paths);
    let pairs: PairCount[];
    try {
        pairs = signedPairs(db).filter((pair) => inPerimeter(pair.domain, bearing));
    } finally {
        db.close();
    }
    const result = await reverifyPairs(paths, pairs, vault, yieldTurn, onProgress);
    return { perimeter, result };
}

export interface VerdictChange {
    readonly hash: string;
    readonly from: Verdict;
    readonly to: Verdict;
}

export interface ReverifyResult {
    /** Messages read again from `raw/`. */
    readonly checked: number;
    readonly changed: readonly VerdictChange[];
    /** Messages that could not be read or verified; their old row is kept. */
    readonly failed: number;
    /** Requested pairs left alone because the vault holds conflicting keys for them. */
    readonly skippedConflicts: readonly KeyPair[];
}

/**
 * Re-verify exactly the messages that carry a signature from one of `pairs`.
 *
 * `yieldTurn` is awaited before each message: a caller with a main loop to keep alive (the
 * window) hands in a promise that settles on an idle turn, because a microtask never repaints.
 * `onProgress` hears `(checked, total)` once up front and after every message, so a caller can
 * draw a progress bar over a run whose size is only known once the affected messages are found.
 */
export async function reverifyPairs(
    paths: CasePaths,
    pairs: readonly KeyPair[],
    vault: KeyVault,
    yieldTurn?: () => Promise<void>,
    onProgress?: (checked: number, total: number) => void,
): Promise<ReverifyResult> {
    assertWritable(paths);
    const conflicted = new Set(vault.conflicts().map(pairName));
    const skippedConflicts = pairs.filter((pair) => conflicted.has(pairName(pair)));
    const active = pairs.filter((pair) => !conflicted.has(pairName(pair)));
    const keys = vault.toKeyStore({ skipConflicts: true });
    const classifyOptions = { perimeter: readPerimeter(paths) };

    const db = openIndex(paths);
    try {
        // ONE pass over the signatures, matched in memory. A query per pair compares
        // `lower(domain)`, which the (domain, selector) index cannot serve, so every pair was a
        // full scan of the table: for a thousand pairs on a six-figure case, minutes in which no
        // progress could be reported and the file was busy.
        const wanted = new Set(active.map((pair) => pairKey(pair.domain, pair.selector)));
        const affected = new Set<string>();
        if (wanted.size > 0) {
            const rows = db.prepare('SELECT DISTINCT hash, domain, selector FROM signatures').all() as {
                hash?: string;
                domain?: string;
                selector?: string;
            }[];
            for (const row of rows) {
                if (
                    typeof row.hash === 'string' &&
                    wanted.has(pairKey(row.domain ?? '', row.selector ?? ''))
                ) {
                    affected.add(row.hash);
                }
            }
        }

        const before = db.prepare('SELECT verdict FROM messages WHERE hash = ?');
        const changed: VerdictChange[] = [];
        let failed = 0;
        let seen = 0;
        let open = 0;
        const commit = (): void => {
            if (open === 0) return;
            commitBatch(db);
            open = 0;
        };
        onProgress?.(0, affected.size);
        try {
            for (const hash of [...affected].sort()) {
                await yieldTurn?.();
                let finding;
                let raw: Uint8Array | undefined;
                try {
                    raw = new Uint8Array(readFileSync(rawPath(paths, hash)));
                    finding = classifyMessage(await verifyMessage(raw, { keys }), classifyOptions);
                } catch {
                    failed++;
                }
                // A failing write is not a failing message: it rolls the batch back and ends the run.
                if (finding !== undefined) {
                    const old = (before.get(hash) as { verdict?: string } | undefined)?.verdict as
                        | Verdict
                        | undefined;
                    if (open === 0) beginBatch(db);
                    open++;
                    // Only the verdict side changes with a key; the text index is left alone.
                    updateFinding(db, hash, finding);
                    if (raw !== undefined) {
                        writeBodyExplanations(db, hash, finding, raw);
                        writeReceiverAnchors(db, hash, finding, raw);
                    }
                    if (old !== undefined && old !== finding.verdict) {
                        changed.push({ hash, from: old, to: finding.verdict });
                    }
                    if (open >= REVERIFY_BATCH) commit();
                }
                onProgress?.(++seen, affected.size);
            }
            commit();
        } catch (error) {
            rollbackBatch(db);
            throw error;
        }
        await settleSiblings(db, paths, keys, yieldTurn);
        return { checked: affected.size - failed, changed, failed, skippedConflicts };
    } finally {
        db.close();
    }
}
