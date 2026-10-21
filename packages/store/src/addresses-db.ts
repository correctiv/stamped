/**
 * The `addresses` table: one row per (message, address), derived from the header columns of
 * `messages` and from nothing else.
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, deliberately — same reasoning as the indexes in
 * `index-db.ts`. A `SCHEMA_VERSION` bump drops the index, and an index on a case of several
 * hundred GB is hours of re-import (or impossible, when the archive is gone). Everything here is
 * derivable from rows that are already there, so it is created in place and filled in batches:
 * `indexMessage` writes it for every new message, {@link backfillAddresses} fills it for the
 * ones that predate it. Every query over it is correct on an unfilled table, only incomplete —
 * {@link addressesComplete} says which.
 *
 * One row per (hash, address) with `sent` / `received` flags rather than one per role: "how many
 * mails" is then `count(*)` and a person on both To and Cc of one message counts once.
 */

import type { DatabaseSync } from 'node:sqlite';

import { parseAddressList } from '@stamped/import';

/** What the writers need of a message: the three header strings as the index stores them. */
export interface AddressHeaders {
    readonly from: string;
    readonly to: string;
    readonly cc: string;
}

interface Row {
    readonly address: string;
    readonly name: string;
    readonly sent: number;
    readonly received: number;
}

/** Fold the three headers into one row per address. The first display name seen wins. */
export function addressRows(headers: AddressHeaders): Row[] {
    const byAddress = new Map<string, { name: string; sent: number; received: number }>();
    const add = (value: string, sent: number, received: number): void => {
        for (const parsed of parseAddressList(value)) {
            const row = byAddress.get(parsed.address);
            if (row) {
                row.sent ||= sent;
                row.received ||= received;
                if (row.name === '') row.name = parsed.name;
            } else byAddress.set(parsed.address, { name: parsed.name, sent, received });
        }
    };
    add(headers.from, 1, 0);
    add(headers.to, 0, 1);
    add(headers.cc, 0, 1);
    return [...byAddress.entries()].map(([address, row]) => ({ address, ...row }));
}

const READY = new WeakMap<DatabaseSync, boolean>();

function exists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

/**
 * Create the table and its indexes if missing. Best effort, like `ensureIndexes`: the GUI opens
 * a case while an import is writing it, and a busy database must not make it unopenable.
 */
export function ensureAddresses(db: DatabaseSync): void {
    const statements: { name: string; sql: string }[] = [
        {
            name: 'addresses',
            sql: `CREATE TABLE addresses (
                hash TEXT NOT NULL,
                address TEXT NOT NULL,
                name TEXT NOT NULL,
                sent INTEGER NOT NULL,
                received INTEGER NOT NULL
            )`,
        },
        { name: 'addresses_hash', sql: 'CREATE INDEX addresses_hash ON addresses (hash)' },
        { name: 'addresses_address', sql: 'CREATE INDEX addresses_address ON addresses (address)' },
    ];
    for (const statement of statements) {
        try {
            if (!exists(db, statement.name)) db.exec(statement.sql);
        } catch {
            // see above
        }
    }
    READY.delete(db);
}

function hasTable(db: DatabaseSync): boolean {
    let ready = READY.get(db);
    if (ready === undefined) {
        ready = exists(db, 'addresses');
        READY.set(db, ready);
    }
    return ready;
}

/** Write the address rows of one message. A no-op when the table could not be created. */
export function writeAddresses(db: DatabaseSync, hash: string, headers: AddressHeaders): void {
    if (!hasTable(db)) return;
    const insert = db.prepare(
        'INSERT INTO addresses (hash, address, name, sent, received) VALUES (?, ?, ?, ?, ?)',
    );
    for (const row of addressRows(headers)) insert.run(hash, row.address, row.name, row.sent, row.received);
}

/** Forget the address rows of one message. */
export function deleteAddresses(db: DatabaseSync, hash: string): void {
    if (!hasTable(db)) return;
    db.prepare('DELETE FROM addresses WHERE hash = ?').run(hash);
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Has every message that predates the table been read into it? */
export function addressesComplete(db: DatabaseSync): boolean {
    return hasTable(db) && metaValue(db, 'addresses_done') === '1';
}

/**
 * Fill the table for existing messages, one batch of at most `batch` messages.
 *
 * Idempotent and resumable: a rowid cursor in `meta` says where it stopped, and each message's
 * rows are deleted before they are written, so a message a new import already filled — or one
 * this ran over twice — ends up with exactly one set of rows. Each call is its own short
 * transaction, which is what lets the GUI run it between frames without freezing, and lets a
 * concurrent import write in between.
 */
export function backfillAddresses(db: DatabaseSync, batch = 2000): { done: boolean; processed: number } {
    if (!hasTable(db)) return { done: false, processed: 0 };
    if (metaValue(db, 'addresses_done') === '1') return { done: true, processed: 0 };
    const cursor = Number(metaValue(db, 'addresses_cursor') ?? 0);
    const rows = db
        .prepare(
            `SELECT rowid AS id, hash, sender, recipients, cc FROM messages
             WHERE rowid > ? ORDER BY rowid LIMIT ${Math.max(1, Math.trunc(batch))}`,
        )
        .all(cursor) as { id: number; hash: string; sender: string; recipients: string; cc: string }[];

    let own = true;
    try {
        db.exec('BEGIN');
    } catch {
        own = false;
    }
    try {
        for (const row of rows) {
            deleteAddresses(db, row.hash);
            writeAddresses(db, row.hash, { from: row.sender, to: row.recipients, cc: row.cc });
        }
        const last = rows[rows.length - 1];
        if (last) setMeta(db, 'addresses_cursor', String(last.id));
        else setMeta(db, 'addresses_done', '1');
        if (own) db.exec('COMMIT');
    } catch (error) {
        if (own) {
            try {
                db.exec('ROLLBACK');
            } catch {
                // no transaction was open
            }
        }
        throw error;
    }
    return { done: rows.length === 0, processed: rows.length };
}

/** Run {@link backfillAddresses} to the end — for the CLI, which has nothing else to do meanwhile. */
export function backfillAll(db: DatabaseSync, onProgress?: (processed: number) => void): void {
    let total = 0;
    for (;;) {
        const step = backfillAddresses(db);
        total += step.processed;
        if (step.processed > 0) onProgress?.(total);
        if (step.done) return;
    }
}
