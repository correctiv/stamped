/**
 * The folder list: the archives this case was imported from.
 *
 * "Folders" in a mail client are the sender's own filing; here they are the FILES the case came
 * out of, because that is the division a journalist works in — this mbox from one source, that
 * Maildir from another. The provenance lives in the import log and nowhere else (see
 * `eachLogEntry` in `@stamped/store`), so the list is read from there rather than from the index.
 */

import { fmt, _, _n } from '@stamped/core';
import { sourceMailboxes, type LogSource } from '@stamped/store';

import { mailboxLabel } from '../../lib/mailbox.ts';
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

/**
 * A path as the header bar says it: the home directory written as `~`.
 *
 * PLAIN TEXT, like {@link baseName} — `Adw.WindowTitle` parses no markup. The abbreviation is the
 * one every file manager and shell makes, and it is here because the subtitle is the line that
 * says WHICH archive is open: `/home/someone/Cases/Harbour Leak` wraps out of the header bar and
 * reads as a system path, where `~/Cases/Harbour Leak` reads as a folder the person chose. A
 * screenshot showed the other end of it, a case under `mktemp -d` whose subtitle was
 * `/tmp/tmp.hT3kQa/case` — a path that tells a reader nothing about their own case.
 *
 * `home` is passed in rather than read from the environment, so these view models keep running on
 * both runtimes and the function stays testable without one.
 */
export function shortPath(path: string, home: string | undefined): string {
    const base = (home ?? '').replace(/\/+$/, '');
    if (base === '') return path;
    if (path === base) return '~';
    // The separator is part of the test: `/home/adamson` merely starts with `/home/ada`.
    return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** The row above the archive list: the filter cleared, and how much there is to filter. */
export interface AllSources {
    readonly title: string;
    readonly subtitle: string;
    readonly icon: string;
}

/**
 * The "all archives" row, which exists so there is always a way BACK out of a filter.
 *
 * It counts the archives rather than the messages: the message total is the one the middle pane's
 * own header carries (`filterSummary`), and a second total in a second place is a second thing to
 * keep true. What this row adds is how many sources the case was built from — the number that
 * says whether a filtered view is one of two or one of forty.
 */
export function allSources(sources: readonly LogSource[]): AllSources {
    return {
        title: escapeLine(_('All archives')),
        subtitle: escapeLine(
            fmt(_n('{count} archive imported', '{count} archives imported', sources.length), {
                count: groupDigits(sources.length),
            }),
        ),
        icon: 'folder-symbolic',
    };
}

/**
 * An mbox is one file holding many messages; a Maildir or a loose `.eml` is one message a file.
 *
 * `package-x-generic-symbolic` rather than the `mail-archive-symbolic` that was here: that name
 * is not in Adwaita, and an icon name the theme does not have draws nothing — see the note on
 * `verdictIcon`.
 */
function sourceIcon(kind: string): string {
    return kind === 'mbox' ? 'package-x-generic-symbolic' : 'mail-unread-symbolic';
}

export function sourceRows(sources: readonly LogSource[], grouped = false): SourceRow[] {
    return sources.map((source) => ({
        source: source.source,
        title: escapeLine(baseName(source.source)),
        subtitle: escapeLine(sourceLine(source, grouped)),
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
function sourceLine(source: LogSource, grouped: boolean): string {
    const read = fmt(_n('{count} message', '{count} messages', source.messages), {
        count: groupDigits(source.messages),
    });
    const line =
        source.duplicates === 0
            ? read
            : fmt(
                  _n(
                      '{read}, one of them already in the case',
                      '{read}, {duplicates} of them already in the case',
                      source.duplicates,
                  ),
                  { read, duplicates: groupDigits(source.duplicates) },
              );
    // A folder import's part files are all named the same way inside each mailbox
    // (`part-01.mbox`), so the row's title alone cannot tell two mailboxes apart. The mailbox
    // name is provenance from the import log (see `AGENTS.md`); prefixing it here is the only
    // place the sidebar can still say which mailbox a `part-01.mbox` row came out of.
    // Under its mailbox's own row the prefix would say the same thing twice.
    return source.mailbox === undefined || grouped
        ? line
        : fmt(_('{mailbox} — {line}'), { mailbox: source.mailbox, line });
}

/** A mailbox as the sidebar's row for it: selecting it shows everything out of its files. */
export interface MailboxRow {
    /** The name as the report spells it — `''` for the mail no mailbox could be named for. */
    readonly mailbox: string;
    readonly title: string;
    readonly subtitle: string;
    readonly messages: number;
    readonly icon: string;
    /** The files of it, which the row expands to. */
    readonly parts: readonly SourceRow[];
}

/**
 * The archives grouped under their mailboxes, or `undefined` when the import names none.
 *
 * A journalist thinks in mailboxes, not in `part-01.mbox`. The files stay reachable underneath
 * because "which file did this come from" is still provenance. The grouping is
 * {@link sourceMailboxes}, the rule the report and the mailbox scope use, so a row here selects
 * exactly the messages the overview counts for it. With no mailbox to name, the flat list of
 * archives is the honest view, and a lone "Unknown mailbox" row above it would add nothing.
 */
export function mailboxRows(sources: readonly LogSource[]): MailboxRow[] | undefined {
    const names = sourceMailboxes(sources);
    if (![...names.values()].some((name) => name !== '')) return undefined;
    const rows = sourceRows(sources, true);
    const grouped = new Map<string, SourceRow[]>();
    for (const row of rows) {
        const name = names.get(row.source) ?? '';
        const parts = grouped.get(name) ?? [];
        parts.push(row);
        grouped.set(name, parts);
    }
    return [...grouped]
        .map(([mailbox, parts]) => {
            const messages = parts.reduce((sum, part) => sum + part.messages, 0);
            return {
                mailbox,
                title: escapeLine(mailboxLabel(mailbox)),
                subtitle: escapeLine(
                    fmt(_('{messages} in {files}'), {
                        messages: fmt(_n('{count} message', '{count} messages', messages), {
                            count: groupDigits(messages),
                        }),
                        files: fmt(_n('{count} file', '{count} files', parts.length), {
                            count: groupDigits(parts.length),
                        }),
                    }),
                ),
                messages,
                icon: 'avatar-default-symbolic',
                parts,
            };
        })
        .sort(
            (a, b) =>
                Number(a.mailbox === '') - Number(b.mailbox === '') ||
                b.messages - a.messages ||
                a.mailbox.localeCompare(b.mailbox),
        );
}
