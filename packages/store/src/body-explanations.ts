/**
 * The `body_explanations` table: for each BODY-ALTERED signature, what the export-artefact retry
 * found, cached per (raw hash, signature position).
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, exactly like `unsigned_headers` (see
 * `unsigned-headers.ts`): a `SCHEMA_VERSION` bump drops the index. A row is a pure function of the
 * raw bytes and the retry rules, so only a change of the RULES can make it stale — that is what
 * {@link BODY_EXPLANATION_VERSION} is for. CHANGING `retry.ts` MEANS BUMPING IT.
 *
 * `artefact` is the {@link ExportArtefact} that brings the signed hash back, or `'none'`. It is an
 * EXPLANATION only; the verdict stays `body-altered`. `flags` records what the header block shows,
 * which the report offers as an indication, never as proof.
 */

import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { MessageFinding } from '@stamped/core';
import { type HeaderField, parseHeaderFields, splitMessage } from '@stamped/import';
import { explainBodyByRetry } from '@stamped/verify';

import type { CasePaths } from './case.ts';
import { rawPath } from './raw.ts';
import { statementFor } from './statements.ts';

/** The version of the retry rules behind the cached rows. Bump it with `retry.ts`. */
export const BODY_EXPLANATION_VERSION = 1;

/** The marker for "looked, no artefact explains it". */
export const NO_ARTEFACT = 'none';

/** What the header block of one body-altered message shows about one signature. */
export interface BodyHeaderFlags {
    /** An `X-MS-Exchange-*` or `X-MS-TNEF-Correlator` header: the message passed through Exchange. */
    readonly exchange: boolean;
    /** An `Authentication-Results` header records `dkim=pass` for this signature's domain. */
    readonly receiverPass: boolean;
}

const EXCHANGE = 1;
const RECEIVER_PASS = 2;
/** The header was readable; without it the two flags above say nothing. */
const EXAMINED = 4;

/** Read the flags off parsed header fields for one signing domain. Pure. */
export function analyseBodyHeaders(fields: readonly HeaderField[], domain: string): BodyHeaderFlags {
    const wanted = domain.toLowerCase();
    return {
        exchange: fields.some(
            (field) => field.lower.startsWith('x-ms-exchange-') || field.lower === 'x-ms-tnef-correlator',
        ),
        receiverPass: fields.some(
            (field) =>
                field.lower === 'authentication-results' &&
                field.value.split(';').some((part) => {
                    if (!/\bdkim\s*=\s*pass\b/i.test(part)) return false;
                    const identity = /header\.[di]\s*=\s*"?([^\s;"]+)/i.exec(part)?.[1]?.toLowerCase();
                    return identity !== undefined && (identity === wanted || identity.endsWith(`@${wanted}`));
                }),
        ),
    };
}

function toBits(flags: BodyHeaderFlags | undefined): number {
    if (flags === undefined) return 0;
    return EXAMINED | (flags.exchange ? EXCHANGE : 0) | (flags.receiverPass ? RECEIVER_PASS : 0);
}

const READY = new WeakMap<DatabaseSync, boolean>();

function exists(db: DatabaseSync, name: string): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?').get(name) as
        | { n?: number }
        | undefined;
    return Number(row?.n ?? 0) > 0;
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Create the table if missing. Best effort, like `ensureUnsignedHeaders`. */
export function ensureBodyExplanations(db: DatabaseSync): void {
    try {
        if (!exists(db, 'body_explanations')) {
            db.exec(
                `CREATE TABLE body_explanations (
                    hash TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    artefact TEXT NOT NULL,
                    flags INTEGER NOT NULL,
                    PRIMARY KEY (hash, position)
                )`,
            );
            // A new table is empty, so it is current by definition: otherwise the first backfill
            // would clear what the importer has just written.
            setMeta(db, 'body_explanations_version', String(BODY_EXPLANATION_VERSION));
        }
    } catch {
        // a busy database must not make the case unopenable
    }
    READY.delete(db);
}

function hasTable(db: DatabaseSync): boolean {
    let ready = READY.get(db);
    if (ready === undefined) {
        ready = exists(db, 'body_explanations');
        READY.set(db, ready);
    }
    return ready;
}

/** Forget the cached explanations of one message. */
export function deleteBodyExplanations(db: DatabaseSync, hash: string): void {
    if (!hasTable(db)) return;
    statementFor(db, 'DELETE FROM body_explanations WHERE hash = ?').run(hash);
}

function putRow(db: DatabaseSync, hash: string, position: number, artefact: string, flags: number): void {
    statementFor(
        db,
        'INSERT OR REPLACE INTO body_explanations (hash, position, artefact, flags) VALUES (?, ?, ?, ?)',
    ).run(hash, position, artefact, flags);
}

/**
 * Cache the retry result of every body-altered signature of one message, from the finding the
 * verifier has just produced and the bytes it was produced from. Called by the importer and by
 * reverify, which have both at hand. Replaces what the hash had; a no-op without the table.
 */
export function writeBodyExplanations(
    db: DatabaseSync,
    hash: string,
    finding: MessageFinding,
    raw: Uint8Array,
): void {
    if (!hasTable(db)) return;
    deleteBodyExplanations(db, hash);
    let fields: HeaderField[] | undefined;
    for (const [position, found] of finding.signatures.entries()) {
        if (found.verdict !== 'body-altered') continue;
        fields ??= parseHeaderFields(splitMessage(raw).header);
        putRow(
            db,
            hash,
            position,
            found.evidence.exportArtefact ?? NO_ARTEFACT,
            toBits(analyseBodyHeaders(fields, found.evidence.domain)),
        );
    }
}

/** The tags of one DKIM-Signature value. */
function dkimTags(value: string): Map<string, string> {
    const tags = new Map<string, string>();
    for (const part of value.split(';')) {
        const at = part.indexOf('=');
        if (at > 0) tags.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).replace(/\s+/g, ''));
    }
    return tags;
}

interface SignatureRow {
    position: number;
    domain: string;
    selector: string;
}

/**
 * Work out one signature of a raw message the way the verifier did: the nth DKIM-Signature header
 * (signature positions follow header order), its tags, and the retry. A header that does not match
 * the row's domain and selector is not that signature, and gets `'none'`.
 */
function explainFromRaw(raw: Uint8Array, fields: readonly HeaderField[], row: SignatureRow): string {
    const tags = fields
        .filter((field) => field.lower === 'dkim-signature')
        .map((field) => dkimTags(field.value));
    const own = tags[row.position];
    if (!own) return NO_ARTEFACT;
    if (own.get('d')?.toLowerCase() !== row.domain.toLowerCase() || own.get('s') !== row.selector)
        return NO_ARTEFACT;
    const bodyHash = own.get('bh');
    const algorithm = own.get('a');
    if (!bodyHash || !algorithm) return NO_ARTEFACT;
    const limit = own.get('l') === undefined ? Number.NaN : Number(own.get('l'));
    return (
        explainBodyByRetry(raw, {
            canonicalization: own.get('c') ?? 'simple/simple',
            algorithm,
            bodyHashExpected: bodyHash,
            ...(Number.isFinite(limit) ? { lengthLimit: limit } : {}),
        }) ?? NO_ARTEFACT
    );
}

function currentVersion(db: DatabaseSync): boolean {
    return metaValue(db, 'body_explanations_version') === String(BODY_EXPLANATION_VERSION);
}

/** Does the cache cover every body-altered signature that predates it, under the current rules? */
export function bodyExplanationsComplete(db: DatabaseSync): boolean {
    return hasTable(db) && currentVersion(db) && metaValue(db, 'body_explanations_done') === '1';
}

/**
 * Fill the cache for body-altered signatures that lack a current row, one batch of at most
 * `batch` MESSAGES (one raw file is read per message, never more than one is in memory).
 *
 * Idempotent and resumable: a rowid cursor in `meta` says where it stopped, and a row is replaced,
 * never added. A different rule version clears the table and starts over.
 */
export function backfillBodyExplanations(
    db: DatabaseSync,
    paths: CasePaths,
    batch = 500,
): { done: boolean; processed: number } {
    if (!hasTable(db)) return { done: false, processed: 0 };
    if (!currentVersion(db)) {
        db.exec('DELETE FROM body_explanations');
        setMeta(db, 'body_explanations_cursor', '0');
        setMeta(db, 'body_explanations_done', '0');
        setMeta(db, 'body_explanations_version', String(BODY_EXPLANATION_VERSION));
    }
    if (metaValue(db, 'body_explanations_done') === '1') return { done: true, processed: 0 };
    const cursor = Number(metaValue(db, 'body_explanations_cursor') ?? 0);
    const messages = db
        .prepare(
            `SELECT DISTINCT m.rowid AS id, m.hash AS hash
             FROM signatures s
             JOIN messages m ON m.hash = s.hash
             LEFT JOIN body_explanations b ON b.hash = s.hash AND b.position = s.position
             WHERE m.rowid > ? AND s.verdict = 'body-altered' AND b.hash IS NULL
             ORDER BY m.rowid LIMIT ${Math.max(1, Math.trunc(batch))}`,
        )
        .all(cursor) as { id: number; hash: string }[];
    const pending = db.prepare(
        `SELECT s.position AS position, s.domain AS domain, s.selector AS selector
         FROM signatures s LEFT JOIN body_explanations b ON b.hash = s.hash AND b.position = s.position
         WHERE s.hash = ? AND s.verdict = 'body-altered' AND b.hash IS NULL ORDER BY s.position`,
    );

    let own = true;
    try {
        db.exec('BEGIN');
    } catch {
        own = false;
    }
    try {
        for (const message of messages) {
            const rows = pending.all(message.hash) as unknown as SignatureRow[];
            let raw: Uint8Array | undefined;
            try {
                raw = new Uint8Array(readFileSync(rawPath(paths, message.hash)));
            } catch {
                raw = undefined;
            }
            const fields = raw === undefined ? undefined : parseHeaderFields(splitMessage(raw).header);
            for (const row of rows) {
                if (raw === undefined || fields === undefined) {
                    putRow(db, message.hash, row.position, NO_ARTEFACT, 0);
                } else {
                    putRow(
                        db,
                        message.hash,
                        row.position,
                        explainFromRaw(raw, fields, row),
                        toBits(analyseBodyHeaders(fields, row.domain)),
                    );
                }
            }
        }
        const last = messages[messages.length - 1];
        if (last) setMeta(db, 'body_explanations_cursor', String(last.id));
        else setMeta(db, 'body_explanations_done', '1');
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
    return { done: messages.length === 0, processed: messages.length };
}

/** Run {@link backfillBodyExplanations} to the end — for the report. */
export function backfillBodyExplanationsAll(
    db: DatabaseSync,
    paths: CasePaths,
    onProgress?: (processed: number) => void,
): void {
    let total = 0;
    for (;;) {
        const step = backfillBodyExplanations(db, paths);
        total += step.processed;
        if (step.processed > 0) onProgress?.(total);
        if (step.done) return;
    }
}

/** The body-altered messages, explained and not, counted over MESSAGES. */
export interface BodyExplanationTotals {
    /** Messages whose current verdict is body-altered and that the cache covers. */
    readonly examined: number;
    /** Messages explained by an export artefact, per artefact (one artefact per message). */
    readonly explained: Readonly<Record<string, number>>;
    /** The rest: no artefact brings the signed hash back. */
    readonly unexplained: number;
    /** Of the unexplained: Exchange/TNEF markers present. The groups overlap. */
    readonly exchange: number;
    /** Of the unexplained: the receiving server recorded no `dkim=pass` for the signing domain. */
    readonly noReceiverPass: number;
}

/** One aggregate query over the cache, joined with the current verdicts. */
export function bodyExplanationTotals(db: DatabaseSync): BodyExplanationTotals {
    if (!hasTable(db)) return { examined: 0, explained: {}, unexplained: 0, exchange: 0, noReceiverPass: 0 };
    const rows = db
        .prepare(
            `SELECT g.artefact AS artefact, count(*) AS n, SUM(g.exchange) AS exchange, SUM(g.nopass) AS nopass
             FROM (
                 SELECT b.hash AS hash,
                        COALESCE(MIN(CASE WHEN b.artefact != '${NO_ARTEFACT}' THEN b.artefact END), '${NO_ARTEFACT}') AS artefact,
                        MAX((b.flags & ${EXCHANGE}) != 0) AS exchange,
                        MAX((b.flags & ${EXAMINED}) != 0 AND (b.flags & ${RECEIVER_PASS}) = 0) AS nopass
                 FROM body_explanations b JOIN messages m ON m.hash = b.hash
                 WHERE m.verdict = 'body-altered'
                 GROUP BY b.hash
             ) g GROUP BY g.artefact`,
        )
        .all() as { artefact: string; n: number; exchange: number | null; nopass: number | null }[];
    let examined = 0;
    let unexplained = 0;
    let exchange = 0;
    let noReceiverPass = 0;
    const explained: Record<string, number> = {};
    for (const row of rows) {
        const n = Number(row.n);
        examined += n;
        if (row.artefact === NO_ARTEFACT) {
            unexplained = n;
            exchange = Number(row.exchange ?? 0);
            noReceiverPass = Number(row.nopass ?? 0);
        } else {
            explained[row.artefact] = n;
        }
    }
    return { examined, explained, unexplained, exchange, noReceiverPass };
}
