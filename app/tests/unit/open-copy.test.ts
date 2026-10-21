/**
 * The copy handed to a mail program: same bytes, read-only, and never inside the case.
 *
 * Synthetic literal only. The property that matters is that the stored evidence file is not the
 * file anything else is given.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { encodeLatin1 } from '@stamped/import';
import { casePaths, rawPath, store } from '@stamped/store';

import { openCopy } from '../../src/lib/open-copy.ts';

export default async () => {
    await describe('openCopy', async () => {
        await it('copies the bytes to a read-only file outside the case', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-open-case-'));
            const dir = join(mkdtempSync(join(tmpdir(), 'stamped-open-dir-')), 'copies');
            try {
                const paths = casePaths(root);
                const raw = encodeLatin1('From: a@example.com\r\nSubject: Hi\r\n\r\nbody\r\n');
                const { hash } = store(paths, raw);
                const copy = openCopy(paths, hash, dir);
                expect(copy).toBe(join(dir, `${hash.slice(0, 12)}.eml`));
                if (copy === undefined) return;
                expect(copy === rawPath(paths, hash)).toBe(false);
                expect(relative(root, copy).startsWith('..')).toBe(true);
                expect(new Uint8Array(readFileSync(copy))).toStrictEqual(raw);
                expect(statSync(copy).mode & 0o777).toBe(0o400);
                expect(statSync(dir).mode & 0o777).toBe(0o700);
                // a second call replaces the read-only copy instead of failing on it
                expect(openCopy(paths, hash, dir)).toBe(copy);
            } finally {
                rmSync(root, { recursive: true, force: true });
                rmSync(join(dir, '..'), { recursive: true, force: true });
            }
        });

        await it('returns nothing for a message the case does not hold', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-open-case-'));
            try {
                expect(openCopy(casePaths(root), 'c'.repeat(64), join(root, 'x'))).toBe(undefined);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
