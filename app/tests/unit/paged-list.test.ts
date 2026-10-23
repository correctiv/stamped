/**
 * The paging bookkeeping behind the message list: when a fetch may start, when its answer is
 * dropped, when the list ends. No widget, no worker — the fetch is a function the test holds.
 */

import { describe, expect, it } from '@gjsify/unit';
import { nearEnd, PagedList } from '../../src/lib/paged-list.ts';

const rows = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

function make(pageSize: number) {
    const landed: { page: readonly number[]; replace: boolean }[] = [];
    const list = new PagedList<number>({
        pageSize,
        onPage: (page, replace) => landed.push({ page, replace }),
    });
    return { list, landed };
}

export default async () => {
    await describe('PagedList', async () => {
        await it('asks for each page at the offset already delivered', async () => {
            const { list, landed } = make(3);
            list.reset(7);
            const offsets: number[] = [];
            const fetch = async (offset: number) => {
                offsets.push(offset);
                return rows(offset, Math.min(3, 7 - offset));
            };
            await list.loadMore(fetch);
            await list.loadMore(fetch);
            await list.loadMore(fetch);
            expect(offsets).toStrictEqual([0, 3, 6]);
            expect(landed.map((l) => l.replace)).toStrictEqual([true, false, false]);
            expect(list.loaded).toBe(7);
            expect(list.hasMore).toBe(false);
        });

        await it('ends on a short page even when the total promised more', async () => {
            const { list } = make(5);
            list.reset(100);
            await list.loadMore(async () => rows(0, 2));
            expect(list.hasMore).toBe(false);
        });

        await it('does not start a second fetch while one is out', async () => {
            const { list } = make(2);
            list.reset(10);
            let release: (page: number[]) => void = () => {};
            const first = list.loadMore(() => new Promise<number[]>((resolve) => (release = resolve)));
            expect(list.isLoading).toBe(true);
            expect(await list.loadMore(async () => rows(0, 2))).toBe(false);
            release(rows(0, 2));
            expect(await first).toBe(true);
            expect(list.isLoading).toBe(false);
        });

        await it('drops the answer of a list that was reset meanwhile', async () => {
            const { list, landed } = make(2);
            list.reset(10);
            let release: (page: number[]) => void = () => {};
            const stale = list.loadMore(() => new Promise<number[]>((resolve) => (release = resolve)));
            list.reset(4);
            release(rows(0, 2));
            expect(await stale).toBe(false);
            expect(landed.length).toBe(0);
            expect(list.loaded).toBe(0);
            expect(await list.loadMore(async () => rows(0, 2))).toBe(true);
            expect(landed.length).toBe(1);
        });

        await it('an empty list has nothing to load', async () => {
            const { list } = make(2);
            list.reset(0);
            expect(list.hasMore).toBe(false);
            expect(await list.loadMore(async () => rows(0, 2))).toBe(false);
        });

        await it('finish closes the list and drops a fetch still out', async () => {
            const { list, landed } = make(2);
            list.reset(10);
            let release: (page: number[]) => void = () => {};
            const pending = list.loadMore(() => new Promise<number[]>((resolve) => (release = resolve)));
            list.finish(5);
            release(rows(0, 2));
            expect(await pending).toBe(false);
            expect(landed.length).toBe(0);
            expect(list.hasMore).toBe(false);
            expect(list.loaded).toBe(5);
        });

        await it('lets the next call retry after a failed fetch', async () => {
            const { list } = make(2);
            list.reset(10);
            let failed = false;
            try {
                await list.loadMore(async () => {
                    throw new Error('worker gone');
                });
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
            expect(list.isLoading).toBe(false);
            expect(await list.loadMore(async () => rows(0, 2))).toBe(true);
        });
    });

    await describe('nearEnd', async () => {
        await it('is true once less than the margin of list is left', async () => {
            expect(nearEnd(0, 500, 10000, 1000)).toBe(false);
            expect(nearEnd(8500, 500, 10000, 1000)).toBe(true);
            expect(nearEnd(8500, 500, 10000, 0)).toBe(false);
            expect(nearEnd(9500, 500, 10000, 0)).toBe(true);
        });
    });
};
