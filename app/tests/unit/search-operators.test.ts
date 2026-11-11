/**
 * The search operators against a real index: the words, the filters, the order, and the way a
 * query written the old way keeps working. Synthetic only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding, Verdict } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    casePaths,
    digest,
    hashScope,
    indexMessage,
    narrowedBy,
    openIndex,
    parseSearch,
    searchHits,
    SearchSyntaxError,
} from '@stamped/store';

interface Mail {
    readonly subject: string;
    readonly body?: string;
    readonly from?: string;
    readonly to?: string;
    readonly date?: string;
    readonly verdict?: Verdict;
}

function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

function raw(mail: Mail): Uint8Array {
    const lines = [
        `From: ${mail.from ?? 'Ada Lovelace <ada@example.com>'}`,
        `To: ${mail.to ?? 'Grace Hopper <grace@example.net>'}`,
        `Subject: ${mail.subject}`,
        ...(mail.date === undefined ? [] : [`Date: ${mail.date}`]),
        `Message-ID: <${mail.subject.replace(/\W+/g, '-').toLowerCase()}@example.com>`,
        '',
        mail.body ?? `body of ${mail.subject}`,
        '',
    ];
    return encodeLatin1(lines.join('\n'));
}

function withIndex(body: (db: DatabaseSync, put: (mail: Mail) => string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-operators-'));
    try {
        const db = openIndex(casePaths(root));
        try {
            body(db, (mail) => {
                const bytes = raw(mail);
                const hash = digest(bytes);
                indexMessage(db, {
                    hash,
                    bytes: bytes.length,
                    summary: summarise(bytes),
                    finding: finding(mail.verdict ?? 'unsigned'),
                });
                return hash;
            });
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function subjects(db: DatabaseSync, query: string, options = {}): string[] {
    return searchHits(db, query, { limit: 50, ...options }).map((hit) => hit.subject);
}

export default async () => {
    await describe('search operators', async () => {
        await it('searches one field with from:, to: and subject:', async () => {
            withIndex((db, put) => {
                put({
                    subject: 'Harbour plan',
                    from: 'Ada <ada@example.com>',
                    to: 'Grace <grace@example.net>',
                });
                put({ subject: 'Lunch', from: 'Grace <grace@example.net>', to: 'Ada <ada@example.com>' });
                expect(subjects(db, 'from:ada')).toStrictEqual(['Harbour plan']);
                expect(subjects(db, 'to:ada')).toStrictEqual(['Lunch']);
                expect(subjects(db, 'subject:lunch')).toStrictEqual(['Lunch']);
                expect(subjects(db, 'subject:ada')).toStrictEqual([]);
            });
        });

        await it('excludes a word with - and NOT', async () => {
            withIndex((db, put) => {
                put({ subject: 'Harbour plan', body: 'the harbour plan' });
                put({ subject: 'Harbour draft', body: 'the harbour plan, draft' });
                expect(subjects(db, 'harbour -draft')).toStrictEqual(['Harbour plan']);
                expect(subjects(db, 'harbour NOT draft')).toStrictEqual(['Harbour plan']);
                expect(subjects(db, 'harbour -draft -plan')).toStrictEqual([]);
            });
        });

        await it('combines with AND, OR and parentheses', async () => {
            withIndex((db, put) => {
                put({ subject: 'One', from: 'Ada <ada@example.com>', body: 'alpha' });
                put({ subject: 'Two', from: 'Grace <grace@example.net>', body: 'beta' });
                put({ subject: 'Three', from: 'Ada <ada@example.com>', body: 'beta' });
                expect(subjects(db, 'from:ada beta')).toStrictEqual(['Three']);
                expect(subjects(db, 'from:ada AND beta')).toStrictEqual(['Three']);
                expect(subjects(db, 'from:grace OR body:alpha').sort()).toStrictEqual(['One', 'Two']);
                expect(subjects(db, '(alpha OR beta) from:ada').sort()).toStrictEqual(['One', 'Three']);
            });
        });

        await it('matches a prefix and a phrase exactly', async () => {
            withIndex((db, put) => {
                put({ subject: 'Harbour plan', body: 'the harbour authority' });
                put({ subject: 'Harbourside', body: 'authority of the harbour' });
                expect(subjects(db, 'subject:harbour*').sort()).toStrictEqual([
                    'Harbour plan',
                    'Harbourside',
                ]);
                expect(subjects(db, 'subject:harbour').sort()).toStrictEqual(['Harbour plan']);
                expect(subjects(db, 'body:"harbour authority"')).toStrictEqual(['Harbour plan']);
                expect(subjects(db, 'body:"authority harbour"')).toStrictEqual([]);
            });
        });

        await it('treats a value as text and never as FTS5 syntax', async () => {
            withIndex((db, put) => {
                put({ subject: 'Plain', body: 'alpha beta' });
                // A quoted star is a character FTS5 drops, never a prefix: "alph" is not a word of the body.
                expect(subjects(db, 'body:"alph*" from:ada')).toStrictEqual([]);
                expect(subjects(db, 'body:NEAR from:ada')).toStrictEqual([]);
                expect(subjects(db, 'body:alpha from:ada')).toStrictEqual(['Plain']);
            });
        });

        await it('filters by verdict and dkim: alike', async () => {
            withIndex((db, put) => {
                put({ subject: 'Signed', verdict: 'confirmed', body: 'harbour' });
                put({ subject: 'Altered', verdict: 'body-altered', body: 'harbour' });
                expect(subjects(db, 'harbour verdict:body-altered')).toStrictEqual(['Altered']);
                expect(subjects(db, 'harbour dkim:confirmed')).toStrictEqual(['Signed']);
                expect(subjects(db, 'verdict:body-altered')).toStrictEqual(['Altered']);
            });
        });

        await it('finds nothing, and does not widen, when the list and the query ask for different verdicts', async () => {
            withIndex((db, put) => {
                put({ subject: 'Signed', verdict: 'confirmed', body: 'harbour' });
                expect(subjects(db, 'harbour verdict:body-altered', { verdict: 'confirmed' })).toStrictEqual(
                    [],
                );
                expect(subjects(db, 'harbour verdict:confirmed', { verdict: 'confirmed' })).toStrictEqual([
                    'Signed',
                ]);
                expect(narrowedBy({ verdict: 'unsigned' }, { verdict: 'confirmed' })).toBe(undefined);
            });
        });

        await it('filters by date: after is on or after, before is strictly before, in UTC', async () => {
            withIndex((db, put) => {
                put({ subject: 'February', date: 'Thu, 29 Feb 2024 23:59:59 +0000', body: 'harbour' });
                put({ subject: 'March first', date: 'Fri, 01 Mar 2024 00:00:00 +0000', body: 'harbour' });
                put({ subject: 'March last', date: 'Sun, 31 Mar 2024 12:00:00 +0000', body: 'harbour' });
                put({ subject: 'April', date: 'Mon, 01 Apr 2024 00:00:00 +0000', body: 'harbour' });
                put({ subject: 'No date', body: 'harbour' });
                expect(subjects(db, 'harbour after:2024-03 before:2024-04').sort()).toStrictEqual([
                    'March first',
                    'March last',
                ]);
                expect(subjects(db, 'harbour after:2024-03-01').includes('February')).toBe(false);
                expect(subjects(db, 'harbour before:2024-03-01')).toStrictEqual(['February']);
                // A message without a readable date is never inside a window.
                expect(subjects(db, 'harbour after:2000').includes('No date')).toBe(false);
                expect(subjects(db, 'after:2024-03 before:2024-04').sort()).toStrictEqual([
                    'March first',
                    'March last',
                ]);
            });
        });

        await it('sorts by date, undated last', async () => {
            withIndex((db, put) => {
                put({ subject: 'Middle', date: 'Fri, 01 Mar 2024 00:00:00 +0000', body: 'harbour' });
                put({ subject: 'Oldest', date: 'Thu, 01 Feb 2024 00:00:00 +0000', body: 'harbour' });
                put({ subject: 'Newest', date: 'Mon, 01 Apr 2024 00:00:00 +0000', body: 'harbour' });
                put({ subject: 'Undated', body: 'harbour' });
                expect(subjects(db, 'harbour sort:newest')).toStrictEqual([
                    'Newest',
                    'Middle',
                    'Oldest',
                    'Undated',
                ]);
                expect(subjects(db, 'harbour sort:oldest')).toStrictEqual([
                    'Oldest',
                    'Middle',
                    'Newest',
                    'Undated',
                ]);
                expect(subjects(db, 'harbour sort:newest', { limit: 2 })).toStrictEqual(['Newest', 'Middle']);
                expect(subjects(db, 'sort:oldest')).toStrictEqual(['Oldest', 'Middle', 'Newest', 'Undated']);
            });
        });

        await it('lists the newest first for a query of filters alone', async () => {
            withIndex((db, put) => {
                put({ subject: 'Older', date: 'Thu, 01 Feb 2024 00:00:00 +0000', verdict: 'confirmed' });
                put({ subject: 'Newer', date: 'Mon, 01 Apr 2024 00:00:00 +0000', verdict: 'confirmed' });
                put({ subject: 'Other', date: 'Mon, 01 Apr 2024 00:00:00 +0000', verdict: 'unsigned' });
                expect(subjects(db, 'verdict:confirmed')).toStrictEqual(['Newer', 'Older']);
            });
        });

        await it('narrows to the mailbox the caller resolved', async () => {
            withIndex((db, put) => {
                const one = put({ subject: 'In the mailbox', body: 'harbour' });
                put({ subject: 'Elsewhere', body: 'harbour' });
                const mailbox = hashScope(db, new Set([one]));
                try {
                    expect(subjects(db, 'harbour mailbox:ada', { mailbox })).toStrictEqual([
                        'In the mailbox',
                    ]);
                    expect(subjects(db, 'mailbox:ada', { mailbox })).toStrictEqual(['In the mailbox']);
                } finally {
                    mailbox.close();
                }
            });
        });

        await it('refuses a mailbox: that nobody resolved', async () => {
            withIndex((db, put) => {
                put({ subject: 'One', body: 'harbour' });
                let thrown: unknown;
                try {
                    searchHits(db, 'harbour mailbox:ada');
                } catch (error) {
                    thrown = error;
                }
                expect(thrown instanceof SearchSyntaxError).toBe(true);
            });
        });

        await it('throws a SearchSyntaxError for a mistake in the operators', async () => {
            withIndex((db, put) => {
                put({ subject: 'One', body: 'harbour' });
                for (const query of ['from:', 'verdict:nonsense', '-harbour', 'after:2024-02-31']) {
                    let thrown: unknown;
                    try {
                        searchHits(db, query);
                    } catch (error) {
                        thrown = error;
                    }
                    expect([query, thrown instanceof SearchSyntaxError]).toStrictEqual([query, true]);
                }
            });
        });

        await it('keeps a query written the old way exactly as it was', async () => {
            withIndex((db, put) => {
                put({ subject: 'Invoice', body: 'harbour contract', from: 'Chef <chef@firma.de>' });
                put({ subject: 'Lunch', body: 'sandwich' });
                expect(subjects(db, 'subject : invoice')).toStrictEqual(['Invoice']);
                expect(subjects(db, 'harbour AND contract')).toStrictEqual(['Invoice']);
                expect(subjects(db, '"harbour contract"')).toStrictEqual(['Invoice']);
                // FTS5 rejects an address; the literal fallback still finds it.
                expect(subjects(db, 'chef@firma.de')).toStrictEqual(['Invoice']);
                expect(parseSearch('subject : invoice').raw).toBe(true);
            });
        });
    });
};
