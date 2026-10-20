/**
 * The search index: SQLite with FTS5, derived from `raw/` and nothing else.
 *
 * THE INVARIANT THAT SHAPES THIS MODULE: a row here holds only what the message's own bytes say.
 * Not which mbox it came out of, not when it was imported — those are the import log's, because
 * they are facts about the IMPORT rather than about the message. Keeping them out is what makes
 * `index.db` reconstructible by walking `raw/`, and a cache that can always be rebuilt is a cache
 * whose schema may change without asking a journalist for an archive they may no longer have.
 *
 * WHY A STANDALONE FTS5 TABLE and not an external-content one: external content keeps the text in
 * the ordinary table and needs triggers to stay in step, and gjsify's `node:sqlite` splits a
 * script on every `;` — a trigger body, which contains semicolons, would be cut into fragments.
 * The duplicated text costs disk; a half-created trigger would cost silent search misses.
 *
 * Nothing here decides a verdict. The verdict column is a copy of what `@stamped/verify` and
 * `@stamped/core` already concluded from the raw bytes, stored so that the report does not have
 * to re-verify a hundred thousand messages to count them.
 */

import { DatabaseSync } from 'node:sqlite';

import { type MessageFinding, type Verdict, fmt, _ } from '@stamped/core';
import type { MessageSummary } from '@stamped/import';

import type { CasePaths } from './case.ts';

/**
 * Bumped whenever a column changes. A database at another version is DROPPED and rebuilt rather
 * than migrated — see the module note: it is a cache, and `raw/` has everything needed to refill
 * it. A migration path here would be code that is never exercised until the one day it matters.
 */
export const SCHEMA_VERSION = 1;

/** The columns of the FTS5 table, in order. Searchable under these names. */
const FTS_COLUMNS = [
    'message_id',
    'sender',
    'recipients',
    'cc',
    'subject',
    'date',
    'in_reply_to',
    'refs',
    'text',
] as const;

/** One message, ready to be indexed: what it says, and what was concluded about its signatures. */
export interface IndexEntry {
    readonly hash: string;
    /** Size of the raw message in bytes. */
    readonly bytes: number;
    readonly summary: MessageSummary;
    readonly finding: MessageFinding;
}

/** What a search gives back. Enough to recognise a message and to find it under `raw/`. */
export interface SearchHit {
    readonly hash: string;
    readonly subject: string;
    readonly from: string;
    readonly date: string;
    readonly sentAt?: number;
    readonly verdict: Verdict;
}

/**
 * Open the case's index, creating or rebuilding the schema when it is missing or out of date.
 *
 * The caller closes it. Callers that only read still get a schema created, which is deliberate:
 * searching a case that was never imported should say "no results", not fail with a missing
 * table that reads like a broken installation.
 */
export function openIndex(paths: CasePaths): DatabaseSync {
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(paths.database);
    } catch {
        throw new Error(fmt(_('Cannot open the index of the case folder {path}.'), { path: paths.root }));
    }
    if (schemaVersion(db) !== SCHEMA_VERSION) createSchema(db);
    return db;
}

/** The version the database was created at, or 0 when it holds no schema of ours. */
function schemaVersion(db: DatabaseSync): number {
    if (!tableExists(db, 'meta')) return 0;
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
        | { value?: string }
        | undefined;
    return row?.value === undefined ? 0 : Number(row.value);
}

/** Is this table (or virtual table) there? Asked instead of `IF NOT EXISTS`, which `CREATE
 * VIRTUAL TABLE` does not reliably survive through gjsify's SQL parser. */
function tableExists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

/** Drop whatever is there and lay out the current schema. */
function createSchema(db: DatabaseSync): void {
    for (const table of ['messages', 'signatures', 'messages_fts', 'meta']) {
        if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`);
    }

    db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE messages (
            hash TEXT PRIMARY KEY,
            message_id TEXT,
            sender TEXT NOT NULL,
            recipients TEXT NOT NULL,
            cc TEXT NOT NULL,
            subject TEXT NOT NULL,
            date TEXT NOT NULL,
            sent_at INTEGER,
            in_reply_to TEXT NOT NULL,
            refs TEXT NOT NULL,
            from_domain TEXT,
            verdict TEXT NOT NULL,
            caveats TEXT NOT NULL,
            bytes INTEGER NOT NULL
        );
        CREATE TABLE signatures (
            hash TEXT NOT NULL,
            position INTEGER NOT NULL,
            domain TEXT NOT NULL,
            selector TEXT NOT NULL,
            algorithm TEXT NOT NULL,
            verdict TEXT NOT NULL,
            aligned INTEGER NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE INDEX signatures_hash ON signatures (hash);
        CREATE INDEX signatures_key ON signatures (domain, selector);
        CREATE INDEX messages_sent_at ON messages (sent_at);
        CREATE INDEX messages_from_domain ON messages (from_domain);
    `);

    // Separate from the script above: a virtual table is a different statement kind, and keeping
    // it alone makes a failure here say "FTS5 is missing" rather than "the schema failed".
    db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(hash UNINDEXED, ${FTS_COLUMNS.join(', ')})`);

    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
}

/** Is this message in the index already? The question that makes indexing resumable. */
export function isIndexed(db: DatabaseSync, hash: string): boolean {
    const row = db.prepare('SELECT 1 AS n FROM messages WHERE hash = ?').get(hash);
    return row !== undefined;
}

/** How many messages the index holds. */
export function messageCount(db: DatabaseSync): number {
    const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
}

/**
 * Put one message in the index, replacing whatever was there for that hash.
 *
 * Replacing rather than failing on a conflict, because the same message re-indexed after a
 * schema change or a newly collected key must end up with the NEW verdict. The hash is the
 * identity, so there is nothing to lose by rewriting the row.
 */
export function indexMessage(db: DatabaseSync, entry: IndexEntry): void {
    removeMessage(db, entry.hash);
    const summary = entry.summary;

    db.prepare(
        `INSERT INTO messages (
            hash, message_id, sender, recipients, cc, subject, date, sent_at,
            in_reply_to, refs, from_domain, verdict, caveats, bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        entry.hash,
        summary.messageId ?? null,
        summary.from,
        summary.to,
        summary.cc,
        summary.subject,
        summary.date,
        summary.sentAt ?? null,
        summary.inReplyTo,
        summary.references,
        summary.fromDomain ?? null,
        entry.finding.verdict,
        JSON.stringify(entry.finding.caveats),
        entry.bytes,
    );

    db.prepare(
        `INSERT INTO messages_fts (hash, ${FTS_COLUMNS.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        entry.hash,
        summary.messageId ?? '',
        summary.from,
        summary.to,
        summary.cc,
        summary.subject,
        summary.date,
        summary.inReplyTo,
        summary.references,
        summary.text,
    );

    const signature = db.prepare(
        `INSERT INTO signatures (hash, position, domain, selector, algorithm, verdict, aligned, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [position, found] of entry.finding.signatures.entries()) {
        signature.run(
            entry.hash,
            position,
            found.evidence.domain,
            found.evidence.selector,
            found.evidence.algorithm,
            found.verdict,
            found.evidence.aligned ? 1 : 0,
            found.evidence.unverifiableBecause ?? '',
        );
    }
}

/** Forget one message. Used before re-indexing it; the raw store is untouched either way. */
export function removeMessage(db: DatabaseSync, hash: string): void {
    db.prepare('DELETE FROM messages WHERE hash = ?').run(hash);
    db.prepare('DELETE FROM messages_fts WHERE hash = ?').run(hash);
    db.prepare('DELETE FROM signatures WHERE hash = ?').run(hash);
}

/**
 * Search, newest-looking matches first by FTS5's own relevance ranking.
 *
 * Two queries rather than a join with `MATCH`: the FTS table answers which hashes matched and in
 * what order, then the ordinary table is read by key. It is one extra round trip per hit on a
 * list the operator is going to read with their eyes, and it keeps both statements to the plain
 * SQL that gjsify's parser handles.
 *
 * `query` is a user's search string, not FTS5 syntax — see `toMatchExpression`.
 */
export function searchMessages(db: DatabaseSync, query: string, limit = 20): SearchHit[] {
    const match = query.trim();
    if (match === '') return [];
    // Interpolated, not bound: `LIMIT ?` is not accepted everywhere, and the value is an integer
    // this function clamps itself, so there is no string to inject.
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
    const hits = db
        .prepare(`SELECT hash FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ${capped}`)
        .all(match) as { hash?: string }[];

    const row = db.prepare(
        'SELECT hash, subject, sender, date, sent_at, verdict FROM messages WHERE hash = ?',
    );
    const found: SearchHit[] = [];
    for (const hit of hits) {
        if (typeof hit.hash !== 'string') continue;
        const message = row.get(hit.hash) as Record<string, unknown> | undefined;
        if (!message) continue;
        found.push({
            hash: String(message.hash),
            subject: String(message.subject ?? ''),
            from: String(message.sender ?? ''),
            date: String(message.date ?? ''),
            sentAt: message.sent_at === null || message.sent_at === undefined ? undefined : Number(message.sent_at),
            verdict: String(message.verdict) as Verdict,
        });
    }
    return found;
}
