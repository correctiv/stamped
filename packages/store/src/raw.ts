/**
 * The raw store: the messages as they arrived, addressed by what they contain.
 *
 * WHY CONTENT-ADDRESSED. A DKIM verdict is a statement about octets, so the thing a journalist
 * may have to defend in court is the octets — not a database row derived from them. Naming each
 * file by the SHA-256 of its own bytes makes three properties fall out at once:
 *
 * - **Byte-exactness is checkable.** Anyone can re-hash the file and compare it with its name.
 *   A store that quietly re-encoded a message would be caught by its own filenames.
 * - **Duplicates collapse.** The same message in an inbox mbox and a sent-items mbox is one
 *   file, imported once, reported as seen twice. An archive of mailing-list traffic is mostly
 *   duplicates, and counting them as distinct messages would inflate every number in the report.
 * - **A re-import is idempotent.** Running the same import twice adds nothing, which is what
 *   lets an interrupted import simply be run again.
 *
 * Files are never overwritten and never deleted here. Writing is by a temporary file and a
 * rename, so a store never contains a half-written message even if the process is killed
 * mid-import — a truncated file under a hash that does not match it is precisely the artefact
 * that would discredit the whole case folder.
 */

import { createHash } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { fmt, _ } from '@stamped/core';

import type { CasePaths } from './case.ts';

/** The SHA-256 of some bytes, lowercase hex. The name a message is stored under. */
export function digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Where a hash lives under `raw/`. Two hex characters of fan-out, so no directory grows huge. */
export function rawPath(paths: CasePaths, hash: string): string {
    return join(paths.raw, hash.slice(0, 2), `${hash}.eml`);
}

/** What happened to one message on its way into the store. */
export interface StoreResult {
    readonly hash: string;
    /** `false` when the store already held these exact bytes. */
    readonly stored: boolean;
    readonly path: string;
}

/**
 * Put one message in the store, or notice that it is already there.
 *
 * The existence check is the deduplication: a hash collision on SHA-256 is not a failure mode
 * worth engineering around, so a file that is already there is the same message by definition.
 */
export function store(paths: CasePaths, raw: Uint8Array): StoreResult {
    const hash = digest(raw);
    const path = rawPath(paths, hash);
    if (existsSync(path)) return { hash, stored: false, path };

    mkdirSync(join(paths.raw, hash.slice(0, 2)), { recursive: true });
    // Written beside its destination and renamed: both are on the same filesystem, so the rename
    // is atomic and a killed process leaves a `.part` nobody reads rather than a short message
    // under a hash that does not describe it.
    const temporary = `${path}.part`;
    try {
        writeFileSync(temporary, raw);
        renameSync(temporary, path);
    } catch (_error) {
        try {
            if (existsSync(temporary)) unlinkSync(temporary);
        } catch {
            // The failure that matters is the one below; a leftover `.part` is inert.
        }
        throw new Error(fmt(_('Cannot write into the case folder {path}.'), { path: paths.root }));
    }
    return { hash, stored: true, path };
}

/** One line of the import log: where a message was found, and when it was read. */
export interface ImportLogEntry {
    readonly hash: string;
    /** The file it came out of — the mbox, or the individual message file. */
    readonly source: string;
    /** Byte offset within that file. 0 for a source that holds one message. */
    readonly offset: number;
    readonly kind: string;
    readonly bytes: number;
    /** ISO 8601, when this import read it. */
    readonly at: string;
    /** `true` when the store already held these bytes — the message is in the case twice. */
    readonly duplicate: boolean;
}

/**
 * Append entries to the import log.
 *
 * JSON Lines rather than a table in the database, because this is the chain of custody: it must
 * survive the index being deleted, be readable with `tail` on a machine with no tooling, and be
 * append-only in the ordinary sense that a crash truncates at most the last line. Batched because
 * one `appendFileSync` per message makes the import I/O-bound on the log rather than on the
 * archive.
 */
export function appendLog(paths: CasePaths, entries: readonly ImportLogEntry[]): void {
    if (entries.length === 0) return;
    const text = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    appendFileSync(paths.log, text);
}

/**
 * Read one message back out of the store, or `undefined` when it cannot be read at all.
 *
 * Every consumer that shows a message — the detail pane, the raw-source view, a re-verification
 * after a key arrived — goes through here rather than through {@link rawPath} and its own
 * `readFileSync`, so the one place that turns a hash into octets is also the one place that
 * decides what a missing or unreadable file means. `undefined` and not a throw: a case folder
 * whose `raw/` was partly deleted must still open and still list what it has.
 */
export function readRaw(paths: CasePaths, hash: string): Uint8Array | undefined {
    try {
        return new Uint8Array(readFileSync(rawPath(paths, hash)));
    } catch {
        return undefined;
    }
}

/** One file an import read messages out of, and how much of the case came from it. */
export interface LogSource {
    /** The path as the import saw it — the mbox, or the individual message file. */
    readonly source: string;
    readonly kind: string;
    /** Messages read out of it, duplicates included. */
    readonly messages: number;
    /** Of those, how many the store already held — the same mail in a second archive. */
    readonly duplicates: number;
}

/**
 * Walk the import log entry by entry.
 *
 * THE LOG, NOT THE INDEX, is where a message's provenance lives — `index-db.ts` holds only what
 * a message's own bytes say, which is what makes the index rebuildable. So "which archive did
 * this come out of" can only be answered here, and anything that groups a case by its sources
 * reads this function.
 *
 * The file is read whole. One line is about 200 bytes, so a case of a few hundred thousand
 * messages is a few tens of megabytes — affordable for an answer a person asked for, and the
 * seam for a chunked reader is this function alone if an archive ever makes it not so. A line
 * that does not parse is skipped rather than fatal: the log is append-only, and a crash can
 * truncate the last line.
 */
export function eachLogEntry(paths: CasePaths, visit: (entry: ImportLogEntry) => void): void {
    if (!existsSync(paths.log)) return;
    let text: string;
    try {
        text = readFileSync(paths.log, 'utf8');
    } catch {
        return;
    }
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let entry: Partial<ImportLogEntry>;
        try {
            entry = JSON.parse(line) as Partial<ImportLogEntry>;
        } catch {
            continue;
        }
        if (typeof entry.hash !== 'string' || typeof entry.source !== 'string') continue;
        visit({
            hash: entry.hash,
            source: entry.source,
            offset: Number(entry.offset ?? 0),
            kind: String(entry.kind ?? ''),
            bytes: Number(entry.bytes ?? 0),
            at: String(entry.at ?? ''),
            duplicate: entry.duplicate === true,
        });
    }
}

/** The sources of a case, most mail first — the folder list of a case. */
export function logSources(paths: CasePaths): LogSource[] {
    const sources = new Map<string, { kind: string; messages: number; duplicates: number }>();
    eachLogEntry(paths, (entry) => {
        const seen = sources.get(entry.source) ?? { kind: entry.kind, messages: 0, duplicates: 0 };
        seen.messages++;
        if (entry.duplicate) seen.duplicates++;
        sources.set(entry.source, seen);
    });
    return [...sources]
        .map(([source, counts]) => ({ source, ...counts }))
        .sort((a, b) => b.messages - a.messages || a.source.localeCompare(b.source));
}

/**
 * The hashes one source contributed.
 *
 * A set rather than a query, because the index cannot answer it (see {@link eachLogEntry}) — and
 * a set is also what a list filter needs: the same message can come out of two archives, so
 * "the messages of this mbox" overlaps with another source's rather than partitioning the case.
 */
export function sourceHashes(paths: CasePaths, source: string): Set<string> {
    const hashes = new Set<string>();
    eachLogEntry(paths, (entry) => {
        if (entry.source === source) hashes.add(entry.hash);
    });
    return hashes;
}
