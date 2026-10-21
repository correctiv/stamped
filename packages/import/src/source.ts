/**
 * Reading a source: an mbox, a Maildir, a single message, a directory of those.
 *
 * The parsing in this package is pure, so the mbox rules and the decoders are testable from a
 * byte array. This module and `folder.ts` are the parts that touch a filesystem, and between
 * them they decide what a path IS — `source.ts` for a source as it is, `folder.ts` for a tree of
 * mailboxes — and read it in a way that keeps the memory ceiling at one message rather than one
 * archive.
 *
 * WHY `readSync` INTO ONE BUFFER and not `createReadStream`: the consumer is synchronous and runs
 * on GJS, which has no always-on event loop (see `app/src/index.ts`). A stream would need the
 * loop to be pumped for a job that never waits on anything, and the error path — a half-read
 * archive whose callbacks already ran — is far harder to report honestly than a `readSync` that
 * threw at a known offset. One buffer is allocated per source and reused for every chunk.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { fmt, _ } from '@stamped/core';

import { looksLikeMbox, MboxSplitter, type MboxFlavour, type RawMessage } from './mbox.ts';

/** How much of a source is read at a time. */
const CHUNK = 1 << 20;

/** What a path turned out to hold. Reported, so the operator can see it was read as intended. */
export type SourceKind = 'mbox' | 'maildir' | 'eml';

/** One message, with the source it came out of. */
export interface SourceMessage extends RawMessage {
    /** The file this message was read from — the mbox, or the individual `.eml`. */
    readonly path: string;
    readonly kind: SourceKind;
    /** The mailbox this message belongs to, when the layout names one. See `folder.ts`. */
    readonly mailbox?: string;
}

export interface ReadOptions {
    /** Which `From ` quoting the archives use. See {@link MboxFlavour}. */
    readonly flavour?: MboxFlavour;
    /** The mailbox the messages belong to, recorded with every message. */
    readonly mailbox?: string;
}

/**
 * Read every message under `path`, calling `emit` for each.
 *
 * Returns how many messages were emitted. Directories are walked depth-first in sorted order, so
 * two imports of the same tree produce the same import log — which is what makes a log diffable
 * and an import reproducible.
 */
export function readSource(
    path: string,
    emit: (message: SourceMessage) => void,
    options: ReadOptions = {},
): number {
    const stats = stat(path);
    if (stats.isDirectory()) return readDirectory(path, emit, options);
    return readFile(path, emit, options);
}

/**
 * Read one file as an mbox, whatever its first line looks like.
 *
 * The general reader decides by CONTENT: a file that starts with a believable `From ` line is an
 * archive, anything else is one message. That decision is the wrong one for a folder of mbox
 * PARTS, because the layout says what the file is — a part of a mailbox — and a part that does
 * not start with a separator is a BROKEN part, not a message. Reading it as one message would
 * put a fragment of a mailbox into the case folder as a mail nobody sent, and the reporter
 * would never know the archive was damaged.
 *
 * So the parts of a mailbox are read this way, and a part that yields no message is reported as
 * the failure it is.
 */
export function readMboxFile(
    path: string,
    emit: (message: SourceMessage) => void,
    options: ReadOptions = {},
): number {
    let count = 0;
    const splitter = new MboxSplitter((message) => {
        count++;
        emit({ ...message, path, kind: 'mbox', ...named(options.mailbox) });
    }, options.flavour);
    forEachChunk(path, (chunk) => splitter.feed(chunk));
    splitter.end();
    return count;
}

/** The mailbox field, present only when there is one — an absent key and an undefined one differ. */
function named(mailbox?: string): { mailbox?: string } {
    return mailbox === undefined ? {} : { mailbox };
}

/**
 * A directory: a Maildir if it looks like one, otherwise a plain tree of sources.
 *
 * The Maildir test is the presence of `cur`/`new` (RFC-less, but universal since qmail), and it
 * matters because a Maildir's `tmp` must NOT be read: it holds messages a delivery agent is in
 * the middle of writing, and importing one gets half a message into the case folder with a hash
 * that will never match the finished file.
 */
function readDirectory(path: string, emit: (message: SourceMessage) => void, options: ReadOptions): number {
    const entries = readdirSync(path).sort();
    if (entries.includes('cur') || entries.includes('new')) {
        let count = 0;
        for (const box of ['new', 'cur']) {
            if (!entries.includes(box)) continue;
            const dir = join(path, box);
            for (const name of readdirSync(dir).sort()) {
                const file = join(dir, name);
                if (!stat(file).isFile()) continue;
                count += readMaildirMessage(file, emit, options.mailbox);
            }
        }
        // A Maildir may hold sub-folders (`.Sent`, `.Archive`); they are Maildirs themselves.
        for (const name of entries) {
            if (!name.startsWith('.') || name === '.' || name === '..') continue;
            const sub = join(path, name);
            if (stat(sub).isDirectory()) count += readDirectory(sub, emit, options);
        }
        return count;
    }

    let count = 0;
    for (const name of entries) {
        count += readSource(join(path, name), emit, options);
    }
    return count;
}

/** One Maildir file is one message, whole. */
function readMaildirMessage(path: string, emit: (message: SourceMessage) => void, mailbox?: string): number {
    const raw = readWhole(path);
    if (raw.length === 0) return 0;
    emit({ raw, offset: 0, path, kind: 'maildir', ...named(mailbox) });
    return 1;
}

/**
 * A single file: an mbox when its first line says so, otherwise one message.
 *
 * Decided by CONTENT, not by extension, for the same reason `--key` is: an archive arrives named
 * `inbox`, `Takeout/Mail/All mail.mbox`, or `dump.txt`, and the operator should not have to
 * declare which is which. A `.eml` that happens to start with a `From ` separator reads as a
 * one-message mbox, which gives back the same message.
 */
function readFile(path: string, emit: (message: SourceMessage) => void, options: ReadOptions): number {
    let count = 0;
    const head = readHead(path, 1024);
    if (head.length === 0) return 0;

    if (!looksLikeMbox(head)) {
        emit({ raw: readWhole(path), offset: 0, path, kind: 'eml', ...named(options.mailbox) });
        return 1;
    }

    const splitter = new MboxSplitter((message) => {
        count++;
        emit({ ...message, path, kind: 'mbox', ...named(options.mailbox) });
    }, options.flavour);
    forEachChunk(path, (chunk) => splitter.feed(chunk));
    splitter.end();
    return count;
}

/** Read `path` in chunks, reusing one buffer. The buffer is only valid during the callback. */
function forEachChunk(path: string, consume: (chunk: Uint8Array) => void): void {
    const fd = openSync(path, 'r');
    try {
        const buffer = new Uint8Array(CHUNK);
        for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, null);
            if (read <= 0) break;
            consume(buffer.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
}

/** The first `length` bytes, for deciding what a file is. */
function readHead(path: string, length: number): Uint8Array {
    const fd = openSync(path, 'r');
    try {
        const buffer = new Uint8Array(length);
        const read = readSync(fd, buffer, 0, length, 0);
        return buffer.subarray(0, Math.max(0, read));
    } finally {
        closeSync(fd);
    }
}

/** A whole file, for the sources that are one message. */
function readWhole(path: string): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    forEachChunk(path, (chunk) => {
        parts.push(chunk.slice());
        total += chunk.length;
    });
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** `statSync`, naming the path: an unreadable source is a typo, not an import result. */
function stat(path: string): { isDirectory(): boolean; isFile(): boolean } {
    try {
        const stats = statSync(path);
        if (!stats) throw new Error('no stats');
        return stats as { isDirectory(): boolean; isFile(): boolean };
    } catch {
        throw new Error(fmt(_('Cannot read {path}.'), { path }));
    }
}
