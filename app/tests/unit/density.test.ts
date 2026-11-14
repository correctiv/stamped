/**
 * The row density of the message list: the pixels it is worth, and the file it is kept in.
 *
 * The widgets are not testable without a display; what a density MEANS is, and so is the
 * promise that an unreadable settings file costs nobody their list.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    DEFAULT_DENSITY,
    DENSITIES,
    DENSITY_NAME,
    isDensity,
    readDensity,
    rowMetrics,
    writeDensity,
} from '../../src/lib/density.ts';

function withDir(run: (dir: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-density-'));
    try {
        run(join(root, 'state'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export default async () => {
    await describe('row density', async () => {
        await it('offers comfortable and compact, comfortable by default', async () => {
            expect([...DENSITIES]).toStrictEqual(['comfortable', 'compact']);
            expect(DEFAULT_DENSITY).toBe('comfortable');
        });

        await it('makes a compact row shorter than a comfortable one, and neither flush', async () => {
            const comfortable = rowMetrics('comfortable');
            const compact = rowMetrics('compact');
            expect(compact.marginVertical < comfortable.marginVertical).toBe(true);
            expect(compact.chipGap < comfortable.chipGap).toBe(true);
            // Rows that touch read as one block, and then a star belongs to the wrong subject.
            for (const metrics of [comfortable, compact]) {
                expect(metrics.marginVertical > 0).toBe(true);
                expect(metrics.chipGap > 0).toBe(true);
                expect(metrics.spacing > 0).toBe(true);
            }
        });

        await it('knows which words are densities', async () => {
            for (const density of DENSITIES) expect(isDensity(density)).toBe(true);
            for (const other of ['cosy', '', 'COMPACT', 7, null, undefined]) {
                expect(isDensity(other)).toBe(false);
            }
        });

        await it('is the default until something is chosen, and the choice survives', async () => {
            withDir((dir) => {
                expect(readDensity(dir)).toBe(DEFAULT_DENSITY);
                writeDensity(dir, 'compact');
                expect(readDensity(dir)).toBe('compact');
                writeDensity(dir, 'comfortable');
                expect(readDensity(dir)).toBe('comfortable');
            });
        });

        await it('stores one word and a version, nothing about any case', async () => {
            withDir((dir) => {
                writeDensity(dir, 'compact');
                const body = JSON.parse(readFileSync(join(dir, DENSITY_NAME), 'utf8')) as Record<
                    string,
                    unknown
                >;
                expect(Object.keys(body).sort()).toStrictEqual(['density', 'version']);
                expect(body).toStrictEqual({ version: 1, density: 'compact' });
            });
        });

        await it('reads a corrupt, foreign or newer file as the default', async () => {
            withDir((dir) => {
                mkdirSync(dir, { recursive: true });
                const file = join(dir, DENSITY_NAME);
                for (const text of [
                    'not json',
                    '[]',
                    '{"version":99,"density":"compact"}',
                    '{"version":1,"density":"cosy"}',
                    '{"version":1}',
                ]) {
                    writeFileSync(file, text);
                    expect(readDensity(dir)).toBe(DEFAULT_DENSITY);
                }
            });
        });

        await it('swallows a write that fails instead of refusing the setting', async () => {
            withDir((dir) => {
                // The state "directory" is a file: creating it fails on every platform and as root.
                mkdirSync(join(dir, '..'), { recursive: true });
                writeFileSync(dir, 'in the way');
                writeDensity(dir, 'compact');
                expect(readDensity(dir)).toBe(DEFAULT_DENSITY);
            });
        });
    });
};
