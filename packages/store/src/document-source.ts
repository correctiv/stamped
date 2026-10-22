/**
 * The indexer's view of a case: which messages, in what order, and what text.
 *
 * The shapes are declared here, not imported from `@stamped/semantic`, which must stay free of
 * this package; TypeScript matches them structurally.
 *
 * ORDER is the browse order of the message list (newest `sent_at` first, undated last, hash as
 * the tie-break), so the walk is an index walk on `messages_browse` and the mail a journalist
 * sees first is searchable first. The cursor is a keyset, not an offset: a deep page stays cheap.
 *
 * TEXT comes from `raw/` through `summarise`, not from the FTS table: its `hash` column is
 * UNINDEXED, so a lookup by hash there is a scan of the whole table per page.
 */

import type { DatabaseSync } from 'node:sqlite';

import { summarise } from '@stamped/import';

import type { CasePaths } from './case.ts';
import { countMessages } from './index-db.ts';
import { readRaw } from './raw.ts';

export interface IndexSourceEntry {
    readonly hash: string;
    readonly sentAt?: number;
}

export interface IndexSourceDocument {
    readonly hash: string;
    readonly subject: string;
    readonly body: string;
}

export interface IndexDocumentSource {
    count(): number;
    next(after: IndexSourceEntry | undefined, limit: number): IndexSourceEntry[];
    read(hashes: readonly string[]): IndexSourceDocument[];
}

export function indexDocumentSource(db: DatabaseSync, paths: CasePaths): IndexDocumentSource {
    return {
        count: () => countMessages(db),
        next(after, limit) {
            const size = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));
            let where = '';
            let args: (string | number)[] = [];
            if (after !== undefined && after.sentAt !== undefined) {
                where = 'WHERE sent_at < ? OR (sent_at = ? AND hash > ?) OR sent_at IS NULL';
                args = [after.sentAt, after.sentAt, after.hash];
            } else if (after !== undefined) {
                where = 'WHERE sent_at IS NULL AND hash > ?';
                args = [after.hash];
            }
            const rows = db
                .prepare(
                    `SELECT hash, sent_at FROM messages ${where}
                     ORDER BY sent_at IS NULL, sent_at DESC, hash ASC LIMIT ${size}`,
                )
                .all(...args) as { hash: string; sent_at: number | null }[];
            return rows.map((row) => ({
                hash: String(row.hash),
                ...(row.sent_at === null || row.sent_at === undefined ? {} : { sentAt: Number(row.sent_at) }),
            }));
        },
        read(hashes) {
            const out: IndexSourceDocument[] = [];
            for (const hash of hashes) {
                const raw = readRaw(paths, hash);
                if (!raw) continue;
                const summary = summarise(raw);
                out.push({ hash, subject: summary.subject, body: summary.text });
            }
            return out;
        },
    };
}
