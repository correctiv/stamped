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
    missingPairs,
    normaliseKeyName,
    pairName,
    type KeyPair,
    type KeyVault,
    type PairCount,
    type Verdict,
} from '@stamped/core';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { beginBatch, commitBatch, openIndex, rollbackBatch, updateFinding } from './index-db.ts';
import { settleSiblings } from './siblings.ts';
import { rawPath } from './raw.ts';

/** Messages per write transaction: short enough that a reader never waits long for the lock. */
const REVERIFY_BATCH = 50;

function pairKey(domain: string, selector: string): string {
    return `${normaliseKeyName(domain)}\n${selector.toLowerCase()}`;
}

/** Pairs with `no-key` signatures, and how many distinct messages each affects, most first. */
function noKeyPairs(db: DatabaseSync): PairCount[] {
    const rows = db
        .prepare(
            `SELECT lower(domain) AS domain, lower(selector) AS selector, count(DISTINCT hash) AS messages
             FROM signatures WHERE reason = 'no-key'
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

/** The pairs the vault holds no key for, by the number of messages they leave unverifiable. */
export function missingKeyPairs(db: DatabaseSync, vault: KeyVault): PairCount[] {
    return missingPairs(noKeyPairs(db), vault);
}

/** Pairs the vault HAS a key for but whose messages still say `no-key`: a reverify is due. */
export function unappliedKeyPairs(db: DatabaseSync, vault: KeyVault): PairCount[] {
    const missing = new Set(missingKeyPairs(db, vault).map(pairName));
    return noKeyPairs(db).filter((pair) => !missing.has(pairName(pair)));
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
    const conflicted = new Set(vault.conflicts().map(pairName));
    const skippedConflicts = pairs.filter((pair) => conflicted.has(pairName(pair)));
    const active = pairs.filter((pair) => !conflicted.has(pairName(pair)));
    const keys = vault.toKeyStore({ skipConflicts: true });

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
                try {
                    const raw = new Uint8Array(readFileSync(rawPath(paths, hash)));
                    finding = classifyMessage(await verifyMessage(raw, { keys }));
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
