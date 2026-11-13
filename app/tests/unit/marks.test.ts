/**
 * The marks of a case: tags and bookmarks in their own file, which an index rebuild must not take.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    addTag,
    bookmarkedHashes,
    type CasePaths,
    hashesWithTag,
    markedHashes,
    parseSearch,
    MARKS_VERSION,
    marksFile,
    marksOf,
    normaliseTag,
    openCase,
    openIndex,
    readMarks,
    removeTag,
    setBookmark,
    setTags,
    summariseMarks,
} from '@stamped/store';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function withCase(run: (paths: CasePaths) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-marks-'));
    try {
        run(openCase(join(root, 'case')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export default async () => {
    await describe('marks', async () => {
        await it('has nothing marked while no file exists', async () => {
            withCase((paths) => {
                expect(readMarks(paths).size).toBe(0);
                expect(marksOf(paths, A)).toStrictEqual({ tags: [], bookmark: false });
                expect(existsSync(marksFile(paths))).toBe(false);
            });
        });

        await it('round-trips tags and a bookmark through the file', async () => {
            withCase((paths) => {
                setTags(paths, A, ['Follow up', 'Legal']);
                setBookmark(paths, A, true);
                setBookmark(paths, B, true);
                expect(marksOf(paths, A)).toStrictEqual({ tags: ['Follow up', 'Legal'], bookmark: true });
                expect(marksOf(paths, B)).toStrictEqual({ tags: [], bookmark: true });
                expect(bookmarkedHashes(paths)).toStrictEqual([A, B]);
                const body = JSON.parse(readFileSync(marksFile(paths), 'utf8')) as { version: number };
                expect(body.version).toBe(MARKS_VERSION);
            });
        });

        await it('normalises a tag and keeps the first spelling of a case-insensitive repeat', async () => {
            expect(normaliseTag('  two   words ')).toBe('two words');
            withCase((paths) => {
                setTags(paths, A, ['Legal', 'legal', ' LEGAL ', 'Press']);
                expect(marksOf(paths, A).tags).toStrictEqual(['Legal', 'Press']);
                addTag(paths, A, 'press');
                expect(marksOf(paths, A).tags).toStrictEqual(['Legal', 'Press']);
                removeTag(paths, A, 'LEGAL');
                expect(marksOf(paths, A).tags).toStrictEqual(['Press']);
            });
        });

        await it('rejects an empty or overlong tag instead of cutting it', async () => {
            expect(() => normaliseTag('   ')).toThrow();
            expect(() => normaliseTag('x'.repeat(65))).toThrow();
            expect(normaliseTag('x'.repeat(64)).length).toBe(64);
        });

        await it('drops a message from the file once nothing is marked on it', async () => {
            withCase((paths) => {
                setTags(paths, A, ['One']);
                setTags(paths, A, []);
                expect(readMarks(paths).size).toBe(0);
                const body = JSON.parse(readFileSync(marksFile(paths), 'utf8')) as { messages: object };
                expect(Object.keys(body.messages).length).toBe(0);
            });
        });

        await it('lists the hashes of a tag without regard to case, and counts for the sidebar', async () => {
            withCase((paths) => {
                setTags(paths, A, ['Legal', 'Press']);
                setTags(paths, B, ['legal']);
                setTags(paths, C, ['Press']);
                setBookmark(paths, C, true);
                expect(hashesWithTag(paths, 'LEGAL')).toStrictEqual([A, B]);
                expect(hashesWithTag(paths, 'missing')).toStrictEqual([]);
                const summary = summariseMarks(paths);
                expect(summary.bookmarks).toBe(1);
                expect(summary.tags).toStrictEqual([
                    { tag: 'Legal', count: 2 },
                    { tag: 'Press', count: 2 },
                ]);
            });
        });

        await it('survives the index being deleted and rebuilt', async () => {
            withCase((paths) => {
                openIndex(paths).close();
                setTags(paths, A, ['Keep']);
                setBookmark(paths, A, true);
                rmSync(paths.database, { force: true });
                openIndex(paths).close();
                expect(marksOf(paths, A)).toStrictEqual({ tags: ['Keep'], bookmark: true });
            });
        });

        await it('refuses a file from a newer version and leaves it as it was', async () => {
            withCase((paths) => {
                const future = `{"version":${MARKS_VERSION + 1},"messages":{}}\n`;
                writeFileSync(marksFile(paths), future);
                expect(() => readMarks(paths)).toThrow();
                expect(() => setTags(paths, A, ['x'])).toThrow();
                expect(readFileSync(marksFile(paths), 'utf8')).toBe(future);
            });
        });

        await it('never overwrites a corrupt file', async () => {
            withCase((paths) => {
                writeFileSync(marksFile(paths), '{ not json');
                expect(() => setBookmark(paths, A, true)).toThrow();
                expect(readFileSync(marksFile(paths), 'utf8')).toBe('{ not json');
            });
        });

        await it('resolves tag: and is:bookmarked to the hashes that hold all of them', async () => {
            withCase((paths) => {
                setTags(paths, A, ['Legal', 'Follow up']);
                setTags(paths, B, ['legal']);
                setBookmark(paths, B, true);
                setBookmark(paths, C, true);
                const of = (query: string) => {
                    const found = markedHashes(paths, parseSearch(query).filters);
                    return found === undefined ? undefined : [...found].sort();
                };
                expect(of('harbour')).toBe(undefined);
                expect(of('tag:LEGAL')).toStrictEqual([A, B]);
                expect(of('tag:legal tag:"follow up"')).toStrictEqual([A]);
                expect(of('tag:legal is:bookmarked')).toStrictEqual([B]);
                expect(of('is:bookmarked')).toStrictEqual([B, C]);
            });
        });

        await it('calls a tag nobody uses an error, and no bookmarks an empty answer', async () => {
            withCase((paths) => {
                setTags(paths, A, ['legal']);
                expect(() => markedHashes(paths, parseSearch('tag:typo').filters)).toThrow();
                expect([
                    ...(markedHashes(paths, parseSearch('is:bookmarked').filters) ?? ['x']),
                ]).toStrictEqual([]);
            });
        });
    });
};
