/**
 * The host half of the key vault: the case's `keys.json` on disk.
 *
 * The model (and why it is per case) lives in `@stamped/core`'s `keyvault.ts`; this reads and
 * writes the file. The write goes through a temp file and a rename so a crash mid-save leaves the
 * previous vault intact — it is the only record of which keys were gathered and from where.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fmt, KeyVault, _ } from '@stamped/core';
import { assertWritable, type CasePaths, VAULT_NAME } from '@stamped/store';

import { loadSeed } from './seed.ts';

export function vaultFile(caseDir: string): string {
    return join(caseDir, VAULT_NAME);
}

/** The case's vault with the shipped seed attached underneath it (never saved with it). */
export function loadVault(caseDir: string, seed: KeyVault | undefined = loadSeed()): KeyVault {
    const path = vaultFile(caseDir);
    if (!existsSync(path)) return new KeyVault().attachSeed(seed);
    try {
        return KeyVault.fromJson(readFileSync(path, 'utf8')).attachSeed(seed);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(fmt(_('Cannot use {path}: {reason}'), { path, reason }));
    }
}

export function saveVault(paths: CasePaths, vault: KeyVault): void {
    assertWritable(paths);
    mkdirSync(paths.root, { recursive: true });
    const path = vaultFile(paths.root);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, vault.toJson());
    renameSync(tmp, path);
}
