/**
 * The PDF report's numbers: mailbox derivation, the cluster flag, anonymised names, the unsigned
 * header rules, and a smoke test of the document itself (GJS only — Cairo is not on Node).
 *
 * Every message here is synthetic. The cluster rows are fed by hand so the thresholds are tested
 * without importing thousands of mails.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding, Verdict } from '@stamped/core';
import { encodeLatin1, parseHeaderFields, summarise } from '@stamped/import';
import {
    analyseUnsignedHeaders,
    appendLog,
    caseReport,
    digest,
    domainsByVerdict,
    indexMessage,
    mailboxOf,
    openCase,
    openIndex,
    periodBreakdown,
    rawSetDigest,
    type CaseReport,
} from '@stamped/store';

import {
    buildPdfModel,
    CLUSTER_MIN_MESSAGES,
    clusterRows,
    keyProvenance,
    type PdfReportInput,
} from '../../src/lib/pdf-report-model.ts';

function raw(subject: string): Uint8Array {
    return encodeLatin1(
        [
            'From: Ada <ada@example.com>',
            'To: Grace <grace@example.net>',
            `Subject: ${subject}`,
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            '',
            'body',
            '',
        ].join('\n'),
    );
}

function finding(verdict: Verdict, domain: string): MessageFinding {
    return {
        verdict,
        caveats: [],
        signatures: [
            {
                verdict,
                caveats: [],
                evidence: {
                    domain,
                    selector: 'sel',
                    algorithm: 'rsa-sha256',
                    canonicalization: 'relaxed/relaxed',
                    signedHeaders: ['from'],
                    bodyHashOk: verdict !== 'body-altered',
                    signatureOk: verdict === 'confirmed',
                    authorDomain: domain,
                    aligned: true,
                    keyBits: 2048,
                    keySource: 'operator',
                },
            },
        ],
    };
}

function fields(lines: string[]) {
    return parseHeaderFields(encodeLatin1(`${lines.join('\r\n')}\r\n\r\n`));
}

export default async () => {
    await describe('mailboxOf', async () => {
        await it('prefers the log field', async () => {
            expect(mailboxOf({ mailbox: 'ada@example.com', source: '/x/y/part-01.mbox' })).toBe(
                'ada@example.com',
            );
        });
        await it('falls back to the parent folder', async () => {
            expect(mailboxOf({ source: '/leak/ada@example.com/part-01.mbox' })).toBe('ada@example.com');
        });
        await it('skips the Maildir sub-folder', async () => {
            expect(mailboxOf({ source: '/leak/Inbox/cur/1700000000.eml' })).toBe('Inbox');
        });
        await it('names nothing it cannot see', async () => {
            expect(mailboxOf({ source: 'one.eml' })).toBe('');
        });
    });

    await describe('cluster rows', async () => {
        const period = (mailbox: string, year: number, messages: number, altered: number) => ({
            mailbox,
            year,
            messages,
            bodyAltered: altered,
            headersAltered: 0,
        });

        await it('flags a large, three-times-average row only', async () => {
            const rows = clusterRows(
                [
                    period('a', 2020, CLUSTER_MIN_MESSAGES, 300),
                    period('a', 2021, CLUSTER_MIN_MESSAGES, 100),
                    period('b', 2020, CLUSTER_MIN_MESSAGES - 1, 400),
                ],
                0.1,
                false,
            );
            expect(rows.map((r) => r.flagged)).toStrictEqual([true, false, false]);
        });

        await it('flags nothing when the case has no altered mail', async () => {
            const rows = clusterRows([period('a', 2020, 1000, 0)], 0, false);
            expect(rows[0]?.flagged).toBe(false);
        });

        await it('anonymises by size, stably', async () => {
            const rows = clusterRows(
                [period('small@example.com', 2020, 10, 0), period('big@example.com', 2020, 90, 0)],
                0,
                true,
            );
            expect(rows.map((r) => r.mailbox)).toStrictEqual(['M1', 'M2']);
            expect(rows.map((r) => r.messages)).toStrictEqual([90, 10]);
        });
    });

    await describe('unsigned header rules', async () => {
        await it('reads the four flags', async () => {
            const flags = analyseUnsignedHeaders(
                fields([
                    'From: a@example.com',
                    'X-Old-DKIM-Signature: v=1',
                    'Authentication-Results: mx.example.net; dkim=pass header.d=example.com',
                    'ARC-Message-Signature: i=1',
                ]),
            );
            expect(flags).toStrictEqual({
                neverTransported: true,
                renamedSignature: true,
                authResultsPass: true,
                arcOnly: true,
            });
        });
        await it('reports a clean transported message as none', async () => {
            const flags = analyseUnsignedHeaders(fields(['Received: from x', 'From: a@example.com']));
            expect(flags).toStrictEqual({
                neverTransported: false,
                renamedSignature: false,
                authResultsPass: false,
                arcOnly: false,
            });
        });
    });

    await describe('key provenance', async () => {
        await it('counts key mismatches and unauthenticated hashes apart', async () => {
            const report = {
                reasons: [
                    { reason: 'no-key', messages: 5 },
                    { reason: 'key-mismatch', messages: 3 },
                ],
                caveats: [{ caveat: 'body-hash-unauthenticated', messages: 2 }],
                missing: [],
            } as unknown as CaseReport;
            const p = keyProvenance([], report);
            expect(p.messagesWithoutKey).toBe(5);
            expect(p.messagesKeyMismatch).toBe(3);
            expect(p.messagesUnauthenticatedHash).toBe(2);
            expect(p.messagesExpired).toBe(0);
        });
    });

    await describe('the case aggregation', async () => {
        await it('counts per mailbox and year, and digests the set', async () => {
            const root = mkdtempSync(join(tmpdir(), 'stamped-pdf-'));
            try {
                const paths = openCase(root);
                const db = openIndex(paths);
                try {
                    const specs: [string, Verdict, string][] = [
                        ['one', 'body-altered', '/leak/ada@example.com/part-01.mbox'],
                        ['two', 'confirmed', '/leak/ada@example.com/part-01.mbox'],
                        ['three', 'headers-altered', '/leak/grace@example.net/part-01.mbox'],
                    ];
                    const entries = specs.map(([subject, verdict, source]) => {
                        const bytes = raw(subject);
                        const hash = digest(bytes);
                        indexMessage(db, {
                            hash,
                            bytes: bytes.length,
                            summary: summarise(bytes),
                            finding: finding(verdict, 'example.com'),
                        });
                        return {
                            hash,
                            source,
                            offset: 0,
                            kind: 'mbox',
                            bytes: bytes.length,
                            at: '2024-01-01T00:00:00Z',
                            duplicate: false,
                        };
                    });
                    appendLog(paths, entries);

                    const rows = periodBreakdown(db, paths);
                    const ada = rows.find((r) => r.mailbox === 'ada@example.com');
                    expect(ada?.year).toBe(2024);
                    expect(ada?.messages).toBe(2);
                    expect(ada?.bodyAltered).toBe(1);
                    const grace = rows.find((r) => r.mailbox === 'grace@example.net');
                    expect(grace?.headersAltered).toBe(1);

                    const first = rawSetDigest(db);
                    expect(first.messages).toBe(3);
                    expect(first.sha256.length).toBe(64);
                    expect(rawSetDigest(db).sha256).toBe(first.sha256);

                    const domains = domainsByVerdict(db, 15);
                    expect(domains.find((d) => d.verdict === 'confirmed')?.domains[0]?.domain).toBe(
                        'example.com',
                    );

                    const input: PdfReportInput = {
                        caseName: 'synthetic',
                        checkedAt: new Date('2026-01-02T00:00:00Z'),
                        version: '0.0.0',
                        report: caseReport(db, { paths }),
                        periods: rows,
                        domains,
                        digest: first,
                        keys: [],
                        anonymizeMailboxes: true,
                    };
                    const model = buildPdfModel(input);
                    expect(model.checkedAt).toBe('2026-01-02');
                    expect(model.verdicts.length).toBe(6);
                    expect(model.clusters.every((c) => /^M\d+$/.test(c.mailbox ?? ''))).toBe(true);
                    expect(JSON.stringify(model).includes('example.net')).toBe(false);

                    // Cairo exists on GJS only; on Node the model is all there is to check.
                    if (
                        (globalThis as { imports?: { cairo?: { PDFSurface?: unknown } } }).imports?.cairo
                            ?.PDFSurface !== undefined
                    ) {
                        const { renderPdfReport } = await import('../../src/lib/pdf-report.ts');
                        const file = join(root, 'report.pdf');
                        const { pages } = await renderPdfReport(model, file);
                        expect(existsSync(file)).toBe(true);
                        const bytes = readFileSync(file);
                        expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
                        expect(pages > 1).toBe(true);
                    }
                } finally {
                    db.close();
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
