/**
 * The fast half of the import performance check: the pipeline must not hold on to the archive.
 *
 * The throughput itself is not asserted here — a CI runner's speed says nothing about the code —
 * only the shape that makes a 30 000-message import possible at all: the memory after the second
 * half of a run is not meaningfully larger than after the first. The big run, with numbers, is
 * `gjsify workspace stamped-cli bench`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeyStore } from '@stamped/core';
import { importSources, openCase } from '@stamped/store';
import { describe, expect, it } from '@gjsify/unit';

const MESSAGES = 1500;

/** A message of about 6 KiB with bare LF line ends, like a mailbox from a Unix MTA. */
function message(n: number): string {
    const body = `line of ordinary text number ${n} with some more words in it\n`.repeat(100);
    return `From sender@example.com Mon Jan  1 00:00:00 2024\nFrom: a${n}@example.com\nTo: b@example.org\nSubject: Message ${n}\nDate: Mon, 01 Jan 2024 00:00:00 +0000\nMessage-ID: <${n}@example.com>\n\n${body}\n`;
}

function rss(): number | undefined {
    return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : undefined;
}

export default async () => {
    await describe('import memory', async () => {
        await it('stays flat from the middle of a run to its end', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-throughput-'));
            try {
                const mbox = join(root, 'load.mbox');
                writeFileSync(mbox, Array.from({ length: MESSAGES }, (_, n) => message(n)).join(''));
                const samples: number[] = [];
                const result = await importSources(openCase(join(root, 'case')), [mbox], {
                    keys: new KeyStore(),
                    onProgress: (progress) => {
                        const now = rss();
                        if (now !== undefined && progress.read === MESSAGES / 2) samples[0] = now;
                    },
                });
                const end = rss();
                expect(result.read).toBe(MESSAGES);
                expect(result.indexed).toBe(MESSAGES);
                if (end !== undefined && samples[0] !== undefined) {
                    // Generous: an allocator that has not returned its pages is not a leak. A
                    // pipeline that keeps every message grows by the whole mailbox, ~9 MiB here.
                    expect(end - samples[0] < 64 * 1048576).toBe(true);
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
