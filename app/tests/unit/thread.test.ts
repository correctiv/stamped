/**
 * The conversation of a message: arranged from `Message-ID`, `In-Reply-To` and `References`, and
 * found in the index without a table of its own. Synthetic only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import type { MessageFinding } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import {
    buildThread,
    casePaths,
    digest,
    indexMessage,
    messageIds,
    openIndex,
    threadOf,
    type ThreadEntry,
    type ThreadMessage,
} from '@stamped/store';

const UNSIGNED: MessageFinding = { verdict: 'unsigned', caveats: [], signatures: [] };

interface Mail {
    readonly id?: string;
    readonly subject?: string;
    readonly replyTo?: string;
    readonly references?: string;
    readonly date?: string;
}

function raw(mail: Mail): Uint8Array {
    const lines = ['From: Ada Lovelace <ada@example.com>', 'To: Grace Hopper <grace@example.net>'];
    lines.push(`Subject: ${mail.subject ?? 'Hello'}`);
    lines.push(`Date: ${mail.date ?? 'Tue, 05 Mar 2024 09:40:00 +0000'}`);
    if (mail.id !== undefined) lines.push(`Message-ID: ${mail.id}`);
    if (mail.replyTo !== undefined) lines.push(`In-Reply-To: ${mail.replyTo}`);
    if (mail.references !== undefined) lines.push(`References: ${mail.references}`);
    return encodeLatin1([...lines, '', `body of ${mail.id ?? mail.subject ?? 'x'}`, ''].join('\n'));
}

function withIndex(body: (db: DatabaseSync, put: (mail: Mail) => string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-thread-'));
    try {
        const db = openIndex(casePaths(root));
        try {
            body(db, (mail) => {
                const bytes = raw(mail);
                const hash = digest(bytes);
                indexMessage(db, { hash, bytes: bytes.length, summary: summarise(bytes), finding: UNSIGNED });
                return hash;
            });
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function message(
    hash: string,
    id: string | undefined,
    replyTo: string[],
    references: string[],
    sentAt?: number,
) {
    const result: ThreadMessage = {
        hash,
        ...(id === undefined ? {} : { messageId: id }),
        inReplyTo: replyTo,
        references,
        subject: `s-${hash}`,
        sender: 'ada@example.com',
        date: '',
        ...(sentAt === undefined ? {} : { sentAt }),
        verdict: 'unsigned',
    };
    return result;
}

/** `depth:hash-or-id` per entry, the shape an assertion can read at a glance. */
function shape(entries: readonly ThreadEntry[]): string[] {
    return entries.map(
        (entry) => `${entry.depth}:${entry.hash ?? entry.messageId}${entry.missing ? '!' : ''}`,
    );
}

export default async () => {
    await describe('messageIds', async () => {
        await it('takes every angle-bracketed id in order and nothing else', async () => {
            expect(messageIds('<a@x> <b@x>\n\t<c@x> junk')).toStrictEqual(['<a@x>', '<b@x>', '<c@x>']);
            expect(messageIds('')).toStrictEqual([]);
            expect(messageIds('no ids here')).toStrictEqual([]);
        });
    });

    await describe('buildThread', async () => {
        await it('lays a chain out in reply order', async () => {
            const entries = buildThread(
                [
                    message('c', '<c>', ['<b>'], ['<a>', '<b>'], 3),
                    message('a', '<a>', [], [], 1),
                    message('b', '<b>', ['<a>'], ['<a>'], 2),
                ],
                'b',
            );
            expect(shape(entries)).toStrictEqual(['0:a', '1:b', '2:c']);
            expect(entries.map((entry) => entry.focus)).toStrictEqual([false, true, false]);
        });

        await it('puts two replies side by side, oldest first', async () => {
            const entries = buildThread(
                [
                    message('a', '<a>', [], [], 1),
                    message('c', '<c>', ['<a>'], ['<a>'], 3),
                    message('b', '<b>', ['<a>'], ['<a>'], 2),
                ],
                'c',
            );
            expect(shape(entries)).toStrictEqual(['0:a', '1:b', '1:c']);
        });

        await it('shows a parent that is not in the archive as a missing entry', async () => {
            const entries = buildThread(
                [
                    message('b', '<b>', ['<gone>'], ['<gone>'], 2),
                    message('c', '<c>', ['<gone>'], ['<gone>'], 3),
                ],
                'b',
            );
            expect(shape(entries)).toStrictEqual(['0:<gone>!', '1:b', '1:c']);
            expect(entries[0]?.hash).toBe(undefined);
        });

        await it('keeps an ancestor named only in References as a missing link of the chain', async () => {
            const entries = buildThread([message('c', '<c>', ['<b>'], ['<a>', '<b>'], 3)], 'c');
            expect(shape(entries)).toStrictEqual(['0:<a>!', '1:<b>!', '2:c']);
        });

        await it('falls back on the last Reference when there is no In-Reply-To', async () => {
            const entries = buildThread(
                [message('a', '<a>', [], [], 1), message('b', '<b>', [], ['<a>'], 2)],
                'b',
            );
            expect(shape(entries)).toStrictEqual(['0:a', '1:b']);
        });

        await it('drops a link that would close a loop', async () => {
            const entries = buildThread(
                [message('a', '<a>', ['<b>'], ['<b>'], 1), message('b', '<b>', ['<a>'], ['<a>'], 2)],
                'a',
            );
            expect(entries.length).toBe(2);
            expect(entries.filter((entry) => entry.depth === 0).length).toBe(1);
        });

        await it('keeps a message that replies to itself as a root', async () => {
            const entries = buildThread([message('a', '<a>', ['<a>'], ['<a>'], 1)], 'a');
            expect(shape(entries)).toStrictEqual(['0:a']);
        });

        await it('gives a second copy of an id its own place instead of dropping it', async () => {
            const entries = buildThread(
                [
                    message('a1', '<a>', [], [], 1),
                    message('a2', '<a>', [], [], 2),
                    message('b', '<b>', ['<a>'], ['<a>'], 3),
                ],
                'a2',
            );
            expect(entries.map((entry) => entry.hash)).toStrictEqual(['a1', 'a2', 'b']);
            expect(entries.map((entry) => entry.depth)).toStrictEqual([0, 0, 1]);
            expect(entries.find((entry) => entry.focus)?.hash).toBe('a2');
        });

        await it('handles a message without an id', async () => {
            const entries = buildThread([message('n', undefined, ['<a>'], ['<a>'], 2)], 'n');
            expect(shape(entries)).toStrictEqual(['0:<a>!', '1:n']);
            expect(entries[1]?.messageId).toBe(undefined);
        });

        await it('returns nothing for a message that is not among those given', async () => {
            expect(buildThread([message('a', '<a>', [], [])], 'zzz')).toStrictEqual([]);
        });
    });

    await describe('threadOf', async () => {
        await it('finds ancestors and descendants through the index', async () => {
            withIndex((db, put) => {
                const a = put({
                    id: '<a@example.com>',
                    subject: 'Question',
                    date: 'Tue, 05 Mar 2024 09:00:00 +0000',
                });
                const b = put({
                    id: '<b@example.com>',
                    subject: 'Re: Question',
                    replyTo: '<a@example.com>',
                    references: '<a@example.com>',
                    date: 'Tue, 05 Mar 2024 10:00:00 +0000',
                });
                const c = put({
                    id: '<c@example.com>',
                    subject: 'Re: Re: Question',
                    replyTo: '<b@example.com>',
                    references: '<a@example.com> <b@example.com>',
                    date: 'Tue, 05 Mar 2024 11:00:00 +0000',
                });
                put({ id: '<other@example.com>', subject: 'Unrelated' });

                const thread = threadOf(db, b);
                expect(thread?.truncated).toBe(false);
                expect(thread?.entries.map((entry) => entry.hash)).toStrictEqual([a, b, c]);
                expect(thread?.entries.map((entry) => entry.depth)).toStrictEqual([0, 1, 2]);
                // The same conversation from either end.
                expect(threadOf(db, a)?.entries.map((entry) => entry.hash)).toStrictEqual([a, b, c]);
                expect(threadOf(db, c)?.entries.map((entry) => entry.hash)).toStrictEqual([a, b, c]);
            });
        });

        await it('reports an unknown parent as missing', async () => {
            withIndex((db, put) => {
                const b = put({
                    id: '<b@example.com>',
                    replyTo: '<gone@example.com>',
                    references: '<gone@example.com>',
                });
                const thread = threadOf(db, b);
                expect(shape(thread?.entries ?? [])).toStrictEqual(['0:<gone@example.com>!', `1:${b}`]);
            });
        });

        await it('does not group by subject', async () => {
            withIndex((db, put) => {
                const a = put({ id: '<a@example.com>', subject: 'Same subject' });
                put({ id: '<b@example.com>', subject: 'Same subject' });
                expect(threadOf(db, a)?.entries.length).toBe(1);
            });
        });

        await it('finds replies to an id that carries characters FTS5 treats as syntax', async () => {
            withIndex((db, put) => {
                const id = '<"quoted"-AND-(near)*+x@example.com>';
                const a = put({ id, subject: 'Odd id' });
                const b = put({ id: '<b@example.com>', replyTo: id, references: id });
                expect(threadOf(db, a)?.entries.map((entry) => entry.hash)).toStrictEqual([a, b]);
            });
        });

        await it('does not take a message whose reference only looks like the id', async () => {
            withIndex((db, put) => {
                const a = put({ id: '<abc@example.com>' });
                // Shares the token `abc` and `example` with the id, but names another message.
                put({
                    id: '<b@example.com>',
                    replyTo: '<abc@other.example>',
                    references: '<abc@other.example>',
                });
                expect(threadOf(db, a)?.entries.length).toBe(1);
            });
        });

        await it('survives a cycle in the stored headers', async () => {
            withIndex((db, put) => {
                const a = put({
                    id: '<a@example.com>',
                    replyTo: '<b@example.com>',
                    references: '<b@example.com>',
                });
                put({ id: '<b@example.com>', replyTo: '<a@example.com>', references: '<a@example.com>' });
                expect(threadOf(db, a)?.entries.length).toBe(2);
            });
        });

        await it('stops at its limit and says so', async () => {
            withIndex((db, put) => {
                let previous: string | undefined;
                let first = '';
                for (let i = 0; i < 12; i++) {
                    const id = `<m${i}@example.com>`;
                    const hash = put({
                        id,
                        date: `Tue, 05 Mar 2024 ${String(9 + (i % 12)).padStart(2, '0')}:00:00 +0000`,
                        ...(previous === undefined ? {} : { replyTo: previous, references: previous }),
                    });
                    if (i === 0) first = hash;
                    previous = id;
                }
                const thread = threadOf(db, first, 5);
                expect(thread?.truncated).toBe(true);
                expect(thread?.entries.filter((entry) => !entry.missing).length).toBe(5);
                expect(threadOf(db, first)?.truncated).toBe(false);
            });
        });

        await it('returns undefined for a hash the index does not hold', async () => {
            withIndex((db) => {
                expect(threadOf(db, 'f'.repeat(64))).toBe(undefined);
            });
        });

        await it('gives a message without an id a conversation of itself', async () => {
            withIndex((db, put) => {
                const a = put({ subject: 'No id' });
                const thread = threadOf(db, a);
                expect(shape(thread?.entries ?? [])).toStrictEqual([`0:${a}`]);
            });
        });
    });
};
