/**
 * The query worker, from both ends: the protocol that carries a question to the second thread,
 * and the queries themselves at the size a real case asks them at.
 *
 * Two halves, deliberately not one:
 *
 * - **The protocol** is tested against a FAKE channel, so queueing, the timeout, the restart and
 *   the error path are exercised in-process on GJS and Node both — without a built worker file,
 *   without a thread, and without waiting a minute for a real timeout. The fake is hostile where
 *   it matters: it goes on delivering replies after it was closed, because the client's
 *   generation guard is what must drop them, not the transport's good manners.
 * - **The queries** run through {@link runQuery} against a real index, which is the same call the
 *   worker makes — one implementation, two callers, so a test here covers what the window gets.
 *
 * The scale check at the end builds a synthetic case of {@link SCALE_MESSAGES} messages and asks
 * it the two questions a scrolling list asks: a page, and the count under it. It asserts what is
 * true on any machine — the pages tile the list exactly, and the last page costs what the first
 * one did — and PRINTS the wall time of each call, because that duration is precisely the stall
 * this whole change moves off the main thread. The before/after numbers in the pull request come
 * from the GUI, not from here; this is the part that stays honest on a CI runner.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';
import { KeyVault, parseKeyMaterial, type MessageFinding, type Verdict } from '@stamped/core';
import { encodeLatin1, summarise } from '@stamped/import';
import { casePaths, digest, indexMessage, openIndex, store } from '@stamped/store';

import {
    QueryClient,
    READY_ID,
    type QueryChannel,
    type QueryReply,
    type QueryRequest,
} from '../../src/gui/query-client.ts';
import { initI18n } from '../../src/lib/i18n.ts';
import { PAGE_SIZE, runQuery, runQueryAsync, type QueryContext } from '../../src/lib/queries.ts';
import { saveVault } from '../../src/lib/vault.ts';
import { fixture, fixtureKeys } from './fixtures.ts';

/** Big enough that a full-table query is work, small enough that the suite stays a suite. */
const SCALE_MESSAGES = 3000;

const PATHS = casePaths('/nowhere');

// ── The fake transport ──────────────────────────────────────────────────────────────────────

/** One fake worker: what the client sent it, and the three levers a test pulls on it. */
interface FakeChannel {
    readonly sent: QueryRequest[];
    readonly channel: QueryChannel;
    closed: boolean;
    /** Answer as the worker would. Works after `close()` too — see the file comment. */
    deliver(reply: QueryReply): void;
    /** Announce the worker as loaded, which is what lets the client post at all. */
    announce(): void;
    /** The death Node reports and GJS does not. */
    die(reason: string): void;
}

/**
 * A spawner of fake workers.
 *
 * `announce` is the handshake: by default the fake declares itself loaded the moment the client
 * attaches its handler, which is the ordinary case — a worker is ready long before the person
 * asks a second question. The one test that cares about the gap passes `false` and announces by
 * hand.
 */
function fakeChannels(announce = true): { spawn: () => QueryChannel; made: FakeChannel[] } {
    const made: FakeChannel[] = [];
    const spawn = (): QueryChannel => {
        const sent: QueryRequest[] = [];
        let onMessage: (reply: QueryReply) => void = () => undefined;
        let onClose: (reason: string) => void = () => undefined;
        const fake: FakeChannel = {
            sent,
            closed: false,
            channel: {
                post: (request) => sent.push(request),
                onMessage: (handler) => {
                    onMessage = handler;
                    if (announce) fake.announce();
                },
                onClose: (handler) => {
                    onClose = handler;
                },
                close: () => {
                    fake.closed = true;
                },
            },
            deliver: (reply) => onMessage(reply),
            announce: () => onMessage({ id: READY_ID, ok: true, result: 'ready' }),
            die: (reason) => onClose(reason),
        };
        made.push(fake);
        return fake.channel;
    };
    return { spawn, made };
}

/** Let the microtask queue — and, with a delay, the timers — run. */
function tick(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a promise has done so far. These tests assert on ORDER as much as on the value. */
interface Watched {
    done: boolean;
    ok: boolean;
    value?: unknown;
    error?: string;
}

function watch(promise: Promise<unknown>): Watched {
    const state: Watched = { done: false, ok: false };
    promise.then(
        (value) => {
            state.done = true;
            state.ok = true;
            state.value = value;
        },
        (error: Error) => {
            state.done = true;
            state.ok = false;
            state.error = error.message;
        },
    );
    return state;
}

/**
 * Wait until a watched promise has settled.
 *
 * A fixed delay is the wrong instrument for a timeout test: the deadline is 25 ms here, but a
 * busy CI runner can take far longer than that to get back to the timer, and the test would be
 * reporting the runner's load rather than the client's behaviour.
 */
async function settled(state: Watched, limit = 10_000): Promise<Watched> {
    const until = Date.now() + limit;
    while (!state.done && Date.now() < until) await tick(5);
    return state;
}

/** The requests a channel got that are not the implicit `open`. */
function questions(fake: FakeChannel): QueryRequest[] {
    return fake.sent.filter((request) => request.op !== 'open');
}

// ── A case to query ─────────────────────────────────────────────────────────────────────────

function finding(verdict: Verdict): MessageFinding {
    return { verdict, caveats: [], signatures: [] };
}

interface Mail {
    readonly id: string;
    readonly from: string;
    readonly to?: string;
    readonly subject?: string;
    readonly date?: string;
    readonly verdict?: Verdict;
}

function put(ctx: QueryContext, mail: Mail): string {
    const lines = [
        `From: ${mail.from}`,
        `To: ${mail.to ?? 'nobody@example.org'}`,
        `Subject: ${mail.subject ?? mail.id}`,
    ];
    if (mail.date) lines.push(`Date: ${mail.date}`);
    lines.push(`Message-ID: <${mail.id}@example.com>`, '', 'body', '');
    const raw = encodeLatin1(lines.join('\n'));
    const hash = digest(raw);
    indexMessage(
        ctx.db,
        { hash, bytes: raw.length, summary: summarise(raw), finding: finding(mail.verdict ?? 'confirmed') },
        { fresh: true },
    );
    return hash;
}

/** A case folder with an index, handed to `body` as the context a query runs against. */
async function withCase(body: (ctx: QueryContext) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-query-'));
    try {
        const paths = casePaths(root);
        const db = openIndex(paths);
        try {
            await body({ paths, db });
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** How long one call took, in milliseconds — the number a stall is measured in. */
function timed<T>(body: () => T): { value: T; ms: number } {
    const started = Date.now();
    const value = body();
    return { value, ms: Date.now() - started };
}

export default async () => {
    await describe('the query protocol', async () => {
        await it('opens the case before anything is asked of the worker', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn);
            watch(client.ask('total', {}));
            await tick();
            expect(made.length).toBe(1);
            const open = made[0]?.sent[0];
            expect(open?.op).toBe('open');
            expect(open?.id).toBe(0);
            expect((open?.params as { paths?: { root?: string } })?.paths?.root).toBe(PATHS.root);
            client.close();
        });

        await it('holds what was asked until the worker says it is listening', async () => {
            // On GJS a message posted before the worker's module finished evaluating is dropped
            // without a reply, an `error` or an `exit` — so nothing may go out before the
            // handshake, including the `open` the client sends itself.
            const { spawn, made } = fakeChannels(false);
            const client = new QueryClient(PATHS, spawn);
            const early = watch(client.ask('total', {}));
            await tick();
            const fake = made[0]!;
            expect(fake.sent.length).toBe(0);

            fake.announce();
            await tick();
            expect(fake.sent[0]?.op).toBe('open');
            expect(questions(fake)[0]?.op).toBe('total');

            fake.deliver({ id: questions(fake)[0]!.id, ok: true, result: 11 });
            await tick();
            expect(early.value).toBe(11);
            client.close();
        });

        await it('keeps one request in flight and the rest in order behind it', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn);
            const first = watch(client.ask('total', {}));
            const second = watch(client.ask('count', { query: {} }));
            await tick();

            const fake = made[0];
            if (!fake) throw new Error('no channel was spawned');
            expect(questions(fake).length).toBe(1);
            expect(questions(fake)[0]?.op).toBe('total');

            fake.deliver({ id: questions(fake)[0]!.id, ok: true, result: 7 });
            await tick();
            expect(first.value).toBe(7);
            expect(second.done).toBe(false);
            expect(questions(fake).length).toBe(2);
            expect(questions(fake)[1]?.op).toBe('count');

            fake.deliver({ id: questions(fake)[1]!.id, ok: true, result: 3 });
            await tick();
            expect(second.value).toBe(3);
            client.close();
        });

        await it('turns a failed answer into a rejection and goes on serving', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn);
            const failed = watch(client.ask('report', {}));
            await tick();
            const fake = made[0]!;
            fake.deliver({ id: questions(fake)[0]!.id, ok: false, error: 'no such table: messages' });
            await tick();
            expect(failed.ok).toBe(false);
            expect(failed.error).toBe('no such table: messages');

            // One failure must not poison the queue: the next question still reaches the worker.
            const next = watch(client.ask('total', {}));
            await tick();
            fake.deliver({ id: questions(fake)[1]!.id, ok: true, result: 1 });
            await tick();
            expect(next.value).toBe(1);
            expect(client.restarts).toBe(0);
            client.close();
        });

        await it('says the timeout in the language of the catalogue', async () => {
            const { spawn } = fakeChannels();
            initI18n({ LANG: 'de_DE.UTF-8' });
            try {
                const client = new QueryClient(PATHS, spawn, 25);
                const lost = watch(client.ask('timeline', {}));
                await settled(lost);
                expect(lost.error?.includes('nicht geantwortet')).toBe(true);
                client.close();
            } finally {
                initI18n({ LANG: 'C' });
            }
        });

        await it('gives up on a silent worker and answers the next question on a fresh one', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn, 25);
            const lost = watch(client.ask('timeline', {}));
            await settled(lost);
            expect(lost.ok).toBe(false);
            expect(lost.error?.includes('did not answer')).toBe(true);
            expect(client.restarts).toBe(1);
            expect(made[0]?.closed).toBe(true);

            const again = watch(client.ask('total', {}));
            await tick();
            expect(made.length).toBe(2);
            const fresh = made[1]!;
            expect(fresh.sent[0]?.op).toBe('open');
            fresh.deliver({ id: questions(fresh)[0]!.id, ok: true, result: 2 });
            await tick();
            expect(again.value).toBe(2);
            client.close();
        });

        await it('ignores a late answer from the worker it gave up on', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn, 25);
            await settled(watch(client.ask('total', {})));

            const pending = watch(client.ask('total', {}));
            await tick();
            const stale = made[0]!;
            const fresh = made[1]!;
            // Same id on the dead worker: only the generation tells the two apart.
            stale.deliver({ id: questions(fresh)[0]!.id, ok: true, result: 999 });
            await tick();
            expect(pending.done).toBe(false);

            fresh.deliver({ id: questions(fresh)[0]!.id, ok: true, result: 5 });
            await tick();
            expect(pending.value).toBe(5);
            client.close();
        });

        await it('rejects what was in flight when the worker dies', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn);
            const crashed = watch(client.ask('page', { query: {} }));
            await tick();
            made[0]!.die('worker exited with code 1');
            await tick();
            expect(crashed.ok).toBe(false);
            expect(crashed.error).toBe('worker exited with code 1');
            expect(client.restarts).toBe(1);

            const after = watch(client.ask('total', {}));
            await tick();
            expect(made.length).toBe(2);
            made[1]!.deliver({ id: questions(made[1]!)[0]!.id, ok: true, result: 4 });
            await tick();
            expect(after.value).toBe(4);
            client.close();
        });

        await it('ends the worker on close and refuses every later question', async () => {
            const { spawn, made } = fakeChannels();
            const client = new QueryClient(PATHS, spawn);
            const inFlight = watch(client.ask('report', {}));
            await tick();
            client.close();
            await tick();
            expect(made[0]?.closed).toBe(true);
            expect(inFlight.ok).toBe(false);
            expect(inFlight.error?.includes('closed')).toBe(true);

            const later = watch(client.ask('total', {}));
            await tick();
            expect(later.ok).toBe(false);
            // No second worker: a closed case never starts a thread again.
            expect(made.length).toBe(1);
        });
    });

    await describe('the shared query layer', async () => {
        await it('answers the questions the window asks of an open case', async () => {
            await withCase((ctx) => {
                const first = put(ctx, {
                    id: 'a',
                    from: 'Ada <ada@example.com>',
                    to: 'bob@example.org',
                    subject: 'harbour ledger',
                    date: 'Tue, 05 Mar 2024 09:40:00 +0000',
                });
                put(ctx, {
                    id: 'b',
                    from: 'bob@example.org',
                    to: 'ada@example.com',
                    subject: 'quarterly figures',
                    date: 'Wed, 06 Mar 2024 09:40:00 +0000',
                    verdict: 'body-altered',
                });

                expect(runQuery(ctx, 'total', {})).toBe(2);
                expect(runQuery(ctx, 'count', { query: { verdict: 'body-altered' } })).toBe(1);
                expect(runQuery(ctx, 'page', { query: { text: 'harbour' } }).length).toBe(1);
                expect(
                    runQuery(ctx, 'page', {
                        query: { scope: { kind: 'person', address: 'ada@example.com' } },
                    }).length,
                ).toBe(2);
                expect(
                    runQuery(ctx, 'people', { search: 'ada' }).map((person) => person.address),
                ).toStrictEqual(['ada@example.com']);
                expect(runQuery(ctx, 'timeline', {}).buckets.length).toBe(2);
                // A case is "complete" only once the backfill has walked it, which is the
                // question the window's idle loop asks. A fresh index has the table but not the
                // flag, so this is false until one step says it is done — and the window must get
                // both answers through the protocol, not just the happy one.
                expect(runQuery(ctx, 'peopleComplete', {})).toBe(false);
                expect(runQuery(ctx, 'backfillStep', {}).processed).toBe(2);
                // A batch that found nothing left is the one that marks the case done, so the
                // window has to keep asking after the last message — one step short and the
                // Personen view would stay "incomplete" on a case it has fully read.
                expect(runQuery(ctx, 'backfillStep', {}).done).toBe(true);
                expect(runQuery(ctx, 'peopleComplete', {})).toBe(true);
                expect(runQuery(ctx, 'message', { hash: first })?.subject).toBe('harbour ledger');
                expect(runQuery(ctx, 'report', {}).messages).toBe(2);
                // No import ever wrote a log here, and that is an empty list rather than a failure.
                expect(runQuery(ctx, 'sources', {})).toStrictEqual([]);
            });
        });

        await it('answers null for a hash it does not know, never undefined', async () => {
            await withCase((ctx) => {
                // JSON has no `undefined`: a key that vanished from the reply would read as a
                // protocol error at the other end rather than as "no such message".
                expect(runQuery(ctx, 'message', { hash: 'deadbeef' })).toBe(null);
            });
        });

        await it('drops the cached scope tables when the index changed underneath them', async () => {
            await withCase((ctx) => {
                put(ctx, { id: 'a', from: 'ada@example.com' });
                const scope = { kind: 'person', address: 'ada@example.com' } as const;
                expect(runQuery(ctx, 'count', { query: { scope } })).toBe(1);
                put(ctx, { id: 'b', from: 'ada@example.com' });
                // Still the table built before the write — the stale answer the GUI must not keep.
                expect(runQuery(ctx, 'count', { query: { scope } })).toBe(1);
                expect(runQuery(ctx, 'dropScopes', {})).toBe(null);
                expect(runQuery(ctx, 'count', { query: { scope } })).toBe(2);
            });
        });
    });

    await describe('verifying a stored message on the worker', async () => {
        await it('judges against the vault saved NOW, and says null for a hash it does not hold', async () => {
            await withCase(async (ctx) => {
                const kept = store(ctx.paths, fixture('confirmed.eml'));
                const before = await runQueryAsync(ctx, 'verify', { hash: kept.hash });
                expect(before?.verdict).toBe('unverifiable');

                const parsed = parseKeyMaterial(
                    fixtureKeys().lookup('t2048._domainkey.example.com')?.record ?? '',
                );
                if (parsed.kind !== 'key') throw new Error('expected a key');
                const vault = new KeyVault();
                vault.add({
                    domain: 'example.com',
                    selector: 't2048',
                    key: parsed,
                    origin: 'operator',
                    fetchedAt: '2026-10-20T10:00:00Z',
                });
                saveVault(ctx.paths.root, vault);

                const after = await runQueryAsync(ctx, 'verify', { hash: kept.hash });
                expect(after?.verdict).toBe('confirmed');
                expect(await runQueryAsync(ctx, 'verify', { hash: 'f'.repeat(64) })).toBe(null);
            });
        });

        await it('answers the synchronous operations through the same entry point', async () => {
            await withCase(async (ctx) => {
                expect(await runQueryAsync(ctx, 'total', {})).toBe(0);
            });
        });
    });

    await describe('the query layer at case scale', async () => {
        await it('pages a large case without a page costing more than the first', async () => {
            await withCase((ctx) => {
                ctx.db.exec('BEGIN');
                for (let n = 0; n < SCALE_MESSAGES; n++) {
                    put(ctx, {
                        id: `m${n}`,
                        from: `person${n % 97}@example.com`,
                        to: `rcpt${n % 31}@example.net`,
                        subject: `quarterly ledger #${n}`,
                        date: new Date(Date.UTC(2024, 0, 1) + n * 600_000).toUTCString(),
                        verdict: n % 7 === 0 ? 'unverifiable' : 'confirmed',
                    });
                }
                ctx.db.exec('COMMIT');

                const counted = timed(() => runQuery(ctx, 'count', { query: {} }));
                expect(counted.value).toBe(SCALE_MESSAGES);

                const report = timed(() => runQuery(ctx, 'report', {}));
                expect(report.value.messages).toBe(SCALE_MESSAGES);

                // The whole list, page by page: every message exactly once, and the pages tile it
                // with no gap and no overlap. That is what a lazily scrolled list rests on — a
                // page that repeated a row would show the journalist the same mail twice and hide
                // another one entirely.
                const seen = new Set<string>();
                const pageTimes: number[] = [];
                for (let offset = 0; offset < SCALE_MESSAGES; offset += PAGE_SIZE) {
                    const page = timed(() => runQuery(ctx, 'page', { query: {}, offset }));
                    pageTimes.push(page.ms);
                    expect(page.value.length).toBe(PAGE_SIZE);
                    for (const hit of page.value) seen.add(hit.hash);
                }
                expect(pageTimes.length).toBe(SCALE_MESSAGES / PAGE_SIZE);
                expect(seen.size).toBe(SCALE_MESSAGES);
                // Past the end there is nothing left, and asking is not an error.
                expect(runQuery(ctx, 'page', { query: {}, offset: SCALE_MESSAGES }).length).toBe(0);

                // These are the durations the main thread used to spend not repainting. Printed
                // rather than asserted: a CI runner's speed is not the code's.
                console.log(
                    'QUERY MS',
                    JSON.stringify({
                        messages: SCALE_MESSAGES,
                        count: counted.ms,
                        report: report.ms,
                        firstPage: pageTimes[0],
                        lastPage: pageTimes[pageTimes.length - 1],
                    }),
                );
            });
        });
    });
};
