/**
 * The `receiver_anchors` table: for each signature that carries no proof of its own, whether the
 * RECEIVING server recorded `dkim=pass` for it, cached per (raw hash, signature position).
 *
 * A signature is "without proof of its own" when no published key could be used: `unverifiable`,
 * or `confirmed-with-caveats` through a `recovered-key`. The `Authentication-Results` line a
 * receiving server wrote at delivery time is a separate, weaker witness for those. It is NOT
 * signed, so it is a claim of the archive and an indicator, never a reason to lift the verdict.
 * That is why it is its own number and not a caveat.
 *
 * ADDITIVE, AND OUTSIDE `createSchema`, exactly like `body_explanations` (see
 * `body-explanations.ts`): a `SCHEMA_VERSION` bump drops the index. A row is a pure function of
 * the header block and {@link hasReceiverPass}, so only a change of that RULE can make it stale —
 * that is what {@link RECEIVER_ANCHOR_VERSION} is for. CHANGING THE RULE MEANS BUMPING IT.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { MessageFinding } from '@stamped/core';
import { type HeaderField, parseHeaderFields, splitMessage } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { rawPath } from './raw.ts';
import { statementFor } from './statements.ts';
import { readHeaderBlock } from './unsigned-headers.ts';

/** The version of the rule behind the cached rows. Bump it with {@link hasReceiverPass}. */
export const RECEIVER_ANCHOR_VERSION = 1;

/**
 * Does an `Authentication-Results` header record `dkim=pass` for this signing domain?
 *
 * The part has to name the domain itself (`header.d=` or `header.i=`, the latter as the domain or
 * as `user@domain`): a `dkim=pass` for a forwarder says nothing about this signature. Pure.
 */
export function hasReceiverPass(fields: readonly HeaderField[], domain: string): boolean {
    const wanted = domain.toLowerCase();
    return fields.some(
        (field) =>
            field.lower === 'authentication-results' &&
            field.value.split(';').some((part) => {
                if (!/\bdkim\s*=\s*pass\b/i.test(part)) return false;
                const identity = /header\.[di]\s*=\s*"?([^\s;"]+)/i.exec(part)?.[1]?.toLowerCase();
                return identity !== undefined && (identity === wanted || identity.endsWith(`@${wanted}`));
            }),
    );
}

/** The header was readable; without it the pass flag says nothing. */
const EXAMINED = 1;
const RECEIVER_PASS = 2;

function toBits(fields: readonly HeaderField[] | undefined, domain: string): number {
    if (fields === undefined) return 0;
    return EXAMINED | (hasReceiverPass(fields, domain) ? RECEIVER_PASS : 0);
}

/**
 * Does this signature of a message belong to the cache? The one rule, written once for the
 * importer and for reverify; {@link QUALIFYING} says the same for rows already in the index.
 */
function qualifies(finding: MessageFinding, verdict: string): boolean {
    return (
        verdict === 'unverifiable' ||
        (verdict === 'confirmed-with-caveats' && finding.caveats.includes('recovered-key'))
    );
}

/** The index-side form of {@link qualifies}; `s` is a signature row, `m` its message. */
const QUALIFYING = `(s.verdict = 'unverifiable' OR (s.verdict = 'confirmed-with-caveats' AND m.caveats LIKE '%"recovered-key"%'))`;

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

/** Create the table if missing. Best effort, like `ensureBodyExplanations`. */
export function ensureReceiverAnchors(db: DatabaseSync): void {
    try {
        if (!exists(db, 'receiver_anchors')) {
            db.exec(
                `CREATE TABLE receiver_anchors (
                    hash TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    flags INTEGER NOT NULL,
                    PRIMARY KEY (hash, position)
                )`,
            );
            // A new table is empty, so it is current by definition: otherwise the first backfill
            // would clear what the importer has just written.
            setMeta(db, 'receiver_anchors_version', String(RECEIVER_ANCHOR_VERSION));
        }
    } catch {
        // a busy database must not make the case unopenable
    }
    READY.delete(db);
}

function hasTable(db: DatabaseSync): boolean {
    let ready = READY.get(db);
    if (ready === undefined) {
        ready = exists(db, 'receiver_anchors');
        READY.set(db, ready);
    }
    return ready;
}

/** Forget the cached anchors of one message. */
export function deleteReceiverAnchors(db: DatabaseSync, hash: string): void {
    if (!hasTable(db)) return;
    statementFor(db, 'DELETE FROM receiver_anchors WHERE hash = ?').run(hash);
}

function putRow(db: DatabaseSync, hash: string, position: number, flags: number): void {
    statementFor(db, 'INSERT OR REPLACE INTO receiver_anchors (hash, position, flags) VALUES (?, ?, ?)').run(
        hash,
        position,
        flags,
    );
}

/**
 * Cache the anchor of every qualifying signature of one message, from the finding the verifier
 * has just produced and the bytes it was produced from. Called by the importer and by reverify.
 * Replaces what the hash had; a no-op without the table.
 */
export function writeReceiverAnchors(
    db: DatabaseSync,
    hash: string,
    finding: MessageFinding,
    raw: Uint8Array,
): void {
    if (!hasTable(db)) return;
    deleteReceiverAnchors(db, hash);
    let fields: HeaderField[] | undefined;
    for (const [position, found] of finding.signatures.entries()) {
        if (!qualifies(finding, found.verdict)) continue;
        fields ??= parseHeaderFields(splitMessage(raw).header);
        putRow(db, hash, position, toBits(fields, found.evidence.domain));
    }
}

function currentVersion(db: DatabaseSync): boolean {
    return metaValue(db, 'receiver_anchors_version') === String(RECEIVER_ANCHOR_VERSION);
}

/** Does the cache cover every qualifying signature that predates it, under the current rule? */
export function receiverAnchorsComplete(db: DatabaseSync): boolean {
    return hasTable(db) && currentVersion(db) && metaValue(db, 'receiver_anchors_done') === '1';
}

interface PendingRow {
    position: number;
    domain: string;
}

/**
 * Fill the cache for qualifying signatures that lack a current row, one batch of at most `batch`
 * MESSAGES (one header block is read per message, never more than one is in memory).
 *
 * Idempotent and resumable: a rowid cursor in `meta` says where it stopped, and a row is
 * replaced, never added. A different rule version clears the table and starts over. A header
 * that cannot be read gets flags 0, so the backfill never retries it.
 */
export function backfillReceiverAnchors(
    db: DatabaseSync,
    paths: CasePaths,
    batch = 500,
): { done: boolean; processed: number } {
    if (!hasTable(db)) return { done: false, processed: 0 };
    if (!currentVersion(db)) {
        db.exec('DELETE FROM receiver_anchors');
        setMeta(db, 'receiver_anchors_cursor', '0');
        setMeta(db, 'receiver_anchors_done', '0');
        setMeta(db, 'receiver_anchors_version', String(RECEIVER_ANCHOR_VERSION));
    }
    if (metaValue(db, 'receiver_anchors_done') === '1') return { done: true, processed: 0 };
    const cursor = Number(metaValue(db, 'receiver_anchors_cursor') ?? 0);
    const messages = db
        .prepare(
            `SELECT DISTINCT m.rowid AS id, m.hash AS hash
             FROM signatures s
             JOIN messages m ON m.hash = s.hash
             LEFT JOIN receiver_anchors r ON r.hash = s.hash AND r.position = s.position
             WHERE m.rowid > ? AND ${QUALIFYING} AND r.hash IS NULL
             ORDER BY m.rowid LIMIT ${Math.max(1, Math.trunc(batch))}`,
        )
        .all(cursor) as { id: number; hash: string }[];
    const pending = db.prepare(
        `SELECT s.position AS position, s.domain AS domain
         FROM signatures s
         JOIN messages m ON m.hash = s.hash
         LEFT JOIN receiver_anchors r ON r.hash = s.hash AND r.position = s.position
         WHERE s.hash = ? AND ${QUALIFYING} AND r.hash IS NULL ORDER BY s.position`,
    );

    let own = true;
    try {
        db.exec('BEGIN');
    } catch {
        own = false;
    }
    try {
        for (const message of messages) {
            const rows = pending.all(message.hash) as unknown as PendingRow[];
            let fields: readonly HeaderField[] | undefined;
            try {
                const block = readHeaderBlock(rawPath(paths, message.hash));
                fields = block === undefined ? undefined : parseHeaderFields(block);
            } catch {
                // an unreadable header means flags 0 for every signature, never a failed batch
                fields = undefined;
            }
            for (const row of rows) putRow(db, message.hash, row.position, toBits(fields, row.domain));
        }
        const last = messages[messages.length - 1];
        if (last) setMeta(db, 'receiver_anchors_cursor', String(last.id));
        else setMeta(db, 'receiver_anchors_done', '1');
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

/** Run {@link backfillReceiverAnchors} to the end — for the report. */
export function backfillReceiverAnchorsAll(
    db: DatabaseSync,
    paths: CasePaths,
    onProgress?: (processed: number) => void,
): void {
    let total = 0;
    for (;;) {
        const step = backfillReceiverAnchors(db, paths);
        total += step.processed;
        if (step.processed > 0) onProgress?.(total);
        // no progress and not done covers the absent table (ensure is best effort): looping
        // forever on it would hang the report; stopping makes the next run retry.
        if (step.done || step.processed === 0) return;
    }
}

/** One group of messages without proof of their own, and how many of them have an anchor. */
export interface ReceiverAnchorGroup {
    /** Messages in the group, anchored or not. */
    readonly messages: number;
    /** Of those, messages where the receiving server recorded `dkim=pass` for a signature. */
    readonly anchored: number;
}

/** A signing domain with anchored messages among its unverifiable ones. */
export interface ReceiverAnchorDomain {
    readonly domain: string;
    readonly messages: number;
    readonly anchored: number;
}

/**
 * The receiving server's witness, counted over MESSAGES. The two groups do not overlap:
 * `unverifiable` is the message verdict, `recoveredKey` is `confirmed-with-caveats` through a
 * recovered key. An indicator, never a verdict: the line is unsigned.
 */
export interface ReceiverAnchorTotals {
    readonly unverifiable: ReceiverAnchorGroup;
    readonly recoveredKey: ReceiverAnchorGroup;
    /** Signing domains of unverifiable signatures with at least one anchored message, most first. */
    readonly domains: readonly ReceiverAnchorDomain[];
}

const NO_GROUP: ReceiverAnchorGroup = { messages: 0, anchored: 0 };
const DOMAIN_LIMIT = 10;

function groupCount(db: DatabaseSync, kind: 'unverifiable' | 'recovered-key'): ReceiverAnchorGroup {
    // The signature must itself be of the group's kind: a message with one unverifiable and one
    // recovered-key signature is anchored only by the signature the group is about.
    const where =
        kind === 'unverifiable'
            ? `m.verdict = 'unverifiable' AND s.verdict = 'unverifiable'`
            : `m.verdict = 'confirmed-with-caveats' AND s.verdict = 'confirmed-with-caveats' AND m.caveats LIKE '%"recovered-key"%'`;
    const total = db
        .prepare(
            kind === 'unverifiable'
                ? `SELECT count(*) AS n FROM messages m WHERE m.verdict = 'unverifiable'`
                : `SELECT count(*) AS n FROM messages m
                   WHERE m.verdict = 'confirmed-with-caveats' AND m.caveats LIKE '%"recovered-key"%'`,
        )
        .get() as { n?: number } | undefined;
    const anchored = db
        .prepare(
            `SELECT count(DISTINCT r.hash) AS n
             FROM receiver_anchors r
             JOIN signatures s ON s.hash = r.hash AND s.position = r.position
             JOIN messages m ON m.hash = r.hash
             WHERE (r.flags & ${RECEIVER_PASS}) != 0 AND ${where}`,
        )
        .get() as { n?: number } | undefined;
    return { messages: Number(total?.n ?? 0), anchored: Number(anchored?.n ?? 0) };
}

/** A few aggregate queries over the cache, joined with the current verdicts. */
export function receiverAnchorTotals(db: DatabaseSync): ReceiverAnchorTotals {
    if (!hasTable(db)) return { unverifiable: NO_GROUP, recoveredKey: NO_GROUP, domains: [] };
    const domains = db
        .prepare(
            `SELECT s.domain AS domain,
                    count(DISTINCT s.hash) AS messages,
                    count(DISTINCT CASE WHEN (r.flags & ${RECEIVER_PASS}) != 0 THEN s.hash END) AS anchored
             FROM signatures s
             JOIN messages m ON m.hash = s.hash
             LEFT JOIN receiver_anchors r ON r.hash = s.hash AND r.position = s.position
             WHERE m.verdict = 'unverifiable' AND s.verdict = 'unverifiable'
             GROUP BY s.domain HAVING anchored > 0
             ORDER BY anchored DESC, messages DESC, s.domain LIMIT ${DOMAIN_LIMIT}`,
        )
        .all() as { domain: string; messages: number; anchored: number }[];
    return {
        unverifiable: groupCount(db, 'unverifiable'),
        recoveredKey: groupCount(db, 'recovered-key'),
        domains: domains.map((row) => ({
            domain: String(row.domain),
            messages: Number(row.messages),
            anchored: Number(row.anchored),
        })),
    };
}
