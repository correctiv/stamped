/**
 * The seed key layer: a shipped, read-only, lowest-priority source underneath the case's vault.
 *
 * Offline and synthetic: the seed bundle is built here from the fixture keys (example.com), never
 * from a DNS answer. The rules under test: the seed answers only where the case holds nothing,
 * it is never exported or saved as the case's own, and it keeps the conservative `archive-key`
 * caveat instead of claiming a record published when the message was signed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    classifyMessage,
    exportKeyBundle,
    KeyVault,
    missingPairs,
    parseKeyBundle,
    parseKeyMaterial,
} from '@stamped/core';
import { verifyMessage } from '@stamped/verify';
import { describe, expect, it } from '@gjsify/unit';

import { keyStoreFrom } from '../../src/lib/keys.ts';
import { loadSeed, SEED_ENV, seedFromText, seedPath } from '../../src/lib/seed.ts';
import { keyRows } from '../../src/gui/view/keys.ts';
import { fixture, fixtureKeys, fixturePath } from './fixtures.ts';

const NAME = 't2048._domainkey.example.com';
const PAIR = { domain: 'example.com', selector: 't2048' };
const OTHER = { domain: 'example.com', selector: 'trotated' };

function record(name: string): string {
    return fixtureKeys().lookup(name)?.record ?? '';
}

function newKey(name: string, origin: 'seed' | 'operator', fetchedAt = '2026-01-01T00:00:00Z') {
    const parsed = parseKeyMaterial(record(name));
    if (parsed.kind !== 'key') throw new Error('expected a key');
    const [selector, , ...rest] = name.split('.');
    return { domain: rest.join('.'), selector: selector ?? '', key: parsed, origin, fetchedAt } as const;
}

function seedLayer(...names: string[]): KeyVault {
    const vault = new KeyVault();
    for (const name of names) vault.add(newKey(name, 'seed'));
    return seedFromText(exportKeyBundle(vault), 'seed-keys.json');
}

function withEnv<T>(env: Record<string, string>, run: () => T): T {
    const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
        return run();
    } finally {
        for (const [k, v] of before) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

export default async () => {
    await describe('the seed layer in the vault', async () => {
        await it('answers a pair the case holds nothing for, as an archive-provenance key', async () => {
            const vault = new KeyVault().attachSeed(seedLayer(NAME));
            const found = vault.toKeyStore().lookup(NAME);
            expect(found?.source).toBe('archive');
            expect(found?.record).toBe(record(NAME));
        });

        await it('is beaten by the case’s own key', async () => {
            const vault = new KeyVault().attachSeed(seedLayer(NAME));
            vault.add(newKey(NAME, 'operator'));
            expect(vault.toKeyStore().lookup(NAME)?.source).toBe('operator');
        });

        await it('never answers a pair the case holds a different record for', async () => {
            const seed = new KeyVault();
            seed.add({ ...newKey('trotated._domainkey.example.com', 'seed'), selector: 't2048' });
            const vault = new KeyVault().attachSeed(seedFromText(exportKeyBundle(seed), 'seed-keys.json'));
            vault.add(newKey(NAME, 'operator'));
            vault.add({ ...newKey('trotated._domainkey.example.com', 'operator'), selector: 't2048' });
            expect(vault.conflicts().length).toBe(1);
            expect(vault.toKeyStore().lookup(NAME)?.source).toBe('operator');
        });

        await it('stays invisible: not counted, not listed, not saved, still missing', async () => {
            const vault = new KeyVault().attachSeed(seedLayer(NAME));
            expect(vault.size).toBe(0);
            expect(vault.all().length).toBe(0);
            expect(vault.recordsFor(PAIR).length).toBe(0);
            expect(vault.toJson().includes('"seed"')).toBe(false);
            const missing = missingPairs([{ ...PAIR, mails: 3 }], vault);
            expect(missing.length).toBe(1);
            expect(vault.seedCovers(PAIR)).toBe(true);
            expect(vault.seedCovers(OTHER)).toBe(false);
        });

        await it('is never exported as the case’s own', async () => {
            const vault = new KeyVault().attachSeed(seedLayer(NAME));
            expect(parseKeyBundle(exportKeyBundle(vault), 'out.json').length).toBe(0);
            vault.add(newKey('trotated._domainkey.example.com', 'operator'));
            const exported = parseKeyBundle(exportKeyBundle(vault), 'out.json');
            expect(exported.map((k) => k.selector)).toStrictEqual(['trotated']);
        });

        await it('stamps every entry seed, whatever the file claims', async () => {
            const owner = new KeyVault();
            owner.add(newKey(NAME, 'operator'));
            const seed = seedFromText(exportKeyBundle(owner), 'seed-keys.json');
            expect(seed.all().map((e) => e.origin)).toStrictEqual(['seed']);
        });
    });

    await describe('a message checked with a seed key', async () => {
        await it('is confirmed only with the archive-key caveat', async () => {
            const keys = new KeyVault().attachSeed(seedLayer(NAME)).toKeyStore();
            const finding = classifyMessage(await verifyMessage(fixture('confirmed.eml'), { keys }));
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect(finding.caveats).toContain('archive-key');
        });
    });

    await describe('finding and loading the seed file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'stamped-seed-'));
        const file = join(dir, 'seed-keys.json');
        const vault = new KeyVault();
        vault.add(newKey(NAME, 'operator'));
        writeFileSync(file, exportKeyBundle(vault));

        await it('uses the override file, and no file means no seed', async () => {
            expect(seedPath({ [SEED_ENV]: file })).toBe(file);
            expect(seedPath({ [SEED_ENV]: join(dir, 'absent.json') })).toBe(undefined);
            expect(loadSeed({ [SEED_ENV]: join(dir, 'absent.json') })).toBe(undefined);
            expect(loadSeed({ [SEED_ENV]: file })?.seedNames().size).toBe(0);
            expect(loadSeed({ [SEED_ENV]: file })?.all().length).toBe(1);
        });

        await it('skips a damaged file instead of failing', async () => {
            const bad = join(dir, 'bad.json');
            writeFileSync(bad, '{ not json');
            expect(loadSeed({ [SEED_ENV]: bad })).toBe(undefined);
        });

        await it('feeds --key arguments on top of it', async () => {
            const keys = withEnv({ [SEED_ENV]: file }, () => keyStoreFrom([]));
            expect(keys.lookup(NAME)?.source).toBe('archive');
            const override = withEnv({ [SEED_ENV]: file }, () => keyStoreFrom([`${NAME}=${record(NAME)}`]));
            expect(override.lookup(NAME)?.source).toBe('operator');
        });

        rmSync(dir, { recursive: true, force: true });
    });

    await describe('the key work list with a seed', async () => {
        const demand = {
            domain: 'example.com',
            selector: 't2048',
            messages: 5,
            unverifiable: 0,
            confirmed: 0,
            withCaveats: 5,
        };

        await it('marks a seed-covered pair as such and not as stored', async () => {
            const rows = keyRows([demand], new Set(), new Set([NAME]));
            expect(rows[0]?.have).toBe(false);
            expect(rows[0]?.status).toBe('Seed key in use');
        });

        await it('is unchanged without a seed', async () => {
            const rows = keyRows([demand], new Set());
            expect(rows[0]?.status).toBe('Nothing waiting');
        });
    });

    await describe('the shipped bundle', async () => {
        const path = join(fixturePath('..', '..', '..', 'data'), 'seed-keys.json');

        await it('parses, and every entry is a seed entry with a source', async () => {
            expect(existsSync(path)).toBe(true);
            const text = readFileSync(path, 'utf8');
            const data = JSON.parse(text) as {
                notice?: string;
                retrievedAt?: string;
                entries: { source?: string }[];
            };
            expect(typeof data.notice).toBe('string');
            expect(typeof data.retrievedAt).toBe('string');
            expect(data.entries.length > 0).toBe(true);
            expect(data.entries.every((e) => typeof e.source === 'string')).toBe(true);
            const seed = seedFromText(text, path);
            expect(seed.all().length).toBe(data.entries.length);
        });
    });
};
