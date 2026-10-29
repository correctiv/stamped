/**
 * The two halves of a search meeting: which run an answer belongs to, and what the meaning may
 * add to a list the words already filled. No widget and no worker — the hits are plain objects.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    addsMeaning,
    mergeSemantic,
    searchPhaseOf,
    SearchRuns,
    PROGRESS_DELAY_MS,
} from '../../src/lib/search-progress.ts';

const hit = (hash: string, match: 'text' | 'semantic' | 'both' = 'text') => ({ hash, match });

export default async () => {
    await describe('SearchRuns', async () => {
        await it('the run that started last is the current one', async () => {
            const runs = new SearchRuns();
            const first = runs.start();
            expect(runs.isCurrent(first)).toBe(true);
            const second = runs.start();
            expect(runs.isCurrent(first)).toBe(false);
            expect(runs.isCurrent(second)).toBe(true);
            expect(runs.token).toBe(second);
        });

        await it('cancel supersedes without starting a run', async () => {
            const runs = new SearchRuns();
            const only = runs.start();
            runs.cancel();
            expect(runs.isCurrent(only)).toBe(false);
            // Nothing is current now: a late answer from any run is dropped.
            expect(runs.isCurrent(runs.token)).toBe(true);
            expect(runs.token).toBe(only + 1);
        });

        await it('a filter flipped during a search supersedes it, same query text', async () => {
            // The case the old check missed: the words are identical, the list is not.
            const runs = new SearchRuns();
            const searching = runs.start();
            runs.start(); // the verdict filter changed and refilled the list
            expect(runs.isCurrent(searching)).toBe(false);
        });
    });

    await describe('mergeSemantic', async () => {
        await it('appends only what is not on screen, in the fused order', async () => {
            const merged = [hit('b', 'both'), hit('x', 'semantic'), hit('a', 'text'), hit('y', 'semantic')];
            const { append, total } = mergeSemantic(['a', 'b', 'c'], merged);
            expect(append.map((h) => h.hash)).toStrictEqual(['x', 'y']);
            expect(total).toBe(5);
        });

        await it('leaves the rows on screen in the order they are shown', async () => {
            // The fusion ranks `c` first; the list must not re-order around it.
            const shown = ['a', 'b', 'c'];
            const { append } = mergeSemantic(shown, [hit('c', 'both'), hit('a'), hit('b')]);
            expect(append.length).toBe(0);
            expect(shown).toStrictEqual(['a', 'b', 'c']);
        });

        await it('appends a hash the fusion lists twice only once', async () => {
            const { append, total } = mergeSemantic([], [hit('x', 'semantic'), hit('x', 'semantic')]);
            expect(append.map((h) => h.hash)).toStrictEqual(['x']);
            expect(total).toBe(1);
        });

        await it('a list the words left empty is filled by the meaning alone', async () => {
            const { append, total } = mergeSemantic([], [hit('x', 'semantic'), hit('y', 'semantic')]);
            expect(append.map((h) => h.hash)).toStrictEqual(['x', 'y']);
            expect(total).toBe(2);
        });

        await it('nothing to merge leaves the list as it stands', async () => {
            const { append, total } = mergeSemantic(['a', 'b'], []);
            expect(append.length).toBe(0);
            expect(total).toBe(2);
        });
    });

    await describe('addsMeaning', async () => {
        await it('is false when every hit came from the words', async () => {
            expect(addsMeaning([hit('a'), hit('b')])).toBe(false);
        });

        await it('is true for a hit the meaning found or helped find', async () => {
            expect(addsMeaning([hit('a'), hit('b', 'semantic')])).toBe(true);
            expect(addsMeaning([hit('a', 'both')])).toBe(true);
        });

        await it('is false for a search that found nothing', async () => {
            expect(addsMeaning([])).toBe(false);
        });
    });

    await describe('searchPhaseOf', async () => {
        await it('names a phase, or nothing', async () => {
            expect(searchPhaseOf('meaning')).toBe('meaning');
            expect(searchPhaseOf('loading-model')).toBe('loading-model');
            expect(searchPhaseOf('text')).toBe('text');
            expect(searchPhaseOf('idle')).toBe(undefined);
            expect(searchPhaseOf('')).toBe(undefined);
        });

        await it('waits before it says anything', async () => {
            expect(PROGRESS_DELAY_MS > 0).toBe(true);
        });
    });
};
