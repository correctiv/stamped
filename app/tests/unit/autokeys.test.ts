/**
 * Automatic key fetching: the missing-pair ranking, the one consent, and the re-verification
 * that follows. Transport is injected, so nothing here touches the network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    type ConsentText,
    type FetchLike,
    fetchKeys,
    KeyStore,
    KeyVault,
    parseKeyMaterial,
    type TxtResolver,
} from '@stamped/core';
import {
    digest,
    beginBatch,
    commitBatch,
    importSources,
    messageCount,
    missingKeyPairs,
    openCase,
    openIndex,
    reverifyPairs,
    unappliedKeyPairs,
    type CasePaths,
} from '@stamped/store';

import { fixture, fixtureKeys, fixturePath } from './fixtures.ts';

const T2048 = 't2048._domainkey.example.com';
const TED = 'ted._domainkey.example.com';

function record(name: string): string {
    return fixtureKeys().lookup(name)?.record ?? '';
}

/** A case holding three signed fixtures, imported with NO keys: everything is unverifiable. */
async function withCase(body: (paths: CasePaths) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-auto-'));
    try {
        const paths = openCase(root);
        for (const name of ['confirmed.eml', 'headers-altered.eml', 'confirmed-ed25519.eml']) {
            await importSources(paths, [fixturePath(name)], { keys: new KeyStore() });
        }
        await body(paths);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function verdictOf(paths: CasePaths, fixtureName: string): string {
    const db = openIndex(paths);
    try {
        const row = db
            .prepare('SELECT verdict FROM messages WHERE hash = ?')
            .get(digest(fixture(fixtureName))) as { verdict?: string } | undefined;
        return row?.verdict ?? 'none';
    } finally {
        db.close();
    }
}

function archiveFetch(rows: Record<string, string>, asked: string[]): FetchLike {
    return async (url) => {
        asked.push(url);
        const query = new URL(url).searchParams;
        const name = `${query.get('selector')}._domainkey.${query.get('domain')}`;
        const value = rows[name];
        return {
            ok: true,
            status: 200,
            json: async () =>
                value === undefined
                    ? []
                    : [{ domain: query.get('domain'), selector: query.get('selector'), value }],
        };
    };
}

const noDns: TxtResolver = async () => {
    throw new Error('DNS must not be asked');
};

export default async () => {
    await describe('missing keys of a case', async () => {
        await it('ranks the pairs by the number of messages they affect', async () => {
            await withCase(async (paths) => {
                const db = openIndex(paths);
                try {
                    expect(messageCount(db)).toBe(3);
                    const missing = missingKeyPairs(db, new KeyVault());
                    expect(missing.map((p) => `${p.selector}@${p.domain}:${p.mails}`)).toStrictEqual([
                        't2048@example.com:2',
                        'ted@example.com:1',
                    ]);
                } finally {
                    db.close();
                }
            });
        });
    });

    await describe('fetching on one consent', async () => {
        await it('asks about exactly the listed pairs, and only after a yes', async () => {
            await withCase(async (paths) => {
                const db = openIndex(paths);
                const missing = missingKeyPairs(db, new KeyVault());
                db.close();

                // A refusal sends nothing at all.
                const refused: string[] = [];
                const none = await fetchKeys(new KeyVault(), missing, {
                    channels: ['archive.prove.email', 'dns'],
                    confirm: async () => false,
                    fetch: archiveFetch({}, refused),
                    resolveTxt: noDns,
                });
                expect(none.consented).toBe(false);
                expect(refused.length).toBe(0);

                // A yes covers the listed pairs, with the counts shown in the prompt.
                let shown: ConsentText | undefined;
                const asked: string[] = [];
                const vault = new KeyVault();
                const done = await fetchKeys(vault, missing, {
                    channels: ['archive.prove.email'],
                    confirm: async (text) => {
                        shown = text;
                        return true;
                    },
                    fetch: archiveFetch({ [T2048]: record(T2048) }, asked),
                    resolveTxt: noDns,
                });
                expect(shown?.items.length).toBe(2);
                expect(shown?.items[0]?.includes(T2048)).toBe(true);
                expect(shown?.items[0]?.includes('2')).toBe(true);
                expect(asked.length).toBe(2);
                expect(done.stored.length).toBe(1);
                expect(done.misses.length).toBe(1);
            });
        });

        await it('falls back to the DNS only for what the archive lacked', async () => {
            await withCase(async (paths) => {
                const db = openIndex(paths);
                const missing = missingKeyPairs(db, new KeyVault());
                db.close();
                const dnsAsked: string[] = [];
                const vault = new KeyVault();
                const done = await fetchKeys(vault, missing, {
                    channels: ['archive.prove.email', 'dns'],
                    confirm: async () => true,
                    fetch: archiveFetch({ [T2048]: record(T2048) }, []),
                    resolveTxt: async (name) => {
                        dnsAsked.push(name);
                        return [[record(TED)]];
                    },
                });
                expect(dnsAsked).toStrictEqual([TED]);
                expect(done.stored.map((s) => s.origin).sort()).toStrictEqual(['archive.prove.email', 'dns']);
                expect(done.misses.length).toBe(0);
            });
        });
        await it('stores each key the moment it arrives, not at the end', async () => {
            await withCase(async (paths) => {
                const db = openIndex(paths);
                const missing = missingKeyPairs(db, new KeyVault());
                db.close();
                const seen: string[] = [];
                const vaultSizeWhenCalled: number[] = [];
                const vault = new KeyVault();
                await fetchKeys(vault, missing, {
                    channels: ['archive.prove.email', 'dns'],
                    confirm: async () => true,
                    fetch: archiveFetch({ [T2048]: record(T2048) }, []),
                    resolveTxt: async () => [[record(TED)]],
                    onStored: (s) => {
                        seen.push(s.pair.selector);
                        // the key must already be IN the vault when the caller is told, so a save
                        // there keeps it even if the run dies before the end
                        vaultSizeWhenCalled.push(vault.size);
                    },
                });
                expect(seen).toStrictEqual(['t2048', 'ted']);
                expect(vaultSizeWhenCalled).toStrictEqual([1, 2]);
            });
        });
    });

    await describe('re-verification', async () => {
        await it('turns unverifiable into a real verdict once the key has arrived', async () => {
            await withCase(async (paths) => {
                expect(verdictOf(paths, 'confirmed.eml')).toBe('unverifiable');
                const db = openIndex(paths);
                const missing = missingKeyPairs(db, new KeyVault());
                db.close();

                const vault = new KeyVault();
                await fetchKeys(vault, missing, {
                    channels: ['archive.prove.email'],
                    confirm: async () => true,
                    fetch: archiveFetch({ [T2048]: record(T2048) }, []),
                    resolveTxt: noDns,
                });
                const result = await reverifyPairs(paths, vault.all(), vault);

                expect(result.checked).toBe(2);
                expect(result.changed.length).toBe(2);
                // Verified against a key that only the archive vouches for: confirmed, with the
                // archive-key caveat — and the altered message is still reported as altered.
                expect(verdictOf(paths, 'confirmed.eml')).toBe('confirmed-with-caveats');
                expect(verdictOf(paths, 'headers-altered.eml')).toBe('headers-altered');
                expect(verdictOf(paths, 'confirmed-ed25519.eml')).toBe('unverifiable');

                const again = openIndex(paths);
                try {
                    expect(missingKeyPairs(again, vault).map((p) => p.selector)).toStrictEqual(['ted']);
                    expect(unappliedKeyPairs(again, vault).length).toBe(0);
                } finally {
                    again.close();
                }
            });
        });

        await it('reports progress while keys are looked up, rising to the total', async () => {
            await withCase(async (paths) => {
                const db = openIndex(paths);
                const missing = missingKeyPairs(db, new KeyVault());
                db.close();
                const seen: [number, number][] = [];
                await fetchKeys(new KeyVault(), missing, {
                    channels: ['archive.prove.email', 'dns'],
                    confirm: async () => true,
                    fetch: archiveFetch({ [T2048]: record(T2048) }, []),
                    resolveTxt: async () => [[record(TED)]],
                    onProgress: (done, total) => void seen.push([done, total]),
                });
                expect(seen[0]).toStrictEqual([0, 2]);
                expect(seen[seen.length - 1]).toStrictEqual([2, 2]);
                for (let i = 1; i < seen.length; i++) {
                    expect((seen[i]?.[0] ?? 0) >= (seen[i - 1]?.[0] ?? 0)).toBe(true);
                }
            });
        });

        await it('reports the total before the first message and rises to it', async () => {
            await withCase(async (paths) => {
                const vault = new KeyVault();
                const pair = { domain: 'example.com', selector: 't2048' };
                const parsed = parseKeyMaterial(record(T2048));
                if (parsed.kind !== 'key') throw new Error('fixture key');
                vault.add({ ...pair, key: parsed, origin: 'dns', fetchedAt: new Date().toISOString() });
                const seen: [number, number][] = [];
                await reverifyPairs(
                    paths,
                    [pair],
                    vault,
                    undefined,
                    (done, total) => void seen.push([done, total]),
                );
                expect(seen[0]).toStrictEqual([0, 2]);
                expect(seen[seen.length - 1]).toStrictEqual([2, 2]);
            });
        });

        await it('re-verifies without rewriting the text index, and keeps the first verdict', async () => {
            await withCase(async (paths) => {
                const hash = digest(fixture('confirmed.eml'));
                const probe = (): { rowid: number; first: string | null } => {
                    const db = openIndex(paths);
                    try {
                        const fts = db.prepare('SELECT rowid FROM messages_fts WHERE hash = ?').get(hash) as {
                            rowid: number;
                        };
                        const msg = db
                            .prepare('SELECT first_verdict FROM messages WHERE hash = ?')
                            .get(hash) as {
                            first_verdict: string | null;
                        };
                        return { rowid: Number(fts.rowid), first: msg.first_verdict };
                    } finally {
                        db.close();
                    }
                };
                const before = probe();
                const vault = new KeyVault();
                const parsed = parseKeyMaterial(record(T2048));
                if (parsed.kind !== 'key') throw new Error('fixture key');
                vault.add({
                    domain: 'example.com',
                    selector: 't2048',
                    key: parsed,
                    origin: 'dns',
                    fetchedAt: new Date().toISOString(),
                });
                await reverifyPairs(paths, vault.all(), vault);
                expect(verdictOf(paths, 'confirmed.eml')).toBe('confirmed');
                const after = probe();
                // A delete-and-insert of the FTS row would give it a new rowid (and scan the whole table).
                expect(after.rowid).toBe(before.rowid);
                expect(after.first).toBe('unverifiable');
            });
        });

        await it('does not block a reader in another connection while a batch is open', async () => {
            await withCase(async (paths) => {
                const writer = openIndex(paths);
                const reader = openIndex(paths);
                try {
                    const mode = writer.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
                    expect(String(Object.values(mode)[0]).toLowerCase()).toBe('wal');
                    beginBatch(writer);
                    writer.prepare("UPDATE messages SET caveats = '[]'").run();
                    const row = reader.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
                    expect(Number(row.n)).toBe(3);
                    commitBatch(writer);
                } finally {
                    reader.close();
                    writer.close();
                }
            });
        });

        await it('flags a conflicting key and never upgrades a verdict with it', async () => {
            await withCase(async (paths) => {
                const vault = new KeyVault();
                const now = new Date().toISOString();
                const [name, other] = [T2048, 't512._domainkey.example.com'];
                const first = parseKeyMaterial(record(name));
                const second = parseKeyMaterial(record(other));
                if (first.kind !== 'key' || second.kind !== 'key') throw new Error('fixture keys');
                const pair = { domain: 'example.com', selector: 't2048' };
                vault.add({ ...pair, key: first, origin: 'archive.prove.email', fetchedAt: now });
                const outcome = vault.add({ ...pair, key: second, origin: 'dns', fetchedAt: now });
                expect(outcome.status).toBe('conflict');

                const result = await reverifyPairs(paths, [pair], vault);
                expect(result.skippedConflicts.length).toBe(1);
                expect(result.checked).toBe(0);
                expect(verdictOf(paths, 'confirmed.eml')).toBe('unverifiable');
            });
        });
    });
};
