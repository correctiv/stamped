/**
 * The Personen and Zeitleiste views as data: what each row says and which filter it sets.
 *
 * One address is one person. A row shows the display names seen for it and never merges two
 * addresses, so the list cannot assert that two mailboxes are one human.
 */

import { VERDICTS, fmt, _, _n, type Verdict } from '@stamped/core';
import type { Person, Timeline, TimelineBucket } from '@stamped/store';

import { groupDigits } from './format.ts';
import { escapeLine } from './markup.ts';
import type { OverviewFilter } from './overview.ts';
import { verdictLook } from './verdict.ts';

/** A verdict's slice of a row's bar. */
export interface BarSegment {
    readonly verdict: Verdict;
    readonly cssClass: string;
    /** Messages in this slice. */
    readonly messages: number;
    /** 0 … 1 of the whole bar. */
    readonly share: number;
}

/** One line of the people list. */
export interface PersonRow {
    readonly address: string;
    /** Escaped: the most used display name, or the address when there is none. */
    readonly title: string;
    /** Escaped: address, other names, sent/received, period. */
    readonly subtitle: string;
    readonly count: string;
    readonly segments: readonly BarSegment[];
    readonly filter: OverviewFilter;
}

/** `2019-03-04` of an instant, UTC. */
export function isoDay(instant: number): string {
    return new Date(instant).toISOString().slice(0, 10);
}

/** Slices of a bar, in verdict order, zeroes dropped; shares are of `of`. */
export function barSegments(
    verdicts: readonly { readonly verdict: Verdict; readonly messages: number }[],
    of: number,
): BarSegment[] {
    const segments: BarSegment[] = [];
    for (const verdict of VERDICTS) {
        const messages = verdicts.find((entry) => entry.verdict === verdict)?.messages ?? 0;
        if (messages <= 0 || of <= 0) continue;
        segments.push({
            verdict,
            cssClass: verdictLook(verdict).cssClass,
            messages,
            share: messages / of,
        });
    }
    return segments;
}

/** The people list as rows. */
export function personRows(people: readonly Person[]): PersonRow[] {
    return people.map((person) => {
        const [first, ...others] = person.names;
        const parts: string[] = [];
        if (first !== undefined) parts.push(person.address);
        if (others.length > 0) {
            parts.push(fmt(_('also as {names}'), { names: others.map((other) => other.name).join(', ') }));
        }
        parts.push(
            fmt(_('{sent} sent, {received} received'), {
                sent: groupDigits(person.sent),
                received: groupDigits(person.received),
            }),
        );
        if (person.earliest !== undefined && person.latest !== undefined) {
            const from = isoDay(person.earliest);
            const to = isoDay(person.latest);
            parts.push(from === to ? from : `${from} – ${to}`);
        }
        return {
            address: person.address,
            title: escapeLine(first?.name ?? person.address),
            subtitle: escapeLine(parts.join(' · ')),
            count: groupDigits(person.messages),
            segments: barSegments(person.verdicts, person.messages),
            filter: { scope: { kind: 'person', address: person.address } },
        };
    });
}

/** One bar of the timeline. */
export interface TimelineRow {
    readonly key: string;
    /** Escaped label: `2024-03`, `2024-03-05` or "No date". */
    readonly label: string;
    readonly count: string;
    /** 0 … 1 against the busiest bucket. */
    readonly share: number;
    readonly segments: readonly BarSegment[];
    readonly filter: OverviewFilter;
}

/** The timeline as rows, oldest first, the undated mail last and only when there is some. */
export function timelineRows(timeline: Timeline): TimelineRow[] {
    const busiest = timeline.buckets.reduce((max, bucket) => Math.max(max, bucket.messages), 0);
    const row = (bucket: TimelineBucket): TimelineRow => ({
        key: bucket.key,
        label: escapeLine(bucket.key),
        count: groupDigits(bucket.messages),
        share: busiest > 0 ? bucket.messages / busiest : 0,
        segments: barSegments(bucket.verdicts, bucket.messages),
        filter: { scope: { kind: 'period', period: bucket.key } },
    });
    const rows = timeline.buckets.map(row);
    if (timeline.undated > 0) {
        rows.push({
            key: 'undated',
            label: escapeLine(_('No date')),
            count: groupDigits(timeline.undated),
            share: 0,
            segments: [],
            filter: { scope: { kind: 'period', period: 'undated' } },
        });
    }
    return rows;
}

/** The sentence above the timeline: the unit and how many messages carry no date. */
export function timelineNote(timeline: Timeline): string {
    const unit =
        timeline.unit === 'day'
            ? _('Mails per day, by UTC date of sending.')
            : _('Mails per month, by UTC date of sending.');
    if (timeline.undated === 0) return escapeLine(unit);
    return escapeLine(
        `${unit} ${fmt(_n('{n} message has no readable date.', '{n} messages have no readable date.', timeline.undated), { n: groupDigits(timeline.undated) })}`,
    );
}

/** What the people view says while the address table is still being filled for an older case. */
export function peopleIncompleteNote(): string {
    return escapeLine(_('Reading the addresses of this case — the list is not complete yet.'));
}
