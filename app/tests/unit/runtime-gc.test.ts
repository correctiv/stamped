/** The collection hook the llama embedder calls between batches — must be harmless anywhere. */

import { describe, expect, it } from '@gjsify/unit';
import { collectGarbage, runningOnGjs } from '@stamped/semantic/runtime';

export default async () => {
    await describe('collectGarbage', async () => {
        await it('runs without throwing and leaves live data alone', async () => {
            const kept = new Float32Array([1, 2, 3]);
            collectGarbage();
            expect(Array.from(kept)).toStrictEqual([1, 2, 3]);
        });

        await it('knows which runtime it is on', async () => {
            expect(typeof runningOnGjs()).toBe('boolean');
        });
    });
};
