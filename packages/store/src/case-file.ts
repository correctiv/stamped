/**
 * The case file: a case folder as ONE file you can hand to someone, and what it takes to trust it.
 *
 * A `.stamped` file is a ZIP (stored, ZIP64 where needed — see `zip-store.ts`) holding a closed
 * list of members and a `manifest.jsonl` as the last one. The manifest says, for every other
 * member, its size and SHA-256; the ZIP's comment says the manifest's own SHA-256. Opening a case
 * file checks all of it, and a mismatch REFUSES to unpack: a copy of evidence that does not match
 * what was sealed is not "mostly fine".
 *
 * WHAT IT IS NOT: a signature. It proves the file is the one that was written (integrity), not
 * who wrote it (authenticity); anyone can build a consistent file. `docs/case-file.md` has the
 * format and the reasoning.
 *
 * THE LIST OF MEMBERS IS CLOSED, AND HERE. A new file in the case folder is either added to
 * `FIXED_MEMBERS` (it is packed) or deliberately left out; one that is neither is skipped and
 * REPORTED, never silently dropped. `index.db` is packed as a consistent snapshot (`VACUUM INTO`)
 * because nothing can rebuild it from `raw/`: it holds history the source archives alone produce.
 */

import { createHash } from 'node:crypto';
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    statfsSync,
    statSync,
    writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fmt, _, _n } from '@stamped/core';

import {
    CASE_MARKER_NAME,
    CASE_VERSION,
    type CasePaths,
    IMPORT_LOG_NAME,
    INDEX_NAME,
    isCase,
    VAULT_NAME,
} from './case.ts';
import { SCHEMA_VERSION } from './index-db.ts';
import { MARKS_NAME } from './marks.ts';
import { PERIMETER_NAME } from './perimeter.ts';
import { SEMANTIC_SETTING_NAME } from './semantic-setting.ts';
import {
    MANIFEST_MEMBER,
    ZipReader,
    type ZipEntry,
    type ZipLimits,
    ZipWriter,
    checkName,
} from './zip-store.ts';

export const CASE_FILE_EXTENSION = '.stamped';
export const CASE_FILE_MIME = 'application/vnd.stamped.case+zip';
export const CASE_FILE_FORMAT = 'stamped-case-file';
/** Bumped when a build could not read what an older one wrote. */
export const CASE_FILE_VERSION = 1;

/**
 * The files of a case folder that go into a case file, besides `raw/`.
 *
 * Left out ON PURPOSE: `vectors.db` (derived, hours to compute, tied to a model the recipient may
 * not have), the `*-status.json` files (they describe a process on THIS machine), `*.tmp`,
 * `*.part` and SQLite's `-wal`/`-shm` (a half-written state, which the snapshot replaces).
 */
export const FIXED_MEMBERS: readonly string[] = [
    CASE_MARKER_NAME,
    IMPORT_LOG_NAME,
    INDEX_NAME,
    VAULT_NAME,
    MARKS_NAME,
    PERIMETER_NAME,
    SEMANTIC_SETTING_NAME,
];

const RAW_MEMBER = /^raw\/([0-9a-f]{2})\/([0-9a-f]{64})\.eml$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MANIFEST_FLUSH = 1024 * 1024;
const SLACK_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROBLEM_LIMIT = 50;
const SKIPPED_LIMIT = 200;

/** Does the case file carry a member of this name? */
export function isMemberName(name: string): boolean {
    if (FIXED_MEMBERS.includes(name)) return true;
    const raw = RAW_MEMBER.exec(name);
    return raw !== null && raw[2]!.startsWith(raw[1]!);
}

/** The SHA-256 a raw member's own name claims, or `undefined` for any other member. */
function rawHash(name: string): string | undefined {
    return RAW_MEMBER.exec(name)?.[2];
}

export interface PackProgress {
    (done: number, total: number): void;
}

export interface PackOptions {
    /** Replace an existing target. */
    readonly force?: boolean;
    readonly onProgress?: PackProgress;
    /** Tests lower these to make ZIP64 reachable with a handful of bytes. */
    readonly limits?: ZipLimits;
    /** Overrides the free space `statfs` reports. A test hook. */
    readonly freeBytes?: number;
}

export interface PackResult {
    readonly path: string;
    readonly members: number;
    readonly bytes: number;
    /** Sha-256 of the manifest, as stored in the ZIP comment. */
    readonly sha256: string;
    /** Names left out because they are not on the list; capped, see `skippedCount`. */
    readonly skipped: readonly string[];
    readonly skippedCount: number;
}

interface Listed {
    readonly name: string;
    readonly path: string;
    size: number;
}

interface Listing {
    readonly members: Listed[];
    readonly skipped: string[];
    skippedCount: number;
}

function listMembers(paths: CasePaths): Listing {
    const listing: Listing = { members: [], skipped: [], skippedCount: 0 };
    const skip = (name: string): void => {
        listing.skippedCount++;
        if (listing.skipped.length < SKIPPED_LIMIT) listing.skipped.push(name);
    };

    for (const entry of readdirSync(paths.root, { withFileTypes: true })) {
        if (entry.name === 'raw' && entry.isDirectory()) continue;
        if (FIXED_MEMBERS.includes(entry.name) && entry.isFile()) {
            const path = join(paths.root, entry.name);
            listing.members.push({ name: entry.name, path, size: statSync(path).size });
        } else {
            skip(entry.isDirectory() ? `${entry.name}/` : entry.name);
        }
    }

    if (existsSync(paths.raw)) {
        for (const folder of readdirSync(paths.raw, { withFileTypes: true })) {
            if (!folder.isDirectory() || !/^[0-9a-f]{2}$/.test(folder.name)) {
                skip(`raw/${folder.name}`);
                continue;
            }
            const base = join(paths.raw, folder.name);
            for (const file of readdirSync(base, { withFileTypes: true })) {
                const name = `raw/${folder.name}/${file.name}`;
                if (file.isFile() && isMemberName(name)) {
                    const path = join(base, file.name);
                    listing.members.push({ name, path, size: statSync(path).size });
                } else {
                    skip(name);
                }
            }
        }
    }

    listing.members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return listing;
}

/** What `statfs` says is free where `path` will be written, or `undefined` when it cannot say. */
function freeSpace(path: string): number | undefined {
    try {
        const stats = statfsSync(path);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return undefined;
    }
}

function ensureSpace(directory: string, needed: number, override: number | undefined): void {
    const free = override ?? freeSpace(directory);
    if (free === undefined || free >= needed + SLACK_BYTES) return;
    throw new Error(
        fmt(_('Not enough free space in {path}: about {needed} MiB are needed, {free} MiB are free.'), {
            path: directory,
            needed: Math.ceil(needed / 1048576),
            free: Math.floor(free / 1048576),
        }),
    );
}

/** A consistent copy of the index, taken while the case may be open elsewhere. */
function snapshotIndex(source: string, target: string): void {
    rmSync(target, { force: true });
    // A plain connection, never `openIndex`: that one creates and migrates, and this must not touch
    // the index it is about to seal.
    const db = new DatabaseSync(source);
    try {
        db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
        db.close();
    }
}

/**
 * Seal the case folder at `paths` into the file `target`.
 *
 * An export, not a save: the folder stays the live case. Writes `<target>.part` and renames it at
 * the end, so a crash leaves no half file under the real name. Refuses a target inside the case,
 * and an existing target without `force`. The caller refuses while something works on the case.
 */
export function packCase(paths: CasePaths, target: string, options: PackOptions = {}): PackResult {
    if (!isCase(paths.root)) {
        throw new Error(fmt(_('{path} is not a case folder.'), { path: paths.root }));
    }
    const destination = resolve(target);
    const inside = relative(resolve(paths.root), destination);
    if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
        throw new Error(
            fmt(_('The case file cannot be written inside the case folder it is made from: {path}'), {
                path: destination,
            }),
        );
    }
    if (existsSync(destination) && options.force !== true) {
        throw new Error(fmt(_('{path} already exists. Use --force to replace it.'), { path: destination }));
    }

    const listing = listMembers(paths);
    const indexMember = listing.members.find((member) => member.name === INDEX_NAME);
    const withoutIndex = listing.members.reduce(
        (sum, member) => (member === indexMember ? sum : sum + member.size),
        0,
    );
    // The snapshot is written beside the target and then copied into it: the index twice.
    ensureSpace(dirname(destination), withoutIndex + (indexMember?.size ?? 0) * 2, options.freeBytes);

    const part = `${destination}.part`;
    const snapshot = `${destination}.index.part`;
    const manifestPart = `${destination}.manifest.part`;
    rmSync(part, { force: true });
    rmSync(manifestPart, { force: true });
    let writer: ZipWriter | undefined;
    try {
        if (indexMember !== undefined) {
            snapshotIndex(indexMember.path, snapshot);
            indexMember.size = statSync(snapshot).size;
        }
        const total = listing.members.reduce((sum, member) => sum + member.size, 0);

        writer = new ZipWriter(part, { limits: options.limits });
        let lines: string[] = [
            JSON.stringify({
                format: CASE_FILE_FORMAT,
                version: CASE_FILE_VERSION,
                caseVersion: CASE_VERSION,
                schemaVersion: SCHEMA_VERSION,
            }),
        ];
        let pending = lines[0]!.length;
        const flush = (): void => {
            if (lines.length === 0) return;
            appendFileSync(manifestPart, `${lines.join('\n')}\n`);
            lines = [];
            pending = 0;
        };

        let done = 0;
        for (const member of listing.members) {
            const written = writer.addFile(member.name, member === indexMember ? snapshot : member.path);
            const claimed = rawHash(member.name);
            if (claimed !== undefined && claimed !== written.sha256) {
                throw new Error(
                    fmt(
                        _(
                            '{name} does not match its own hash: the case is already damaged, and sealing it would hide that.',
                        ),
                        {
                            name: member.name,
                        },
                    ),
                );
            }
            const line = JSON.stringify({ path: member.name, size: written.size, sha256: written.sha256 });
            lines.push(line);
            pending += line.length + 1;
            if (pending >= MANIFEST_FLUSH) flush();
            done += written.size;
            options.onProgress?.(done, total);
        }
        flush();

        const manifest = writer.addFile(MANIFEST_MEMBER, manifestPart);
        writer.finish(manifest.sha256);
        writer = undefined;
        renameSync(part, destination);
        return {
            path: destination,
            members: listing.members.length,
            bytes: done,
            sha256: manifest.sha256,
            skipped: listing.skipped,
            skippedCount: listing.skippedCount,
        };
    } catch (error) {
        writer?.abort();
        rmSync(part, { force: true });
        throw error;
    } finally {
        rmSync(snapshot, { force: true });
        rmSync(manifestPart, { force: true });
    }
}

export interface CheckOptions {
    /** Write every member below this folder as it is checked. It must exist and be empty. */
    readonly extractTo?: string;
    /** Stop at the first member that does not match (an unpack has no use for the rest). */
    readonly stopAtFirst?: boolean;
    readonly maxProblems?: number;
    readonly onProgress?: PackProgress;
}

export interface CheckResult {
    readonly ok: boolean;
    readonly members: number;
    readonly bytes: number;
    readonly problems: readonly string[];
    /** Problems found beyond the ones listed. */
    readonly moreProblems: number;
    readonly caseVersion?: number;
    readonly schemaVersion?: number;
    readonly sha256?: string;
}

class Problems {
    readonly list: string[] = [];
    more = 0;
    private readonly limit: number;
    constructor(limit: number) {
        this.limit = limit;
    }
    add(message: string): void {
        if (this.list.length < this.limit) this.list.push(message);
        else this.more++;
    }
    get any(): boolean {
        return this.list.length > 0;
    }
}

interface ManifestLine {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
}

function parseManifestLine(text: string): ManifestLine {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error(_('The manifest holds a line that is not JSON.'));
    }
    const line = value as Partial<ManifestLine> | null;
    if (
        line === null ||
        typeof line !== 'object' ||
        typeof line.path !== 'string' ||
        typeof line.size !== 'number' ||
        !Number.isSafeInteger(line.size) ||
        line.size < 0 ||
        typeof line.sha256 !== 'string' ||
        !HEX64.test(line.sha256)
    ) {
        throw new Error(_('The manifest holds a line that is not a member entry.'));
    }
    return { path: line.path, size: line.size, sha256: line.sha256 };
}

/**
 * Check a case file against its manifest, and optionally unpack it while doing so.
 *
 * Streams: the central directory and the manifest are walked side by side, both sorted, so the
 * memory used does not grow with the number of messages. NOTHING is trusted before it is checked:
 * names against the closed list, order and duplicates, the manifest against the ZIP comment, each
 * member against the manifest, each raw member against the hash in its own name.
 */
export function checkCaseFile(path: string, options: CheckOptions = {}): CheckResult {
    const problems = new Problems(options.maxProblems ?? DEFAULT_PROBLEM_LIMIT);
    let reader: ZipReader;
    try {
        reader = ZipReader.open(path);
    } catch (error) {
        problems.add(message(error));
        return result(problems, 0, 0);
    }
    let members = 0;
    let bytes = 0;
    let header: { caseVersion: number; schemaVersion: number } | undefined;
    try {
        const manifest = scanDirectory(reader, problems);
        bytes = manifest.bytes;
        members = manifest.members;
        if (manifest.entry === undefined || problems.any) return result(problems, members, bytes);

        if (!HEX64.test(reader.comment)) {
            problems.add(_('The file carries no manifest hash in its comment.'));
            return result(problems, members, bytes);
        }
        const sealed = createHash('sha256');
        for (const block of reader.chunks(manifest.entry)) sealed.update(block);
        if (sealed.digest('hex') !== reader.comment) {
            problems.add(_('The manifest does not match the hash sealed in the file: it was changed.'));
            return result(problems, members, bytes);
        }

        const lines = reader.lines(manifest.entry);
        const first = lines.next();
        header = parseHeader(first.done === true ? undefined : first.value, problems);
        if (header === undefined) return result(problems, members, bytes);

        walkMembers(reader, manifest.entry, lines, problems, options, bytes);
        return result(problems, members, bytes, header, reader.comment);
    } catch (error) {
        problems.add(message(error));
        return result(problems, members, bytes, header);
    } finally {
        reader.close();
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function result(
    problems: Problems,
    members: number,
    bytes: number,
    header?: { caseVersion: number; schemaVersion: number },
    sha256?: string,
): CheckResult {
    return {
        ok: !problems.any,
        members,
        bytes,
        problems: problems.list,
        moreProblems: problems.more,
        ...header,
        ...(sha256 !== undefined && !problems.any ? { sha256 } : {}),
    };
}

/** First pass: names, order, the manifest being last. Returns the manifest's entry. */
function scanDirectory(
    reader: ZipReader,
    problems: Problems,
): { entry: ZipEntry | undefined; members: number; bytes: number } {
    let previous: string | undefined;
    let last: ZipEntry | undefined;
    let members = 0;
    let bytes = 0;
    let index = 0;
    for (const entry of reader.entries()) {
        index++;
        if (index === reader.count) {
            last = entry;
            continue;
        }
        members++;
        bytes += entry.size;
        if (entry.name === MANIFEST_MEMBER) {
            problems.add(_('The manifest is not the last member.'));
            continue;
        }
        const unsafe = checkName(entry.name);
        if (unsafe !== undefined) {
            problems.add(fmt(_('{name}: {problem}.'), { name: JSON.stringify(entry.name), problem: unsafe }));
        } else if (!isMemberName(entry.name)) {
            problems.add(fmt(_('{name} is not a member a case file may hold.'), { name: entry.name }));
        }
        if (previous !== undefined && entry.name <= previous) {
            problems.add(
                fmt(_('{name} is listed twice or out of order.'), { name: JSON.stringify(entry.name) }),
            );
        }
        previous = entry.name;
    }
    if (last === undefined) {
        problems.add(_('The case file is empty.'));
    } else if (last.name !== MANIFEST_MEMBER) {
        problems.add(_('The case file has no manifest as its last member.'));
        last = undefined;
    }
    return { entry: last, members, bytes };
}

function parseHeader(
    text: string | undefined,
    problems: Problems,
): { caseVersion: number; schemaVersion: number } | undefined {
    let value: Record<string, unknown> | undefined;
    try {
        value = text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
    } catch {
        value = undefined;
    }
    if (
        value === undefined ||
        value === null ||
        value.format !== CASE_FILE_FORMAT ||
        typeof value.version !== 'number' ||
        typeof value.caseVersion !== 'number' ||
        typeof value.schemaVersion !== 'number'
    ) {
        problems.add(_('The manifest has no valid header: this is not a Stamped case file.'));
        return undefined;
    }
    if (
        value.version > CASE_FILE_VERSION ||
        value.caseVersion > CASE_VERSION ||
        value.schemaVersion > SCHEMA_VERSION
    ) {
        problems.add(_('This case file was written by a newer version of Stamped.'));
        return undefined;
    }
    return { caseVersion: value.caseVersion, schemaVersion: value.schemaVersion };
}

/** Second pass: every member against its manifest line, in step. */
function walkMembers(
    reader: ZipReader,
    manifestEntry: ZipEntry,
    lines: Generator<string>,
    problems: Problems,
    options: CheckOptions,
    total: number,
): void {
    const nextLine = (): ManifestLine | undefined => {
        const next = lines.next();
        return next.done === true ? undefined : parseManifestLine(next.value);
    };
    let wanted = nextLine();
    let done = 0;
    let sawMarker = false;
    const made = new Set<string>();

    for (const entry of reader.entries()) {
        if (entry.offset === manifestEntry.offset) break;
        while (wanted !== undefined && wanted.path < entry.name) {
            problems.add(
                fmt(_('{name} is in the manifest but missing from the file.'), { name: wanted.path }),
            );
            wanted = nextLine();
        }
        let expected: ManifestLine | undefined;
        if (wanted !== undefined && wanted.path === entry.name) {
            expected = wanted;
            wanted = nextLine();
        } else {
            problems.add(fmt(_('{name} is in the file but not in the manifest.'), { name: entry.name }));
        }

        const hash = createHash('sha256');
        let output: number | undefined;
        try {
            if (options.extractTo !== undefined && expected !== undefined) {
                const file = join(options.extractTo, ...entry.name.split('/'));
                const folder = dirname(file);
                if (!made.has(folder)) {
                    mkdirSync(folder, { recursive: true });
                    made.add(folder);
                }
                output = openSync(file, 'wx');
            }
            for (const block of reader.chunks(entry)) {
                hash.update(block);
                if (output !== undefined) {
                    for (let at = 0; at < block.length; )
                        at += writeSync(output, block, at, block.length - at);
                }
                done += block.length;
                options.onProgress?.(done, total);
            }
        } finally {
            if (output !== undefined) closeSync(output);
        }

        const digest = hash.digest('hex');
        if (entry.name === CASE_MARKER_NAME) sawMarker = true;
        if (expected !== undefined) {
            if (expected.size !== entry.size) {
                problems.add(
                    fmt(_('{name} has a different size than the manifest says.'), { name: entry.name }),
                );
            } else if (expected.sha256 !== digest) {
                problems.add(
                    fmt(_('{name} does not match the manifest: its content was changed.'), {
                        name: entry.name,
                    }),
                );
            }
        }
        const claimed = rawHash(entry.name);
        if (claimed !== undefined && claimed !== digest) {
            problems.add(
                fmt(_('{name} does not match its own hash: the message was changed.'), { name: entry.name }),
            );
        }
        if (options.stopAtFirst === true && problems.any) return;
    }
    for (; wanted !== undefined; wanted = nextLine()) {
        problems.add(fmt(_('{name} is in the manifest but missing from the file.'), { name: wanted.path }));
    }
    if (!sawMarker)
        problems.add(fmt(_('The file holds no {name}: it is not a case.'), { name: CASE_MARKER_NAME }));
}

/** Check a case file and read nothing more than it takes: used for the "does it fit" question. */
export function verifyCaseFile(path: string, options: CheckOptions = {}): CheckResult {
    return checkCaseFile(path, { ...options, extractTo: undefined });
}

export interface UnpackResult {
    readonly path: string;
    readonly members: number;
    readonly bytes: number;
}

export interface UnpackOptions {
    readonly onProgress?: PackProgress;
    /** Overrides the free space `statfs` reports. A test hook. */
    readonly freeBytes?: number;
}

/**
 * Unpack a case file into `folder`, or refuse and leave nothing behind.
 *
 * The members land in `<folder>.unpacking` and the folder is renamed into place only after every
 * check passed, so a case folder that exists is a case folder that matched its manifest.
 */
export function unpackCaseFile(file: string, folder: string, options: UnpackOptions = {}): UnpackResult {
    const target = resolve(folder);
    const staging = `${target}.unpacking`;
    if (existsSync(staging)) {
        throw new Error(
            fmt(_('{path} is left over from an earlier unpacking. Remove it first.'), { path: staging }),
        );
    }
    if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
        throw new Error(fmt(_('{path} already exists and is not empty.'), { path: target }));
    }

    const reader = ZipReader.open(file);
    let size = 0;
    try {
        for (const entry of reader.entries()) size += entry.size;
    } finally {
        reader.close();
    }
    ensureSpace(dirname(target), size, options.freeBytes);

    mkdirSync(staging, { recursive: true });
    try {
        const checked = checkCaseFile(file, {
            extractTo: staging,
            stopAtFirst: true,
            onProgress: options.onProgress,
        });
        if (!checked.ok) {
            throw new Error(
                fmt(_('{file} failed its integrity check and was not unpacked: {problem}'), {
                    file,
                    problem: checked.problems[0] ?? '',
                }),
            );
        }
        if (existsSync(target)) rmdirSync(target);
        renameSync(staging, target);
        return { path: target, members: checked.members, bytes: checked.bytes };
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

/** How a result reads in one line, for the CLI. */
export function describeCounts(members: number, bytes: number): string {
    return fmt(_n('{count} member, {mib} MiB', '{count} members, {mib} MiB', members), {
        count: members,
        mib: Math.ceil(bytes / 1048576),
    });
}
