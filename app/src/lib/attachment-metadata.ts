/**
 * What the attachment section of a report says, as data the PDF report renders.
 *
 * An INDICATION about the attachments, never about the message: DKIM covers the bytes as sent and
 * says nothing about a file's earlier life. The note says so before it gives a number, and
 * nothing here ever feeds a verdict.
 */

import { _, _n, fmt } from '@stamped/core';
import { type AttachmentIndication, attachmentFindings, LONG_AFTER_MS } from '@stamped/import';
import type { AttachmentTotals } from '@stamped/store';

export interface AttachmentSection {
    readonly heading: string;
    readonly note: string;
    /** Label and the number of messages. */
    readonly rows: readonly [label: string, messages: number][];
}

/** The section, or `undefined` when no attachment was of a format that is examined. Call after `initI18n()`. */
export function attachmentSection(totals: AttachmentTotals): AttachmentSection | undefined {
    if (totals.examined === 0) return undefined;
    const days = Math.round(LONG_AFTER_MS / (24 * 3600 * 1000));
    return {
        heading: _('Attachment metadata'),
        note: _(
            'The properties inside PDF, Office (including .doc, .xls and .ppt), OpenDocument and image attachments can show that a file was changed after it was sent, or long after it was made. They are easy to set and many harmless tools rewrite them: an indication, not proof. This is separate from the signature verdicts and never changes one. Other file types are not examined, and a message is counted once however many attachments it has.',
        ),
        rows: [
            [_('Messages with an examined attachment'), totals.examined],
            [_('Created or modified after the message’s Date header'), totals.modifiedAfterSent],
            [
                fmt(_('Modified long after it was created (more than {days} days)'), { days: String(days) }),
                totals.modifiedLongAfterCreation,
            ],
            [_('PDF saved on top of an earlier version'), totals.incrementalUpdates],
        ],
    };
}

/** `2024-05-01 10:30 UTC`: one fixed form, since the zone the file named is not the reader's. */
function stamp(epochMs: number): string {
    return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The lines the reader shows under one attachment: what its properties say, and, when a flag is
 * set, which one — always with "indication, not proof". Call after `initI18n()`.
 */
export function indicationLines(indication: AttachmentIndication): string[] {
    const facts: string[] = [];
    if (indication.createdAt !== undefined) facts.push(fmt(_('Created {date}'), { date: stamp(indication.createdAt) }));
    if (indication.modifiedAt !== undefined) {
        facts.push(fmt(_('Modified {date}'), { date: stamp(indication.modifiedAt) }));
    }
    const tool = indication.producer ?? indication.creator;
    if (tool !== undefined) facts.push(fmt(_('Made with {tool}'), { tool }));
    if (indication.lastModifiedBy !== undefined) {
        facts.push(fmt(_('Last saved by {name}'), { name: indication.lastModifiedBy }));
    }
    if (indication.updates > 0) {
        facts.push(
            fmt(_n('{count} later revision', '{count} later revisions', indication.updates), {
                count: String(indication.updates),
            }),
        );
    }
    const flags: string[] = [];
    if (indication.modifiedAfterSent) flags.push(_('Dated after the message’s Date header.'));
    if (indication.modifiedLongAfterCreation) flags.push(_('Modified long after it was created.'));
    if (indication.incrementalUpdates) flags.push(_('Saved on top of an earlier version.'));
    const out: string[] = [];
    if (facts.length > 0) out.push(facts.join(' · '));
    if (flags.length > 0) out.push(`${flags.join(' ')} ${_('An indication, not proof.')}`);
    return out;
}

/**
 * The reader's lines per attachment position, for one raw message. A message the analysis cannot
 * walk simply has none: the reader must open whatever the archive holds.
 */
export function attachmentLines(raw: Uint8Array): Map<number, string[]> {
    const out = new Map<number, string[]>();
    try {
        for (const { index, indication } of attachmentFindings(raw)) {
            const lines = indicationLines(indication);
            if (lines.length > 0) out.set(index, lines);
        }
    } catch {
        // see above
    }
    return out;
}
