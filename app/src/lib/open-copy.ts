/**
 * A private, read-only copy of a stored message, for handing to another program.
 *
 * NEVER the file in the case. A mail program may rewrite, move or flag the file it is given, and
 * the stored bytes are what the verdict is computed from — so the program gets a copy in a
 * directory of its own, mode 0400, and the path inside the case is never handed out. The copy
 * is byte-identical; the name is the first twelve hex digits of the hash, which is how the
 * message is named everywhere else.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { readRaw, type CasePaths } from '@stamped/store';

/** The directory the copies go to: one per user, so another account cannot read or replace it. */
export function openCopyDir(): string {
    const user = userInfo();
    const who = user.uid >= 0 ? String(user.uid) : user.username;
    return join(tmpdir(), `stamped-open-${who}`);
}

/**
 * Write the message's bytes to the private directory and return the path of the copy, or
 * `undefined` when the case holds no such message.
 *
 * `dir` is for tests. An earlier copy of the same message is replaced: it is read-only, so it is
 * removed first rather than written over.
 */
export function openCopy(paths: CasePaths, hash: string, dir: string = openCopyDir()): string | undefined {
    const raw = readRaw(paths, hash);
    if (!raw) return undefined;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const target = join(dir, `${hash.slice(0, 12)}.eml`);
    if (existsSync(target)) rmSync(target, { force: true });
    writeFileSync(target, raw, { mode: 0o400 });
    chmodSync(target, 0o400);
    return target;
}
