/**
 * The sidebar's list of marks: the bookmarks, and one row per tag the person has used.
 *
 * Kept as data for the same reason the other sidebar lists are: which rows appear, in which
 * order and with which scope behind them is what a test can hold, and the widget only draws it.
 */

import { _ } from '@stamped/core';
import type { MarksSummary } from '@stamped/store';

import type { ScopeRef } from '../../lib/queries.ts';

/** One row of the marks list. */
export interface MarkRow {
    /** Unescaped: a tag is the person's own text, and `Adw.ActionRow` escapes its title itself. */
    readonly title: string;
    readonly count: number;
    readonly icon: string;
    /** The scope the list is narrowed to when the row is chosen. */
    readonly scope: ScopeRef;
}

/** The rows for a summary: bookmarks first, when any, then the tags most used first. */
export function markRows(summary: MarksSummary): MarkRow[] {
    const rows: MarkRow[] = [];
    if (summary.bookmarks > 0) {
        rows.push({
            title: _('Bookmarks'),
            count: summary.bookmarks,
            icon: 'starred-symbolic',
            scope: { kind: 'bookmarks' },
        });
    }
    for (const { tag, count } of summary.tags) {
        rows.push({ title: tag, count, icon: 'user-bookmarks-symbolic', scope: { kind: 'tag', tag } });
    }
    return rows;
}

/**
 * How many characters of a tag a chip in a message row shows.
 *
 * A tag may be as long as `MAX_TAG_LENGTH` (64 characters) and a list row is three or four words
 * wide, so the text is cut HERE, in data, rather than by an ellipsizing label: two labels that
 * ellipsize inside one box shrink together, and the layout prototype for this came out with both
 * chips reading "au…" whenever the subject beside them was long. Cutting the text instead leaves
 * every chip its natural width, and the chip's tooltip carries the tag whole.
 */
export const MAX_CHIP_LENGTH = 18;

/** How many chips one row shows before the remaining tags are only counted. */
export const MAX_CHIPS = 3;

/** The tag chips of one row: the labels as they are drawn, and how many tags they leave out. */
export interface TagChips {
    /** Unescaped, like {@link MarkRow.title}: a chip is a plain label, not markup. */
    readonly labels: readonly string[];
    /** Tags beyond {@link MAX_CHIPS}, shown as `+N`; 0 when every tag fits. */
    readonly hidden: number;
}

/**
 * One chip's text: at most `max` characters, the last one an ellipsis when it had to be cut.
 *
 * Counted in code points, not UTF-16 units — a tag written in emoji or outside the BMP would
 * otherwise be cut through the middle of a character and draw as a replacement glyph.
 */
export function chipLabel(tag: string, max: number = MAX_CHIP_LENGTH): string {
    const points = [...tag];
    if (points.length <= max) return tag;
    return `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** The chips for a message's tags, in the order the person's marks file holds them. */
export function tagChips(
    tags: readonly string[],
    max: number = MAX_CHIPS,
    maxLength: number = MAX_CHIP_LENGTH,
): TagChips {
    const shown = tags.slice(0, Math.max(0, max));
    return {
        labels: shown.map((tag) => chipLabel(tag, maxLength)),
        hidden: tags.length - shown.length,
    };
}

/** Which row of `rows` a scope belongs to, or -1: a tag matches without regard to case. */
export function markRowIndex(rows: readonly MarkRow[], scope: ScopeRef): number {
    return rows.findIndex((row) => {
        if (scope.kind === 'bookmarks') return row.scope.kind === 'bookmarks';
        if (scope.kind === 'tag') {
            return row.scope.kind === 'tag' && row.scope.tag.toLowerCase() === scope.tag.toLowerCase();
        }
        return false;
    });
}
