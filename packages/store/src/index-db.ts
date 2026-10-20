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

import { type Caveat, type MessageFinding, type Verdict, fmt, _ } from '@stamped/core';
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
 * `query` is tried as FTS5 syntax first (phrases, `AND`/`OR`, `subject : …`); what FTS5 rejects —
 * an address like `chef@firma.de`, a domain, `Re: Angebot` — is searched as literal terms instead
 * (see {@link toLiteralTerms}), so a plain search never ends in a syntax error.
 */
/** Every whitespace-separated word as a quoted FTS5 string: all must occur, none is syntax. */
export function toLiteralTerms(query: string): string {
    return query
        .split(/\s+/)
        .filter((term) => term !== '')
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(' ');
}

/** The columns {@link toHit} reads, so the two queries that produce hits cannot drift apart. */
const HIT_COLUMNS = 'hash, subject, sender, date, sent_at, verdict';

/** One row of `messages`, as a hit. The one place a column name becomes a field name. */
function toHit(message: Record<string, unknown>): SearchHit {
    return {
        hash: String(message.hash),
        subject: String(message.subject ?? ''),
        from: String(message.sender ?? ''),
        date: String(message.date ?? ''),
        sentAt:
            message.sent_at === null || message.sent_at === undefined ? undefined : Number(message.sent_at),
        verdict: String(message.verdict) as Verdict,
    };
}

export function searchMessages(db: DatabaseSync, query: string, limit = 20): SearchHit[] {
    const match = query.trim();
    if (match === '') return [];
    // Interpolated, not bound: `LIMIT ?` is not accepted everywhere, and the value is an integer
    // this function clamps itself, so there is no string to inject.
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
    const statement = db.prepare(
        `SELECT hash FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ${capped}`,
    );
    let hits: { hash?: string }[];
    try {
        hits = statement.all(match) as { hash?: string }[];
    } catch {
        hits = statement.all(toLiteralTerms(match)) as { hash?: string }[];
    }

    const row = db.prepare(`SELECT ${HIT_COLUMNS} FROM messages WHERE hash = ?`);
    const found: SearchHit[] = [];
    for (const hit of hits) {
        if (typeof hit.hash !== 'string') continue;
        const message = row.get(hit.hash) as Record<string, unknown> | undefined;
        if (!message) continue;
        found.push(toHit(message));
    }
    return found;
}

/** How a list of messages is narrowed. Every field absent means "the whole case, newest first". */
export interface ListOptions {
    /** Only messages with this verdict. */
    readonly verdict?: Verdict;
    /** Only these hashes — what a folder filter is, see `sourceHashes` in `raw.ts`. */
    readonly hashes?: ReadonlySet<string>;
    readonly limit?: number;
}

/**
 * The messages of a case, newest first, without a search term.
 *
 * The list a journalist sees before they have typed anything, so it is a separate function from
 * {@link searchMessages} rather than that one with an empty query: the orders differ and neither
 * is a degenerate case of the other. Search ranks by FTS5 relevance, where "newest" is
 * meaningless; a browse list ranks by `sent_at`, and the messages whose `Date` could not be read
 * sort LAST instead of to 1970 — a gap in the data must not look like a fact about the message
 * (same rule as `parseDate`).
 *
 * `hashes` is filtered in TypeScript rather than as a `WHERE hash IN (…)`: a source of a hundred
 * thousand messages would be a hundred thousand bind parameters, past SQLite's variable limit.
 * The page is small, so the cost is reading rows until it is full.
 */
export function listMessages(db: DatabaseSync, options: ListOptions = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 200) || 1));
    const hashes = options.hashes;
    // Over-read when a hash filter applies: the rows it drops still have to come from somewhere,
    // and reading the whole case to filter it would defeat the LIMIT on a large archive. A filter
    // that is sparser than this cap shows a short page rather than a wrong one.
    const scan = hashes ? Math.min(20_000, limit * 50) : limit;

    const where = options.verdict ? 'WHERE verdict = ?' : '';
    const rows = db
        .prepare(
            `SELECT ${HIT_COLUMNS} FROM messages ${where}
             ORDER BY sent_at IS NULL, sent_at DESC, hash ASC LIMIT ${scan}`,
        )
        .all(...(options.verdict ? [options.verdict] : [])) as Record<string, unknown>[];

    const found: SearchHit[] = [];
    for (const row of rows) {
        if (hashes && !hashes.has(String(row.hash))) continue;
        found.push(toHit(row));
        if (found.length >= limit) break;
    }
    return found;
}

/** Everything the index holds about one message — the detail pane's row, verdict and signatures. */
export interface IndexedMessage {
    readonly hash: string;
    readonly bytes: number;
    readonly messageId?: string;
    readonly from: string;
    readonly to: string;
    readonly cc: string;
    readonly subject: string;
    readonly date: string;
    readonly sentAt?: number;
    readonly fromDomain?: string;
    readonly verdict: Verdict;
    /** The caveats of the signature the message verdict came from. */
    readonly caveats: readonly Caveat[];
}

/**
 * One message out of the index, or `undefined` when the index has no row for that hash.
 *
 * ONLY WHAT THE INDEX CONCLUDED, and the trust order in the package note applies without an
 * exception here: this is a cache of a verification that ran at import time against the keys then
 * available. A pane that shows the full evidence chain of each signature re-verifies the raw
 * bytes (`readRaw` plus `@stamped/verify`) instead of reading it from here, because a key
 * collected since would change the answer and this row would not know.
 */
export function readMessage(db: DatabaseSync, hash: string): IndexedMessage | undefined {
    const row = db
        .prepare(
            `SELECT hash, message_id, sender, recipients, cc, subject, date, sent_at,
                    from_domain, verdict, caveats, bytes
             FROM messages WHERE hash = ?`,
        )
        .get(hash) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    return {
        hash: String(row.hash),
        bytes: Number(row.bytes ?? 0),
        messageId: optionalText(row.message_id),
        from: String(row.sender ?? ''),
        to: String(row.recipients ?? ''),
        cc: String(row.cc ?? ''),
        subject: String(row.subject ?? ''),
        date: String(row.date ?? ''),
        sentAt: row.sent_at === null || row.sent_at === undefined ? undefined : Number(row.sent_at),
        fromDomain: optionalText(row.from_domain),
        verdict: String(row.verdict) as Verdict,
        caveats: parseCaveats(row.caveats),
    };
}

/** A nullable TEXT column as `string | undefined`, never as the string `"null"`. */
function optionalText(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : String(value);
}

/**
 * The `caveats` column back into a list.
 *
 * An unreadable column yields an empty list rather than throwing: the verdict is the finding and
 * it is in its own column, so a detail pane must still open. The caveats are shown from the
 * re-verification anyway — see {@link readMessage}.
 */
function parseCaveats(value: unknown): Caveat[] {
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? (parsed.filter((item) => typeof item === 'string') as Caveat[]) : [];
    } catch {
        return [];
    }
}
