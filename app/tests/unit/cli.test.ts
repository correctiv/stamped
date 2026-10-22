/**
 * The CLI's argument and output helpers: where the case folder is, the pair file errors, the
 * fetch summary and the duration line. Synthetic input only.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import { tallyFetch, tallyLines } from '../../src/lib/autofetch.ts';
import { caseRoot } from '../../src/lib/case.ts';
import { formatDuration } from '../../src/lib/duration.ts';
import { readPairFile } from '../../src/lib/pairs.ts';

function message(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return '';
}

export default async () => {
    await describe('the case argument', async () => {
        await it('takes the case positionally or as --case', async () => {
            expect(caseRoot('report', undefined, ['./case'])).toStrictEqual({ root: './case', rest: [] });
            expect(caseRoot('report', './case', [])).toStrictEqual({ root: './case', rest: [] });
            expect(caseRoot('search', undefined, ['./case', 'invoice'])).toStrictEqual({
                root: './case',
                rest: ['invoice'],
            });
            // with --case, every positional is left to the command
            expect(caseRoot('search', './case', ['invoice'])).toStrictEqual({
                root: './case',
                rest: ['invoice'],
            });
        });

        await it('falls back only where a default folder exists, and names the command otherwise', async () => {
            expect(caseRoot('reverify', undefined, [undefined], '.stamped').root).toBe('.stamped');
            const text = message(() => caseRoot('report', undefined, [undefined]));
            expect(text.includes('report')).toBe(true);
            expect(text.includes('--case')).toBe(true);
        });
    });

    await describe('pair files', async () => {
        await it('names the file in every error', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'stamped-pairs-'));
            try {
                const missing = join(dir, 'nope.tsv');
                expect(message(() => readPairFile(missing)).includes(missing)).toBe(true);
                const bad = join(dir, 'bad.tsv');
                writeFileSync(bad, 'example.com\n');
                const text = message(() => readPairFile(bad));
                expect(text.includes(bad)).toBe(true);
                expect(text.includes('line 1')).toBe(true);
                const good = join(dir, 'good.tsv');
                writeFileSync(good, 'example.com\tsel\t3\n');
                expect(readPairFile(good)[0]?.mails).toBe(3);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    await describe('the fetch summary', async () => {
        await it('counts stored keys per channel, not found, and conflicts', async () => {
            const tally = tallyFetch(
                [
                    { origin: 'archive.prove.email', conflict: false },
                    { origin: 'archive.prove.email', conflict: true },
                    { origin: 'dns', conflict: false },
                ],
                4,
            );
            expect(tally).toStrictEqual({
                archive: 2,
                dns: 1,
                notFound: 4,
                errors: 0,
                conflicts: 1,
            });
            expect(tallyLines(tally).length).toBe(4);
            expect(tallyLines({ ...tally, conflicts: 0 }).length).toBe(3);
            const failed = tallyFetch([], 0, 322);
            expect(failed.errors).toBe(322);
            expect(tallyLines(failed).some((l) => l.includes('322') && l.includes('Retry later'))).toBe(true);
        });

        await it('formats durations', async () => {
            expect(formatDuration(250)).toBe('250 ms');
            expect(formatDuration(1900)).toBe('1.9 s');
            expect(formatDuration(125_000)).toBe('2 min 5 s');
        });
    });
};
