/**
 * The query helper that keeps a GPU hang out of the window: the wire format, the helper's loop
 * (`serveEmbedder`), the window's client (`createHelperEmbedder`) against a fake channel, and the
 * two joined through an in-memory pipe.
 *
 * SYNTHETIC DATA ONLY: a fake embedder and fake channels. The real processes are exercised by hand.
 */

import { describe, expect, it } from '@gjsify/unit';
import type { Embedder } from '@stamped/semantic';

import { createHelperEmbedder, type HelperChannel } from '../../src/lib/embed-client.ts';
import { parseHelperMessage, parseHelperRequest } from '../../src/lib/embed-protocol.ts';
import { bufferedLines, serveEmbedder } from '../../src/lib/embed-serve.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The error a promise ends with, or undefined when it resolved. */
async function failure(promise: Promise<unknown>): Promise<string | undefined> {
    try {
        await promise;
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Lines pushed by the test, read by `for await`, ended by `end()`. */
function pipe(): { lines: AsyncIterable<string>; push: (line: string) => void; end: () => void } {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    return {
        push(line) {
            queue.push(line);
            wake?.();
        },
        end() {
            ended = true;
            wake?.();
        },
        lines: {
            async *[Symbol.asyncIterator]() {
                for (;;) {
                    const next = queue.shift();
                    if (next !== undefined) {
                        yield next;
                        continue;
                    }
                    if (ended) return;
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            },
        },
    };
}

function fakeEmbedder(): Embedder & { disposed: number; calls: string[] } {
    const embedder = {
        modelId: 'fake/model',
        dimensions: 2,
        disposed: 0,
        calls: [] as string[],
        async embedQuery(text: string): Promise<Float32Array> {
            embedder.calls.push(text);
            if (text === 'boom') throw new Error('the model fell over');
            return Float32Array.from([text.length, 0.5]);
        },
        async embedDocuments(): Promise<Float32Array[]> {
            return [];
        },
        async dispose(): Promise<void> {
            embedder.disposed++;
        },
    };
    return embedder;
}

interface FakeChannel extends HelperChannel {
    readonly sent: string[];
    closed: number;
    killed: number;
    emit(message: unknown): void;
    exit(): void;
}

type Behaviour = (channel: FakeChannel, nth: number) => void;

/** A helper that says `ready` and answers every request with the text's length. */
const answering =
    (modelId = 'fake/model'): Behaviour =>
    (channel) => {
        channel.emit({ type: 'ready', modelId, dimensions: 2 });
    };

function fakeWorld(behaviour: Behaviour, answer = true) {
    const channels: FakeChannel[] = [];
    const spawn = (onLine: (line: string) => void): HelperChannel => {
        let exit!: () => void;
        const exited = new Promise<void>((resolve) => {
            exit = resolve;
        });
        const channel: FakeChannel = {
            sent: [],
            closed: 0,
            killed: 0,
            exited,
            exit,
            emit: (message) => onLine(typeof message === 'string' ? message : JSON.stringify(message)),
            send(line) {
                channel.sent.push(line);
                if (!answer) return;
                const request = JSON.parse(line) as { id: number; text: string };
                queueMicrotask(() => channel.emit({ id: request.id, vector: [request.text.length, 0.5] }));
            },
            close() {
                channel.closed++;
                exit();
            },
            kill() {
                channel.killed++;
                exit();
            },
        };
        channels.push(channel);
        queueMicrotask(() => behaviour(channel, channels.length));
        return channel;
    };
    return { channels, spawn };
}

export default async () => {
    await describe('embed protocol', async () => {
        await it('reads the helper messages and nothing else', async () => {
            expect(parseHelperMessage('{"type":"ready","modelId":"m","dimensions":3}')).toStrictEqual({
                type: 'ready',
                modelId: 'm',
                dimensions: 3,
            });
            expect(parseHelperMessage('{"type":"unavailable"}')).toStrictEqual({ type: 'unavailable' });
            expect(parseHelperMessage('{"id":4,"vector":[1,2]}')).toStrictEqual({ id: 4, vector: [1, 2] });
            expect(parseHelperMessage('{"id":4,"error":"no"}')).toStrictEqual({ id: 4, error: 'no' });
            expect(parseHelperMessage('ggml_vulkan: found 1 device')).toBe(undefined);
            expect(parseHelperMessage('{"type":"ready"}')).toBe(undefined);
            expect(parseHelperMessage('{"id":"4"}')).toBe(undefined);
            expect(parseHelperMessage('[1]')).toBe(undefined);
        });

        await it('reads a request or nothing', async () => {
            expect(parseHelperRequest('{"id":1,"text":"hello"}')).toStrictEqual({ id: 1, text: 'hello' });
            expect(parseHelperRequest('{"id":1}')).toBe(undefined);
            expect(parseHelperRequest('hello')).toBe(undefined);
        });
    });

    await describe('bufferedLines', async () => {
        await it('keeps lines that arrive before anyone reads, then ends with the source', async () => {
            const handlers: Record<string, (line: string) => void> = {};
            const lines = bufferedLines({
                on(event: string, listener: (line: string) => void) {
                    handlers[event] = listener;
                },
            } as Parameters<typeof bufferedLines>[0]);
            handlers.line!('early');
            handlers.line!('earlier');
            const seen: string[] = [];
            const reading = (async () => {
                for await (const line of lines) seen.push(line);
            })();
            await sleep(1);
            handlers.line!('late');
            await sleep(1);
            handlers.close!('');
            await reading;
            expect(seen).toStrictEqual(['early', 'earlier', 'late']);
        });
    });

    await describe('serveEmbedder', async () => {
        async function serve(create: () => Promise<Embedder | undefined>, lines: string[]) {
            const input = pipe();
            const written: string[] = [];
            const done = serveEmbedder(create, { lines: input.lines, write: (line) => written.push(line) });
            for (const line of lines) input.push(line);
            input.end();
            await done;
            return written.map((line) => JSON.parse(line) as unknown);
        }

        await it('says ready, answers in order, and disposes at the end of the pipe', async () => {
            const embedder = fakeEmbedder();
            const out = await serve(
                async () => embedder,
                ['{"id":1,"text":"ab"}', 'not a request', '{"id":2,"text":"abcd"}'],
            );
            expect(out).toStrictEqual([
                { type: 'ready', modelId: 'fake/model', dimensions: 2 },
                { id: 1, vector: [2, 0.5] },
                { id: 2, vector: [4, 0.5] },
            ]);
            expect(embedder.disposed).toBe(1);
        });

        await it('turns an embedding failure into an error answer and keeps serving', async () => {
            const out = await serve(
                async () => fakeEmbedder(),
                ['{"id":1,"text":"boom"}', '{"id":2,"text":"x"}'],
            );
            expect(out[1]).toStrictEqual({ id: 1, error: 'the model fell over' });
            expect(out[2]).toStrictEqual({ id: 2, vector: [1, 0.5] });
        });

        await it('says unavailable when there is no model, or it will not load', async () => {
            expect(await serve(async () => undefined, ['{"id":1,"text":"x"}'])).toStrictEqual([
                { type: 'unavailable' },
            ]);
            expect(
                await serve(async () => {
                    throw new Error('no gguf');
                }, []),
            ).toStrictEqual([{ type: 'unavailable' }]);
        });
    });

    await describe('createHelperEmbedder', async () => {
        await it('learns the model from ready, and embeds through the helper', async () => {
            const world = fakeWorld(answering());
            const embedder = await createHelperEmbedder({ spawn: world.spawn });
            expect(embedder?.modelId).toBe('fake/model');
            expect(embedder?.dimensions).toBe(2);
            const vector = await embedder?.embedQuery('abc');
            expect(vector instanceof Float32Array).toBe(true);
            expect(Array.from(vector ?? [])).toStrictEqual([3, 0.5]);
            expect(world.channels.length).toBe(1);
            embedder?.dispose();
        });

        await it('skips stray lines a native library wrote to stdout', async () => {
            const world = fakeWorld((channel) => {
                channel.emit('ggml_vulkan: Found 1 Vulkan device');
                channel.emit({ type: 'ready', modelId: 'fake/model', dimensions: 2 });
            });
            const embedder = await createHelperEmbedder({ spawn: world.spawn });
            expect(embedder === undefined).toBe(false);
            embedder?.dispose();
        });

        await it('is undefined, and ends the helper, when the machine has no model', async () => {
            const world = fakeWorld((channel) => channel.emit({ type: 'unavailable' }));
            expect(await createHelperEmbedder({ spawn: world.spawn })).toBe(undefined);
            expect(world.channels[0]?.closed).toBe(1);
        });

        await it('kills a helper that never gets ready', async () => {
            const world = fakeWorld(() => undefined);
            expect(await createHelperEmbedder({ spawn: world.spawn, startMs: 20 })).toBe(undefined);
            expect(world.channels[0]?.killed).toBe(1);
        });

        await it('rejects with what the helper said when it fails one query', async () => {
            const world = fakeWorld(answering(), false);
            const embedder = await createHelperEmbedder({ spawn: world.spawn });
            const asked = failure(embedder!.embedQuery('boom'));
            await sleep(1);
            const sent = JSON.parse(world.channels[0]!.sent[0]!) as { id: number };
            world.channels[0]!.emit({ id: sent.id, error: 'the model fell over' });
            expect(await asked).toBe('the model fell over');
            embedder?.dispose();
        });

        await it('fails the query in flight when the helper dies, and starts a new one for the next', async () => {
            const world = fakeWorld(answering(), false);
            const embedder = await createHelperEmbedder({ spawn: world.spawn });
            const asked = failure(embedder!.embedQuery('hello'));
            await sleep(1);
            world.channels[0]!.exit();
            expect(await asked).toBe('The embedding helper ended');
            expect(world.channels.length).toBe(1);

            const again = embedder!.embedQuery('hi');
            await sleep(1);
            expect(world.channels.length).toBe(2);
            const sent = JSON.parse(world.channels[1]!.sent[0]!) as { id: number };
            world.channels[1]!.emit({ id: sent.id, vector: [9, 9] });
            expect(Array.from(await again)).toStrictEqual([9, 9]);
            embedder?.dispose();
        });

        await it('kills a helper that does not answer a query', async () => {
            const world = fakeWorld(answering(), false);
            const embedder = await createHelperEmbedder({ spawn: world.spawn, requestMs: 20 });
            expect(await failure(embedder!.embedQuery('stuck'))).toBe('The embedding helper did not answer');
            expect(world.channels[0]?.killed).toBe(1);
            embedder?.dispose();
        });

        await it('ends the helper after a quiet spell and starts one on the next search', async () => {
            const world = fakeWorld(answering());
            const embedder = await createHelperEmbedder({ spawn: world.spawn, idleMs: 20 });
            await embedder!.embedQuery('a');
            await sleep(60);
            expect(world.channels[0]?.closed).toBe(1);
            expect(world.channels[0]?.killed).toBe(0);
            expect(Array.from(await embedder!.embedQuery('abc'))).toStrictEqual([3, 0.5]);
            expect(world.channels.length).toBe(2);
            embedder?.dispose();
        });

        await it('does not trust a respawned helper that loaded another model', async () => {
            const world = fakeWorld((channel, nth) =>
                answering(nth === 1 ? 'fake/model' : 'other/model')(channel, nth),
            );
            const embedder = await createHelperEmbedder({ spawn: world.spawn, idleMs: 20 });
            await sleep(60);
            expect(await failure(embedder!.embedQuery('a'))).toBe(
                'The embedding helper came up with another model',
            );
            expect(world.channels[1]?.killed).toBe(1);
            embedder?.dispose();
        });

        await it('closes the helper on dispose, and does not embed documents', async () => {
            const world = fakeWorld(answering());
            const embedder = await createHelperEmbedder({ spawn: world.spawn });
            embedder?.dispose();
            expect(world.channels[0]?.closed).toBe(1);
            expect(await failure(embedder!.embedDocuments([]))).toBe(
                'The query embedder does not embed documents',
            );
        });
    });

    await describe('window and helper joined', async () => {
        await it('answers through an in-memory pipe and lets the helper dispose when the window lets go', async () => {
            const embedder = fakeEmbedder();
            const spawn = (onLine: (line: string) => void): HelperChannel => {
                const input = pipe();
                const exited = serveEmbedder(async () => embedder, { lines: input.lines, write: onLine });
                return {
                    send: (line) => input.push(line),
                    close: () => input.end(),
                    kill: () => input.end(),
                    exited,
                };
            };
            const client = await createHelperEmbedder({ spawn });
            expect(client?.modelId).toBe('fake/model');
            expect(Array.from(await client!.embedQuery('four'))).toStrictEqual([4, 0.5]);
            expect(await failure(client!.embedQuery('boom'))).toBe('the model fell over');
            expect(embedder.calls).toStrictEqual(['four', 'boom']);
            client?.dispose();
            await sleep(5);
            expect(embedder.disposed).toBe(1);
        });
    });
};
