// How long the main thread stops answering, with the queries inline and with them on the worker:
//
//   gjsify workspace stamped-cli bench:stall [messages]
//
// Builds a synthetic case under the system temp directory, then asks it the five questions the
// window asks when it opens one — first inline on this thread, the way the window used to, then
// through the worker — while a 5 ms GLib timeout watches the main context. The longest gap
// between two of those ticks IS the stall: the stretch in which a GTK window does not repaint and
// does not answer a click. Everything else here only exists to produce that one number.
//
// Not part of `gjsify test`: it takes minutes at a realistic case size, and the figure it prints
// is a property of the machine it ran on. Keep it reproducible rather than asserted — the test
// suite checks that paging is correct, this checks that it is bearable.

import GLib from 'gi://GLib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeLatin1, summarise } from '@stamped/import';
import { casePaths, digest, indexMessage, openIndex } from '@stamped/store';

import { workerChannel } from '../src/gui/query-channel.ts';
import { QueryClient } from '../src/gui/query-client.ts';
import { runQuery, type QueryContext } from '../src/lib/queries.ts';

const COUNT = Number(process.argv[2] ?? 8000);

const root = mkdtempSync(join(tmpdir(), 'stamped-stall-'));
const paths = casePaths(root);

function fill(): void {
    const db = openIndex(paths);
    db.exec('BEGIN');
    for (let n = 0; n < COUNT; n++) {
        const raw = encodeLatin1(
            [
                `From: Person ${n % 500} <person${n % 500}@example.com>`,
                `To: rcpt${n % 97}@example.net`,
                `Subject: quarterly ledger #${n}`,
                `Date: ${new Date(Date.UTC(2020, 0, 1) + n * 600_000).toUTCString()}`,
                `Message-ID: <m${n}@example.com>`,
                '',
                'body',
                '',
            ].join('\n'),
        );
        indexMessage(
            db,
            {
                hash: digest(raw),
                bytes: raw.length,
                summary: summarise(raw),
                finding: { verdict: n % 7 === 0 ? 'unverifiable' : 'confirmed', caveats: [], signatures: [] },
            },
            { fresh: true },
        );
    }
    db.exec('COMMIT');
    db.close();
}

let watching = false;
let last = Date.now();
let worst = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
    const now = Date.now();
    if (watching && now - last > worst) worst = now - last;
    last = now;
    return GLib.SOURCE_CONTINUE;
});

function start(): void {
    worst = 0;
    last = Date.now();
    watching = true;
}

function stop(): number {
    watching = false;
    return worst;
}

function settle(ms = 200): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const filling = Date.now();
fill();
console.log(`filled ${COUNT} messages in ${Date.now() - filling} ms`);
await settle();

// ── Before: every question on the main thread ───────────────────────────────────────────────
const db = openIndex(paths);
const ctx: QueryContext = { paths, db };
const inlineStarted = Date.now();
start();
runQuery(ctx, 'count', { query: {} });
runQuery(ctx, 'report', {});
runQuery(ctx, 'page', { query: {} });
runQuery(ctx, 'people', { search: '' });
runQuery(ctx, 'timeline', {});
await settle();
const before = stop();
const inlineMs = Date.now() - inlineStarted;
db.close();

// ── After: the same questions through the worker ────────────────────────────────────────────
const workerStarted = Date.now();
start();
const client = new QueryClient(paths, workerChannel);
await client.ask('count', { query: {} });
await client.ask('report', {});
await client.ask('page', { query: {} });
await client.ask('people', { search: '' });
await client.ask('timeline', {});
await settle();
const after = stop();
const workerMs = Date.now() - workerStarted;
client.close();

console.log(
    'STALL ' +
        JSON.stringify({
            messages: COUNT,
            beforeStallMs: before,
            afterStallMs: after,
            inlineWallMs: inlineMs,
            workerWallMs: workerMs,
        }),
);

rmSync(root, { recursive: true, force: true });
await settle(50);
process.exit(0);
