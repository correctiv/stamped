/**
 * The words of the semantic search controls: the settings dialog's rows and the marker on a hit.
 *
 * Pure, so the same text is testable on Node and GJS. Nothing here opens a dialog: a runtime or a
 * model that is missing is explained in a row, quietly, and text search carries on.
 */

import { fmt, _, _n } from '@stamped/core';
import type { SemanticSetting } from '@stamped/store';
import type { GpuPin } from '@stamped/semantic/gpu-guard';
import type { GpuSetting } from '@stamped/semantic/prebuilt-bins';

import type { EmbedderAvailability } from '../../lib/semantic-embedder.ts';
import type { MatchKind } from '../../lib/hybrid-search.ts';
import type { SemanticState } from '../../lib/semantic-state.ts';
import { remainingTime, semanticLines } from '../../lib/semantic-status.ts';

/** What the settings dialog shows. */
export interface SemanticSettingsView {
    /** Whether the switch is on. */
    readonly active: boolean;
    /** Whether the person can flip it: not without a model runtime. */
    readonly sensitive: boolean;
    /** The state, one fact per line. */
    readonly lines: string[];
    /** "About 7.8 h for 120,000 messages", once a probe exists. */
    readonly estimate: string | undefined;
    /** Why the switch is dead, when it is. */
    readonly note: string | undefined;
    /** Why the graphics card is not used, when a crash pinned the CPU; the dialog offers to undo it. */
    readonly pinNote: string | undefined;
}

/** The estimate sentence, or `undefined` before the machine has been measured. */
export function semanticEstimate(setting: SemanticSetting | undefined, total: number): string | undefined {
    const probe = setting?.probe;
    if (probe === undefined || total <= 0) return undefined;
    return fmt(_n('About {time} for {count} message.', 'About {time} for {count} messages.', total), {
        time: remainingTime(probe.estimatedHours * 3600),
        count: String(total),
    });
}

function unavailableNote(availability: EmbedderAvailability): string | undefined {
    if (availability === 'runtime') {
        return _('Stamped ships no language model for this kind of machine. Text search is not affected.');
    }
    if (availability === 'model') {
        return _('No embedding model was found on this machine. Text search is not affected.');
    }
    return undefined;
}

/** What the dialog knows about where the vectors are computed. */
export interface SemanticBackendInfo {
    /** The backend of the run the status file describes. */
    readonly backend?: 'gpu' | 'cpu';
    /** The CPU pin a dead GPU session left behind. */
    readonly pin?: GpuPin;
    /** `STAMPED_SEMANTIC_GPU`: with `on` or `off` the environment decides and a pin means nothing. */
    readonly gpu?: GpuSetting;
}

export function semanticSettingsView(
    availability: EmbedderAvailability,
    state: SemanticState,
    setting: SemanticSetting | undefined,
    total: number,
    info: SemanticBackendInfo = {},
): SemanticSettingsView {
    const note = unavailableNote(availability);
    const lines: string[] = [];
    if (note === undefined) {
        // Only while something runs: a finished index runs nowhere, and a stale "graphics card"
        // after a crash would contradict the pin note below it.
        const working = state.kind === 'indexing' || state.kind === 'probing';
        if (working && info.backend === 'gpu') lines.push(_('Runs on the graphics card.'));
        if (working && info.backend === 'cpu') lines.push(_('Runs on the processor.'));
        lines.push(...semanticLines(state));
    }
    const pin = note === undefined && (info.gpu ?? 'auto') === 'auto' ? info.pin : undefined;
    const pinNote =
        pin === undefined
            ? undefined
            : fmt(
                  _(
                      'The graphics card is not used: process {pid} stopped while using it ({time}). That can be a driver fault, or another program that had filled the graphics memory.',
                  ),
                  { pid: String(pin.pid), time: new Date(pin.at).toLocaleString() },
              );
    return {
        active: setting?.enabled === true,
        sensitive: availability === 'ready',
        lines,
        estimate: note === undefined && state.kind !== 'ready' ? semanticEstimate(setting, total) : undefined,
        note,
        pinNote,
    };
}

/** The quiet marker on a hit the meaning found; none for a plain text match. */
export function matchBadge(match: MatchKind): string | undefined {
    if (match === 'semantic') return _('Similar meaning');
    if (match === 'both') return _('Text and meaning');
    return undefined;
}

/** The line under the list title while the meaning's hits are still coming. */
export function meaningPendingLine(loading: boolean): string {
    return loading ? _('Loading semantic search…') : _('Searching by meaning…');
}
