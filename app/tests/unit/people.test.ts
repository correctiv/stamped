/**
 * Personen and Zeitleiste: the address parser, the `addresses` table with its backfill, the two
 * queries over it, and the view models on top.
 *
 * Everything is synthetic — made-up addresses on `example.*` domains, built in a temporary index.
 * The assertions that matter: one address stays one person (never merged), the backfill is
 * idempotent and resumable, and a case without the table filled is incomplete, not wrong.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding, Verdict } from '@stamped/core';
import { encodeLatin1, parseAddressList, summarise } from '@stamped/import';
import {
    addressesComplete,
    backfillAddresses,
    backfillAll,
    bucketRange,
    casePaths,
    digest,
    type HashScope,
    indexMessage,
    openIndex,
    peopleList,
    periodScope,
    personScope,
    removeMessage,
    timeline,
} from '@stamped/store';

import { barSegments, isoDay, personRows, timelineNote, timelineRows } from '../../src/gui/view/people.ts';
import { filterBannerText } from '../../src/gui/view/overview.ts';

function withIndex(body: (db: DatabaseSync) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-people-'));
    try {
        const db = openIndex(casePaths(root));
        try {
            body(db);
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

interface Mail {
    readonly id: string;
    readonly from: string;
    readonly to?: string;
    readonly cc?: string;
    readonly date?: string;
    readonly verdict?: Verdict;
}

function put(db: DatabaseSync, mail: Mail): string {
    const lines = [`From: ${mail.from}`, `To: ${mail.to ?? 'nobody@example.org'}`];
    if (mail.cc) lines.push(`Cc: ${mail.cc}`);
    lines.push(`Subject: ${mail.id}`);
    if (mail.date) lines.push(`Date: ${mail.date}`);
    lines.push(`Message-ID: <${mail.id}@example.com>`, '', 'body', '');
    const raw = encodeLatin1(lines.join('\n'));
    const hash = digest(raw);
    indexMessage(db, {
        hash,
        bytes: raw.length,
        summary: summarise(raw),
        finding: finding(mail.verdict ?? 'confirmed'),
    });
    return hash;
}

/** The hashes of `candidates` a scope admits, sorted; its size must agree with what it admits. */
function admitted(scope: HashScope, candidates: readonly string[]): string[] {
    try {
        const members = candidates.filter((hash) => scope.has(hash)).sort();
        expect(scope.size).toBe(members.length);
        return members;
    } finally {
        scope.close();
    }
}

/** Wipe the table and its markers, as an index from before the table looks. */
function forgetAddresses(db: DatabaseSync): void {
    db.exec('DELETE FROM addresses');
    db.exec("DELETE FROM meta WHERE key LIKE 'addresses_%'");
}

export default async () => {
    await describe('parseAddressList', async () => {
        await it('lower-cases the address and keeps the name as written', async () => {
            expect(parseAddressList('"Ada L." <Ada@Example.COM>')).toStrictEqual([
                { address: 'ada@example.com', name: 'Ada L.' },
            ]);
        });

        await it('splits on commas outside quotes and brackets', async () => {
            expect(
                parseAddressList('"Lovelace, Ada" <ada@example.com>, bob@example.org (Bob)'),
            ).toStrictEqual([
                { address: 'ada@example.com', name: 'Lovelace, Ada' },
                { address: 'bob@example.org', name: 'Bob' },
            ]);
        });

        await it('drops what is not an address', async () => {
            expect(parseAddressList('undisclosed-recipients:;')).toStrictEqual([]);
            expect(parseAddressList('Just A Name')).toStrictEqual([]);
            expect(parseAddressList(undefined)).toStrictEqual([]);
            expect(parseAddressList('')).toStrictEqual([]);
        });

        await it('never merges two addresses', async () => {
            expect(parseAddressList('Ada <ada@a.example>, Ada <ada@b.example>')).toStrictEqual([
                { address: 'ada@a.example', name: 'Ada' },
                { address: 'ada@b.example', name: 'Ada' },
            ]);
        });
    });

    await describe('the addresses table', async () => {
        await it('is filled by indexMessage and emptied by removeMessage', async () => {
            withIndex((db) => {
                const hash = put(db, { id: 'one', from: 'Ada <ada@example.com>', to: 'bob@example.org' });
                expect(peopleList(db).map((person) => person.address)).toStrictEqual([
                    'ada@example.com',
                    'bob@example.org',
                ]);
                removeMessage(db, hash);
                expect(peopleList(db)).toStrictEqual([]);
            });
        });

        await it('counts a person on To and Cc of one message once', async () => {
            withIndex((db) => {
                put(db, { id: 'one', from: 'ada@example.com', to: 'bob@example.org', cc: 'bob@example.org' });
                const bob = peopleList(db).find((person) => person.address === 'bob@example.org');
                expect(bob?.messages).toBe(1);
                expect(bob?.received).toBe(1);
                expect(bob?.sent).toBe(0);
            });
        });

        await it('backfills an index that predates it, idempotently and in batches', async () => {
            withIndex((db) => {
                for (let n = 0; n < 5; n++)
                    put(db, { id: `m${n}`, from: 'ada@example.com', to: 'bob@example.org' });
                const before = peopleList(db);
                forgetAddresses(db);
                expect(addressesComplete(db)).toBe(false);
                expect(peopleList(db)).toStrictEqual([]);

                expect(backfillAddresses(db, 2)).toStrictEqual({ done: false, processed: 2 });
                expect(peopleList(db)[0]?.messages).toBe(2);
                backfillAll(db);
                expect(addressesComplete(db)).toBe(true);
                expect(peopleList(db)).toStrictEqual(before);

                // a second run changes nothing
                forgetAddresses(db);
                backfillAll(db);
                backfillAll(db);
                expect(peopleList(db)).toStrictEqual(before);
            });
        });

        await it('does not duplicate rows a new import already wrote during a backfill', async () => {
            withIndex((db) => {
                put(db, { id: 'old', from: 'ada@example.com' });
                forgetAddresses(db);
                backfillAddresses(db, 1);
                put(db, { id: 'new', from: 'ada@example.com' });
                backfillAll(db);
                expect(peopleList(db).find((person) => person.address === 'ada@example.com')?.messages).toBe(
                    2,
                );
            });
        });
    });

    await describe('peopleList', async () => {
        await it('ranks by mail count, then address, with sent, received, period, verdicts and names', async () => {
            withIndex((db) => {
                put(db, {
                    id: 'a',
                    from: 'Ada <ada@example.com>',
                    to: 'bob@example.org',
                    date: 'Tue, 05 Mar 2024 09:40:00 +0000',
                });
                put(db, {
                    id: 'b',
                    from: 'Ada Lovelace <ada@example.com>',
                    to: 'bob@example.org',
                    date: 'Wed, 06 Mar 2024 09:40:00 +0000',
                    verdict: 'body-altered',
                });
                put(db, { id: 'c', from: 'bob@example.org', to: 'ada@example.com' });
                const people = peopleList(db);
                expect(people.map((person) => person.address)).toStrictEqual([
                    'ada@example.com',
                    'bob@example.org',
                ]);
                const ada = people[0];
                expect(ada?.messages).toBe(3);
                expect(ada?.sent).toBe(2);
                expect(ada?.received).toBe(1);
                expect(ada?.earliest).toBe(Date.UTC(2024, 2, 5, 9, 40));
                expect(ada?.latest).toBe(Date.UTC(2024, 2, 6, 9, 40));
                expect(ada?.verdicts.find((entry) => entry.verdict === 'body-altered')?.messages).toBe(1);
                expect(ada?.verdicts.find((entry) => entry.verdict === 'confirmed')?.messages).toBe(2);
                expect(ada?.names.map((name) => name.name).sort()).toStrictEqual(['Ada', 'Ada Lovelace']);
            });
        });

        await it('searches name and address, and pages', async () => {
            withIndex((db) => {
                put(db, { id: 'a', from: 'Ada <ada@example.com>', to: 'bob@example.org' });
                put(db, { id: 'b', from: 'carol@example.net', to: 'bob@example.org' });
                expect(peopleList(db, { search: 'LOVE' })).toStrictEqual([]);
                expect(peopleList(db, { search: 'ada' }).map((person) => person.address)).toStrictEqual([
                    'ada@example.com',
                ]);
                expect(
                    peopleList(db, { search: 'example.net' }).map((person) => person.address),
                ).toStrictEqual(['carol@example.net']);
                expect(peopleList(db, { search: '%' })).toStrictEqual([]);
                expect(peopleList(db, { limit: 1 }).map((person) => person.address)).toStrictEqual([
                    'bob@example.org',
                ]);
                expect(peopleList(db, { limit: 1, offset: 1 }).map((person) => person.address)).toStrictEqual(
                    ['ada@example.com'],
                );
            });
        });
    });

    await describe('personScope', async () => {
        await it('holds the messages an address appears in, in any role', async () => {
            withIndex((db) => {
                const one = put(db, { id: 'a', from: 'ada@example.com', to: 'bob@example.org' });
                const two = put(db, { id: 'b', from: 'carol@example.net', to: 'ada@example.com' });
                const three = put(db, { id: 'c', from: 'carol@example.net', to: 'bob@example.org' });
                expect(admitted(personScope(db, ' ADA@example.com '), [one, two, three])).toStrictEqual(
                    [one, two].sort(),
                );
            });
        });
    });

    await describe('timeline', async () => {
        await it('buckets per month when the case is long, and counts undated apart', async () => {
            withIndex((db) => {
                put(db, { id: 'a', from: 'ada@example.com', date: 'Tue, 05 Mar 2024 09:40:00 +0000' });
                put(db, {
                    id: 'b',
                    from: 'ada@example.com',
                    date: 'Fri, 08 Mar 2024 09:40:00 +0000',
                    verdict: 'unverifiable',
                });
                put(db, { id: 'c', from: 'ada@example.com', date: 'Mon, 03 Jun 2024 09:40:00 +0000' });
                put(db, { id: 'd', from: 'ada@example.com' });
                const result = timeline(db);
                expect(result.unit).toBe('month');
                expect(result.undated).toBe(1);
                expect(result.buckets.map((bucket) => [bucket.key, bucket.messages])).toStrictEqual([
                    ['2024-03', 2],
                    ['2024-06', 1],
                ]);
                expect(
                    result.buckets[0]?.verdicts.find((entry) => entry.verdict === 'unverifiable')?.messages,
                ).toBe(1);
            });
        });

        await it('buckets per day when the case is short, and a unit can be forced', async () => {
            withIndex((db) => {
                put(db, { id: 'a', from: 'ada@example.com', date: 'Tue, 05 Mar 2024 09:40:00 +0000' });
                put(db, { id: 'b', from: 'ada@example.com', date: 'Wed, 06 Mar 2024 23:59:00 +0000' });
                expect(timeline(db).unit).toBe('day');
                expect(timeline(db).buckets.map((bucket) => bucket.key)).toStrictEqual([
                    '2024-03-05',
                    '2024-03-06',
                ]);
                expect(timeline(db, 'month').buckets.map((bucket) => bucket.key)).toStrictEqual(['2024-03']);
            });
        });
    });

    await describe('periodScope', async () => {
        await it('holds one bucket, the undated mail, and nothing for a bad key', async () => {
            withIndex((db) => {
                const march = put(db, {
                    id: 'a',
                    from: 'ada@example.com',
                    date: 'Tue, 05 Mar 2024 09:40:00 +0000',
                });
                const may = put(db, {
                    id: 'b',
                    from: 'ada@example.com',
                    date: 'Mon, 03 Jun 2024 09:40:00 +0000',
                });
                const none = put(db, { id: 'c', from: 'ada@example.com' });
                const all = [march, may, none];
                expect(admitted(periodScope(db, '2024-03'), all)).toStrictEqual([march]);
                expect(admitted(periodScope(db, '2024-06-03'), all)).toStrictEqual([may]);
                expect(admitted(periodScope(db, '2024-06-04'), all)).toStrictEqual([]);
                expect(admitted(periodScope(db, 'undated'), all)).toStrictEqual([none]);
                expect(admitted(periodScope(db, 'nonsense'), all)).toStrictEqual([]);
            });
        });

        await it('reads bucket keys as half-open UTC ranges', async () => {
            expect(bucketRange('2024-12')).toStrictEqual({
                from: Date.UTC(2024, 11, 1),
                to: Date.UTC(2025, 0, 1),
            });
            expect(bucketRange('2024-02-29')).toStrictEqual({
                from: Date.UTC(2024, 1, 29),
                to: Date.UTC(2024, 2, 1),
            });
            expect(bucketRange('2024-13')).toBe(undefined);
            expect(bucketRange('x')).toBe(undefined);
        });
    });

    await describe('the people and timeline views', async () => {
        await it('slices a bar in verdict order and drops zeroes', async () => {
            const segments = barSegments(
                [
                    { verdict: 'confirmed', messages: 3 },
                    { verdict: 'body-altered', messages: 1 },
                    { verdict: 'unverifiable', messages: 0 },
                ],
                4,
            );
            expect(segments.map((segment) => [segment.verdict, segment.share])).toStrictEqual([
                ['confirmed', 0.75],
                ['body-altered', 0.25],
            ]);
            expect(barSegments([{ verdict: 'confirmed', messages: 1 }], 0)).toStrictEqual([]);
        });

        await it('names a person by the most used name and filters to the address', async () => {
            withIndex((db) => {
                put(db, {
                    id: 'a',
                    from: 'Ada <ada@example.com>',
                    to: 'bob@example.org',
                    date: 'Tue, 05 Mar 2024 09:40:00 +0000',
                });
                const rows = personRows(peopleList(db));
                const ada = rows.find((row) => row.address === 'ada@example.com');
                expect(ada?.title).toBe('Ada');
                expect(ada?.filter).toStrictEqual({ scope: { kind: 'person', address: 'ada@example.com' } });
                expect(ada?.subtitle.includes('2024-03-05')).toBe(true);
                const bob = rows.find((row) => row.address === 'bob@example.org');
                expect(bob?.title).toBe('bob@example.org');
            });
        });

        await it('lists the timeline oldest first with the undated mail last', async () => {
            withIndex((db) => {
                put(db, { id: 'a', from: 'ada@example.com', date: 'Tue, 05 Mar 2024 09:40:00 +0000' });
                put(db, { id: 'b', from: 'ada@example.com', date: 'Tue, 05 Mar 2024 10:40:00 +0000' });
                put(db, { id: 'c', from: 'ada@example.com', date: 'Wed, 06 Mar 2024 10:40:00 +0000' });
                put(db, { id: 'd', from: 'ada@example.com' });
                const result = timeline(db);
                const rows = timelineRows(result);
                expect(rows.map((row) => row.key)).toStrictEqual(['2024-03-05', '2024-03-06', 'undated']);
                expect(rows.map((row) => row.share)).toStrictEqual([1, 0.5, 0]);
                expect(rows[2]?.filter).toStrictEqual({ scope: { kind: 'period', period: 'undated' } });
                expect(timelineNote(result).includes('1')).toBe(true);
            });
        });

        await it('formats an instant as a UTC day', async () => {
            expect(isoDay(Date.UTC(2019, 2, 4, 23, 59))).toBe('2019-03-04');
        });

        await it('words the banner for a person and a period', async () => {
            const person = filterBannerText({ kind: 'person', address: 'ada@example.com' });
            const period = filterBannerText({ kind: 'period', period: '2024-03' });
            expect(person.includes('ada@example.com')).toBe(true);
            expect(period.includes('2024-03')).toBe(true);
        });
    });
};
