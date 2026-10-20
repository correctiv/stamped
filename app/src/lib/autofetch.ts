/**
 * The shared tail of `import`, `keys fetch` and `reverify`: ask once for every missing key of a
 * case, store what arrives, and re-verify exactly the messages those keys bear on.
 */

import {
    fetchKeys,
    fmt,
    pairName,
    type LookupChannel,
    _,
    _n,
} from '@stamped/core';
import {
    missingKeyPairs,
    openIndex,
    reverifyPairs,
    unappliedKeyPairs,
    type CasePaths,
    type ReverifyResult,
} from '@stamped/store';

import { askConsent } from './consent.ts';
import { resolveTxt } from './dns.ts';
import { loadVault, saveVault } from './vault.ts';

export const DEFAULT_CHANNELS: readonly LookupChannel[] = ['archive.prove.email', 'dns'];

export interface AutoOptions {
    readonly yes: boolean;
    readonly channels?: readonly LookupChannel[];
}

function printReverify(result: ReverifyResult): void {
    console.log(
        fmt(
            _n(
                '{count} message re-verified, {changed} verdict changed.',
                '{count} messages re-verified, {changed} verdicts changed.',
                result.checked,
            ),
            { count: result.checked, changed: result.changed.length },
        ),
    );
    for (const change of result.changed) {
        console.log(`  ${change.hash.slice(0, 12)}  ${change.from} → ${change.to}`);
    }
    for (const pair of result.skippedConflicts) {
        console.log(
            fmt(_('! {name} holds different keys; its messages were left as they are.'), {
                name: pairName(pair),
            }),
        );
    }
    if (result.failed > 0) {
        console.log(
            fmt(_n('{failed} message could not be re-verified.', '{failed} messages could not be re-verified.', result.failed), {
                failed: result.failed,
            }),
        );
    }
}

/** Re-verify the messages whose key is in the vault but whose verdict does not use it yet. */
export async function reverifyApplicable(paths: CasePaths): Promise<ReverifyResult | undefined> {
    const vault = loadVault(paths.root);
    const db = openIndex(paths);
    let pairs;
    try {
        pairs = unappliedKeyPairs(db, vault);
    } finally {
        db.close();
    }
    if (pairs.length === 0) return undefined;
    const result = await reverifyPairs(paths, pairs, vault);
    printReverify(result);
    return result;
}

/** One consent for all missing keys, then fetch, store and re-verify. */
export async function fetchMissingAndReverify(paths: CasePaths, options: AutoOptions): Promise<void> {
    const vault = loadVault(paths.root);
    const db = openIndex(paths);
    let missing;
    try {
        missing = missingKeyPairs(db, vault);
    } finally {
        db.close();
    }
    if (missing.length > 0 && !options.yes && !process.stdin.isTTY) {
        console.log(
            fmt(
                _n(
                    '{count} key is missing. No terminal and no --yes, so nothing was looked up; run `stamped keys fetch --case {path}`.',
                    '{count} keys are missing. No terminal and no --yes, so nothing was looked up; run `stamped keys fetch --case {path}`.',
                    missing.length,
                ),
                { count: missing.length, path: paths.root },
            ),
        );
        return;
    }
    const summary = await fetchKeys(vault, missing, {
        channels: options.channels ?? DEFAULT_CHANNELS,
        confirm: (text) => askConsent(text, options.yes),
        fetch: (url) => fetch(url),
        resolveTxt,
    });
    if (summary.asked.length > 0 && !summary.consented) {
        console.log(_('Skipped; nothing was sent.'));
        return;
    }
    if (summary.stored.length > 0) saveVault(paths.root, vault);
    for (const s of summary.stored) {
        console.log(
            fmt(_('  stored  {name} via {origin}{flag}'), {
                name: pairName(s.pair),
                origin: s.origin,
                flag: s.conflict ? _(' — DIFFERS from a stored key') : '',
            }),
        );
    }
    for (const miss of summary.misses) {
        console.log(fmt(_('  no key  {name}: {reason}'), { name: pairName(miss.pair), reason: miss.reason }));
    }
    await reverifyApplicable(paths);
}
