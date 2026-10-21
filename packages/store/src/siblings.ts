/**
 * The second pass: a key that confirms other mail of the case is not a wrong key.
 *
 * `key-newer-than-message` says a header failure may come from a rotated selector. Where the
 * same (domain, selector) already produced a `confirmed` or `confirmed-with-caveats` signature
 * in this case, that doubt is gone and the failure is far more likely a real edit, so the
 * caveat must not soften it. Only the case knows that, so it is decided here and handed to the
 * verifier as plain data (`confirmedPairs`); `@stamped/core` stays pure.
 */

import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { classifyMessage, keyNameFor, type KeyStore } from '@stamped/core';
import { summarise } from '@stamped/import';
import { verifyMessage } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { indexMessage } from './index-db.ts';
import { rawPath } from './raw.ts';

/** Names of the pairs that have at least one verified signature in the case. */
export function confirmedPairNames(db: DatabaseSync): Set<string> {
    const rows = db
        .prepare(
            `SELECT DISTINCT domain, selector FROM signatures
             WHERE verdict IN ('confirmed', 'confirmed-with-caveats')`,
        )
        .all() as { domain?: string; selector?: string }[];
    return new Set(rows.map((row) => keyNameFor(String(row.domain ?? ''), String(row.selector ?? ''))));
}

/**
 * Re-classify the messages carrying `key-newer-than-message` whose pair is confirmed elsewhere.
 * Returns how many were re-classified; a message that cannot be read keeps its old row.
 */
export async function settleSiblings(db: DatabaseSync, paths: CasePaths, keys: KeyStore): Promise<number> {
    const confirmed = confirmedPairNames(db);
    if (confirmed.size === 0) return 0;
    const candidates = db
        .prepare(
            `SELECT m.hash AS hash FROM messages m, json_each(m.caveats) AS c
             WHERE c.value = 'key-newer-than-message'`,
        )
        .all() as { hash?: string }[];
    let settled = 0;
    for (const { hash } of candidates) {
        if (typeof hash !== 'string') continue;
        try {
            const raw = new Uint8Array(readFileSync(rawPath(paths, hash)));
            const finding = classifyMessage(await verifyMessage(raw, { keys, confirmedPairs: confirmed }));
            if (finding.caveats.includes('key-newer-than-message')) continue;
            indexMessage(db, { hash, bytes: raw.length, summary: summarise(raw), finding });
            settled++;
        } catch {
            // keeps its old row
        }
    }
    return settled;
}
