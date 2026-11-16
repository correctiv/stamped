/**
 * The seed key bundle: public DKIM keys of the large mailbox providers, shipped with the app.
 *
 * It is a READ-ONLY, lowest-priority layer under the case's own vault (see
 * `KeyVault.attachSeed`), never copied into a case's `keys.json`. It is found like the other
 * bundled data: through `XDG_DATA_DIRS`, where the launcher `gjsify ship` writes puts the app's
 * own `share/` first. No file means no seed, and that is not an error: a package build or a
 * development checkout simply runs without one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KeyVault, parseKeyBundle } from '@stamped/core';

import { bundledDataDirs } from './model-path.ts';

/** Names the seed file directly; for tests and for a maintainer trying a fresh bundle. */
export const SEED_ENV = 'STAMPED_SEED_KEYS';

/** The seed's path inside a data directory. */
export const SEED_RELATIVE = join('stamped', 'seed-keys.json');

/** Where the seed file would be, or `undefined` when none exists. */
export function seedPath(env: Record<string, string | undefined> = process.env): string | undefined {
    const override = env[SEED_ENV];
    if (override !== undefined && override !== '') return existsSync(override) ? override : undefined;
    for (const dir of bundledDataDirs(env)) {
        const candidate = join(dir, SEED_RELATIVE);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}

/** Read a seed bundle's text into a vault. Every entry is stamped `seed`, whatever the file says. */
export function seedFromText(text: string, file: string): KeyVault {
    const vault = new KeyVault();
    for (const key of parseKeyBundle(text, file)) vault.add({ ...key, origin: 'seed' });
    return vault;
}

let cached: { readonly path: string | undefined; readonly vault: KeyVault | undefined } | undefined;

/**
 * The seed layer, or `undefined`. A damaged seed file is skipped rather than fatal: the seed is a
 * convenience, and a case must stay usable without it.
 */
export function loadSeed(env: Record<string, string | undefined> = process.env): KeyVault | undefined {
    const path = seedPath(env);
    if (cached?.path === path && cached !== undefined) return cached.vault;
    let vault: KeyVault | undefined;
    if (path !== undefined) {
        try {
            vault = seedFromText(readFileSync(path, 'utf8'), path);
        } catch {
            vault = undefined;
        }
    }
    cached = { path, vault };
    return vault;
}
