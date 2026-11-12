/**
 * The progress `stamped report --pdf --progress=jsonl` prints, and how the window reads it.
 *
 * The report is six steps of very different weight (the summary query, the digest over every
 * hash, the body-altered fill, the receiver-anchor fill, the unsigned fill that reads one raw file per message, the
 * attachment fill that reads them all, the rendering), so a bar over the steps alone would sit still for minutes and then jump. Every line
 * therefore carries the step AND how far that step is, and {@link reportFraction} puts the two
 * together. A step that cannot say how far it is reports `total` 0.
 *
 * Like the import's lines these are SNAPSHOTS: a line that is lost costs the reader nothing.
 * NUMBERS AND PHASE NAMES ONLY — never a mailbox, an address or a path of the case.
 */

import { _ } from '@stamped/core';

export type ReportPhase =
    | 'summary'
    | 'digest'
    | 'body'
    | 'anchors'
    | 'unsigned'
    | 'attachments'
    | 'render';

/** One step of the run. `step` counts from 1 of `steps`. */
export interface ReportProgressLine {
    readonly phase: ReportPhase;
    readonly step: number;
    readonly steps: number;
    readonly done: number;
    /** 0 when the step cannot say how much there is. */
    readonly total: number;
}

/** The last line: the file is written and complete. */
export interface ReportDoneLine {
    readonly phase: 'done';
    readonly pages: number;
    readonly file: string;
}

export type ReportEvent = ReportProgressLine | ReportDoneLine;

const PHASES: readonly string[] = ['summary', 'digest', 'body', 'anchors', 'unsigned', 'attachments', 'render'];

/** The phases of a run, in order; the unsigned and attachment fills only run when asked for. */
export function reportPhases(withUnsigned: boolean, withAttachments = false): ReportPhase[] {
    return [
        'summary',
        'digest',
        'body',
        'anchors',
        ...(withUnsigned ? (['unsigned'] as const) : []),
        ...(withAttachments ? (['attachments'] as const) : []),
        'render',
    ];
}

/** The line for one point of one phase. */
export function reportProgressLine(
    phases: readonly ReportPhase[],
    phase: ReportPhase,
    done: number,
    total: number,
): ReportProgressLine {
    return { phase, step: phases.indexOf(phase) + 1, steps: phases.length, done, total };
}

/** One line of the subprocess's stdout, or `undefined` for anything that is not ours. */
export function parseReportLine(line: string): ReportEvent | undefined {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.phase === 'done') {
        return typeof record.pages === 'number' && typeof record.file === 'string'
            ? { phase: 'done', pages: record.pages, file: record.file }
            : undefined;
    }
    const { phase, step, steps, done, total } = record;
    if (typeof phase !== 'string' || !PHASES.includes(phase)) return undefined;
    if (
        typeof step !== 'number' ||
        typeof steps !== 'number' ||
        typeof done !== 'number' ||
        typeof total !== 'number' ||
        steps < 1
    ) {
        return undefined;
    }
    return { phase: phase as ReportPhase, step, steps, done, total };
}

/** 0 … 1 over the whole run: the finished steps, plus the share of the current one. */
export function reportFraction(event: ReportEvent): number {
    if (event.phase === 'done') return 1;
    const within = event.total > 0 ? Math.min(1, Math.max(0, event.done / event.total)) : 0;
    return Math.min(1, Math.max(0, (event.step - 1 + within) / event.steps));
}

/** What the run is doing, for the row in the activity popover. Call after `initI18n()`. */
export function reportPhaseLabel(phase: ReportPhase): string {
    switch (phase) {
        case 'summary':
            return _('Counting verdicts');
        case 'digest':
            return _('Fingerprinting the message set');
        case 'body':
            return _('Checking altered bodies');
        case 'anchors':
            return _('Reading receiving-server records');
        case 'unsigned':
            return _('Reading unsigned headers');
        case 'attachments':
            return _('Reading attachment properties');
        case 'render':
            return _('Writing the PDF');
    }
}
