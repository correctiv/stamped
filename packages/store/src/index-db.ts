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

import { type Caveat, type MessageFinding, type Verdict, VERDICTS, fmt, _ } from '@stamped/core';
import type { MessageSummary } from '@stamped/import';

import { deleteAddresses, ensureAddresses, writeAddresses } from './addresses-db.ts';
import { deleteUnsignedHeaders, ensureUnsignedHeaders } from './unsigned-headers.ts';
import type { CasePaths } from './case.ts';
import { statementFor } from './statements.ts';

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
    // WAL + NORMAL: the index is a cache that `raw/` can refill, so a power cut costing the last
    // few commits is harmless, while a sync per commit is what made indexing I/O-bound. Best
    // effort: a backend that refuses a pragma still indexes, just slower.
    // busy_timeout first: a second writer (the window beside a CLI run) waits up to 5 s for the
    // lock instead of failing at once, and the journal_mode switch itself needs the lock too.
    for (const pragma of [
        'PRAGMA busy_timeout=5000',
        'PRAGMA journal_mode=WAL',
        'PRAGMA synchronous=NORMAL',
    ]) {
        try {
            db.exec(pragma);
        } catch {
            // see above
        }
    }
    if (schemaVersion(db) !== SCHEMA_VERSION) createSchema(db);
    // Both are in-place additions to an index the journalist already has: a column whose absence
    // would mean no history, and the indexes of a case older than they were written.
    addFirstVerdictColumn(db);
    ensureIndexes(db);
    ensureAddresses(db);
    ensureUnsignedHeaders(db);
    return db;
}

/**
 * Older indexes lack `first_verdict`. Added in place instead of bumping the schema (which would
 * drop the cache): those rows stay NULL, and the report reads NULL as "no history".
 */
function addFirstVerdictColumn(db: DatabaseSync): void {
    const columns = db.prepare('PRAGMA table_info(messages)').all() as { name?: string }[];
    if (columns.some((column) => column.name === 'first_verdict')) return;
    db.exec('ALTER TABLE messages ADD COLUMN first_verdict TEXT');
}

/** Open a transaction. Pair with {@link commitBatch}; the importer commits every few hundred. */
export function beginBatch(db: DatabaseSync): void {
    db.exec('BEGIN');
}

/** Commit what {@link beginBatch} opened. */
export function commitBatch(db: DatabaseSync): void {
    db.exec('COMMIT');
}

/** Undo an open batch. Never throws: it runs on an error path that has a better error to report. */
export function rollbackBatch(db: DatabaseSync): void {
    try {
        db.exec('ROLLBACK');
    } catch {
        // no transaction was open
    }
}

/** Every indexed hash, loaded once — one scan instead of one query per message. */
export function indexedHashes(db: DatabaseSync): Set<string> {
    const rows = db.prepare('SELECT hash FROM messages').all() as { hash?: string }[];
    const hashes = new Set<string>();
    for (const row of rows) if (typeof row.hash === 'string') hashes.add(row.hash);
    return hashes;
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
            first_verdict TEXT,
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
    `);

    // Separate from the script above: a virtual table is a different statement kind, and keeping
    // it alone makes a failure here say "FTS5 is missing" rather than "the schema failed".
    db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(hash UNINDEXED, ${FTS_COLUMNS.join(', ')})`);

    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
}

/**
 * The indexes, by name, so {@link ensureIndexes} can add one to a case that predates it.
 *
 * NOT part of {@link createSchema} and not covered by {@link SCHEMA_VERSION}, deliberately. A
 * version bump DROPS the index and a dropped index is empty until somebody re-imports the
 * archive — which is exactly the thing a journalist may no longer have. An index is derived from
 * rows that are already there, so it can be created in place instead, and adding one then costs
 * a case nothing but the time to build it.
 *
 * `messages_browse` carries the browse order as the ORDER BY writes it, expression and all:
 * `sent_at IS NULL` first so a message whose `Date` could not be read sorts LAST rather than to
 * 1970, then newest first, then the hash to break ties. Without it a page deep into a six-figure
 * case sorts the whole table to throw away everything before the offset. `messages_verdict_browse`
 * is the same order per verdict, which is what the sidebar filter asks for.
 */
const INDEXES: readonly { readonly name: string; readonly sql: string }[] = [
    { name: 'signatures_hash', sql: 'CREATE INDEX signatures_hash ON signatures (hash)' },
    { name: 'signatures_key', sql: 'CREATE INDEX signatures_key ON signatures (domain, selector)' },
    { name: 'messages_sent_at', sql: 'CREATE INDEX messages_sent_at ON messages (sent_at)' },
    { name: 'messages_from_domain', sql: 'CREATE INDEX messages_from_domain ON messages (from_domain)' },
    {
        name: 'messages_browse',
        sql: 'CREATE INDEX messages_browse ON messages (sent_at IS NULL, sent_at DESC, hash ASC)',
    },
    {
        name: 'messages_verdict_browse',
        sql: 'CREATE INDEX messages_verdict_browse ON messages (verdict, sent_at IS NULL, sent_at DESC, hash ASC)',
    },
    // Partial: a case is mostly messages with no caveat, and `caveatCounts` walks `json_each` over
    // every row that has one. The index holds only the rows that do, so the count reads them and
    // nothing else.
    {
        name: 'messages_caveats',
        sql: "CREATE INDEX messages_caveats ON messages (caveats) WHERE caveats <> '[]'",
    },
];

/**
 * Create whatever index is missing. Runs on every open, costs one `sqlite_master` query each.
 *
 * Each statement on its own `exec`, as the schema's virtual table is: gjsify's `node:sqlite`
 * splits a script on every `;`, and a failure then says which index could not be built rather
 * than that the schema failed.
 *
 * Best effort per index, because `CREATE INDEX` is a write and the GUI opens the same case while
 * an import subprocess is writing it — a busy database must not make a case unopenable for
 * reading. The index is then built by whichever open comes after the import, and every query
 * here is correct without it, only slower.
 */
function ensureIndexes(db: DatabaseSync): void {
    for (const index of INDEXES) {
        if (tableExists(db, index.name)) continue;
        try {
            db.exec(index.sql);
        } catch {
            // see above
        }
    }
}

/** Is this message in the index already? The question that makes indexing resumable. */
export function isIndexed(db: DatabaseSync, hash: string): boolean {
    const row = statementFor(db, 'SELECT 1 AS n FROM messages WHERE hash = ?').get(hash);
    return row !== undefined;
}

/** How many messages the index holds, whatever any filter would say. */
export function messageCount(db: DatabaseSync): number {
    return countMessages(db);
}

/**
 * Put one message in the index, replacing whatever was there for that hash.
 *
 * Replacing rather than failing on a conflict, because the same message re-indexed after a
 * schema change or a newly collected key must end up with the NEW verdict. The hash is the
 * identity, so there is nothing to lose by rewriting the row. `options.fresh` skips the removal
 * for a message the caller knows is new.
 */
export function indexMessage(db: DatabaseSync, entry: IndexEntry, options: { fresh?: boolean } = {}): void {
    // `fresh`: the caller knows the hash is not indexed. The delete from the FTS table is a full
    // scan (`hash` is UNINDEXED), so for a new message it is pure cost.
    // The verdict at the first indexing is kept across re-indexing: it is the "before" of the
    // before/now table in the report. A legacy row (NULL) stays NULL.
    let firstVerdict: string | null = entry.finding.verdict;
    if (!options.fresh) {
        const previous = statementFor(db, 'SELECT first_verdict FROM messages WHERE hash = ?').get(
            entry.hash,
        ) as { first_verdict?: string | null } | undefined;
        if (previous) firstVerdict = previous.first_verdict ?? null;
        removeMessage(db, entry.hash);
    }
    const summary = entry.summary;

    statementFor(
        db,
        `INSERT INTO messages (
            hash, message_id, sender, recipients, cc, subject, date, sent_at,
            in_reply_to, refs, from_domain, verdict, first_verdict, caveats, bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        firstVerdict,
        JSON.stringify(entry.finding.caveats),
        entry.bytes,
    );

    statementFor(
        db,
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

    writeAddresses(db, entry.hash, { from: summary.from, to: summary.to, cc: summary.cc });

    writeSignatures(db, entry.hash, entry.finding);
}

function writeSignatures(db: DatabaseSync, hash: string, finding: MessageFinding): void {
    const signature = statementFor(
        db,
        `INSERT INTO signatures (hash, position, domain, selector, algorithm, verdict, aligned, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [position, found] of finding.signatures.entries()) {
        signature.run(
            hash,
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

/**
 * Replace what the verifier said about an INDEXED message — verdict, caveats, signatures — and
 * nothing else. Returns false when the hash is not indexed (nothing was written).
 *
 * This is what a re-verification needs instead of {@link indexMessage}: the text, the headers
 * and the addresses do not change with a key, and `indexMessage` would delete the FTS row first —
 * a full scan of the whole text index per message, because `hash` is UNINDEXED there. On a case
 * of several hundred thousand messages that scan, repeated per message, is what starved every
 * other reader of the file. `first_verdict` stays as it is.
 */
export function updateFinding(db: DatabaseSync, hash: string, finding: MessageFinding): boolean {
    const known = statementFor(db, 'SELECT 1 AS n FROM messages WHERE hash = ?').get(hash);
    if (known === undefined) return false;
    statementFor(db, 'UPDATE messages SET verdict = ?, caveats = ? WHERE hash = ?').run(
        finding.verdict,
        JSON.stringify(finding.caveats),
        hash,
    );
    statementFor(db, 'DELETE FROM signatures WHERE hash = ?').run(hash);
    writeSignatures(db, hash, finding);
    return true;
}

/** Forget one message. Used before re-indexing it; the raw store is untouched either way. */
export function removeMessage(db: DatabaseSync, hash: string): void {
    statementFor(db, 'DELETE FROM messages WHERE hash = ?').run(hash);
    statementFor(db, 'DELETE FROM messages_fts WHERE hash = ?').run(hash);
    statementFor(db, 'DELETE FROM signatures WHERE hash = ?').run(hash);
    deleteAddresses(db, hash);
    deleteUnsignedHeaders(db, hash);
}

/** Every whitespace-separated word as a quoted FTS5 string: all must occur, none is syntax. */
export function toLiteralTerms(query: string): string {
    return query
        .split(/\s+/)
        .filter((term) => term !== '')
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(' ');
}

/**
 * The columns {@link toHit} reads, so the two queries that produce hits cannot drift apart.
 *
 * Qualified by table and aliased back: a browse page joins {@link HashScope}'s table, where a
 * bare `hash` would be ambiguous.
 */
const HIT_COLUMNS = [
    'messages.hash AS hash',
    'messages.subject AS subject',
    'messages.sender AS sender',
    'messages.date AS date',
    'messages.sent_at AS sent_at',
    'messages.verdict AS verdict',
].join(', ');

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

/** How a search is narrowed. The term itself is not in here: it is never optional. */
export interface SearchOptions {
    /** Only hits with this verdict. */
    readonly verdict?: Verdict;
    /** Only the hashes this scope admits — see {@link hashScope}. */
    readonly scope?: HashScope;
    /** How many hits to return. */
    readonly limit?: number;
}

/**
 * How many ranked hits a FILTERED search reads before it stops looking.
 *
 * A filter is applied to the ranked hits rather than inside the `MATCH` query — ranking the
 * narrowed set is a different question from narrowing the ranked set, and the second is the one
 * a search box asks. So the rows a filter drops still have to be read, and a search for a common
 * word in a six-figure case would otherwise read every match to fill a page of thirty. This cap
 * shows a SHORT page rather than a wrong one, which is why {@link SearchHit} counts are never
 * reported as a total.
 */
const SEARCH_SCAN_CAP = 20_000;

/**
 * Search, best matches first by FTS5's own relevance ranking, narrowed by verdict and by source.
 *
 * Two queries rather than a join with `MATCH`: the FTS table answers which hashes matched and in
 * what order, then the ordinary table is read by key. It is one extra round trip per hit on a
 * list the operator is going to read with their eyes, and it keeps both statements to the plain
 * SQL that gjsify's parser handles.
 *
 * `query` is tried as FTS5 syntax first (phrases, `AND`/`OR`, `subject : …`); what FTS5 rejects —
 * an address like `chef@firma.de`, a domain, `Re: Angebot` — is searched as literal terms instead
 * (see {@link toLiteralTerms}), so a plain search never ends in a syntax error.
 *
 * The hits are a bounded list by construction — nobody reads the thirty-thousandth match — so
 * this returns them whole and has no `offset`: the list model pages through what it is given,
 * and page two of a ranked search must not re-rank.
 */
export function searchHits(db: DatabaseSync, query: string, options: SearchOptions = {}): SearchHit[] {
    const match = query.trim();
    if (match === '') return [];
    // Interpolated, not bound: `LIMIT ?` is not accepted everywhere, and the value is an integer
    // this function clamps itself, so there is no string to inject.
    const limit = clampSearchLimit(options.limit ?? 20);
    const filtered = options.verdict !== undefined || options.scope !== undefined;
    const scan = filtered ? Math.min(SEARCH_SCAN_CAP, limit * 50) : limit;
    const statement = db.prepare(
        `SELECT hash FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ${scan}`,
    );
    let ranked: { hash?: string }[];
    try {
        ranked = statement.all(match) as { hash?: string }[];
    } catch {
        ranked = statement.all(toLiteralTerms(match)) as { hash?: string }[];
    }

    const row = db.prepare(`SELECT ${HIT_COLUMNS} FROM messages WHERE messages.hash = ?`);
    const found: SearchHit[] = [];
    for (const hit of ranked) {
        if (typeof hit.hash !== 'string') continue;
        // The scope first: one indexed lookup in a temp table is cheaper than reading the row.
        if (options.scope && !options.scope.has(hit.hash)) continue;
        const message = row.get(hit.hash) as Record<string, unknown> | undefined;
        if (!message) continue;
        if (options.verdict !== undefined && String(message.verdict) !== options.verdict) continue;
        found.push(toHit(message));
        if (found.length >= limit) break;
    }
    return found;
}

export function searchMessages(db: DatabaseSync, query: string, limit = 20): SearchHit[] {
    return searchHits(db, query, { limit });
}

/** How many hits a search may return. At least one, at most five thousand. */
function clampSearchLimit(limit: number): number {
    return Math.max(1, Math.min(5000, Math.trunc(limit) || 1));
}

/**
 * How many hashes one `IN` list may carry.
 *
 * SQLite's limit on bound variables is 999 in the older builds and 32766 in the newer ones, and a
 * ranked list of a big case is longer than the smaller limit — so the list is cut into pieces
 * that fit either.
 *
 * EVERY PIECE IS THE SAME SIZE, so that all of them use ONE statement text and the prepared
 * statement cache holds a single entry per case. The last piece is padded with a hash it
 * already contains: `IN` does not repeat a row, so the padding changes nothing but the number
 * of bound values.
 */
const IN_CHUNK = 500;

/** The list in pieces of at most `size`. */
function chunks<T>(list: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/** A piece filled up to `size`, with a hash it already holds. */
function pad<T>(piece: readonly T[], size: number): T[] {
    return [...piece, ...Array<T>(size - piece.length).fill(piece[0])];
}

/**
 * The hits for a ranked list of hashes, in the order the list gives them.
 *
 * WHY IT EXISTS: another kind of search — the vector one — knows WHICH messages are close to a
 * query but nothing about what they say. That is what the index is for, and this is the bridge:
 * a ranked list of hashes in, the same rows a text search returns, out.
 *
 * THE FILTERS ARE THE TEXT SEARCH'S: a verdict and a source scope narrow the hits here exactly
 * as they narrow them there, so a hit can never show a message the person filtered away.
 *
 * A HASH THE INDEX DOES NOT HOLD IS DROPPED, not invented: the vector table and the index can
 * disagree — a message removed from the case, an import that stopped halfway — and a hit without
 * a row has no subject, no date and no verdict to show.
 *
 * The `limit` in the options caps how many hits come back; without one every hash that has a
 * row comes back, because this is a mapping and not a page.
 */
export function hitsForHashes(
    db: DatabaseSync,
    hashes: readonly string[],
    options: SearchOptions = {},
): SearchHit[] {
    if (hashes.length === 0) return [];
    const limit = options.limit === undefined ? undefined : clampSearchLimit(options.limit);

    const rows = new Map<string, SearchHit>();
    for (const chunk of chunks(hashes, IN_CHUNK)) {
        const bound = chunk.length === IN_CHUNK ? chunk : pad(chunk, IN_CHUNK);
        const placeholders = bound.map(() => '?').join(', ');
        const found = statementFor(
            db,
            `SELECT ${HIT_COLUMNS} FROM messages WHERE messages.hash IN (${placeholders})`,
        ).all(...bound) as Record<string, unknown>[];
        for (const row of found) {
            const hit = toHit(row);
            rows.set(hit.hash, hit);
        }
    }

    const hits: SearchHit[] = [];
    for (const hash of hashes) {
        if (limit !== undefined && hits.length >= limit) break;
        const hit = rows.get(hash);
        if (!hit) continue;
        if (options.scope && !options.scope.has(hash)) continue;
        if (options.verdict !== undefined && hit.verdict !== options.verdict) continue;
        hits.push(hit);
    }
    return hits;
}

/**
 * The hashes a filter admits, held in SQLite instead of in TypeScript.
 *
 * WHY A TABLE AND NOT A `Set`. A source filter IS a set of hashes: provenance belongs to the
 * import log and not to a row here (see the module note), so "only this archive" can never become
 * a `WHERE source = ?`. Those hashes cannot be bound — a hundred thousand of them is far past
 * SQLite's variable limit — and filtering them in TypeScript means reading rows only to throw
 * them away, which is what made a filtered list cost a scan of the whole table. Written into a
 * table once, every page of the list joins it instead: the scope is built when the person picks
 * the archive and reused by every page they scroll to.
 *
 * TEMPORARY, so it belongs to this connection and no crash can leave it behind in the case's
 * `index.db`. {@link close} drops it — a scope that outlives its filter is a filter that silently
 * still applies.
 */
export interface HashScope {
    /** The table name, for a query that joins it. Generated here, never from input. */
    readonly table: string;
    /** How many distinct hashes it admits. */
    readonly size: number;
    /** Is this hash admitted? One indexed lookup — what a ranked search filters its hits with. */
    has(hash: string): boolean;
    /** Drop the table. Idempotent, and safe after the connection is gone. */
    close(): void;
}

/** Makes each scope's table name its own, so a new filter can be built before the old is dropped. */
let scopeSerial = 0;

/**
 * Put a set of hashes where SQL can reach it. The caller closes it; see {@link HashScope}.
 *
 * One transaction around the inserts, because without one every row is its own commit and a
 * hundred thousand of them take minutes rather than a second. Best effort: a transaction may
 * already be open — the importer holds one — and the inserts are then simply part of it.
 */
export function hashScope(db: DatabaseSync, hashes: Iterable<string>): HashScope {
    return buildScope(db, (table) => {
        const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (hash) VALUES (?)`);
        for (const hash of hashes) insert.run(hash);
    });
}

/**
 * A scope filled by one `SELECT hash …` inside SQLite — no hash ever travels through JS.
 *
 * For the filters that name a large set by a property (a person, a period): at a million
 * messages a person with a hundred thousand mails would otherwise be that many `Set` entries
 * and that many `run` calls just to be written straight back. `select` must yield one column
 * named `hash`; its parameters are bound, never interpolated.
 */
export function queryScope(
    db: DatabaseSync,
    select: string,
    params: readonly (string | number)[] = [],
): HashScope {
    return buildScope(db, (table) => {
        db.prepare(`INSERT OR IGNORE INTO ${table} (hash) ${select}`).run(...params);
    });
}

function buildScope(db: DatabaseSync, fill: (table: string) => void): HashScope {
    scopeSerial += 1;
    const table = `scope_${scopeSerial}`;
    db.exec(`CREATE TEMP TABLE ${table} (hash TEXT PRIMARY KEY)`);

    const own = beganHere(db);
    try {
        fill(table);
        if (own) commitBatch(db);
    } catch (error) {
        if (own) rollbackBatch(db);
        db.exec(`DROP TABLE ${table}`);
        throw error;
    }

    const member = db.prepare(`SELECT 1 AS n FROM ${table} WHERE hash = ?`);
    const size = Number(
        (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined)?.n ?? 0,
    );
    let open = true;
    return {
        table,
        size,
        has(hash: string): boolean {
            return member.get(hash) !== undefined;
        },
        close(): void {
            if (!open) return;
            open = false;
            try {
                db.exec(`DROP TABLE ${table}`);
            } catch {
                // the connection is already closed, which drops the temp table anyway
            }
        },
    };
}

/** Open a transaction if none is open. `false` means somebody else owns the one we are in. */
function beganHere(db: DatabaseSync): boolean {
    try {
        beginBatch(db);
        return true;
    } catch {
        return false;
    }
}

/**
 * The messages carrying one of these verdicts, as a set a scope can be built from.
 *
 * The set form of the `verdict` column filter: a tap on an overview number narrows the list to
 * several verdicts at once ("the two confirmation verdicts"), which the `verdict = ?` form of
 * {@link countMessages} cannot express. Unknown verdict names are dropped rather than bound —
 * a name the schema has no column value for would silently match nothing anyway, and dropping
 * keeps the caller from building a filter out of a typo.
 */
export function verdictHashes(db: DatabaseSync, verdicts: readonly Verdict[]): Set<string> {
    const known = new Set<string>(VERDICTS);
    const wanted = verdicts.filter((verdict) => known.has(verdict));
    if (wanted.length === 0) return new Set();
    const placeholders = wanted.map(() => '?').join(', ');
    const rows = db
        .prepare(`SELECT hash FROM messages WHERE verdict IN (${placeholders})`)
        .all(...wanted) as { hash?: unknown }[];
    const hashes = new Set<string>();
    for (const row of rows) if (typeof row.hash === 'string') hashes.add(row.hash);
    return hashes;
}

/** What a signature filter asks for. Every field is an `AND`; nothing set means "every signature". */
export interface SignatureQuery {
    /** `d=`, matched case-insensitively — a domain is a name, not a byte string. */
    readonly domain?: string;
    /** `s=`, matched case-insensitively. */
    readonly selector?: string;
    /** The `reason` column — `no-key` for a missing selector, one of the unverifiable reasons. */
    readonly reason?: string;
    /** Only signatures of messages whose own verdict is this one. */
    readonly messageVerdict?: Verdict;
}

/**
 * The messages carrying a matching signature, as a set a scope can be built from.
 *
 * THE SIGNATURE'S PROPERTIES, not the message's: "everything signed by example.com", "the
 * messages waiting on this selector" and "the messages with no verdict because of this reason"
 * are all questions about a `signatures` row, and only the last one additionally needs the
 * message's verdict. Counted over DISTINCT hashes so a message signed twice by the same pair
 * still appears once in the list it filters.
 */
export function signatureHashes(db: DatabaseSync, query: SignatureQuery): Set<string> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.domain !== undefined && query.domain !== '') {
        clauses.push('lower(s.domain) = lower(?)');
        params.push(query.domain);
    }
    if (query.selector !== undefined && query.selector !== '') {
        clauses.push('lower(s.selector) = lower(?)');
        params.push(query.selector);
    }
    if (query.reason !== undefined && query.reason !== '') {
        clauses.push('s.reason = ?');
        params.push(query.reason);
    }
    const verdict = query.messageVerdict;
    if (verdict !== undefined) {
        clauses.push('m.verdict = ?');
        params.push(verdict);
    }
    const join = verdict !== undefined ? 'JOIN messages m ON m.hash = s.hash' : '';
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
        .prepare(`SELECT DISTINCT s.hash AS hash FROM signatures s ${join} ${where}`)
        .all(...params) as { hash?: unknown }[];
    const hashes = new Set<string>();
    for (const row of rows) if (typeof row.hash === 'string') hashes.add(row.hash);
    return hashes;
}

/** How a page of the message list is narrowed. Every field absent means "the whole case". */
export interface BrowseOptions {
    /** Only messages with this verdict. */
    readonly verdict?: Verdict;
    /** Only the hashes this scope admits — what a source filter is, see {@link hashScope}. */
    readonly scope?: HashScope;
    /** How many rows the page holds. */
    readonly limit?: number;
    /** How many rows to skip: which page of the order below is wanted. */
    readonly offset?: number;
}

/** {@link BrowseOptions} plus the convenience form — a plain set, for one query. */
export interface ListOptions extends BrowseOptions {
    /** Only these hashes. Builds a scope for this call alone; a list builds one and keeps it. */
    readonly hashes?: ReadonlySet<string>;
}

/** What a filtered count is asked about: the same narrowing, without a page. */
export type CountOptions = Pick<BrowseOptions, 'verdict' | 'scope'>;

/** `LIMIT`/`OFFSET` are interpolated, not bound: `LIMIT ?` is not accepted everywhere. Integers only. */
function clampLimit(limit: number): number {
    return Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
}

/** The join that applies a scope, or nothing at all. */
function scopeJoin(scope: HashScope | undefined): string {
    return scope ? `JOIN ${scope.table} ON ${scope.table}.hash = messages.hash` : '';
}

/**
 * One page of the case, newest first, without a search term.
 *
 * The list a journalist sees before they have typed anything, so it is a separate function from
 * {@link searchMessages} rather than that one with an empty query: the orders differ and neither
 * is a degenerate case of the other. Search ranks by FTS5 relevance, where "newest" is
 * meaningless; a browse list ranks by `sent_at`, and the messages whose `Date` could not be read
 * sort LAST instead of to 1970 — a gap in the data must not look like a fact about the message
 * (same rule as `parseDate`).
 *
 * PAGED, because the alternative at four hundred thousand messages is to build four hundred
 * thousand rows for a window that shows thirty. The order is exactly what `messages_browse`
 * indexes, expression and all, so a page deep in the case is an index walk rather than a sort of
 * the whole table — which is the difference between a scroll and a freeze.
 */
export function browseMessages(db: DatabaseSync, options: BrowseOptions = {}): SearchHit[] {
    const limit = clampLimit(options.limit ?? 200);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0) || 0);
    const rows = db
        .prepare(
            `SELECT ${HIT_COLUMNS} FROM messages
             ${scopeJoin(options.scope)}
             ${options.verdict ? 'WHERE messages.verdict = ?' : ''}
             ORDER BY messages.sent_at IS NULL, messages.sent_at DESC, messages.hash ASC
             LIMIT ${limit} OFFSET ${offset}`,
        )
        .all(...(options.verdict ? [options.verdict] : [])) as Record<string, unknown>[];
    return rows.map((row) => toHit(row));
}

/**
 * How many messages a filter admits — the length of the list, not of a page.
 *
 * Counted in SQLite rather than by taking the length of what {@link browseMessages} returns: the
 * list model needs the total before it fetches anything, and the number under the list ("300 of
 * 420,000") is a fact about the case that a page cannot see.
 */
export function countMessages(db: DatabaseSync, options: CountOptions = {}): number {
    const row = db
        .prepare(
            `SELECT count(*) AS n FROM messages
             ${scopeJoin(options.scope)}
             ${options.verdict ? 'WHERE messages.verdict = ?' : ''}`,
        )
        .get(...(options.verdict ? [options.verdict] : [])) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
}

/**
 * The first page of a filtered list, taking the hashes as a plain set.
 *
 * The convenience form of {@link browseMessages} for a caller that asks once — a command, a test.
 * The scope it builds lives exactly as long as the query; a list the person scrolls through
 * builds one with {@link hashScope} and keeps it, which is the whole point of the table.
 */
export function listMessages(db: DatabaseSync, options: ListOptions = {}): SearchHit[] {
    const hashes = options.hashes;
    if (hashes === undefined || options.scope !== undefined) return browseMessages(db, options);
    const scope = hashScope(db, hashes);
    try {
        return browseMessages(db, { ...options, scope });
    } finally {
        scope.close();
    }
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
