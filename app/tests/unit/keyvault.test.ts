/**
 * The persistent key vault, the key-material parser, the consent gate and the two lookups.
 *
 * Synthetic keys only (the fixture keys and RFC 8463's published Ed25519 key). Every network
 * path runs against an injected fetch or resolver, so the suite never leaves the machine.
 */

import {
    consentCovers,
    describeConsent,
    KeyVault,
    lookupArchive,
    lookupDns,
    missingPairs,
    parseKeyMaterial,
    parsePairList,
    requestTemplate,
    type FetchLike,
    type LookupConsent,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';

import { fixtureKeys } from './fixtures.ts';

const ED25519_P = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

function rsaRecord(name = 't2048._domainkey.example.com'): string {
    return fixtureKeys().lookup(name)?.record ?? '';
}

function rsaP(name?: string): string {
    return rsaRecord(name).replace('v=DKIM1; k=rsa; p=', '');
}

async function rejects(run: () => Promise<unknown> | unknown): Promise<boolean> {
    try {
        await run();
    } catch {
        return true;
    }
    return false;
}

function key(text: string) {
    const parsed = parseKeyMaterial(text);
    if (parsed.kind !== 'key') throw new Error('expected a key');
    return parsed;
}

export default async () => {
    await describe('key material', async () => {
        await it('reads a bare p= value and measures the modulus', async () => {
            const parsed = key(rsaP());
            expect(parsed.algorithm).toBe('rsa');
            expect(parsed.bits).toBe(2048);
        });

        await it('reads a PEM block and a 512-bit key', async () => {
            expect(key(rsaRecord('t512._domainkey.example.com')).bits).toBe(512);
        });

        await it('reads a record pasted from dig, quoted and split', async () => {
            const p = rsaP();
            const half = Math.floor(p.length / 2);
            const dig = `sel._domainkey.example.com. 300 IN TXT "v=DKIM1; k=rsa; p=${p.slice(0, half)}" "${p.slice(half)}"`;
            expect(key(dig).record).toBe(`v=DKIM1; k=rsa; p=${p}`);
        });

        await it('reads Ed25519 as the raw 32-byte key', async () => {
            const parsed = key(`v=DKIM1; k=ed25519; p=${ED25519_P}`);
            expect(parsed.algorithm).toBe('ed25519');
            expect(parsed.bits).toBe(256);
        });

        await it('reports an empty p= as revoked', async () => {
            expect(parseKeyMaterial('v=DKIM1; p=').kind).toBe('revoked');
        });

        await it('refuses truncated and nonsensical text', async () => {
            expect(await rejects(() => parseKeyMaterial(rsaP().slice(0, 60)))).toBe(true);
            expect(await rejects(() => parseKeyMaterial('hello world'))).toBe(true);
            expect(await rejects(() => parseKeyMaterial('   '))).toBe(true);
            expect(await rejects(() => parseKeyMaterial('v=DKIM1; k=dsa; p=AAAA'))).toBe(true);
        });
    });

    await describe('the vault', async () => {
        const pair = { domain: 'Example.com', selector: 'Sel' };
        const a = key(rsaRecord());
        const b = key(rsaRecord('t512._domainkey.example.com'));

        await it('stores a key with origin, time and bits', async () => {
            const vault = new KeyVault();
            const out = vault.add({ ...pair, key: a, origin: 'operator', fetchedAt: '2026-10-20T10:00:00Z' });
            expect(out.status).toBe('added');
            const entry = vault.recordsFor({ domain: 'example.com', selector: 'sel' })[0];
            expect(entry?.bits).toBe(2048);
            expect(entry?.origin).toBe('operator');
            expect(entry?.algorithm).toBe('rsa');
        });

        await it('keeps a differing key and flags the conflict, never overwriting', async () => {
            const vault = new KeyVault();
            vault.add({ ...pair, key: a, origin: 'archive.prove.email', fetchedAt: '2026-10-20T10:00:00Z' });
            const out = vault.add({ ...pair, key: b, origin: 'dns', fetchedAt: '2026-10-21T10:00:00Z' });
            expect(out.status).toBe('conflict');
            expect(vault.size).toBe(2);
            expect(vault.conflicts().length).toBe(1);
            expect(out.others.length).toBe(1);
        });

        await it('treats the same record twice as unchanged and widens the seen range', async () => {
            const vault = new KeyVault();
            vault.add({
                ...pair,
                key: a,
                origin: 'archive.prove.email',
                fetchedAt: '2026-10-20T10:00:00Z',
                seenFrom: '2024-03-01T00:00:00Z',
                seenTo: '2024-04-01T00:00:00Z',
            });
            const out = vault.add({
                ...pair,
                key: a,
                origin: 'archive.prove.email',
                fetchedAt: '2026-10-22T10:00:00Z',
                seenFrom: '2024-02-01T00:00:00Z',
                seenTo: '2024-03-15T00:00:00Z',
            });
            expect(out.status).toBe('unchanged');
            expect(vault.size).toBe(1);
            expect(out.entry.seenFrom).toBe('2024-02-01T00:00:00Z');
            expect(out.entry.seenTo).toBe('2024-04-01T00:00:00Z');
        });

        await it('feeds the verifier the best origin and maps archives to the archive source', async () => {
            const vault = new KeyVault();
            vault.add({ ...pair, key: a, origin: 'archive.prove.email', fetchedAt: '2026-10-20T10:00:00Z' });
            expect(vault.toKeyStore().lookup('sel._domainkey.example.com')?.source).toBe('archive');
            vault.add({ ...pair, key: a, origin: 'operator', fetchedAt: '2026-10-20T11:00:00Z' });
            expect(vault.toKeyStore().lookup('sel._domainkey.example.com')?.source).toBe('operator');
        });
        await it('serves a recovered key as the recovered source and round-trips it', async () => {
            const vault = new KeyVault();
            vault.add({ ...pair, key: a, origin: 'recovered', fetchedAt: '2026-10-20T10:00:00Z' });
            expect(vault.toKeyStore().lookup('sel._domainkey.example.com')?.source).toBe('recovered');
            const again = KeyVault.fromJson(vault.toJson());
            expect(again.all()[0]?.origin).toBe('recovered');
        });

        await it('round-trips through JSON', async () => {
            const vault = new KeyVault();
            vault.add({
                ...pair,
                key: a,
                origin: 'archive.prove.email',
                fetchedAt: '2026-10-20T10:00:00Z',
                seenFrom: '2024-03-01T00:00:00Z',
                seenTo: '2024-04-01T00:00:00Z',
            });
            const again = KeyVault.fromJson(vault.toJson());
            expect(again.toJson()).toBe(vault.toJson());
            expect(await rejects(() => KeyVault.fromJson('{"version":2}'))).toBe(true);
            expect(await rejects(() => KeyVault.fromJson('nope'))).toBe(true);
        });
    });

    await describe('the pair list', async () => {
        await it('parses TSV with counts and sorts the missing pairs by mail count', async () => {
            const pairs = parsePairList(
                '# domain\tselector\tmails\nexample.com\ta\t3\nexample.com\tb\t40\nexample.com\tc\n',
            );
            expect(pairs.length).toBe(3);
            const vault = new KeyVault();
            vault.add({
                domain: 'example.com',
                selector: 'c',
                key: key(rsaRecord()),
                origin: 'operator',
                fetchedAt: '2026-10-20T10:00:00Z',
            });
            const missing = missingPairs(pairs, vault);
            expect(missing.map((m) => m.selector)).toStrictEqual(['b', 'a']);
        });

        await it('refuses a line without a selector', async () => {
            expect(await rejects(() => parsePairList('example.com\n'))).toBe(true);
        });
    });

    await describe('consent', async () => {
        const pairs = [{ domain: 'example.com', selector: 'sel' }];

        await it('lists exactly the names and, for DNS, says it reveals interest', async () => {
            const dns = describeConsent('dns', pairs);
            expect(dns.items).toStrictEqual(['sel._domainkey.example.com']);
            expect(dns.warning.includes('interest')).toBe(true);
            expect(describeConsent('archive.prove.email', pairs).title.includes('archive.prove.email')).toBe(
                true,
            );
        });

        await it('covers only the listed pair on the listed channel', async () => {
            const consent: LookupConsent = { channel: 'dns', pairs };
            expect(consentCovers(consent, 'dns', pairs[0]!)).toBe(true);
            expect(consentCovers(consent, 'archive.prove.email', pairs[0]!)).toBe(false);
            expect(consentCovers(consent, 'dns', { domain: 'other.example', selector: 'sel' })).toBe(false);
        });
    });

    await describe('lookups', async () => {
        const pair = { domain: 'example.com', selector: 'sel' };

        function archiveFetch(rows: unknown, calls: string[] = []): FetchLike {
            return async (url) => {
                calls.push(url);
                return { ok: true, status: 200, json: async () => rows };
            };
        }

        await it('archive: maps rows to keys with the seen range, filtering other selectors', async () => {
            const calls: string[] = [];
            const rows = [
                {
                    domain: 'example.com',
                    selector: 'sel',
                    value: rsaRecord(),
                    firstSeenAt: '2024-01-01T00:00:00Z',
                    lastSeenAt: '2025-01-01T00:00:00Z',
                },
                {
                    domain: 'mail.example.com',
                    selector: 'sel',
                    value: rsaRecord('t512._domainkey.example.com'),
                },
                { domain: 'example.com', selector: 'other', value: rsaRecord() },
            ];
            const result = await lookupArchive(
                { channel: 'archive.prove.email', pairs: [pair] },
                [pair],
                archiveFetch(rows, calls),
            );
            expect(result.found.length).toBe(1);
            expect(result.found[0]?.origin).toBe('archive.prove.email');
            expect(result.found[0]?.seenFrom).toBe('2024-01-01T00:00:00Z');
            expect(result.found[0]?.key.bits).toBe(2048);
            expect(calls).toStrictEqual([
                'https://archive.prove.email/api/key?domain=example.com&selector=sel',
            ]);
        });

        await it('archive: an empty or unusable answer is a miss, not an error', async () => {
            const consent: LookupConsent = { channel: 'archive.prove.email', pairs: [pair] };
            const empty = await lookupArchive(consent, [pair], archiveFetch([]));
            expect(empty.misses.length).toBe(1);
            const revoked = await lookupArchive(
                consent,
                [pair],
                archiveFetch([{ domain: 'example.com', selector: 'sel', value: 'v=DKIM1; p=' }]),
            );
            expect(revoked.found.length).toBe(0);
        });

        const noSleep = { sleep: async () => undefined, backoffMs: 1 };

        await it('archive: HTTP 429 then 200 is retried and the key is found', async () => {
            const consent: LookupConsent = { channel: 'archive.prove.email', pairs: [pair] };
            const waits: number[] = [];
            let calls = 0;
            const result = await lookupArchive(
                consent,
                [pair],
                async () => {
                    calls++;
                    if (calls === 1) {
                        return {
                            ok: false,
                            status: 429,
                            headers: { get: () => '3' },
                            json: async () => ({}),
                        };
                    }
                    return {
                        ok: true,
                        status: 200,
                        json: async () => [{ domain: 'example.com', selector: 'sel', value: rsaRecord() }],
                    };
                },
                8,
                { sleep: async (ms) => void waits.push(ms), now: () => 0 },
            );
            expect(calls).toBe(2);
            expect(waits[0]).toBe(3000);
            expect(result.found.length).toBe(1);
            expect(result.errors.length).toBe(0);
            expect(result.misses.length).toBe(0);
        });

        await it('archive: a persistent 503 or 429 is an error, never a miss', async () => {
            const consent: LookupConsent = { channel: 'archive.prove.email', pairs: [pair] };
            for (const status of [503, 429]) {
                let calls = 0;
                const down = await lookupArchive(
                    consent,
                    [pair],
                    async () => {
                        calls++;
                        return { ok: false, status, json: async () => ({}) };
                    },
                    8,
                    { ...noSleep, attempts: 3 },
                );
                expect(calls).toBe(3);
                expect(down.misses.length).toBe(0);
                expect(down.errors.length).toBe(1);
                expect(down.errors[0]?.reason.includes(String(status))).toBe(true);
            }
        });

        await it('archive: a thrown fetch is retried, then an error; a 404 is a miss at once', async () => {
            const consent: LookupConsent = { channel: 'archive.prove.email', pairs: [pair] };
            const broken = await lookupArchive(
                consent,
                [pair],
                async () => {
                    throw new Error('timeout');
                },
                8,
                { ...noSleep, attempts: 2 },
            );
            expect(broken.errors[0]?.reason).toBe('timeout');
            expect(broken.misses.length).toBe(0);
            let calls = 0;
            const gone = await lookupArchive(
                consent,
                [pair],
                async () => {
                    calls++;
                    return { ok: false, status: 404, json: async () => ({}) };
                },
                8,
                noSleep,
            );
            expect(calls).toBe(1);
            expect(gone.misses.length).toBe(1);
            expect(gone.errors.length).toBe(0);
        });

        await it('looks pairs up concurrently, bounded, and reports them in pair order', async () => {
            const pairs = Array.from({ length: 20 }, (_unused, i) => ({
                domain: 'example.com',
                selector: `s${i}`,
            }));
            let inFlight = 0;
            let peak = 0;
            const result = await lookupDns(
                { channel: 'dns', pairs },
                pairs,
                async (name) => {
                    inFlight++;
                    peak = Math.max(peak, inFlight);
                    // later pairs answer first, so completion order differs from pair order
                    const index = Number(name.split('.')[0]?.slice(1));
                    await new Promise((resolve) => setTimeout(resolve, 20 - index));
                    inFlight--;
                    throw new Error(name);
                },
                4,
            );
            expect(peak > 1).toBe(true);
            expect(peak <= 4).toBe(true);
            expect(result.errors.map((m) => m.pair.selector)).toStrictEqual(pairs.map((p) => p.selector));
        });

        await it('refuses to send anything the consent does not list', async () => {
            const calls: string[] = [];
            const consent: LookupConsent = { channel: 'archive.prove.email', pairs: [pair] };
            const stranger = { domain: 'secret.example', selector: 'x' };
            expect(await rejects(() => lookupArchive(consent, [stranger], archiveFetch([], calls)))).toBe(
                true,
            );
            expect(await rejects(() => lookupDns(consent, [pair], async () => []))).toBe(true);
            expect(calls.length).toBe(0);
        });

        await it('dns: joins TXT parts and records the dns origin', async () => {
            const record = rsaRecord();
            const half = Math.floor(record.length / 2);
            let asked = '';
            const result = await lookupDns({ channel: 'dns', pairs: [pair] }, [pair], async (name) => {
                asked = name;
                return [[record.slice(0, half), record.slice(half)]];
            });
            expect(asked).toBe('sel._domainkey.example.com');
            expect(result.found[0]?.origin).toBe('dns');
            expect(result.found[0]?.key.bits).toBe(2048);
        });

        await it('dns: a resolver failure and a withdrawn key are misses', async () => {
            const consent: LookupConsent = { channel: 'dns', pairs: [pair] };
            const failed = await lookupDns(consent, [pair], async () => {
                throw new Error('NXDOMAIN');
            });
            expect(failed.misses[0]?.reason).toBe('NXDOMAIN');
            const withdrawn = await lookupDns(consent, [pair], async () => [['v=DKIM1; p=']]);
            expect(withdrawn.found.length).toBe(0);
            expect(withdrawn.misses.length).toBe(1);
        });
    });

    await describe('the provider request', async () => {
        await it('names every selector, the domain and the period', async () => {
            const text = requestTemplate({
                domain: 'example.com',
                selectors: ['a', 'b'],
                period: 'March 2019',
            });
            expect(text.includes('a._domainkey.example.com')).toBe(true);
            expect(text.includes('b._domainkey.example.com')).toBe(true);
            expect(text.includes('March 2019')).toBe(true);
        });
    });
};
