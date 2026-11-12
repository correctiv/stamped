/**
 * The MARKS of a case: the tags and bookmarks the person working on it put on messages.
 *
 * They are a working note, not evidence: nothing here is provenance, so none of it enters the
 * import log or a report unless someone asks for it. But it is the one thing in a case that the
 * person typed, so it must outlive the index: `index.db` is a cache that a schema bump or a
 * rebuild throws away, and a day of tagging must not go with it. That is why the marks sit in
 * their OWN file beside the case's other files, keyed by the raw hash of the message, which is
 * the one name a message keeps across every rebuild.
 *
 * ABSENT MEANS "NOTHING MARKED". A file that exists but cannot be read — corrupt, or written by
 * a newer build — throws instead, and is never overwritten: dropping someone's tags because of a
 * parse error would be silent data loss.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fmt, _ } from '@stamped/core';

import type { CasePaths } from './case.ts';

/** Bumped when a build would misread marks an older build wrote. */
export const MARKS_VERSION = 1;

/** The file's name inside the case folder. */
export const MARKS_NAME = 'marks.json';

/** The longest tag, in characters. A tag is a label, not a note. */
export const MAX_TAG_LENGTH = 64;

/** What is marked on one message. */
export interface Mark {
    readonly tags: readonly string[];
    readonly bookmark: boolean;
}

/** All marks of a case, by raw hash. Only messages with at least one mark appear. */
export type Marks = ReadonlyMap<string, Mark>;

interface MarksFile {
    readonly version: number;
    readonly messages: Record<string, { tags?: string[]; bookmark?: true }>;
    readonly updated: string;
}

/** The file's path inside a case folder. */
export function marksFile(paths: CasePaths): string {
    return join(paths.root, MARKS_NAME);
}

/**
 * One tag as the file stores it: trimmed, inner whitespace collapsed.
 *
 * An empty or overlong tag throws rather than being cut: a silently shortened label would no
 * longer be the one the person typed.
 */
export function normaliseTag(input: string): string {
    const tag = input.replace(/\s+/g, ' ').trim();
    if (tag === '') throw new Error(_('A tag cannot be empty.'));
    if ([...tag].length > MAX_TAG_LENGTH) {
        throw new Error(fmt(_('A tag can have at most {max} characters.'), { max: MAX_TAG_LENGTH }));
    }
    return tag;
}

/** Normalised and without repeats; two spellings that differ only in case count as one. */
function cleanTags(tags: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
        const tag = normaliseTag(raw);
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/** Everything marked in the case. Throws if the file exists and cannot be trusted. */
export function readMarks(paths: CasePaths): Marks {
    const file = marksFile(paths);
    const marks = new Map<string, Mark>();
    if (!existsSync(file)) return marks;
    let parsed: Partial<MarksFile>;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarksFile>;
    } catch {
        throw new Error(fmt(_('{file} is not valid JSON and was left untouched.'), { file: MARKS_NAME }));
    }
    if (typeof parsed.version !== 'number' || parsed.version > MARKS_VERSION) {
        throw new Error(
            fmt(_('{file} was written by a newer version of Stamped and was left untouched.'), {
                file: MARKS_NAME,
            }),
        );
    }
    if (typeof parsed.messages !== 'object' || parsed.messages === null) {
        throw new Error(fmt(_('{file} is malformed and was left untouched.'), { file: MARKS_NAME }));
    }
    for (const [hash, entry] of Object.entries(parsed.messages)) {
        const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((t): t is string => typeof t === 'string')
            : [];
        const bookmark = entry.bookmark === true;
        if (tags.length === 0 && !bookmark) continue;
        marks.set(hash, { tags, bookmark });
    }
    return marks;
}

/** The marks of one message; nothing marked when it has none. */
export function marksOf(paths: CasePaths, hash: string): Mark {
    return readMarks(paths).get(hash) ?? { tags: [], bookmark: false };
}

/** Replace the file with `marks`, atomically. Messages without a mark are left out. */
function writeMarks(paths: CasePaths, marks: Map<string, Mark>): void {
    const messages: MarksFile['messages'] = {};
    for (const hash of [...marks.keys()].sort()) {
        const mark = marks.get(hash) as Mark;
        if (mark.tags.length === 0 && !mark.bookmark) continue;
        messages[hash] = {
            ...(mark.tags.length > 0 ? { tags: [...mark.tags] } : {}),
            ...(mark.bookmark ? { bookmark: true as const } : {}),
        };
    }
    const file = marksFile(paths);
    const body: MarksFile = { version: MARKS_VERSION, messages, updated: new Date().toISOString() };
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(body, undefined, 2)}\n`);
    renameSync(temp, file);
}

/**
 * Read, change one message's mark, write. The last writer wins: a case is worked on by one
 * person at a time, and a lock file would be one more thing to go stale.
 */
function update(paths: CasePaths, hash: string, change: (mark: Mark) => Mark): Mark {
    const marks = new Map(readMarks(paths));
    const next = change(marks.get(hash) ?? { tags: [], bookmark: false });
    marks.set(hash, next);
    writeMarks(paths, marks);
    return next;
}

/** Replace the tags of a message. An empty list removes them. */
export function setTags(paths: CasePaths, hash: string, tags: readonly string[]): Mark {
    const clean = cleanTags(tags);
    return update(paths, hash, (m) => ({ ...m, tags: clean }));
}

/** Add one tag, unless the message has it already in some spelling. */
export function addTag(paths: CasePaths, hash: string, tag: string): Mark {
    return update(paths, hash, (m) => ({ ...m, tags: cleanTags([...m.tags, tag]) }));
}

/** Remove a tag, whatever its case. */
export function removeTag(paths: CasePaths, hash: string, tag: string): Mark {
    const key = tag.trim().toLowerCase();
    return update(paths, hash, (m) => ({ ...m, tags: m.tags.filter((t) => t.toLowerCase() !== key) }));
}

/** Set or clear the bookmark. */
export function setBookmark(paths: CasePaths, hash: string, bookmark: boolean): Mark {
    return update(paths, hash, (m) => ({ ...m, bookmark }));
}

/** What the sidebar lists: every tag with the messages carrying it, and the bookmark count. */
export interface MarksSummary {
    /** Tags by first spelling seen, most used first, then alphabetical. */
    readonly tags: readonly { readonly tag: string; readonly count: number }[];
    readonly bookmarks: number;
}

/** Count the tags and bookmarks of the case. */
export function summariseMarks(paths: CasePaths): MarksSummary {
    const counts = new Map<string, { tag: string; count: number }>();
    let bookmarks = 0;
    for (const mark of readMarks(paths).values()) {
        if (mark.bookmark) bookmarks += 1;
        for (const tag of mark.tags) {
            const key = tag.toLowerCase();
            const entry = counts.get(key);
            if (entry) entry.count += 1;
            else counts.set(key, { tag, count: 1 });
        }
    }
    const tags = [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { tags, bookmarks };
}

/** The raw hashes carrying a tag, matched without regard to case. */
export function hashesWithTag(paths: CasePaths, tag: string): string[] {
    const key = tag.trim().toLowerCase();
    const out: string[] = [];
    for (const [hash, mark] of readMarks(paths)) {
        if (mark.tags.some((t) => t.toLowerCase() === key)) out.push(hash);
    }
    return out;
}

/** The raw hashes of the bookmarked messages. */
export function bookmarkedHashes(paths: CasePaths): string[] {
    const out: string[] = [];
    for (const [hash, mark] of readMarks(paths)) if (mark.bookmark) out.push(hash);
    return out;
}
