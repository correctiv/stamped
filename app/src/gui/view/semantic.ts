/**
 * The words of the semantic search controls: the settings dialog's rows and the marker on a hit.
 *
 * Pure, so the same text is testable on Node and GJS. Nothing here opens a dialog: a runtime or a
 * model that is missing is explained in a row, quietly, and text search carries on.
 */

import { fmt, _, _n } from '@stamped/core';
import type { SemanticSetting } from '@stamped/store';

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

export function semanticSettingsView(
    availability: EmbedderAvailability,
    state: SemanticState,
    setting: SemanticSetting | undefined,
    total: number,
): SemanticSettingsView {
    const note = unavailableNote(availability);
    return {
        active: setting?.enabled === true,
        sensitive: availability === 'ready',
        lines: note === undefined ? semanticLines(state) : [],
        estimate: note === undefined && state.kind !== 'ready' ? semanticEstimate(setting, total) : undefined,
        note,
    };
}

/** The quiet marker on a hit the meaning found; none for a plain text match. */
export function matchBadge(match: MatchKind): string | undefined {
    if (match === 'semantic') return _('Similar meaning');
    if (match === 'both') return _('Text and meaning');
    return undefined;
}
