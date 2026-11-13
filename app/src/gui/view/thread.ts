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
import type { MessageFinding, Verdict } from '@stamped/core';
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

/** The two headers that link a message to its parents; `h=` names them in lower case. */
const LINK_HEADERS = [
    { name: 'In-Reply-To', key: 'in-reply-to' },
    { name: 'References', key: 'references' },
] as const;

/**
 * Do the signatures that VERIFY cover the headers that link this message to its parents? Without
 * a verifying signature nothing is said: an unsigned or broken message has no signed link to
 * report, and the verdict card already says so. Pure, and only about `h=`: a header that is not
 * in it can be added or changed after signing.
 */
export function signedLinksNote(finding: MessageFinding | undefined): string | undefined {
    if (finding === undefined) return undefined;
    const verifying = finding.signatures.filter(
        (signature) => signature.verdict === 'confirmed' || signature.verdict === 'confirmed-with-caveats',
    );
    if (verifying.length === 0) return undefined;
    const covered = LINK_HEADERS.filter((header) =>
        verifying.some((signature) =>
            signature.evidence.signedHeaders.some((name) => name.toLowerCase() === header.key),
        ),
    ).map((header) => header.name);
    const [first, second] = LINK_HEADERS;
    if (covered.length === LINK_HEADERS.length) {
        return fmt(
            _(
                'A verifying signature covers {first} and {second}: the links to the parent messages were signed, not just claimed.',
            ),
            { first: first.name, second: second.name },
        );
    }
    if (covered.length === 1) {
        const other = LINK_HEADERS.find((header) => header.name !== covered[0]);
        return fmt(
            _('A verifying signature covers {signed}, but not {unsigned}: only that link was signed.'),
            { signed: covered[0] ?? '', unsigned: other?.name ?? '' },
        );
    }
    return fmt(
        _(
            'No verifying signature covers {first} or {second}: the links to the parent messages are only claimed.',
        ),
        { first: first.name, second: second.name },
    );
}

export function threadGroup(
    thread: Thread | null | undefined,
    finding?: MessageFinding,
): ThreadGroup | undefined {
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
    const signed = signedLinksNote(finding);
    if (signed !== undefined) parts.push(signed);
    if (thread.truncated) parts.push(_('The conversation is longer than what is shown here.'));
    return {
        title: fmt(_n('Conversation, {count} message', 'Conversation, {count} messages', present), {
            count: present,
        }),
        description: escapeLine(parts.join(' ')),
        rows: thread.entries.map(threadRow),
    };
}
