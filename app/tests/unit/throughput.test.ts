/**
 * The fast half of the import performance check: the pipeline must not hold on to the archive.
 *
 * The throughput itself is not asserted here — a CI runner's speed says nothing about the code —
 * only the shape that makes a 30 000-message import possible at all: resident memory does not
 * climb with the mail count. It is the SLOPE over several sample points that is asserted, not one
 * before/after pair: a per-message cost the size of the message itself is invisible in a generous
 * end-minus-middle bound and unmistakable as a line through the points. The big run, with
 * numbers, is `gjsify workspace stamped-cli bench`.
 *
 * Each sample follows a forced collection. Without it the slope measures WHEN the collector
 * happens to run, not what is retained: the import makes about 200 KiB of garbage per message,
 * and whether a collection lands inside the sampled window decided between a flat line and a
 * climb of 10 MiB per 50 messages, run to run, with the code unchanged. What the store does to
 * make that garbage smaller (`statementFor`) is asserted on its own, by the second test.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { KeyStore } from '@stamped/core';
import { importSources, openCase, statementFor } from '@stamped/store';
import { describe, expect, it } from '@gjsify/unit';
import System from 'system';

const MESSAGES = 800;
const SAMPLE_EVERY = 50;
const BODY_LINES = 900;

/** A message of about 56 KiB with bare LF line ends, like a mailbox from a Unix MTA. */
function message(n: number): string {
    const body = `line of ordinary text number ${n} with some more words in it\n`.repeat(BODY_LINES);
    return `From sender@example.com Mon Jan  1 00:00:00 2024\nFrom: a${n}@example.com\nTo: b@example.org\nSubject: Message ${n}\nDate: Mon, 01 Jan 2024 00:00:00 +0000\nMessage-ID: <${n}@example.com>\n\n${body}\n`;
}

function rss(): number | undefined {
    return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : undefined;
}

/** Least-squares slope of `y` over `x`. */
function slope(points: [number, number][]): number {
    const n = points.length;
    const mx = points.reduce((sum, [x]) => sum + x, 0) / n;
    const my = points.reduce((sum, [, y]) => sum + y, 0) / n;
    let num = 0;
    let den = 0;
    for (const [x, y] of points) {
        num += (x - mx) * (y - my);
        den += (x - mx) ** 2;
    }
    return num / den;
}

export default async () => {
    await describe('import memory', async () => {
        await it('does not grow with the number of messages read', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-throughput-'));
            try {
                const mbox = join(root, 'load.mbox');
                writeFileSync(mbox, Array.from({ length: MESSAGES }, (_, n) => message(n)).join(''));
                const size = message(0).length;
                const samples: [number, number][] = [];
                const result = await importSources(openCase(join(root, 'case')), [mbox], {
                    keys: new KeyStore(),
                    onProgress: (progress) => {
                        if (progress.done % SAMPLE_EVERY !== 0) return;
                        System.gc?.();
                        const now = rss();
                        if (now !== undefined) samples.push([progress.done, now]);
                    },
                });
                expect(result.read).toBe(MESSAGES);
                expect(result.indexed).toBe(MESSAGES);
                // The first two thirds are warm-up: the allocator and the JS heap settle there, and
                // on Node the heap still grows past the halfway mark before it levels off.
                const settled = samples.filter(([read]) => read > (MESSAGES * 2) / 3);
                if (settled.length >= 4) {
                    // A pipeline that keeps each message grows by `size` bytes per message; the
                    // bound is a fifth of that.
                    console.log(
                        'SLOPE',
                        slope(settled),
                        size / 5,
                        JSON.stringify(settled.map(([r, v]) => [r, Math.round(v / 1048576)])),
                    );
                    expect(slope(settled) < size / 5).toBe(true);
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('prepares a statement once per database and SQL text', async () => {
            const a = new DatabaseSync(':memory:');
            const b = new DatabaseSync(':memory:');
            try {
                const sql = 'SELECT 1 AS n';
                expect(statementFor(a, sql) === statementFor(a, sql)).toBe(true);
                expect(statementFor(a, sql) === statementFor(b, sql)).toBe(false);
                expect(statementFor(a, sql) === statementFor(a, 'SELECT 2 AS n')).toBe(false);
                const row = statementFor(a, sql).get() as { n?: unknown } | undefined;
                expect(Number(row?.n)).toBe(1);
            } finally {
                a.close();
                b.close();
            }
        });
    });
};
