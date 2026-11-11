/**
 * The conversation group of the reader: one row per message of the thread the open message is
 * part of.
 *
 * A READING AID. The ids that link these messages are written by the sender, so the group says in
 * its own description that it orders the archive and proves nothing, and every row carries the
 * verdict of that message's own signatures. Strings are Pango-escaped like the rest of the view
 * layer.
 */

import { fmt, _, _n } from '@stamped/core';
import type { Verdict } from '@stamped/core';
import type { Thread, ThreadEntry } from '@stamped/store';

import { shortDate } from './format.ts';
import { escapeLine } from './markup.ts';
import { verdictLook } from './verdict.ts';

/** Deeper replies stop indenting: a long chain would push its text out of the column. */
export const MAX_INDENT = 6;

/** One row of the conversation. */
export interface ThreadRow {
    /** The message to open on activation; absent for an entry that is only referenced. */
    readonly hash?: string;
    readonly title: string;
    readonly subtitle: string;
    /** How many steps to indent, capped at {@link MAX_INDENT}. */
    readonly indent: number;
    readonly focus: boolean;
    readonly missing: boolean;
    readonly verdict?: Verdict;
    /** Two or three words for the badge; empty for a missing entry. */
    readonly badge: string;
    readonly cssClass: string;
}

export function threadRow(entry: ThreadEntry): ThreadRow {
    const indent = Math.min(entry.depth, MAX_INDENT);
    if (entry.missing || entry.verdict === undefined) {
        return {
            title: escapeLine(_('Replied to, but not in the archive')),
            subtitle: escapeLine(entry.messageId ?? ''),
            indent,
            focus: false,
            missing: true,
            badge: '',
            cssClass: '',
        };
    }
    const look = verdictLook(entry.verdict);
    const when = shortDate(entry.date, entry.sentAt);
    return {
        ...(entry.hash === undefined ? {} : { hash: entry.hash }),
        title: escapeLine(entry.subject || _('(no subject)')),
        subtitle: escapeLine(
            [entry.sender || _('(no sender)'), when].filter((part) => part !== '').join(' · '),
        ),
        indent,
        focus: entry.focus,
        missing: false,
        verdict: entry.verdict,
        badge: escapeLine(look.label),
        cssClass: look.cssClass,
    };
}

/** What the group shows. `undefined` when there is no conversation: a lone message has none. */
export interface ThreadGroup {
    readonly title: string;
    readonly description: string;
    readonly rows: readonly ThreadRow[];
}

export function threadGroup(thread: Thread | null | undefined): ThreadGroup | undefined {
    if (thread === null || thread === undefined || thread.entries.length < 2) return undefined;
    const present = thread.entries.filter((entry) => !entry.missing).length;
    const missing = thread.entries.length - present;
    const parts = [
        _(
            'This only orders the messages. The headers that link them are written by the sender, so a reply here proves nothing about who wrote it: each message keeps the verdict of its own signatures.',
        ),
    ];
    if (missing > 0) {
        parts.push(
            fmt(
                _n(
                    '{count} message is referred to but not in the archive.',
                    '{count} messages are referred to but not in the archive.',
                    missing,
                ),
                { count: missing },
            ),
        );
    }
    if (thread.truncated) parts.push(_('The conversation is longer than what is shown here.'));
    return {
        title: fmt(_n('Conversation, {count} message', 'Conversation, {count} messages', present), {
            count: present,
        }),
        description: escapeLine(parts.join(' ')),
        rows: thread.entries.map(threadRow),
    };
}
