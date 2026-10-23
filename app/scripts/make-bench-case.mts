// A synthetic case for measuring the window at a realistic size:
//
//   node --experimental-strip-types scripts/make-bench-case.mts <case-dir> [messages=400000]
//
// Nothing real is in it: reserved example domains, generated names, a seeded mix of verdicts.
// Only the NEWEST messages get a stored copy (enough to click through the first ~6000 rows of
// the list); the rest exist as index rows, which is all a list needs. Deterministic.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { encodeLatin1, summarise } from '@stamped/import';
import { digest, indexMessage, openCase, openIndex, store } from '@stamped/store';

const root = process.argv[2];
const COUNT = Number(process.argv[3] ?? 400_000);
const STORED = 6000;
if (!root || !Number.isInteger(COUNT) || COUNT < 1) {
    console.error('usage: make-bench-case.mts <case-dir> [messages]');
    process.exit(2);
}

const VERDICTS = [
    'confirmed',
    'confirmed',
    'confirmed-with-caveats',
    'unsigned',
    'unsigned',
    'unverifiable',
    'body-altered',
    'headers-altered',
] as const;

mkdirSync(resolve(root), { recursive: true });
const paths = openCase(resolve(root));
const db = openIndex(paths);
const started = Date.now();
db.exec('BEGIN');
for (let n = 0; n < COUNT; n++) {
    const raw = encodeLatin1(
        [
            `From: Person ${n % 500} <person${n % 500}@example.com>`,
            `To: rcpt${n % 97}@example.net`,
            `Subject: quarterly ledger #${n} harbour archive`,
            `Date: ${new Date(Date.UTC(2015, 0, 1) + n * 600_000).toUTCString()}`,
            `Message-ID: <m${n}@example.com>`,
            '',
            `body of message ${n}`,
            '',
        ].join('\n'),
    );
    const hash = digest(raw);
    if (n >= COUNT - STORED) store(paths, raw);
    indexMessage(
        db,
        {
            hash,
            bytes: raw.length,
            summary: summarise(raw),
            finding: { verdict: VERDICTS[n % VERDICTS.length], caveats: [], signatures: [] },
        },
        { fresh: true },
    );
    if (n % 20_000 === 19_999) {
        db.exec('COMMIT');
        db.exec('BEGIN');
        console.error(`${n + 1} / ${COUNT}`);
    }
}
db.exec('COMMIT');
db.close();
console.log(`wrote ${COUNT} messages to ${root} in ${Date.now() - started} ms`);
