/**
 * The key store and the `--key` argument.
 *
 * Small surface, two traps worth a test each: splitting a `--key` argument on the wrong `=` (a
 * DKIM record is full of them), and putting the wrong bytes in `p=` for Ed25519 — both fail as
 * "invalid public key" much later, pointing at the key rather than at what actually went wrong.
 */

import {
    keyNameFor,
    KeyStore,
    looksLikeKeyRecord,
    looksLikePem,
    normaliseKeyName,
    parseKeyArgument,
    recordFromPem,
} from '@stamped/core';
import { describe, expect, it } from '@gjsify/unit';

import { fixtureKeys } from './fixtures.ts';

/**
 * RFC 8463's own test key, as SPKI — 44 bytes, so the raw 32-byte key is the tail.
 *
 * The RFC's key and not a generated one, because then the expected `p=` below is a value
 * published in the standard rather than a value this repo produced. A test asserting that our
 * conversion agrees with our conversion would pass just as happily on a wrong one.
 */
const ED25519_PEM = [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
    '-----END PUBLIC KEY-----',
].join('\n');

/** The same key as RFC 8463 § A.2 publishes it in the DNS. */
const ED25519_P = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

export default async () => {
    await describe('the store', async () => {
        await it('normalises the name it is asked for', async () => {
            const keys = new KeyStore();
            keys.add('Sel._DomainKey.Example.COM.', 'v=DKIM1; p=AAAA', 'operator');
            // A record pasted from `dig` carries the root dot and whatever case the zone used.
            expect(keys.lookup('sel._domainkey.example.com')?.record).toBe('v=DKIM1; p=AAAA');
            expect(keys.lookup('SEL._domainkey.EXAMPLE.com.')?.source).toBe('operator');
        });

        await it('lets a later key replace an earlier one', async () => {
            // The call order is how `--key` beats a key file: last one wins.
            const keys = new KeyStore();
            keys.add('sel._domainkey.example.com', 'v=DKIM1; p=OLD', 'archive');
            keys.add('sel._domainkey.example.com', 'v=DKIM1; p=NEW', 'operator');
            expect(keys.size).toBe(1);
            expect(keys.lookup('sel._domainkey.example.com')?.record).toBe('v=DKIM1; p=NEW');
            expect(keys.lookup('sel._domainkey.example.com')?.source).toBe('operator');
        });

        await it('answers a miss with undefined rather than an error', async () => {
            expect(new KeyStore().lookup('nope._domainkey.example.com')).toBe(undefined);
        });

        await it('builds the DNS name a verifier asks for', async () => {
            expect(keyNameFor('Example.com', 'Sel')).toBe('sel._domainkey.example.com');
            expect(normaliseKeyName('  A._domainkey.B.  ')).toBe('a._domainkey.b');
        });
    });

    await describe('the --key argument', async () => {
        await it('splits on the FIRST equals sign', async () => {
            // A DKIM record is itself full of `=`. Splitting on the last one cuts the record in
            // half and reports an error about a name nobody typed.
            const parsed = parseKeyArgument('sel._domainkey.example.com=v=DKIM1; k=rsa; p=AAAB');
            expect(parsed.name).toBe('sel._domainkey.example.com');
            expect(parsed.value).toBe('v=DKIM1; k=rsa; p=AAAB');
        });

        await it('accepts a file path as the value', async () => {
            expect(parseKeyArgument('sel._domainkey.example.com=./keys/sel.pub.pem').value).toBe(
                './keys/sel.pub.pem',
            );
        });

        await it('refuses an argument with no name', async () => {
            for (const bad of ['no-equals-sign', '=v=DKIM1; p=AAAA']) {
                let threw = false;
                try {
                    parseKeyArgument(bad);
                } catch {
                    threw = true;
                }
                expect(`${bad}: ${threw}`).toBe(`${bad}: true`);
            }
        });
    });

    await describe('telling the forms apart', async () => {
        await it('recognises a TXT record and a PEM block', async () => {
            expect(looksLikeKeyRecord('v=DKIM1; k=rsa; p=AAAB')).toBe(true);
            expect(looksLikeKeyRecord('p=AAAB')).toBe(true);
            expect(looksLikeKeyRecord('./keys/sel.pub.pem')).toBe(false);
            expect(looksLikePem(ED25519_PEM)).toBe(true);
            expect(looksLikePem('v=DKIM1; k=rsa; p=AAAB')).toBe(false);
        });
    });

    await describe('PEM to a DKIM record', async () => {
        await it('puts the raw 32-byte key in p= for Ed25519, not the SPKI', async () => {
            // RFC 8463 § 3. The SPKI form parses and then fails to verify anything, which looks
            // like a bad signature rather than a bad key.
            const record = recordFromPem(ED25519_PEM);
            expect(record.startsWith('v=DKIM1; k=ed25519; p=')).toBe(true);
            const p = record.slice('v=DKIM1; k=ed25519; p='.length);
            expect(p).toBe(ED25519_P);
        });

        await it('puts the whole SPKI in p= for RSA', async () => {
            // The fixture keys are the real thing, so this also proves the conversion the test
            // suite itself depends on.
            const record = fixtureKeys().lookup('t2048._domainkey.example.com')?.record ?? '';
            expect(record.startsWith('v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B')).toBe(true);
            expect(record.includes('\n')).toBe(false);
        });

        await it('refuses a PEM block with nothing in it', async () => {
            let threw = false;
            try {
                recordFromPem('-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----\n');
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });
    });
};
