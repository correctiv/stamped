/**
 * The pool that spreads a batch over several embedding contexts. The contexts here are names and
 * the "embedding" is a promise the test resolves by hand, so the order of events is the test's.
 */

import { describe, expect, it } from '@gjsify/unit';

import { embedAcross } from '@stamped/semantic/context-pool';

interface Pending {
    context: string;
    text: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
}

function manual(): { calls: Pending[]; embedOne: (context: string, text: string) => Promise<string> } {
    const calls: Pending[] = [];
    return {
        calls,
        embedOne: (context, text) =>
            new Promise<string>((resolve, reject) => calls.push({ context, text, resolve, reject })),
    };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export default async () => {
    await describe('embedAcross', async () => {
        await it('keeps every result in the slot of its text', async () => {
            const { vectors, failure } = await embedAcross(
                ['a', 'b'],
                ['x', 'y', 'z'],
                async (context, text) => text.toUpperCase(),
            );
            expect(failure).toBeUndefined();
            expect(vectors).toStrictEqual(['X', 'Y', 'Z']);
        });

        await it('gives the next text to whichever context is free first', async () => {
            const { calls, embedOne } = manual();
            const done = embedAcross(['a', 'b'], ['1', '2', '3'], embedOne);
            await tick();
            expect(calls.map((c) => `${c.context}:${c.text}`)).toStrictEqual(['a:1', 'b:2']);
            calls[1].resolve('v2');
            await tick();
            expect(calls.map((c) => `${c.context}:${c.text}`)).toStrictEqual(['a:1', 'b:2', 'b:3']);
            calls[2].resolve('v3');
            calls[0].resolve('v1');
            expect((await done).vectors).toStrictEqual(['v1', 'v2', 'v3']);
        });

        await it('takes no new text after a failure and waits for the running ones', async () => {
            const { calls, embedOne } = manual();
            let settled = false;
            const done = embedAcross(['a', 'b'], ['1', '2', '3', '4'], embedOne).then((result) => {
                settled = true;
                return result;
            });
            await tick();
            calls[0].reject(new Error('nan'));
            await tick();
            expect(calls.length).toBe(2);
            expect(settled).toBe(false);
            calls[1].resolve('v2');
            const { vectors, failure } = await done;
            expect(calls.length).toBe(2);
            expect(failure?.error).toBeInstanceOf(Error);
            expect(String(failure?.error)).toBe('Error: nan');
            expect(vectors).toStrictEqual([undefined, 'v2', undefined, undefined]);
        });

        await it('reports the first failure when several contexts fail', async () => {
            const { calls, embedOne } = manual();
            const done = embedAcross(['a', 'b'], ['1', '2'], embedOne);
            await tick();
            calls[1].reject(new Error('first'));
            await tick();
            calls[0].reject(new Error('second'));
            expect(String((await done).failure?.error)).toBe('Error: first');
        });

        await it('returns at once for an empty batch', async () => {
            const { vectors, failure } = await embedAcross(['a'], [], async () => 'never');
            expect(failure).toBeUndefined();
            expect(vectors).toStrictEqual([]);
        });
    });
};
