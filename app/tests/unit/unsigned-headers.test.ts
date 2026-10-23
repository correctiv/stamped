/**
 * The `unsigned_headers` cache: the breakdown answers the same from the cache as from the raw
 * files, the backfill is resumable and idempotent, and a rule change refills it. Synthetic only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    backfillUnsignedHeaders,
    type CasePaths,
    digest,
    indexMessage,
    openCase,
    openIndex,
    removeMessage,
    store,
    UNSIGNED_ANALYSER_VERSION,
    unsignedBreakdown,
    unsignedHeadersComplete,
} from '@stamped/store';

const UNSIGNED: MessageFinding = { verdict: 'unsigned', caveats: [], signatures: [] };

const HEADERS: string[][] = [
    ['Received: from x', 'From: a@example.com'],
    ['From: b@example.com', 'X-Old-DKIM-Signature: v=1'],
    ['Received: from y', 'Authentication-Results: mx.example.net; dkim=pass header.d=example.com'],
    ['Received: from z', 'ARC-Message-Signature: i=1', 'From: c@example.com'],
    ['From: d@example.com'],
];

function withCase(body: (db: DatabaseSync, paths: CasePaths) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-unsigned-'));
    try {
        const paths = openCase(root);
        const db = openIndex(paths);
        try {
            body(db, paths);
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function addAll(db: DatabaseSync, paths: CasePaths): string[] {
    return HEADERS.map((lines, i) => {
        const bytes = encodeLatin1(
            `${lines.join('\n')}\nSubject: m${i}\nDate: Tue, 05 Mar 2024 09:40:00 +0000\n\nbody\n`,
        );
        store(paths, bytes);
        const hash = digest(bytes);
        indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: UNSIGNED });
        return hash;
    });
}

const EXPECTED = { examined: 5, neverTransported: 2, renamedSignature: 1, authResultsPass: 1, arcOnly: 1 };

function rowCount(db: DatabaseSync): number {
    return Number((db.prepare('SELECT count(*) AS n FROM unsigned_headers').get() as { n: number }).n);
}

export default async () => {
    await describe('unsigned header cache', async () => {
        await it('answers the breakdown from the cache', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(unsignedBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(unsignedBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(unsignedHeadersComplete(db)).toBe(true);
            });
        });

        await it('is incomplete until the backfill ran, and resumes in small batches', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(unsignedHeadersComplete(db)).toBe(false);
                expect(backfillUnsignedHeaders(db, paths, 2)).toStrictEqual({ done: false, processed: 2 });
                expect(unsignedHeadersComplete(db)).toBe(false);
                expect(backfillUnsignedHeaders(db, paths, 2)).toStrictEqual({ done: false, processed: 2 });
                expect(backfillUnsignedHeaders(db, paths, 2)).toStrictEqual({ done: false, processed: 1 });
                expect(backfillUnsignedHeaders(db, paths, 2)).toStrictEqual({ done: true, processed: 0 });
                expect(unsignedHeadersComplete(db)).toBe(true);
                expect(rowCount(db)).toBe(5);
                expect(unsignedBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(rowCount(db)).toBe(5);
            });
        });

        await it('removeMessage drops the row', async () => {
            withCase((db, paths) => {
                const hashes = addAll(db, paths);
                unsignedBreakdown(db, paths);
                removeMessage(db, hashes[0] as string);
                expect(rowCount(db)).toBe(4);
            });
        });

        await it('refills when the analyser version differs', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                unsignedBreakdown(db, paths);
                db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
                    'unsigned_headers_version',
                    String(UNSIGNED_ANALYSER_VERSION + 1),
                );
                db.exec('UPDATE unsigned_headers SET flags = 0');
                expect(unsignedHeadersComplete(db)).toBe(false);
                expect(unsignedBreakdown(db, paths)).toStrictEqual(EXPECTED);
                expect(unsignedHeadersComplete(db)).toBe(true);
            });
        });

        await it('does not count a message whose raw file is missing as examined', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                const bytes = encodeLatin1('From: gone@example.com\n\nx\n');
                indexMessage(db, {
                    hash: digest(bytes),
                    bytes: bytes.length,
                    summary: summarise(bytes),
                    finding: UNSIGNED,
                });
                const result = unsignedBreakdown(db, paths);
                expect(result.examined).toBe(5);
                expect(rowCount(db)).toBe(6);
            });
        });
    });
};
