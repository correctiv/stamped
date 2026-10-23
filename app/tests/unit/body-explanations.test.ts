/**
 * The `body_explanations` cache: the backfill explains from the raw files, resumes in batches,
 * refills on a version change, and the verify-time write agrees with it. Synthetic only.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    backfillBodyExplanations,
    backfillBodyExplanationsAll,
    BODY_EXPLANATION_VERSION,
    bodyExplanationsComplete,
    bodyExplanationTotals,
    type CasePaths,
    digest,
    indexMessage,
    openCase,
    openIndex,
    removeMessage,
    store,
    writeBodyExplanations,
} from '@stamped/store';

const BODY = 'hello\nworld\n';
const GOOD = createHash('sha256').update('hello\r\nworld\r\n').digest('base64');
const WRONG = createHash('sha256').update('something else\r\n').digest('base64');

function finding(domain: string, artefact?: string): MessageFinding {
    return {
        verdict: 'body-altered',
        caveats: [],
        signatures: [
            {
                verdict: 'body-altered',
                caveats: [],
                evidence: {
                    domain,
                    selector: 's1',
                    algorithm: 'rsa-sha256',
                    aligned: true,
                    exportArtefact: artefact,
                },
            },
        ],
    } as unknown as MessageFinding;
}

interface Sample {
    name: string;
    extra: string[];
    bh: string;
    signed: string;
}

const SAMPLES: Sample[] = [
    { name: 'explained', extra: ['X-MS-Exchange-Organization-Foo: 1'], bh: GOOD, signed: 'example.com' },
    {
        name: 'exchange',
        extra: [
            'X-MS-TNEF-Correlator: x',
            'Authentication-Results: mx.example.net; dkim=pass header.d=example.com',
        ],
        bh: WRONG,
        signed: 'example.com',
    },
    { name: 'nopass', extra: [], bh: WRONG, signed: 'example.com' },
    { name: 'mismatch', extra: [], bh: GOOD, signed: 'other.example.org' },
];

function withCase(body: (db: DatabaseSync, paths: CasePaths) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-bodyexp-'));
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
            `DKIM-Signature: v=1; a=rsa-sha256; c=simple/simple; d=example.com; s=s1; bh=${sample.bh}; b=AAAA`,
            ...sample.extra,
            'From: a@example.com',
            `Subject: m${i}`,
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            '',
            BODY,
        ].join('\n');
        const bytes = encodeLatin1(text);
        store(paths, bytes);
        const hash = digest(bytes);
        const found = finding(sample.signed === 'example.com' ? 'example.com' : 'other.example.org');
        indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: found });
        if (write) writeBodyExplanations(db, hash, found, bytes);
        return bytes;
    });
}

const EXPECTED = {
    examined: 4,
    explained: { 'line-endings': 1 },
    unexplained: 3,
    exchange: 1,
    noReceiverPass: 2,
};

function rowCount(db: DatabaseSync): number {
    return Number((db.prepare('SELECT count(*) AS n FROM body_explanations').get() as { n: number }).n);
}

export default async () => {
    await describe('body explanation cache', async () => {
        await it('backfills from the raw files and counts messages', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(bodyExplanationsComplete(db)).toBe(false);
                backfillBodyExplanationsAll(db, paths);
                expect(bodyExplanationsComplete(db)).toBe(true);
                expect(bodyExplanationTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('is resumable in small batches and idempotent', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                expect(backfillBodyExplanations(db, paths, 3)).toStrictEqual({ done: false, processed: 3 });
                expect(backfillBodyExplanations(db, paths, 3)).toStrictEqual({ done: false, processed: 1 });
                expect(backfillBodyExplanations(db, paths, 3)).toStrictEqual({ done: true, processed: 0 });
                expect(rowCount(db)).toBe(4);
                backfillBodyExplanationsAll(db, paths);
                expect(rowCount(db)).toBe(4);
                expect(bodyExplanationTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('records no artefact for a header that is not the row signature', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                backfillBodyExplanationsAll(db, paths);
                const row = db
                    .prepare(
                        `SELECT b.artefact AS artefact FROM body_explanations b
                         JOIN signatures s ON s.hash = b.hash AND s.position = b.position
                         WHERE s.domain = 'other.example.org'`,
                    )
                    .get() as { artefact: string };
                expect(row.artefact).toBe('none');
            });
        });

        await it('the verify-time write gives the same totals as the backfill', async () => {
            withCase((db, paths) => {
                const bytes = addAll(db, paths, false);
                // what the verifier recorded for the first message
                const first = bytes[0] as Uint8Array;
                writeBodyExplanations(db, digest(first), finding('example.com', 'line-endings'), first);
                for (const [i, raw] of bytes.entries()) {
                    if (i === 0) continue;
                    writeBodyExplanations(db, digest(raw), finding((SAMPLES[i] as Sample).signed), raw);
                }
                expect(bodyExplanationTotals(db)).toStrictEqual(EXPECTED);
            });
        });

        await it('removeMessage drops the rows', async () => {
            withCase((db, paths) => {
                const bytes = addAll(db, paths);
                backfillBodyExplanationsAll(db, paths);
                removeMessage(db, digest(bytes[0] as Uint8Array));
                expect(rowCount(db)).toBe(3);
            });
        });

        await it('refills when the rule version differs', async () => {
            withCase((db, paths) => {
                addAll(db, paths);
                backfillBodyExplanationsAll(db, paths);
                db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
                    'body_explanations_version',
                    String(BODY_EXPLANATION_VERSION + 1),
                );
                db.exec("UPDATE body_explanations SET artefact = 'none', flags = 0");
                expect(bodyExplanationsComplete(db)).toBe(false);
                backfillBodyExplanationsAll(db, paths);
                expect(bodyExplanationTotals(db)).toStrictEqual(EXPECTED);
            });
        });
    });
};
