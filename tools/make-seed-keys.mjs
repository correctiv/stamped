#!/usr/bin/env node
// Builds the seed key bundle: `node tools/make-seed-keys.mjs [--out data/seed-keys.json]`.
//
// MAINTAINER-RUN ONLY. Nothing in the app, the tests or the release workflow calls this: it asks
// the public DNS (via `dig`) and writes a file that is then reviewed and committed like any other
// change. The app only ever READS the committed result.
//
// WHAT THE SEED IS. A small bundle of public DKIM keys of the largest mailbox providers, shipped
// with the app so a case full of Gmail or Yahoo mail does not need a lookup for the commonest
// keys. Every entry is a public DNS record retrieved on the date in the file. The app treats it
// as its LOWEST-priority key source: a key the case holds (imported, typed, fetched) always wins,
// and a pair the seed covers can still be looked up. See AGENTS.md, "Seed keys".
//
// INCLUSION CRITERION (a pair is in only if ALL hold):
//   1. The domain is a large consumer mailbox provider's own sending domain.
//   2. The selector is PROVIDER-WIDE: one selector shared by every user of that provider, named
//      in the provider's own documentation or seen in archive.prove.email's public key list for
//      that domain. Selectors that identify an account, a tenant or a customer are out (for
//      example the per-tenant CNAMEs of Microsoft 365 custom domains, or the per-user
//      selectors a mail host mints on sign-up).
//   3. The pair resolves to a usable key right now. A pair that returns nothing, a revoked key
//      (empty p=) or a record that is not a valid public key is dropped and reported.
// The list comes from PUBLIC sources only; it is never derived from a case or from anyone's mail.
//
// WHAT IT DOES NOT DO. It does not follow rotations: a provider that has moved on leaves the old
// selector's mail unverifiable from the seed, and the normal lookup still finds the historical
// key at archive.prove.email. A seed key is a key retrieved TODAY, not proof of what the DNS said
// when a message was signed; the app wires it in accordingly (see keyvault.ts, origin `seed`).

import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** [domain, selectors…]. Reviewed by hand; add a pair only if it meets the criterion above. */
const PAIRS = [
    ['gmail.com', '20230601', '20251104', '20260707'],
    ['yahoo.com', 's1024', 's2048'],
    ['aol.com', 'a2048', 'sable'],
    ['outlook.com', 'selector1', 'selector2'],
    ['hotmail.com', 'selector1', 'selector2'],
    ['icloud.com', '1a1hai', 'alpha'],
    ['me.com', '1a1hai', 'alpha'],
    ['protonmail.com', 'protonmail', 'protonmail2', 'protonmail3'],
    ['proton.me', 'protonmail', 'protonmail2', 'protonmail3'],
];

const here = dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf('--out');
const out = outIndex === -1 ? join(here, '..', 'data', 'seed-keys.json') : process.argv[outIndex + 1];

/** The TXT answer for a name as one string, chunks joined; `undefined` when there is none. */
function txt(name) {
    let raw;
    try {
        raw = execFileSync('dig', ['+short', '+time=5', '+tries=2', 'TXT', name], { encoding: 'utf8' });
    } catch {
        return undefined;
    }
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('"'));
    for (const line of lines) {
        const record = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
        if (/v=DKIM1/i.test(record) || /(^|;)\s*p=/.test(record)) return record;
    }
    return undefined;
}

/** The `p=` value if it is a valid public key, else `undefined`. */
function validKey(record) {
    const p = /(?:^|;)\s*p=([^;]*)/.exec(record)?.[1]?.replace(/\s+/g, '');
    if (!p) return undefined;
    try {
        createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
        return p;
    } catch {
        return undefined;
    }
}

const now = new Date();
const retrieved = now.toISOString();
const day = retrieved.slice(0, 10);
const entries = [];
const dropped = [];

for (const [domain, ...selectors] of PAIRS) {
    for (const selector of selectors) {
        const name = `${selector}._domainkey.${domain}`;
        const record = txt(name);
        const p = record === undefined ? undefined : validKey(record);
        if (p === undefined) {
            dropped.push(name);
            continue;
        }
        const k = /(?:^|;)\s*k=([^;\s]*)/.exec(record)?.[1]?.toLowerCase() ?? 'rsa';
        entries.push({
            domain,
            selector,
            record: `v=DKIM1; k=${k}; p=${p}`,
            algorithm: k === 'ed25519' ? 'ed25519' : 'rsa',
            bits: 0,
            origin: 'seed',
            fetchedAt: retrieved,
            source: `public DNS record, retrieved ${day}`,
        });
    }
}

// `bits` is informational: the importer reads the real value from the record, never from here.
entries.sort((a, b) => `${a.domain}.${a.selector}`.localeCompare(`${b.domain}.${b.selector}`));
const bundle = {
    format: 'stamped-key-bundle',
    version: 1,
    notice:
        `Stamped seed keys. Public DKIM keys of large mailbox providers, copied from the public DNS on ${day} ` +
        'by tools/make-seed-keys.mjs. Each key is published by its domain owner for anyone to read. ' +
        'This file proves what the DNS said on that day, not what it said when any message was signed: ' +
        'Stamped uses it only where a case holds no key of its own and labels the result accordingly.',
    retrievedAt: retrieved,
    entries,
};
writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote ${entries.length} keys to ${out} (retrieved ${day})`);
if (dropped.length > 0) console.log(`dropped (no usable key): ${dropped.join(', ')}`);
