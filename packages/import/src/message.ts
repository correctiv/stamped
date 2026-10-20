/**
 * One message, reduced to the fields the index stores.
 *
 * This is the whole contract between reading an archive and searching it: everything the search
 * and the report can see about a message is in {@link IndexedMessage}, and it is derived from the
 * raw bytes by pure functions. Keeping it a plain data shape is what lets the index be rebuilt
 * from the raw store at any time — the store is the truth, the database is a cache of it.
 */

import { splitMessage } from './bytes.ts';
import { addressDomain, headerValue, joinedHeader, parseHeaderFields } from './headers.ts';
import { messageText } from './mime.ts';

/** What the index holds about one message, besides its verdict. */
export interface MessageSummary {
    /** `Message-ID`, as written, angle brackets and all. Absent when the message has none. */
    readonly messageId?: string;
    readonly from: string;
    readonly to: string;
    readonly cc: string;
    readonly subject: string;
    /** `Date` as the message wrote it — the sender's claim, kept verbatim. */
    readonly date: string;
    /** The same date as a sortable epoch in milliseconds, when it could be read. */
    readonly sentAt?: number;
    readonly inReplyTo: string;
    readonly references: string;
    /** The From domain, lowercased: how the report groups and how a search filters. */
    readonly fromDomain?: string;
    /** Every `text/*` part, decoded and joined. */
    readonly text: string;
}

/**
 * Summarise one message.
 *
 * Nothing here throws. An archive import that stops on a malformed message leaves the journalist
 * with a partial case folder and no sign of where it stopped — so a message this cannot read
 * becomes a summary of empty strings, which still gets stored, hashed, logged and counted.
 */
export function summarise(raw: Uint8Array): MessageSummary {
    const { header } = splitMessage(raw);
    const fields = parseHeaderFields(header);
    const from = joinedHeader(fields, 'from');
    const date = headerValue(fields, 'date') ?? '';
    return {
        messageId: headerValue(fields, 'message-id'),
        from,
        to: joinedHeader(fields, 'to'),
        cc: joinedHeader(fields, 'cc'),
        subject: headerValue(fields, 'subject') ?? '',
        date,
        sentAt: parseDate(date),
        inReplyTo: joinedHeader(fields, 'in-reply-to'),
        references: joinedHeader(fields, 'references'),
        fromDomain: addressDomain(from),
        text: messageText(raw),
    };
}

/**
 * A `Date` header as epoch milliseconds, or `undefined`.
 *
 * `Date.parse` handles RFC 5322 dates, and `undefined` for the rest is the honest answer: a date
 * nobody can read must not become "1970" in a sorted list, where it would look like a fact about
 * the message rather than a gap. The raw string stays alongside, so the unparseable date is still
 * visible and still searchable.
 */
export function parseDate(value: string): number | undefined {
    if (value.trim() === '') return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
