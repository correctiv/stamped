/**
 * The key bundle: what survives the trip from one case to another, and what the importer refuses.
 *
 * Synthetic keys only (the fixture keys); no file is read, the bundle is text.
 */

import {
    exportKeyBundle,
    KEY_BUNDLE_FORMAT,
    KeyVault,
    parseKeyBundle,
    parseKeyMaterial,
    type NewKey,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';

import { fixtureKeys } from './fixtures.ts';

function key(name: string) {
    const parsed = parseKeyMaterial(fixtureKeys().lookup(name)?.record ?? '');
    if (parsed.kind !== 'key') throw new Error('expected a key');
    return parsed;
}

const PAIR = { domain: 'example.com', selector: 'rot' };

function importInto(vault: KeyVault, bundle: string): void {
    for (const entry of parseKeyBundle(bundle, 'bundle.json')) vault.add(entry);
}

function messageOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return '';
}

export default async () => {
    const A = key('t2048._domainkey.example.com');
    const B = key('t512._domainkey.example.com');

    await describe('key bundle', async () => {
        await it('round-trips every key with its origin and window', async () => {
            const vault = new KeyVault();
            const entries: NewKey[] = [
                {
                    ...PAIR,
                    key: A,
                    origin: 'archive.prove.email',
                    fetchedAt: '2026-10-20T10:00:00.000Z',
                    seenFrom: '2024-01-01T00:00:00.000Z',
                    seenTo: '2024-06-30T00:00:00.000Z',
                },
                {
                    ...PAIR,
                    selector: 'other',
                    key: B,
                    origin: 'archive',
                    fetchedAt: '2026-10-21T10:00:00.000Z',
                },
                { ...PAIR, selector: 'third', key: A, origin: 'dns', fetchedAt: '2026-10-22T10:00:00.000Z' },
            ];
            for (const entry of entries) vault.add(entry);

            const bundle = exportKeyBundle(vault);
            const again = new KeyVault();
            importInto(again, bundle);

            expect(again.all().length).toBe(3);
            expect(again.toJson()).toBe(vault.toJson());
            expect(exportKeyBundle(again)).toBe(bundle);
        });

        await it('does not turn an archive key into a trusted one on the way', async () => {
            const vault = new KeyVault();
            vault.add({ ...PAIR, key: A, origin: 'archive', fetchedAt: '2026-10-20T10:00:00.000Z' });
            const target = new KeyVault();
            importInto(target, exportKeyBundle(vault));
            expect(target.toKeyStore().lookup('rot._domainkey.example.com')?.source).toBe('archive');
        });

        await it('is additive: a second import changes nothing and a differing key is a conflict', async () => {
            const source = new KeyVault();
            source.add({ ...PAIR, key: A, origin: 'dns', fetchedAt: '2026-10-20T10:00:00.000Z' });
            const bundle = exportKeyBundle(source);

            const target = new KeyVault();
            importInto(target, bundle);
            importInto(target, bundle);
            expect(target.all().length).toBe(1);

            target.add({ ...PAIR, key: B, origin: 'operator', fetchedAt: '2026-10-25T10:00:00.000Z' });
            expect(target.conflicts().length).toBe(1);
            importInto(target, bundle);
            // Nothing was overwritten: both keys are still there for `keys resolve`.
            expect(target.all().length).toBe(2);
            expect(target.conflicts().length).toBe(1);
        });

        await it('reads algorithm and size from the record, not from the bundle', async () => {
            const vault = new KeyVault();
            vault.add({ ...PAIR, key: B, origin: 'dns', fetchedAt: '2026-10-20T10:00:00.000Z' });
            const lie = exportKeyBundle(vault).replace('"bits": 512', '"bits": 4096');
            const target = new KeyVault();
            importInto(target, lie);
            expect(target.all()[0]?.bits).toBe(512);
        });

        await it('refuses an unknown format version with a clear message', async () => {
            const bundle = JSON.stringify({ format: KEY_BUNDLE_FORMAT, version: 2, entries: [] });
            expect(messageOf(() => parseKeyBundle(bundle, 'future.json'))).toBe(
                'future.json uses key bundle format 2; this version of Stamped reads 1.',
            );
        });

        await it('refuses what is not a bundle, including the case’s own keys.json', async () => {
            const vault = new KeyVault();
            vault.add({ ...PAIR, key: A, origin: 'dns', fetchedAt: '2026-10-20T10:00:00.000Z' });
            expect(messageOf(() => parseKeyBundle(vault.toJson(), 'keys.json'))).toBe(
                'keys.json is not a Stamped key bundle.',
            );
            expect(messageOf(() => parseKeyBundle('nope', 'x.json'))).toBe('x.json is not valid JSON.');
        });

        await it('adds nothing when one entry is malformed', async () => {
            const vault = new KeyVault();
            vault.add({ ...PAIR, key: A, origin: 'dns', fetchedAt: '2026-10-20T10:00:00.000Z' });
            const parsed = JSON.parse(exportKeyBundle(vault));
            parsed.entries.push({ ...parsed.entries[0], selector: 'bad', record: 'v=DKIM1; p=' });
            expect(messageOf(() => parseKeyBundle(JSON.stringify(parsed), 'b.json'))).toBe(
                'b.json has a malformed entry for bad._domainkey.example.com.',
            );
            parsed.entries[1].record = 'v=DKIM1; k=rsa; p=AAAA';
            parsed.entries[1].origin = 'carrier-pigeon';
            expect(messageOf(() => parseKeyBundle(JSON.stringify(parsed), 'b.json'))).toBe(
                'b.json has a malformed entry for bad._domainkey.example.com.',
            );
        });
    });
};
