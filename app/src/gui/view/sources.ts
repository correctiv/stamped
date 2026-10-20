/**
 * The folder list: the archives this case was imported from.
 *
 * "Folders" in a mail client are the sender's own filing; here they are the FILES the case came
 * out of, because that is the division a journalist works in — this mbox from one source, that
 * Maildir from another. The provenance lives in the import log and nowhere else (see
 * `eachLogEntry` in `@stamped/store`), so the list is read from there rather than from the index.
 */

import { fmt, _, _n } from '@stamped/core';
import type { LogSource } from '@stamped/store';

import { groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';

/** One imported archive as the sidebar shows it. */
export interface SourceRow {
    /** The path as the import saw it. Unescaped: it is also the filter key. */
    readonly source: string;
    /** The file name, which is what distinguishes two archives at a glance. */
    readonly title: string;
    /** How much mail came out of it, and how much of that was already in the case. */
    readonly subtitle: string;
    /** The full path, for the row's tooltip — two files can share a name. */
    readonly tooltip: string;
    readonly messages: number;
    readonly icon: string;
}

/** The last path segment, without pulling in `node:path` — these view models run on both runtimes. */
export function baseName(path: string): string {
    const trimmed = path.replace(/[/\\]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
    return name === '' ? path : name;
}

/** An mbox is one file holding many messages; a Maildir or a loose `.eml` is one message a file. */
function sourceIcon(kind: string): string {
    return kind === 'mbox' ? 'mail-archive-symbolic' : 'mail-unread-symbolic';
}

export function sourceRows(sources: readonly LogSource[]): SourceRow[] {
    return sources.map((source) => ({
        source: source.source,
        title: escapeLine(baseName(source.source)),
        subtitle: escapeLine(sourceLine(source)),
        tooltip: escapeLine(source.source),
        messages: source.messages,
        icon: sourceIcon(source.kind),
    }));
}

/**
 * `1 204 messages, 12 of them already in the case`.
 *
 * The duplicate count is shown rather than netted off, because the same mail arriving from two
 * archives is a fact about the archives: it says the two overlap, which is often how a leak's
 * provenance is reconstructed. A row that silently showed the net figure would hide it.
 */
function sourceLine(source: LogSource): string {
    const read = fmt(_n('{count} message', '{count} messages', source.messages), {
        count: groupDigits(source.messages),
    });
    if (source.duplicates === 0) return read;
    return fmt(
        _n(
            '{read}, one of them already in the case',
            '{read}, {duplicates} of them already in the case',
            source.duplicates,
        ),
        { read, duplicates: groupDigits(source.duplicates) },
    );
}
