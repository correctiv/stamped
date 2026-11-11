/**
 * The `receiver_anchors` cache: the receiving server's `dkim=pass` for signatures without proof of
 * their own. The backfill reads the header blocks, resumes in batches, refills on a version
 * change, and the verify-time write agrees with it. Synthetic only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import { encodeLatin1, parseHeaderFields, summarise } from '@stamped/import';
import {
    backfillReceiverAnchors,
    backfillReceiverAnchorsAll,
    type CasePaths,
    digest,
    hasReceiverPass,
    indexMessage,
    openCase,
    openIndex,
    RECEIVER_ANCHOR_VERSION,
    receiverAnchorsComplete,
    receiverAnchorTotals,
    removeMessage,
    store,
    writeReceiverAnchors,
} from '@stamped/store';

function finding(
    verdict: 'unverifiable' | 'confirmed-with-caveats' | 'confirmed',
    caveats: string[],
): MessageFinding {
    return {
        verdict,
        caveats,
        signatures: [
            {
                verdict,
                caveats,
                evidence: { domain: 'example.com', selector: 's1', algorithm: 'rsa-sha256', aligned: true },
            },
        ],
    } as unknown as MessageFinding;
}

interface Sample {
    name: string;
    extra: string[];
    found: MessageFinding;
}

const PASS = 'Authentication-Results: mx.example.net; dkim=pass header.d=example.com';

const SAMPLES: Sample[] = [
    { name: 'unverifiable, anchored', extra: [PASS], found: finding('unverifiable', []) },
    {
        name: 'unverifiable, pass names a forwarder',
        extra: ['Authentication-Results: mx.example.net; dkim=pass header.d=lists.example.org'],
        found: finding('unverifiable', []),
    },
    { name: 'unverifiable, no record', extra: [], found: finding('unverifiable', []) },
    {
        name: 'recovered key, anchored',
        extra: [PASS],
        found: finding('confirmed-with-caveats', ['recovered-key']),
    },
    {
        name: 'other caveat, anchored',
        extra: [PASS],
        found: finding('confirmed-with-caveats', ['rsa-sha1']),
    },
    { name: 'confirmed, anchored', extra: [PASS], found: finding('confirmed', []) },
];

const EXPECTED = {
    unverifiable: { messages: 3, anchored: 1 },
    recoveredKey: { messages: 1, anchored: 1 },
    domains: [{ domain: 'example.com', messages: 3, anchored: 1 }],
};
/** Three unverifiable signatures and one recovered-key signature: the others never qualify. */
const ROWS = 4;

function withCase(body: (db: DatabaseSync, paths: CasePaths) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-anchors-'));
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

function addAll(db: DatabaseSync, paths: CasePaths, write = false): Uint8Array[] {
    return SAMPLES.map((sample, i) => {
        const text = [
            'DKIM-Signature: v=1; a=rsa-sha256; c=simple/simple; d=example.com; s=s1; bh=AAAA; b=AAAA',
            ...sample.extra,
            'From: a@example.com',
            `Subject: m${i}`,
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            '',
            'hello',
            '',
        ].join('\n');
        const bytes = encodeLatin1(text);
        store(paths, bytes);
        const hash = digest(bytes);
        indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: sample.found });
        if (write) writeReceiverAnchors(db, hash, sample.found, bytes);
        return bytes;
    });
}

function rowCount(db: DatabaseSync): number {
    return Number((db.prepare('SELECT count(*) AS n FROM receiver_anchors').get() as { n: number }).n);
}

function fields(lines: string[]) {
    return parseHeaderFields(encodeLatin1(`${lines.join('\n')}\n`));
}

export default async () => {
    await describe('receiver pass rule', async () => {
        await it('accepts a pass that names the signing domain', async () => {
            expect(hasReceiverPass(fields([PASS]), 'example.com')).toBe(true);
            expect(hasReceiverPass(fields([PASS]), 'EXAMPLE.com')).toBe(true);
        });
        await it('accepts header.i as user@domain', async () => {
            const line = 'Authentication-Results: mx.example.net; dkim=pass header.i=@example.com';
            expect(hasReceiverPass(fields([line]), 'example.com')).toBe(true);
        });
        await it('rejects a pass for another domain', async () => {
            const line = 'Authentication-Results: mx.example.net; dkim=pass header.d=lists.example.org';
            expect(hasReceiverPass(fields([line]), 'example.com')).toBe(false);
        });
        await it('rejects a failure and a missing record', async () => {
            const line = 'Authentication-Results: mx.example.net; dkim=fail header.d=example.com';
            expect(hasReceiverPass(fields([line]), 'example.com')).toBe(false);
            expect(hasReceiverPass(fields(['From: a@example.com']), 'example.com')).toBe(false);
        });
        await it('does not match a domain that only ends alike', async () => {
            const line = 'Authentication-Results: mx.example.net; dkim=pass header.d=notexample.com';
            expect(hasReceiverPass(fields([line]), 'example.com')).toBe(false);
        });
    });

    await describe('receiver anchor cache', async () => {
        await it('backfills from the header blocks and counts messages', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(receiverAnchorsComplete(db)).toBe(false);
                backfillReceiverAnchorsAll(db, paths);
                expect(receiverAnchorsComplete(db)).toBe(true);
                expect(receiverAnchorTotals(db)).toStrictEqual(EXPECTED);
                expect(rowCount(db)).toBe(ROWS);
            });
        });

        await it('is resumable in small batches and idempotent', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(backfillReceiverAnchors(db, paths, 3)).toStrictEqual({ done: false, processed: 3 });
                expect(backfillReceiverAnchors(db, paths, 3)).toStrictEqual({ done: false, processed: 1 });
                expect(backfillReceiverAnchors(db, paths, 3)).toStrictEqual({ done: true, processed: 0 });
                expect(rowCount(db)).toBe(ROWS);
                backfillReceiverAnchorsAll(db, paths);
                backfillReceiverAnchorsAll(db, paths);
                expect(rowCount(db)).toBe(ROWS);
                expect(receiverAnchorTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('the verify-time write gives the same totals as the backfill', async () => {
            withCase((db, paths) => {
                addAll(db, paths, true);
                expect(rowCount(db)).toBe(ROWS);
                expect(receiverAnchorTotals(db)).toStrictEqual(EXPECTED);
                backfillReceiverAnchorsAll(db, paths);
                expect(rowCount(db)).toBe(ROWS);
                expect(receiverAnchorTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('removeMessage drops the rows', async () => {
            withCase((db, paths) => {
                const bytes = addAll(db, paths);
                backfillReceiverAnchorsAll(db, paths);
                removeMessage(db, digest(bytes[0] as Uint8Array));
                expect(rowCount(db)).toBe(ROWS - 1);
            });
        });

        await it('refills when the rule version differs', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                backfillReceiverAnchorsAll(db, paths);
                db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
                    'receiver_anchors_version',
                    String(RECEIVER_ANCHOR_VERSION + 1),
                );
                db.exec('UPDATE receiver_anchors SET flags = 0');
                expect(receiverAnchorsComplete(db)).toBe(false);
                backfillReceiverAnchorsAll(db, paths);
                expect(receiverAnchorTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('stops for a missing table instead of looping', async () => {
            withCase((db, paths) => {
                db.exec('DROP TABLE receiver_anchors');
                const step = backfillReceiverAnchors(db, paths);
                expect(step.processed).toStrictEqual(0);
                expect(step.done).toBe(false);
                backfillReceiverAnchorsAll(db, paths);
                expect(receiverAnchorTotals(db).unverifiable.messages).toStrictEqual(0);
            });
        });
    });
};
