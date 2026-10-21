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
import { summarise } from '@stamped/import';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { indexMessage, openIndex } from './index-db.ts';
import { settleSiblings } from './siblings.ts';
import { rawPath } from './raw.ts';

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

/** Re-verify exactly the messages that carry a signature from one of `pairs`. */
export async function reverifyPairs(
    paths: CasePaths,
    pairs: readonly KeyPair[],
    vault: KeyVault,
): Promise<ReverifyResult> {
    const conflicted = new Set(vault.conflicts().map(pairName));
    const skippedConflicts = pairs.filter((pair) => conflicted.has(pairName(pair)));
    const active = pairs.filter((pair) => !conflicted.has(pairName(pair)));
    const keys = vault.toKeyStore({ skipConflicts: true });

    const db = openIndex(paths);
    try {
        const affected = new Set<string>();
        const select = db.prepare(
            'SELECT DISTINCT hash FROM signatures WHERE lower(domain) = ? AND lower(selector) = ?',
        );
        for (const pair of active) {
            const rows = select.all(normaliseKeyName(pair.domain), pair.selector.toLowerCase()) as {
                hash?: string;
            }[];
            for (const row of rows) if (typeof row.hash === 'string') affected.add(row.hash);
        }

        const before = db.prepare('SELECT verdict FROM messages WHERE hash = ?');
        const changed: VerdictChange[] = [];
        let failed = 0;
        for (const hash of [...affected].sort()) {
            try {
                const raw = new Uint8Array(readFileSync(rawPath(paths, hash)));
                const finding = classifyMessage(await verifyMessage(raw, { keys }));
                const old = (before.get(hash) as { verdict?: string } | undefined)?.verdict as
                    | Verdict
                    | undefined;
                indexMessage(db, { hash, bytes: raw.length, summary: summarise(raw), finding });
                if (old !== undefined && old !== finding.verdict) {
                    changed.push({ hash, from: old, to: finding.verdict });
                }
            } catch {
                failed++;
            }
        }
        await settleSiblings(db, paths, keys);
        return { checked: affected.size - failed, changed, failed, skippedConflicts };
    } finally {
        db.close();
    }
}
