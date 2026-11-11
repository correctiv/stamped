/**
 * Measuring a key rotation: which messages each candidate key verifies, and whether the dates
 * of those messages split cleanly. Synthetic fixtures only (`tools/make-rotation-fixtures.mjs`).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { KeyStore, KeyVault, parseKeyMaterial } from '@stamped/core';
import {
    digest,
    importSources,
    measureKeyEras,
    openCase,
    openIndex,
    reverifyPairs,
    type CasePaths,
} from '@stamped/store';

import { fixture, fixtureKeys, fixturePath } from './fixtures.ts';

const PAIR = { domain: 'example.com', selector: 'trot' };
const NAME = 'trot._domainkey.example.com';

function keyFile(name: string) {
    const parsed = parseKeyMaterial(readFileSync(fixturePath('rotation', name), 'utf8'));
    if (parsed.kind !== 'key') throw new Error('fixture key');
    return parsed;
}

/** Both keys of the rotation, from origins that carry no window of their own. */
function rotationVault(): KeyVault {
    const vault = new KeyVault();
    const now = '2026-11-01T10:00:00.000Z';
    vault.add({ ...PAIR, key: keyFile('old.pub.pem'), origin: 'recovered', fetchedAt: now });
    vault.add({ ...PAIR, key: keyFile('new.pub.pem'), origin: 'dns', fetchedAt: now });
    return vault;
}

async function withCase(
    messages: readonly string[],
    body: (paths: CasePaths) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-eras-'));
    try {
        const paths = openCase(root);
        for (const name of messages) {
            await importSources(paths, [fixturePath(name)], { keys: new KeyStore() });
        }
        await body(paths);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function verdictOf(paths: CasePaths, name: string): string {
    const db = openIndex(paths);
    try {
        const row = db.prepare('SELECT verdict FROM messages WHERE hash = ?').get(digest(fixture(name))) as
            | { verdict?: string }
            | undefined;
        return row?.verdict ?? 'none';
    } finally {
        db.close();
    }
}

const CLEAN = ['rotated-old-1.eml', 'rotated-old-2.eml', 'rotated-new-1.eml', 'rotated-new-2.eml'];

export default async () => {
    await describe('key era measurement', async () => {
        await it('reads a rotation off the dates of the messages each key alone verifies', async () => {
            await withCase(CLEAN, async (paths) => {
                const vault = rotationVault();
                expect(vault.conflicts().length).toBe(1);

                const { pairs, vault: measured } = await measureKeyEras(paths, vault);
                expect(pairs.length).toBe(1);
                const report = pairs[0];
                expect(report?.outcome).toBe('rotation');
                expect(report?.unexplained).toBe(0);
                const old = report?.eras.find((era) => era.key.bits === 1024);
                const current = report?.eras.find((era) => era.key.bits === 2048);
                expect(old?.messages).toBe(2);
                expect(old?.from).toBe('2019-01-10T09:00:00.000Z');
                expect(old?.to).toBe('2019-03-20T09:00:00.000Z');
                expect(current?.messages).toBe(2);
                expect(current?.from).toBe('2024-02-01T09:00:00.000Z');
                expect(current?.to).toBe('2024-04-15T09:00:00.000Z');

                // The measurement edits a copy: the vault the caller passed is as it was.
                expect(vault.conflicts().length).toBe(1);
                expect(measured.conflicts().length).toBe(0);
                // A message in the gap between the windows gets no key, never a chance one.
                expect(measured.toKeyStore().lookup(NAME, '2021-05-10T09:00:00.000Z')).toBeUndefined();
                expect(measured.toKeyStore().lookup(NAME, '2019-02-01T00:00:00.000Z')).toBeDefined();
            });
        });

        await it('verifies the messages afterwards, each under the key of its era', async () => {
            await withCase(CLEAN, async (paths) => {
                const vault = rotationVault();
                const before = await reverifyPairs(paths, [PAIR], vault);
                expect(before.skippedConflicts.length).toBe(1);
                expect(verdictOf(paths, 'rotated-old-1.eml')).toBe('unverifiable');

                const { vault: measured } = await measureKeyEras(paths, vault);
                await reverifyPairs(paths, [PAIR], measured);
                for (const name of CLEAN) {
                    expect(verdictOf(paths, name) === 'unverifiable').toBe(false);
                }
            });
        });

        await it('counts a message no key verifies and still reads the rotation', async () => {
            await withCase([...CLEAN, 'rotated-altered.eml'], async (paths) => {
                const { pairs } = await measureKeyEras(paths, rotationVault());
                expect(pairs[0]?.outcome).toBe('rotation');
                expect(pairs[0]?.unexplained).toBe(1);
            });
        });

        await it('leaves interleaved eras a conflict', async () => {
            await withCase([...CLEAN, 'rotated-stray.eml'], async (paths) => {
                const { pairs, vault: measured } = await measureKeyEras(paths, rotationVault());
                expect(pairs[0]?.outcome).toBe('interleaved');
                // Nothing was written: the old key signed in 2024 again, which is not a rotation.
                expect(measured.conflicts().length).toBe(1);
                expect(measured.all().every((entry) => entry.seenFrom === undefined)).toBe(true);
            });
        });

        await it('does not guess for a key that verifies no message', async () => {
            await withCase(['rotated-old-1.eml', 'rotated-old-2.eml'], async (paths) => {
                const vault = new KeyVault();
                const now = '2026-11-01T10:00:00.000Z';
                vault.add({ ...PAIR, key: keyFile('old.pub.pem'), origin: 'recovered', fetchedAt: now });
                const decoy = parseKeyMaterial(
                    fixtureKeys().lookup('t2048._domainkey.example.com')?.record ?? '',
                );
                if (decoy.kind !== 'key') throw new Error('fixture key');
                vault.add({ ...PAIR, key: decoy, origin: 'dns', fetchedAt: now });

                const { pairs, vault: measured } = await measureKeyEras(paths, vault);
                expect(pairs[0]?.outcome).toBe('unproven');
                expect(measured.conflicts().length).toBe(1);
            });
        });

        await it('has nothing to measure without a conflict', async () => {
            await withCase(CLEAN, async (paths) => {
                const vault = new KeyVault();
                vault.add({
                    ...PAIR,
                    key: keyFile('old.pub.pem'),
                    origin: 'recovered',
                    fetchedAt: '2026-11-01T10:00:00.000Z',
                });
                const { pairs } = await measureKeyEras(paths, vault);
                expect(pairs.length).toBe(0);
            });
        });
    });
};
