/**
 * The conversation a message belongs to, read off `Message-ID`, `In-Reply-To` and `References`.
 *
 * A READING AID, NOT EVIDENCE. Those headers are written by the sender: a forged message can name
 * a real one as its parent and so appear inside a real conversation. So the conversation only
 * orders what the archive holds — every message in it keeps the verdict of its own signatures —
 * and the one thing it does not do is group by similar subject, because that would be a guess.
 *
 * NOTHING IS STORED. The index already has the three headers per message; a thread is found
 * from them when a message is opened. The ids a message names are looked up in `messages`
 * (`message_id`, indexed) and the messages that name it in the FTS columns `in_reply_to` and
 * `refs`, whose tokens are exactly the ids' parts. A hit there is only a candidate: the ids are
 * compared exactly afterwards, so the tokenizer can only cost time, never add a message.
 *
 * A message that is referenced but not in the archive becomes a MISSING entry. In a leak that is
 * a finding of its own — "replied to, and the original is not here" — so it is shown, not hidden.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Verdict } from '@stamped/core';

import { statementFor } from './statements.ts';

/** The ids in a header value, in order: everything between `<` and `>`. */
export function messageIds(value: string): string[] {
    return value.match(/<[^<>\s]+>/g) ?? [];
}

/** What threading needs of one message. */
export interface ThreadMessage {
    readonly hash: string;
    readonly messageId?: string;
    readonly inReplyTo: readonly string[];
    readonly references: readonly string[];
    readonly subject: string;
    readonly sender: string;
    /** The `Date` header as written. */
    readonly date: string;
    readonly sentAt?: number;
    readonly verdict: Verdict;
}

/** One line of a conversation, in reading order. */
export interface ThreadEntry {
    /** The message in the archive; absent for a MISSING entry, one that is only referenced. */
    readonly hash?: string;
    /** The id the headers name it by; absent for a message that has none. */
    readonly messageId?: string;
    readonly depth: number;
    readonly missing: boolean;
    /** The message the reader opened this conversation from. */
    readonly focus: boolean;
    readonly subject: string;
    readonly sender: string;
    readonly date: string;
    readonly sentAt?: number;
    readonly verdict?: Verdict;
}

/** A conversation as found. `truncated` says the walk stopped at its limit. */
export interface Thread {
    readonly entries: readonly ThreadEntry[];
    readonly truncated: boolean;
}

interface Node {
    readonly key: string;
    readonly message?: ThreadMessage;
    parent?: string;
    readonly children: string[];
    /** Further messages carrying the same id: shown beside this one, taking no part in the links. */
    readonly copies: ThreadMessage[];
}

function byTime(a: Node, b: Node): number {
    const x = a.message?.sentAt;
    const y = b.message?.sentAt;
    if (x !== undefined && y !== undefined && x !== y) return x - y;
    if (x === undefined && y !== undefined) return 1;
    if (x !== undefined && y === undefined) return -1;
    return a.key.localeCompare(b.key);
}

/**
 * Arrange messages into the conversation `focus` is part of. Pure, so the rules — cycles, ids
 * nobody holds, one id on two messages — are tested without a case.
 *
 * Each message hangs under its `In-Reply-To` (the last id of `References` when it has none); the
 * rest of `References` chains the ancestors, so two replies to a message that is not in the
 * archive still sit under one missing entry. A link that would close a loop is dropped: a
 * conversation is a tree, and the headers are not trusted to make one.
 */
export function buildThread(messages: readonly ThreadMessage[], focus: string): ThreadEntry[] {
    const nodes = new Map<string, Node>();
    const keyOf = new Map<string, string>();
    for (const message of [...messages].sort((a, b) => a.hash.localeCompare(b.hash))) {
        const id = message.messageId;
        const holder = id === undefined ? undefined : nodes.get(id);
        if (holder !== undefined) {
            // A second copy of one id is a message of its own: it stays visible, but the replies
            // belong to the id, and the id has one place in the conversation.
            holder.copies.push(message);
            keyOf.set(message.hash, holder.key);
            continue;
        }
        const key = id ?? `hash:${message.hash}`;
        nodes.set(key, { key, message, children: [], copies: [] });
        keyOf.set(message.hash, key);
    }

    const ensure = (id: string): Node => {
        let node = nodes.get(id);
        if (node === undefined) {
            node = { key: id, children: [], copies: [] };
            nodes.set(id, node);
        }
        return node;
    };
    const isAncestor = (candidate: string, of: string): boolean => {
        let at: string | undefined = of;
        for (let steps = 0; at !== undefined && steps <= nodes.size; steps++) {
            if (at === candidate) return true;
            at = nodes.get(at)?.parent;
        }
        return false;
    };
    const link = (parentKey: string, childKey: string): void => {
        if (parentKey === childKey) return;
        const child = ensure(childKey);
        if (child.parent !== undefined) return;
        const parent = ensure(parentKey);
        if (isAncestor(childKey, parentKey)) return;
        child.parent = parentKey;
        parent.children.push(childKey);
    };

    const ordered = [...nodes.values()].sort(byTime);
    // First the direct reply links, so a message's own parent is never taken over by a chain
    // that another message's `References` happens to imply.
    for (const node of ordered) {
        const message = node.message;
        if (message === undefined) continue;
        const parentId = message.inReplyTo.at(-1) ?? message.references.at(-1);
        if (parentId !== undefined) link(parentId, node.key);
    }
    for (const node of ordered) {
        const chain = node.message?.references ?? [];
        for (let i = 0; i + 1 < chain.length; i++) {
            const a = chain[i];
            const b = chain[i + 1];
            if (a !== undefined && b !== undefined) link(a, b);
        }
    }

    const start = keyOf.get(focus);
    if (start === undefined) return [];
    let root = start;
    for (let steps = 0; steps <= nodes.size; steps++) {
        const up = nodes.get(root)?.parent;
        if (up === undefined) break;
        root = up;
    }

    const entries: ThreadEntry[] = [];
    const push = (message: ThreadMessage | undefined, key: string, depth: number): void => {
        const messageId = message === undefined ? key : message.messageId;
        entries.push({
            ...(message === undefined ? {} : { hash: message.hash }),
            ...(messageId === undefined ? {} : { messageId }),
            depth,
            missing: message === undefined,
            focus: message === undefined ? false : message.hash === focus,
            subject: message?.subject ?? '',
            sender: message?.sender ?? '',
            date: message?.date ?? '',
            ...(message?.sentAt === undefined ? {} : { sentAt: message.sentAt }),
            ...(message === undefined ? {} : { verdict: message.verdict }),
        });
    };
    const walk = (key: string, depth: number): void => {
        const node = nodes.get(key);
        if (node === undefined) return;
        push(node.message, key, depth);
        for (const copy of node.copies) push(copy, key, depth);
        const children = node.children
            .map((childKey) => nodes.get(childKey))
            .filter((child): child is Node => child !== undefined)
            .sort(byTime);
        for (const child of children) walk(child.key, depth + 1);
    };
    walk(root, 0);
    return entries;
}

interface Row {
    hash: string;
    message_id: string | null;
    subject: string;
    sender: string;
    date: string;
    sent_at: number | null;
    verdict: string;
    in_reply_to: string;
    refs: string;
}

const COLUMNS = 'hash, message_id, subject, sender, date, sent_at, verdict, in_reply_to, refs';

function toMessage(row: Row): ThreadMessage {
    const id = messageIds(row.message_id ?? '')[0];
    return {
        hash: row.hash,
        ...(id === undefined ? {} : { messageId: id }),
        inReplyTo: messageIds(row.in_reply_to),
        references: messageIds(row.refs),
        subject: row.subject,
        sender: row.sender,
        date: row.date,
        ...(row.sent_at === null ? {} : { sentAt: Number(row.sent_at) }),
        verdict: row.verdict as Verdict,
    };
}

/** How many messages one conversation may hold before the walk stops. */
export const THREAD_LIMIT = 300;

/**
 * The conversation of one message: everything reachable through the ids the headers name, up
 * to `limit` messages. `undefined` when the index has no such message.
 */
export function threadOf(db: DatabaseSync, hash: string, limit = THREAD_LIMIT): Thread | undefined {
    const start = statementFor(db, `SELECT ${COLUMNS} FROM messages WHERE hash = ?`).get(hash) as
        | Row
        | undefined;
    if (start === undefined) return undefined;

    const found = new Map<string, ThreadMessage>();
    const queue: string[] = [];
    const asked = new Set<string>();
    let truncated = false;
    const take = (row: Row): void => {
        if (found.has(row.hash)) return;
        if (found.size >= limit) {
            truncated = true;
            return;
        }
        const message = toMessage(row);
        found.set(row.hash, message);
        for (const id of [message.messageId, ...message.inReplyTo, ...message.references]) {
            if (id !== undefined && !asked.has(id)) {
                asked.add(id);
                queue.push(id);
            }
        }
    };
    take(start);

    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const held = statementFor(db, `SELECT ${COLUMNS} FROM messages WHERE message_id = ?`).all(
            id,
        ) as unknown as Row[];
        for (const row of held) take(row);
        for (const row of repliesTo(db, id)) take(row);
    }

    return { entries: buildThread([...found.values()], hash), truncated };
}

/** The messages whose `In-Reply-To` or `References` name `id`, compared exactly. */
function repliesTo(db: DatabaseSync, id: string): Row[] {
    const phrase = `"${id.slice(1, -1).replaceAll('"', '""')}"`;
    let candidates: { hash: string }[];
    try {
        candidates = statementFor(
            db,
            'SELECT hash FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1000',
        ).all(`{in_reply_to refs} : ${phrase}`) as { hash: string }[];
    } catch {
        // An id with no token in it is not a phrase FTS5 accepts; it names nothing to find.
        return [];
    }
    const rows: Row[] = [];
    for (const { hash } of candidates) {
        const row = statementFor(db, `SELECT ${COLUMNS} FROM messages WHERE hash = ?`).get(hash) as
            | Row
            | undefined;
        if (row === undefined) continue;
        if (messageIds(row.in_reply_to).includes(id) || messageIds(row.refs).includes(id)) rows.push(row);
    }
    return rows;
}
