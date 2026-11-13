/**
 * `stamped tag` and the hash prefix it takes: a message is named by the start of its hash, and an
 * ambiguous or unknown start is an error. Synthetic mail only; the case folder is temporary.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    type CasePaths,
    digest,
    indexMessage,
    marksOf,
    openCase,
    openIndex,
    resolveHash,
} from '@stamped/store';

import { tagCommand } from '../../src/commands/tag.ts';

const FINDING: MessageFinding = { verdict: 'unsigned', caveats: [], signatures: [] };

function put(paths: CasePaths, subject: string, forced?: string): string {
    const bytes = encodeLatin1(`From: Ada <ada@example.com>\nSubject: ${subject}\n\nharbour\n`);
    const hash = forced ?? digest(bytes);
    const db = openIndex(paths);
    try {
        indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: FINDING });
    } finally {
        db.close();
    }
    return hash;
}

function withCase(run: (paths: CasePaths, root: string) => Promise<void> | void): Promise<void> | void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-tag-'));
    const done = () => rmSync(root, { recursive: true, force: true });
    try {
        const result = run(openCase(join(root, 'case')), join(root, 'case'));
        if (result instanceof Promise) return result.finally(done);
    } catch (error) {
        done();
        throw error;
    }
    done();
}

/** Run `stamped tag <sub> …` and capture what it printed. */
async function runTag(sub: string, args: Record<string, unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => void lines.push(parts.join(' '));
    try {
        const group = tagCommand();
        const builder = group.builder as (y: { command(c: unknown): unknown }) => unknown;
        let found: { handler: (a: unknown) => unknown } | undefined;
        builder({
            command(c: unknown) {
                const mod = c as { command: string; handler: (a: unknown) => unknown };
                if (mod.command.split(' ')[0] === sub) found = mod;
                return this;
            },
            demandCommand() {
                return this;
            },
            epilog() {
                return this;
            },
        } as never);
        await (found as { handler: (a: unknown) => unknown }).handler({ ...args, _: [], $0: 'stamped' });
    } finally {
        console.log = original;
    }
    return lines;
}

export default async () => {
    await describe('stamped tag', async () => {
        await it('resolves a unique prefix, and refuses an unknown, ambiguous or malformed one', async () => {
            await withCase((paths) => {
                const hash = put(paths, 'One');
                const db = openIndex(paths);
                try {
                    expect(resolveHash(db, hash.slice(0, 8))).toBe(hash);
                    expect(resolveHash(db, hash.slice(0, 8).toUpperCase())).toBe(hash);
                    const other = hash.startsWith('0') ? 'f' : '0';
                    expect(() =>
                        resolveHash(db, `${other}${other}${other}${other}${other}${other}`),
                    ).toThrow();
                    expect(() => resolveHash(db, 'xyz')).toThrow();
                    expect(() => resolveHash(db, hash.slice(0, 3))).toThrow();
                    // a second message that shares the first ten characters makes the prefix ambiguous
                    const sibling = `${hash.slice(0, 10)}${'0'.repeat(54)}`;
                    if (sibling !== hash) put(paths, 'Two', sibling);
                    expect(() => resolveHash(db, hash.slice(0, 8))).toThrow();
                    expect(resolveHash(db, hash)).toBe(hash);
                } finally {
                    db.close();
                }
            });
        });

        await it('adds and removes tags and toggles a bookmark in marks.json', async () => {
            await withCase(async (paths, root) => {
                const hash = put(paths, 'One');
                const prefix = hash.slice(0, 8);
                await runTag('add', { case: root, hash: prefix, tags: ['Legal', 'follow  up'] });
                expect(marksOf(paths, hash).tags).toStrictEqual(['Legal', 'follow up']);
                await runTag('bookmark', { case: root, hash: prefix });
                expect(marksOf(paths, hash).bookmark).toBe(true);
                await runTag('remove', { case: root, hash: prefix, tags: ['legal'] });
                expect(marksOf(paths, hash).tags).toStrictEqual(['follow up']);
                await runTag('bookmark', { case: root, hash: prefix, off: true });
                expect(marksOf(paths, hash).bookmark).toBe(false);
            });
        });

        await it('writes nothing when one of the tags is invalid', async () => {
            await withCase(async (paths, root) => {
                const hash = put(paths, 'One');
                let thrown = false;
                try {
                    await runTag('add', { case: root, hash: hash.slice(0, 8), tags: ['ok', ''] });
                } catch {
                    thrown = true;
                }
                expect(thrown).toBe(true);
                expect(marksOf(paths, hash).tags).toStrictEqual([]);
            });
        });

        await it('lists the tags with their counts, and one message with --hash', async () => {
            await withCase(async (paths, root) => {
                const one = put(paths, 'One');
                const two = put(paths, 'Two');
                await runTag('add', { case: root, hash: one.slice(0, 8), tags: ['legal'] });
                await runTag('add', { case: root, hash: two.slice(0, 8), tags: ['legal', 'draft'] });
                const json = JSON.parse((await runTag('list', { case: root, json: true })).join('\n')) as {
                    tags: { tag: string; count: number }[];
                };
                expect(json.tags.find((entry) => entry.tag === 'legal')?.count).toBe(2);
                const mine = JSON.parse(
                    (await runTag('list', { case: root, hash: two.slice(0, 8), json: true })).join('\n'),
                ) as { hash: string; tags: string[] };
                expect(mine.hash).toBe(two);
                expect(mine.tags).toStrictEqual(['legal', 'draft']);
            });
        });
    });
};
