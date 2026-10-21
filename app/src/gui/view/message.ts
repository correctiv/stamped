/**
 * The middle pane's rows, and the header block of the pane that reads one message.
 *
 * Every string here is already Pango-escaped (see [`markup.ts`](markup.ts)), because mail is full
 * of `<name@example.com>` and a dropped From line is the one failure this tool may not have.
 *
 * A row shows four things and no more: who, when, what about, and which verdict. The sentence
 * behind the verdict is one click away in the reader, never squeezed into the row — a list that
 * tried to summarise six verdicts in a row's worth of space would end up summarising them as
 * "ok" and "not ok", which is the distinction Stamped exists to refuse.
 */

import { fmt, _, _n } from '@stamped/core';
import type { IndexedMessage, SearchHit } from '@stamped/store';
import type { Verdict } from '@stamped/core';

import { formatBytes, groupDigits, shortDate, shortHash } from './format.ts';
import { escapeLine } from './markup.ts';
import { verdictLook } from './verdict.ts';

/** One row of the message list. */
export interface MessageRow {
    readonly hash: string;
    /** The subject, or a marked placeholder — never an empty row. */
    readonly title: string;
    /** `sender · 2019-03-04` */
    readonly subtitle: string;
    readonly verdict: Verdict;
    /** Two or three words for the badge at the end of the row. */
    readonly badge: string;
    readonly cssClass: string;
    readonly icon: string;
    /** The full finding, for the row's tooltip. */
    readonly tooltip: string;
}

/** The middle dot that separates sender from date. Escaped output, so a literal is safe. */
const SEPARATOR = ' · ';

export function messageRow(hit: SearchHit): MessageRow {
    const look = verdictLook(hit.verdict);
    return {
        hash: hit.hash,
        title: escapeLine(hit.subject || _('(no subject)')),
        subtitle: escapeLine((hit.from || _('(no sender)')) + SEPARATOR + shortDate(hit.date, hit.sentAt)),
        verdict: hit.verdict,
        badge: escapeLine(look.label),
        cssClass: look.cssClass,
        icon: look.icon,
        tooltip: escapeLine(look.sentence),
    };
}

export function messageRows(hits: readonly SearchHit[]): MessageRow[] {
    return hits.map(messageRow);
}

/** One header field of the message being read. */
export interface HeaderField {
    readonly label: string;
    readonly value: string;
    /** True for fields a reader may want to copy whole — the hash, the Message-ID. */
    readonly monospace: boolean;
    /**
     * The value as it would be pasted elsewhere: UNESCAPED, and the one string in this module
     * that is.
     *
     * A clipboard takes text, not markup, so a copy button fed from {@link HeaderField.value}
     * would put `&lt;` into the colleague's message where the reader saw `<`. Present only on
     * the fields with a copy button, so a row cannot offer one without a value to give it.
     */
    readonly copy?: string;
}

/**
 * The header block above the verdict card.
 *
 * `Date` is the raw header, not a reformatted one: in the pane that argues about what a message
 * says, the fields are quoted as they stand. `Cc` appears only when there is one, so an empty row
 * cannot be mistaken for "nobody was copied" when the field was simply absent.
 *
 * The hash is here because it is how this message is named everywhere else — in the CLI, in the
 * import log, in a note to a colleague.
 */
export function headerFields(message: IndexedMessage): HeaderField[] {
    const fields: HeaderField[] = [
        { label: _('From'), value: message.from || _('(none)'), monospace: false },
        { label: _('To'), value: message.to || _('(none)'), monospace: false },
    ];
    if (message.cc.trim() !== '') {
        fields.push({ label: _('Cc'), value: message.cc, monospace: false });
    }
    fields.push(
        { label: _('Subject'), value: message.subject || _('(none)'), monospace: false },
        { label: _('Date'), value: message.date || _('(none)'), monospace: false },
    );
    if (message.messageId) {
        fields.push({
            label: _('Message-ID'),
            value: message.messageId,
            monospace: true,
            copy: message.messageId,
        });
    }
    fields.push(
        { label: _('Size'), value: formatBytes(message.bytes), monospace: false },
        // Shortened for the row, WHOLE for the clipboard: twelve hex digits identify the message
        // in this case, and the other fifty-two are what a colleague needs to find the same one.
        { label: _('SHA-256'), value: shortHash(message.hash), monospace: true, copy: message.hash },
    );
    return fields.map((field) => ({
        label: escapeLine(field.label),
        value: escapeLine(field.value),
        monospace: field.monospace,
        ...(field.copy !== undefined ? { copy: field.copy } : {}),
    }));
}

/**
 * The header block of a raw message: everything before the first empty line.
 *
 * PLAIN TEXT, not markup, and the one function here that is — it fills a `Gtk.TextView` buffer,
 * which takes no markup, so escaping it would put a literal `&lt;` in front of every address.
 * The split is on the first empty line because that is what RFC 5322 § 2.1 says separates the
 * header section from the body; a message with no empty line at all is all header, which is also
 * what the verifier sees.
 *
 * CRLF is normalised to LF for display only. The bytes on disk keep their line endings — they
 * are what the body hash was computed over.
 */
export function rawHeaders(text: string): string {
    const normalised = text.replace(/\r\n/g, '\n');
    const end = normalised.indexOf('\n\n');
    return end < 0 ? normalised.replace(/\n+$/, '') : normalised.slice(0, end);
}

/** What the middle pane says when it has nothing to show. */
export interface EmptyList {
    readonly title: string;
    readonly description: string;
    readonly icon: string;
}

/**
 * The empty state, which always names how many messages the case holds.
 *
 * ZERO RESULTS IS THE DANGEROUS ANSWER in this tool: it reads as "the mail is not in the leak".
 * So an empty list says what was searched and how big the haystack was, exactly as `stamped
 * search` prints the case size when it finds nothing. An empty case then says it is empty instead
 * of implying an answer about the archive.
 */
export function emptyList(total: number, query?: string): EmptyList {
    if (total === 0) {
        return {
            title: escapeLine(_('No messages in this case')),
            description: escapeLine(_('Import a mailbox or a folder of messages to begin.')),
            icon: 'folder-open-symbolic',
        };
    }
    const haystack = fmt(_n('The case holds {total} message.', 'The case holds {total} messages.', total), {
        total: groupDigits(total),
    });
    if (query && query.trim() !== '') {
        return {
            title: escapeLine(_('No match')),
            description: escapeLine(`${haystack} ${_('Nothing in it matches this search.')}`),
            icon: 'system-search-symbolic',
        };
    }
    return {
        title: escapeLine(_('Nothing in this view')),
        description: escapeLine(`${haystack} ${_('No message has the verdict you filtered for.')}`),
        // Adwaita has no filter icon at all; `view-conceal-symbolic` says what happened here —
        // the mail is in the case and this view is hiding it. A name the theme lacks would draw
        // nothing, which is how `view-filter-symbolic` left this page blank.
        icon: 'view-conceal-symbolic',
    };
}
