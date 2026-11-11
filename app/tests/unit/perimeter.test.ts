/**
 * The perimeter: a domain the operator names, whose own signatures get one more caveat.
 *
 * Nothing is inferred from the mail — a case without a perimeter must never see the caveat.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    classifyMessage,
    classifySignature,
    inPerimeter,
    KeyVault,
    parseKeyMaterial,
    type SignatureEvidence,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';
import {
    applyPerimeter,
    digest,
    importSources,
    normalisePerimeterDomain,
    openCase,
    openIndex,
    readPerimeter,
    writePerimeter,
    type CasePaths,
} from '@stamped/store';

import { fixture, fixtureKeys, fixturePath } from './fixtures.ts';

function good(overrides: Partial<SignatureEvidence> = {}): SignatureEvidence {
    return {
        domain: 'example.com',
        selector: 'sel',
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: ['from', 'to', 'subject', 'date'],
        bodyHashOk: true,
        signatureOk: true,
        authorDomain: 'example.com',
        aligned: true,
        keyBits: 2048,
        keySource: 'operator',
        ...overrides,
    };
}

/** A vault holding the key `confirmed.eml` was signed with, as a real case's vault would. */
function vaultWithT2048(): KeyVault {
    const parsed = parseKeyMaterial(fixtureKeys().lookup('t2048._domainkey.example.com')?.record ?? '');
    if (parsed.kind !== 'key') throw new Error('fixture key');
    const vault = new KeyVault();
    vault.add({
        domain: 'example.com',
        selector: 't2048',
        key: parsed,
        origin: 'operator',
        fetchedAt: new Date().toISOString(),
    });
    return vault;
}

function caveatsOf(paths: CasePaths, name: string): string[] {
    const db = openIndex(paths);
    try {
        const row = db.prepare('SELECT caveats FROM messages WHERE hash = ?').get(digest(fixture(name))) as
            | { caveats?: string }
            | undefined;
        return JSON.parse(row?.caveats ?? '[]') as string[];
    } finally {
        db.close();
    }
}

export default async () => {
    await describe('perimeter matching', async () => {
        await it('matches the domain itself and every name below it', async () => {
            expect(inPerimeter('example.com', ['example.com'])).toBe(true);
            expect(inPerimeter('mail.Example.com.', ['example.com'])).toBe(true);
        });

        await it('does not match a name that merely ends in the same letters', async () => {
            expect(inPerimeter('badexample.com', ['example.com'])).toBe(false);
            expect(inPerimeter('example.com.evil.example', ['example.com'])).toBe(false);
        });

        await it('matches nothing without a perimeter', async () => {
            expect(inPerimeter('example.com', undefined)).toBe(false);
            expect(inPerimeter('example.com', [])).toBe(false);
        });
    });

    await describe('the self-signed-perimeter caveat', async () => {
        await it('is never added without a perimeter', async () => {
            const finding = classifySignature(good());
            expect(finding.verdict).toBe('confirmed');
            expect([...finding.caveats]).toStrictEqual([]);
        });

        await it('turns a clean signature of a perimeter domain into confirmed-with-caveats', async () => {
            const finding = classifySignature(good(), { perimeter: ['example.com'] });
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual(['self-signed-perimeter']);
        });

        await it('leaves a foreign signer at signer-not-author', async () => {
            const finding = classifySignature(good({ domain: 'attacker.example', aligned: false }), {
                perimeter: ['example.com'],
            });
            expect([...finding.caveats]).toStrictEqual(['signer-not-author']);
        });

        await it('does not touch a signature that did not verify', async () => {
            const finding = classifySignature(good({ signatureOk: false }), { perimeter: ['example.com'] });
            expect(finding.verdict).toBe('headers-altered');
            expect([...finding.caveats]).toStrictEqual([]);
        });

        await it('reaches the message verdict', async () => {
            const finding = classifyMessage([good()], { perimeter: ['example.com'] });
            expect(finding.verdict).toBe('confirmed-with-caveats');
            expect([...finding.caveats]).toStrictEqual(['self-signed-perimeter']);
        });
    });

    await describe('the perimeter file', async () => {
        await it('normalises, sorts and de-duplicates', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-perimeter-'));
            try {
                const paths = openCase(root);
                expect(readPerimeter(paths)).toStrictEqual([]);
                const stored = writePerimeter(paths, ['@Zeta.example.org', 'example.com.', 'example.com']);
                expect(stored).toStrictEqual(['example.com', 'zeta.example.org']);
                expect(readPerimeter(paths)).toStrictEqual(stored);
                writePerimeter(paths, []);
                expect(readPerimeter(paths)).toStrictEqual([]);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('refuses something that is not a domain name', async () => {
            let message = '';
            try {
                normalisePerimeterDomain('not a domain');
            } catch (error) {
                message = String(error);
            }
            expect(message.length > 0).toBe(true);
        });
    });

    await describe('naming the perimeter on a case', async () => {
        await it('adds and removes the caveat on the stored messages, without moving the verdict', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-perimeter-'));
            try {
                const paths = openCase(root);
                await importSources(paths, [fixturePath('confirmed.eml')], { keys: fixtureKeys() });
                expect(caveatsOf(paths, 'confirmed.eml')).toStrictEqual([]);

                const vault = vaultWithT2048();
                const named = await applyPerimeter(paths, ['example.com'], vault);
                expect(named.perimeter).toStrictEqual(['example.com']);
                expect(caveatsOf(paths, 'confirmed.eml')).toStrictEqual(['self-signed-perimeter']);

                await applyPerimeter(paths, [], vault);
                expect(caveatsOf(paths, 'confirmed.eml')).toStrictEqual([]);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('applies the caveat to mail imported after the perimeter was named', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-perimeter-'));
            try {
                const paths = openCase(root);
                writePerimeter(paths, ['example.com']);
                await importSources(paths, [fixturePath('confirmed.eml')], { keys: fixtureKeys() });
                expect(caveatsOf(paths, 'confirmed.eml')).toStrictEqual(['self-signed-perimeter']);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
