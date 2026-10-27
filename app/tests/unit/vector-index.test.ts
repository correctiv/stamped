/**
 * The resident vector index and the SQLite-backed holder around it. Synthetic vectors only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import {
    openVectorDb,
    putVector,
    ResidentVectors,
    searchVectors,
    VectorIndex,
    type VectorRow,
    type VectorRowSource,
} from '@stamped/semantic';

const noWait = (): Promise<void> => Promise.resolve();

function bytesOf(values: number[]): Uint8Array {
    const floats = new Float32Array(values);
    return new Uint8Array(floats.buffer.slice(0));
}

/** An in-memory table: rows in rowid order, the way SQLite hands them out. */
class FakeTable implements VectorRowSource {
    rows: VectorRow[] = [];
    private next = 1;

    put(hash: string, values: number[]): void {
        this.rows = this.rows.filter((row) => row.hash !== hash);
        this.rows.push({ rowid: this.next++, hash, vector: bytesOf(values) });
    }

    reset(): void {
        this.rows = [];
        this.next = 1;
    }

    readAfter(after: number, limit: number): VectorRow[] {
        return this.rows.filter((row) => row.rowid > after).slice(0, limit);
    }

    count(): number {
        return this.rows.length;
    }

    maxRowid(): number {
        return this.rows.length === 0 ? 0 : this.rows[this.rows.length - 1]!.rowid;
    }
}

export default async () => {
    await describe('VectorIndex', async () => {
        await it('loads in batches and finds the closest vectors', async () => {
            const table = new FakeTable();
            for (let i = 0; i < 7; i++) table.put(`h${i}`, [1, i / 10]);
            const loaded: number[] = [];
            const index = new VectorIndex(table, 2, {
                batchSize: 3,
                yieldTo: noWait,
                onProgress: (n) => loaded.push(n),
            });
            await index.load();
            expect(index.size).toBe(7);
            expect(loaded).toStrictEqual([3, 6, 7]);
            const hits = index.search(new Float32Array([1, 0]), 2);
            expect(hits.map((hit) => hit.hash)).toStrictEqual(['h0', 'h1']);
        });

        await it('refreshes only the rows newer than the cursor', async () => {
            const table = new FakeTable();
            table.put('a', [1, 0]);
            table.put('b', [0, 1]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            expect(await index.refresh()).toBe('unchanged');
            table.put('c', [1, 1]);
            expect(await index.refresh()).toBe('extended');
            expect(index.size).toBe(3);
            expect(index.cursor).toBe(3);
        });

        await it('overwrites a replaced hash in place instead of duplicating it', async () => {
            const table = new FakeTable();
            table.put('a', [1, 0]);
            table.put('b', [0, 1]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            table.put('a', [0, 1]);
            await index.refresh();
            expect(index.size).toBe(2);
            const hits = index.search(new Float32Array([0, 1]), 5);
            expect(hits.map((hit) => hit.hash)).toStrictEqual(['a', 'b']);
        });

        await it('reloads from scratch when the table was reset', async () => {
            const table = new FakeTable();
            table.put('a', [1, 0]);
            table.put('b', [0, 1]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            table.reset();
            table.put('z', [1, 0]);
            expect(await index.refresh()).toBe('reloaded');
            expect(index.size).toBe(1);
            expect(index.search(new Float32Array([1, 0]), 5).map((hit) => hit.hash)).toStrictEqual(['z']);
        });

        await it('breaks ties by hash and honours the limit', async () => {
            const table = new FakeTable();
            for (const hash of ['d', 'b', 'c', 'a']) table.put(hash, [1, 0]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            const hits = index.search(new Float32Array([1, 0]), 3);
            expect(hits.map((hit) => hit.hash)).toStrictEqual(['a', 'b', 'c']);
        });

        await it('skips zero and wrong-length rows and rejects a wrong-size query', async () => {
            const table = new FakeTable();
            table.put('ok', [1, 0]);
            table.put('zero', [0, 0]);
            table.put('short', [1]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            expect(index.size).toBe(1);
            expect(index.skipped).toBe(2);
            expect(() => index.search(new Float32Array([1, 0, 0]), 1)).toThrow();
        });

        await it('grows past its first allocation', async () => {
            const table = new FakeTable();
            table.put('first', [1, 0]);
            const index = new VectorIndex(table, 2, { yieldTo: noWait });
            await index.load();
            for (let i = 0; i < 6000; i++) table.put(`n${i}`, [1, (i % 50) / 50 + 0.01]);
            await index.refresh();
            expect(index.size).toBe(6001);
        });
    });

    await describe('ResidentVectors', async () => {
        const model = { modelId: 'test/model', dimensions: 3 };

        function withDb(run: (path: string) => Promise<void>): Promise<void> {
            const dir = mkdtempSync(join(tmpdir(), 'stamped-resident-'));
            return run(join(dir, 'vectors.db')).finally(() => rmSync(dir, { recursive: true, force: true }));
        }

        await it('scores exactly like searchVectors, and picks up rows written after the load', async () => {
            await withDb(async (path) => {
                const db = openVectorDb(path, model);
                const vectors: [string, Float32Array][] = [
                    ['a', new Float32Array([1, 0, 0])],
                    ['b', new Float32Array([0.6, 0.8, 0])],
                    ['c', new Float32Array([0.1, 0.2, 0.9])],
                ];
                for (const [hash, vector] of vectors) putVector(db, hash, vector);
                const states: string[] = [];
                const resident = new ResidentVectors({
                    path,
                    model,
                    yieldTo: noWait,
                    onState: (state) => states.push(state),
                });
                await resident.load();
                const query = new Float32Array([0.9, 0.3, 0.1]);
                expect(await resident.search(query, 3)).toStrictEqual(searchVectors(db, query, 3));
                putVector(db, 'd', new Float32Array([0.9, 0.3, 0.1]));
                const after = await resident.search(query, 1);
                expect(after.map((hit) => hit.hash)).toStrictEqual(['d']);
                expect(states).toContain('ready');
                db.close();
                resident.close();
            });
        });

        await it('holds nothing for a missing file or another model', async () => {
            await withDb(async (path) => {
                const resident = new ResidentVectors({ path, model, yieldTo: noWait });
                expect(await resident.search(new Float32Array([1, 0, 0]), 3)).toStrictEqual([]);
                const db = openVectorDb(path, model);
                putVector(db, 'a', new Float32Array([1, 0, 0]));
                db.close();
                const other = new ResidentVectors({
                    path,
                    model: { modelId: 'other/model', dimensions: 3 },
                    yieldTo: noWait,
                });
                expect(await other.search(new Float32Array([1, 0, 0]), 3)).toStrictEqual([]);
                resident.close();
                other.close();
            });
        });
    });
};
