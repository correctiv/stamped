/**
 * The cases that were open last, for the start screen.
 *
 * A LIST OF PATHS AND TIMES, NOTHING ELSE. It sits in the user's state directory and not in a
 * case: it belongs to the person using this machine, not to a leak, and a case that travels
 * (`stamped case pack`) must not carry the list of what else its owner had open. For the same
 * reason no mail content, subject or count is stored here: a folder name is the most this file
 * can give away, and the start screen can remove an entry from it.
 *
 * A FILE THAT CANNOT BE READ IS AN EMPTY LIST. Unlike `marks.json` this is not something a person
 * typed, it is a convenience that rebuilds itself with the next open: a corrupt or foreign file is
 * replaced rather than turned into an error on the first screen of the app.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The file's name inside the state directory. */
export const RECENT_CASES_NAME = 'recent-cases.json';

/** Bumped when a build would misread a list an older build wrote. */
export const RECENT_CASES_VERSION = 1;

/** How many entries the file keeps. More than the start screen shows: the gone ones fall out of view first. */
export const RECENT_CASES_KEPT = 20;

/** How many the start screen shows. */
export const RECENT_CASES_SHOWN = 6;

export interface RecentCase {
    /** The absolute path of the case folder. */
    readonly path: string;
    /** When it was last opened, milliseconds since the epoch. */
    readonly openedAt: number;
}

/** `$XDG_STATE_HOME/stamped`, else `~/.local/state/stamped`; `%LOCALAPPDATA%\stamped` on Windows. */
export function recentCasesDir(
    env: Record<string, string | undefined> = process.env,
    platform: string = process.platform,
): string {
    if (platform === 'win32') {
        const base = env.LOCALAPPDATA;
        return join(base !== undefined && base !== '' ? base : join(homedir(), 'AppData', 'Local'), 'stamped');
    }
    const state = env.XDG_STATE_HOME;
    return join(state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state'), 'stamped');
}

function isEntry(value: unknown): value is RecentCase {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as { path?: unknown; openedAt?: unknown };
    return typeof entry.path === 'string' && entry.path !== '' && typeof entry.openedAt === 'number';
}

/** The remembered cases, most recently opened first. Never throws. */
export function readRecentCases(dir: string): RecentCase[] {
    try {
        const body = JSON.parse(readFileSync(join(dir, RECENT_CASES_NAME), 'utf8')) as {
            version?: unknown;
            cases?: unknown;
        };
        if (body.version !== RECENT_CASES_VERSION || !Array.isArray(body.cases)) return [];
        return body.cases.filter(isEntry).sort((a, b) => b.openedAt - a.openedAt);
    } catch {
        return [];
    }
}

function writeRecentCases(dir: string, cases: readonly RecentCase[]): void {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, RECENT_CASES_NAME);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: RECENT_CASES_VERSION, cases }, undefined, 2)}\n`);
    renameSync(tmp, file);
}

/**
 * Put a case at the head of the list. The same folder written two ways is one entry.
 *
 * Best effort: a state directory that cannot be written (read-only home, full disk) must not stop
 * a case from opening, so a failure here is swallowed and the list simply stays as it was.
 */
export function rememberCase(dir: string, path: string, now: number = Date.now()): void {
    try {
        const root = resolve(path);
        const rest = readRecentCases(dir).filter((entry) => resolve(entry.path) !== root);
        writeRecentCases(dir, [{ path: root, openedAt: now }, ...rest].slice(0, RECENT_CASES_KEPT));
    } catch {
        // see above
    }
}

/** Take one case off the list. A path that is not on it changes nothing. */
export function forgetCase(dir: string, path: string): void {
    try {
        const root = resolve(path);
        const all = readRecentCases(dir);
        const rest = all.filter((entry) => resolve(entry.path) !== root);
        if (rest.length !== all.length) writeRecentCases(dir, rest);
    } catch {
        // see `rememberCase`
    }
}

/**
 * What the start screen offers: the remembered cases that are still cases, newest first.
 *
 * `exists` is a parameter so the check is the caller's: the window asks the disk, a test asks a
 * set. A folder on an unmounted drive stays in the file and is simply not offered until it is
 * back.
 */
export function offeredCases(
    dir: string,
    exists: (path: string) => boolean,
    limit: number = RECENT_CASES_SHOWN,
): RecentCase[] {
    return readRecentCases(dir)
        .filter((entry) => exists(entry.path))
        .slice(0, limit);
}
