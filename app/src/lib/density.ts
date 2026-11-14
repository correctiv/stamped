/**
 * How tall the rows of the message list are drawn — the person's choice, not a case's.
 *
 * A COMFORTABLE row and a COMPACT one show the same things: the star, the contact line, the
 * subject, the tag chips and the verdict badge. The difference is only the air around them, which
 * is what decides how many messages are on screen at once. Someone skimming a hundred thousand
 * imported messages wants the next screenful; someone reading twenty wants them legible.
 *
 * IT LIVES IN THE STATE DIRECTORY, beside `recent-cases.json`, for the same reason that list
 * does: it belongs to the person using this machine, and a case that travels (`stamped case pack`)
 * must not carry how its owner likes their list. A case has no say in it, and the file holds one
 * word — no path, no case, nothing from any mail.
 *
 * A FILE THAT CANNOT BE READ IS THE DEFAULT. Like `recent-cases.json` and unlike `marks.json`,
 * this is not something a person typed into a case: a corrupt or foreign file is replaced by the
 * next change rather than turned into an error.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file's name inside the state directory. */
export const DENSITY_NAME = 'appearance.json';

/** Bumped when a build would misread a file an older build wrote. */
export const DENSITY_VERSION = 1;

/** The row heights on offer, in the order the settings dialog lists them. */
export const DENSITIES = ['comfortable', 'compact'] as const;

export type Density = (typeof DENSITIES)[number];

/** What a fresh install gets: legible before dense. */
export const DEFAULT_DENSITY: Density = 'comfortable';

/** What a density is worth in pixels — everything about a list row that it decides. */
export interface RowMetrics {
    /** Padding above and below the row's contents. */
    readonly marginVertical: number;
    /** The gap between the star, the text, the badges. */
    readonly spacing: number;
    /** The gap between the subject line and the tag chips under it. */
    readonly chipGap: number;
}

const METRICS: Readonly<Record<Density, RowMetrics>> = {
    comfortable: { marginVertical: 8, spacing: 8, chipGap: 2 },
    // Not zero anywhere: rows that touch read as one block, and the star of the row below then
    // looks like it belongs to the subject above it.
    compact: { marginVertical: 3, spacing: 6, chipGap: 1 },
};

/** The pixels a density asks for. */
export function rowMetrics(density: Density): RowMetrics {
    return METRICS[density];
}

/** Whether a value is one of the densities this build knows. */
export function isDensity(value: unknown): value is Density {
    return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

/** The chosen density, or the default. Never throws. */
export function readDensity(dir: string): Density {
    try {
        const body = JSON.parse(readFileSync(join(dir, DENSITY_NAME), 'utf8')) as {
            version?: unknown;
            density?: unknown;
        };
        if (body.version !== DENSITY_VERSION || !isDensity(body.density)) return DEFAULT_DENSITY;
        return body.density;
    } catch {
        return DEFAULT_DENSITY;
    }
}

/**
 * Remember a density.
 *
 * Best effort, like `rememberCase` in `recent-cases.ts`: a state directory that cannot be written must not stop
 * the list from being redrawn, so the window applies the choice either way and only the next
 * start forgets it.
 */
export function writeDensity(dir: string, density: Density): void {
    try {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, DENSITY_NAME);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ version: DENSITY_VERSION, density }, undefined, 2)}\n`);
        renameSync(tmp, file);
    } catch {
        // see above
    }
}
