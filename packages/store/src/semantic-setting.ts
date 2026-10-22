/**
 * The semantic layer's SETTING for one case: is it on, what did the probe measure, and which
 * model the vectors belong to.
 *
 * A SMALL FILE, WRITTEN ATOMICALLY (`tmp` + rename), beside the case's other files — the same
 * rule the import status follows, so a reader sees the old setting or the new one and never a
 * half-written one.
 *
 * ABSENT MEANS "NEVER DECIDED", NOT "OFF". A case folder without a `semantic.json` has not been
 * asked about semantic search, and the app must not read that as a refusal: the difference
 * decides whether the probe runs before the first indexing. A file that IS there is an answer —
 * `enabled: false` is an answer too, and it is kept, so the app does not ask again.
 *
 * THE PROBE IS KEPT BECAUSE IT IS EXPENSIVE TO REPEAT AND WRONG TO KEEP FOREVER: it measures
 * one machine on one day, so it carries the model it was for and the moment it was taken. A
 * probe of another model says nothing about this one, and the app measures again then.
 *
 * NO MAIL CONTENT: a decision, two numbers about a model, and what a measurement said. The file
 * travels next to a leak and must not become a second place the archive can be read from.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CasePaths } from './case.ts';

/** Bumped when a build would misread a setting an older build wrote. */
export const SEMANTIC_SETTING_VERSION = 1;

/** The file's name inside the case folder. */
export const SEMANTIC_SETTING_NAME = 'semantic.json';

/** What a probe measured, on which model, and when. */
export interface SemanticProbeRecord {
    /** The model the measurement was for. Another model's probe says nothing about this one. */
    readonly modelId: string;
    /** Tokens per second on this machine, over a handful of real messages. */
    readonly tokensPerSecond: number;
    /** How long the whole archive would take at that speed. */
    readonly estimatedHours: number;
    /** What the probe concluded: worth it on this machine, or not. */
    readonly recommendation: 'on' | 'off';
    /** When it was measured, ISO 8601. */
    readonly measuredAt: string;
}

/** The setting of one case. */
export interface SemanticSetting {
    readonly version: number;
    /** The person's answer: on or off. */
    readonly enabled: boolean;
    /** The model the case's vectors belong to; absent before the first run. */
    readonly modelId?: string;
    /** How many float32s a vector of that model has. */
    readonly dimensions?: number;
    /** The last probe, when there was one. */
    readonly probe?: SemanticProbeRecord;
}

/** The file's path inside a case folder. */
export function semanticSettingFile(paths: CasePaths): string {
    return join(paths.root, SEMANTIC_SETTING_NAME);
}

/** The setting, or `undefined` when there is none or it cannot be trusted. */
export function readSemanticSetting(paths: CasePaths): SemanticSetting | undefined {
    let text: string;
    try {
        text = readFileSync(semanticSettingFile(paths), 'utf8');
    } catch {
        return undefined;
    }
    let parsed: Partial<SemanticSetting>;
    try {
        parsed = JSON.parse(text) as Partial<SemanticSetting>;
    } catch {
        return undefined;
    }
    // Refused rather than repaired, like the import status: a file this build cannot fully make
    // sense of is not a setting but a guess, and the guess decides whether a machine embeds a
    // leak for hours.
    if (typeof parsed.version !== 'number' || parsed.version > SEMANTIC_SETTING_VERSION) {
        return undefined;
    }
    if (typeof parsed.enabled !== 'boolean') return undefined;
    if (parsed.modelId !== undefined && typeof parsed.modelId !== 'string') return undefined;
    if (parsed.dimensions !== undefined && typeof parsed.dimensions !== 'number') return undefined;
    if (parsed.probe !== undefined && !isProbeRecord(parsed.probe)) return undefined;
    return parsed as SemanticSetting;
}

/** Is this a probe record we can act on? Every field, because a half-record is no record. */
function isProbeRecord(value: unknown): value is SemanticProbeRecord {
    if (typeof value !== 'object' || value === null) return false;
    const probe = value as Partial<SemanticProbeRecord>;
    if (typeof probe.modelId !== 'string') return false;
    if (!Number.isFinite(probe.tokensPerSecond)) return false;
    if (!Number.isFinite(probe.estimatedHours)) return false;
    if (probe.recommendation !== 'on' && probe.recommendation !== 'off') return false;
    return typeof probe.measuredAt === 'string';
}

/** Write the setting atomically: a reader sees the old setting or the new one, never a torn one. */
export function writeSemanticSetting(paths: CasePaths, setting: SemanticSetting): void {
    const target = semanticSettingFile(paths);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(setting, undefined, 2)}\n`);
    renameSync(tmp, target);
}
