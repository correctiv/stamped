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
