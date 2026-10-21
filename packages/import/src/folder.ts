/**
 * Planning an import of a folder tree — the shape a leaked archive is handed over in.
 *
 * A leak arrives as a FOLDER, not as a file: a top level with one folder per account, each
 * holding its mailbox in pieces (`part-01.mbox`, `part-02.mbox`, …), and — because a leak is
 * somebody's disk, not a mail archive — a README and a licence and a notes file next to them.
 *
 * This module PLANS that tree: which files are mail, which folder is which mailbox, and what was
 * left alone. It reads directory entries and nothing else, so the plan is cheap, and the reading
 * happens afterwards, one file at a time.
 *
 * FOUR DECISIONS, and why each of them is the way it is.
 *
 * **A folder is a mailbox.** The mailbox is named after the folder it came from — flattened, so
 * a nested folder is called the same as the account it holds. The leak's own naming is the only
 * naming there is: nobody writes a manifest, and a manifest written by the leaker is a manifest
 * we would have to trust.
 *
 * **Only mail is mail.** A file is read when its name says it is mail (`.mbox`, `.eml`) or when
 * it is a Maildir. Everything else — a README, a licence, a screenshot of a spreadsheet — is left
 * alone and COUNTED, because "12 files were not mail" is a fact about the archive, while a README
 * imported as a message would be a message nobody ever sent.
 *
 * **A link that leaves the tree is not followed.** A symlink inside the archive is followed when
 * it stays inside it and skipped when it points out, because the archive is evidence: a link
 * that reaches into the operator's own disk is a way to read files that were never part of the
 * leak. The test is on the RESOLVED path, so a link through a link cannot get out either.
 *
 * **The order of the parts does not decide anything.** The parts of a mailbox are sorted so that
 * two imports of the same tree produce the same log — that is reproducibility, not meaning. A
 * part that is not an mbox is not a message either; it is a broken part, and the importer says
 * so rather than inventing a mail out of the fragments.
 */

import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { fmt, _ } from '@stamped/core';

/** Why a file of the tree was left alone. */
export type SkipReason =
    /** Not mail: a README, a licence, a picture of a spreadsheet. */
    | 'not-mail'
    /** A link out of the tree. Followed never — see the module header. */
    | 'outside-root'
    /** A link that points at nothing. */
    | 'dangling'
    /** A mail file with no content in it. */
    | 'empty'
    /** A folder that cannot be listed. The import cannot read what is in it. */
    | 'unreadable';

/** One file the plan did not take, and why. */
export interface SkippedFile {
    readonly path: string;
    readonly reason: SkipReason;
}

/** What a mail file holds. */
export type PartKind =
    /** An mbox: possibly many messages, split at the `From ` separators. */
    | 'mbox'
    /** One message. */
    | 'eml'
    /** A Maildir: `new/` and `cur/`, never `tmp/`. */
    | 'maildir';

/** One file of a mailbox. */
export interface MailPart {
    readonly path: string;
    readonly kind: PartKind;
    /** The size in bytes. 0 for a Maildir, which is a folder. */
    readonly bytes: number;
}

/** One mailbox: a folder, and the mail files in it. */
export interface Mailbox {
    /** The name the mailbox is known by — its folder, flattened. */
    readonly name: string;
    /** The folder the parts came from. */
    readonly folder: string;
    /** The parts, in reading order. */
    readonly parts: readonly MailPart[];
}

/** What a folder tree holds. */
export interface FolderPlan {
    /** The root the plan was made for, resolved to its real path. */
    readonly root: string;
    /** The mailboxes, ordered by their folder. */
    readonly mailboxes: readonly Mailbox[];
    /** The files that were left alone. */
    readonly skipped: readonly SkippedFile[];
}

/**
 * Plan the import of a folder tree.
 *
 * Throws when `root` is not a folder that can be read — the one failure a plan cannot carry,
 * because there is nothing to plan then. Everything else is carried in the plan: a file that
 * cannot be read is a failure of the import, not of the plan.
 */
export function planFolder(root: string): FolderPlan {
    const realRoot = realFolder(root);
    const skipped: SkippedFile[] = [];
    const folders = new Map<string, MailPart[]>();
    // A Maildir AT THE ROOT is one mailbox, not a tree: `cur/` and `new/` hold messages, and
    // `tmp/` — where a delivery agent writes a message it has not finished — is never read.
    if (isMaildir(realRoot)) {
        folders.set(realRoot, [{ path: realRoot, kind: 'maildir', bytes: 0 }]);
        return { root: realRoot, mailboxes: nameMailboxes(realRoot, folders), skipped };
    }
    walk(realRoot, realRoot, folders, skipped, new Set([realRoot]));
    return { root: realRoot, mailboxes: nameMailboxes(realRoot, folders), skipped };
}

/**
 * The real path of a folder, or the reason it is not one.
 *
 * The resolved path is the boundary every link is measured against, so the boundary cannot be
 * walked out of by a path that only looks like it is inside.
 */
function realFolder(root: string): string {
    let real: string;
    try {
        real = realpathSync(root);
    } catch {
        throw new Error(fmt(_('Cannot read {path}.'), { path: root }));
    }
    let folder = false;
    try {
        folder = statSync(real).isDirectory();
    } catch {
        folder = false;
    }
    if (!folder) throw new Error(fmt(_('{path} is not a folder.'), { path: root }));
    return real;
}

/**
 * One folder of the tree, and what is in it.
 *
 * Depth-first and sorted, so two plans of the same tree are the same plan — which is what makes
 * an import reproducible and its log diffable.
 */
function walk(
    dir: string,
    realRoot: string,
    folders: Map<string, MailPart[]>,
    skipped: SkippedFile[],
    visited: Set<string>,
): void {
    let names: string[];
    try {
        names = readdirSync(dir).sort();
    } catch {
        // A folder that cannot be listed is a folder that cannot be imported. It is reported
        // rather than thrown, so the rest of the tree still gets read — and it is reported as
        // UNREADABLE, because "not mail" would be a claim about a folder nobody could look at.
        skipped.push({ path: dir, reason: 'unreadable' });
        return;
    }

    for (const name of names) {
        const path = join(dir, name);
        const link = lstatSafe(path);
        if (link === undefined) {
            skipped.push({ path, reason: 'dangling' });
            continue;
        }

        // A link is followed only when it stays inside the tree. The check is on the RESOLVED
        // path, so a link through a link cannot get out either.
        let stats = link;
        let real = path;
        if (link.isSymbolicLink()) {
            const resolved = resolveLink(path, realRoot);
            if ('reason' in resolved) {
                skipped.push({ path, reason: resolved.reason });
                continue;
            }
            const targetStats = statSafe(resolved.target);
            if (targetStats === undefined) {
                skipped.push({ path, reason: 'dangling' });
                continue;
            }
            stats = targetStats;
            real = resolved.target;
        }

        if (stats.isDirectory()) {
            if (isMaildir(real)) {
                addPart(folders, dir, { path: real, kind: 'maildir', bytes: 0 });
                continue;
            }
            // A folder already walked is a link back into the tree: walking it again would
            // import the same messages twice and, without this, forever.
            if (visited.has(real)) continue;
            visited.add(real);
            walk(real, realRoot, folders, skipped, visited);
            continue;
        }

        if (!stats.isFile()) {
            skipped.push({ path, reason: 'not-mail' });
            continue;
        }

        const kind = mailKind(name);
        if (kind === undefined) {
            skipped.push({ path, reason: 'not-mail' });
            continue;
        }
        if (stats.size === 0) {
            skipped.push({ path, reason: 'empty' });
            continue;
        }
        addPart(folders, dir, { path, kind, bytes: stats.size });
    }
}

/** What a link turned out to be: a place inside the tree, or a reason it was not followed. */
type LinkTarget = { readonly target: string } | { readonly reason: 'outside-root' | 'dangling' };

/** The resolved path of a link, or why it is not followed. */
function resolveLink(path: string, realRoot: string): LinkTarget {
    let target: string;
    try {
        target = realpathSync(path);
    } catch {
        return { reason: 'dangling' };
    }
    if (target === realRoot || target.startsWith(`${realRoot}${sep}`)) return { target };
    return { reason: 'outside-root' };
}

/** `lstat` — the link itself, not what it points at. */
function lstatSafe(path: string): Stats | undefined {
    try {
        return lstatSync(path);
    } catch {
        return undefined;
    }
}

/** `stat` — what a path really is, following a link. */
function statSafe(path: string): Stats | undefined {
    try {
        return statSync(path);
    } catch {
        return undefined;
    }
}

/** Is this folder a Maildir? The presence of `cur` or `new` — see `source.ts`. */
function isMaildir(path: string): boolean {
    try {
        const entries = readdirSync(path);
        return entries.includes('cur') || entries.includes('new');
    } catch {
        return false;
    }
}

/** What a file's NAME says it holds. `.mbox` and `.eml` are mail; nothing else is. */
function mailKind(name: string): PartKind | undefined {
    const lower = name.toLowerCase();
    if (lower.endsWith('.mbox')) return 'mbox';
    if (lower.endsWith('.eml')) return 'eml';
    return undefined;
}

/** Add a mail file to the mailbox of the folder it was found in. */
function addPart(folders: Map<string, MailPart[]>, folder: string, part: MailPart): void {
    const parts = folders.get(folder);
    if (parts) parts.push(part);
    else folders.set(folder, [part]);
}

/**
 * Name the mailboxes and order their parts.
 *
 * The name is the folder's own name — flattened, so a nested folder is called the same as the
 * account it holds. Two folders with the same name would collide, so those are named by their
 * path from the root instead: a name that says where it is beats a name that is ambiguous.
 */
function nameMailboxes(root: string, folders: Map<string, MailPart[]>): Mailbox[] {
    const paths = [...folders.keys()].sort();
    const counts = new Map<string, number>();
    for (const path of paths) {
        const name = basename(path);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return paths.map((path) => {
        const name = basename(path);
        const parts = [...(folders.get(path) ?? [])].sort((a, b) =>
            compareNames(basename(a.path), basename(b.path)),
        );
        return {
            name: counts.get(name) === 1 ? name : relative(root, path).split(sep).join('/'),
            folder: path,
            parts,
        };
    });
}

/**
 * Compare two file names so that `part-2` sorts before `part-10`.
 *
 * Hand-rolled rather than `localeCompare(…, { numeric: true })`, because a collation that depends
 * on the machine's locale would make the import log depend on the machine that produced it.
 */
export function compareNames(a: string, b: string): number {
    const left = a.match(/\d+|\D+/g) ?? [];
    const right = b.match(/\d+|\D+/g) ?? [];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i] ?? '';
        const y = right[i] ?? '';
        if (x === y) continue;
        const xNumber = /^\d/.test(x);
        const yNumber = /^\d/.test(y);
        if (xNumber && yNumber) {
            const difference = Number(x) - Number(y);
            if (difference !== 0) return difference < 0 ? -1 : 1;
            continue;
        }
        return x < y ? -1 : 1;
    }
    return 0;
}
