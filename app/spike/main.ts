import { Worker } from 'node:worker_threads';

const CASE_DB = process.env.SPIKE_CASE_DB!;
const BIG_DB = process.env.SPIKE_BIG_DB!;
const WORKER_URL = new URL(process.env.SPIKE_WORKER ?? './worker.mjs', import.meta.url);
const runtime = typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node';
const out: Record<string, unknown> = { runtime, workerUrl: WORKER_URL.href };
const log = (k: string, v: unknown) => {
    out[k] = v;
    console.log(`[${runtime}] ${k} = ${JSON.stringify(v)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 1;
const pending = new Map<number, (m: any) => void>();
function call(w: Worker, msg: Record<string, unknown>): Promise<any> {
    const id = seq++;
    return new Promise((res) => {
        pending.set(id, res);
        w.postMessage({ id, ...msg });
    });
}

function attach(w: Worker, onReady: (m: any) => void) {
    w.on('message', (m: any) => {
        if (m.ready) return onReady(m);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
    });
}

async function main() {
    // 1. startup
    const t0 = performance.now();
    let w: Worker;
    const ready = new Promise<any>((res) => {
        w = new Worker(WORKER_URL, { workerData: { hello: 'wd' } });
        attach(w, res);
        w.on('error', (e) => log('earlyError', String(e)));
    });
    const r = await Promise.race([ready, sleep(15000).then(() => 'timeout')]);
    log('startupMs', Math.round(performance.now() - t0));
    log('ready', r);
    if (r === 'timeout') return;
    const t1 = performance.now();
    await call(w!, { op: 'ping' });
    log('pingRoundTripMs', +(performance.now() - t1).toFixed(2));

    // 2. case db
    const cnt = await call(w!, { op: 'query', path: CASE_DB, sql: 'SELECT count(*) AS n FROM messages' });
    log('caseCount', cnt.error ?? cnt.result);
    const fts = await call(w!, { op: 'query', path: CASE_DB, sql: "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'the'" });
    log('caseFts', fts.error ?? fts.result);

    // seed big table
    const seed = await call(w!, {
        op: 'exec', path: BIG_DB,
        sql: `CREATE TABLE IF NOT EXISTS big AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20000) SELECT x AS id, 'subject number ' || x AS subject, CASE WHEN x%5=0 THEN NULL ELSE 'sender' || (x%97) || '@example.com' END AS sender, x*1.5 AS score, x%7 AS bucket, 'a body of some typical length ' || x || ' lorem ipsum dolor sit amet' AS snippet FROM c`,
    });
    log('seed', seed.error ?? seed.result);

    // 3. structured clone
    for (const n of [1000, 10000, 20000]) {
        const ts = performance.now();
        const q = await call(w!, { op: 'query', path: BIG_DB, sql: `SELECT * FROM big LIMIT ${n}` });
        const rt = performance.now() - ts;
        const rows = q.result as any[];
        const ok = Array.isArray(rows) && rows.length === n && rows[4].sender === null && typeof rows[0].score === 'number' && typeof rows[0].subject === 'string';
        log(`rows${n}`, { roundTripMs: +rt.toFixed(1), workerMs: +q.workMs?.toFixed(1), shapeOk: ok, err: q.error, sample: rows?.[4] });
    }
    for (const n of [1_000_000]) {
        const ts = performance.now();
        const q = await call(w!, { op: 'bytes', n });
        const rt = performance.now() - ts;
        const u = q.result?.u;
        log(`bytes${n}`, { roundTripMs: +rt.toFixed(1), isU8: u instanceof Uint8Array, ctor: u?.constructor?.name, len: u?.length, v1000: u?.[1000], err: q.error });
    }
    {
        const q = await call(w!, { op: 'query', path: BIG_DB, sql: 'SELECT randomblob(16) AS b, 1 AS i' });
        const b = q.result?.[0]?.b;
        log('blobFromSqlite', { err: q.error, ctor: b?.constructor?.name, isU8: b instanceof Uint8Array, len: b?.length });
    }

    // 4. responsiveness
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const iv = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
    }, 50);
    await sleep(300);
    log('idleMaxGapMs', +maxGap.toFixed(1));
    maxGap = 0; ticks = 0; last = performance.now();
    const ts = performance.now();
    const slow = await call(w!, { op: 'query', path: BIG_DB, sql: 'SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<8000000) SELECT x FROM c)' });
    const dur = performance.now() - ts;
    log('slowQuery', { totalMs: Math.round(dur), workerMs: Math.round(slow.workMs), maxGapMs: +maxGap.toFixed(1), ticks, expectedTicks: Math.round(dur / 50), res: slow.result, err: slow.error });
    // contrast: the same query inline on the main thread
    maxGap = 0; ticks = 0; last = performance.now();
    const { DatabaseSync } = await import('node:sqlite');
    const inl = new DatabaseSync(BIG_DB);
    const ti = performance.now();
    inl.prepare('SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<8000000) SELECT x FROM c)').all();
    await sleep(120);
    log('inlineQuery', { totalMs: Math.round(performance.now() - ti), maxGapMs: +maxGap.toFixed(1) });
    clearInterval(iv);

    // 5a. terminate while running
    const slowP = call(w!, { op: 'query', path: BIG_DB, sql: 'SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<80000000) SELECT x FROM c)' });
    await sleep(500);
    const exitP = new Promise<number>((res) => w!.once('exit', res));
    const tt = performance.now();
    const termRet = await w!.terminate();
    const code = await Promise.race([exitP, sleep(10000).then(() => 'no-exit-in-10s')]);
    log('terminateWhileQuery', { ms: Math.round(performance.now() - tt), termRet, exitCode: code });
    void slowP;

    // 5b. crash
    let errEvent: string | null = null;
    let exited: unknown = 'none';
    const w2ready = new Promise<any>((res) => {
        const w2 = new Worker(WORKER_URL);
        attach(w2, res);
        w2.on('error', (e: any) => { errEvent = String(e?.message ?? e); });
        w2.on('exit', (c: number) => { exited = c; });
        res(w2);
    });
    const w2 = await w2ready;
    await sleep(1500);
    w2.postMessage({ id: 999, op: 'crash' });
    await sleep(2000);
    log('crash', { errorEvent: errEvent, exitCode: exited });

    // 5c. restart cost after terminate
    const t3 = performance.now();
    const w3ready = new Promise<any>((res) => { const w3 = new Worker(WORKER_URL); attach(w3, () => res(w3)); });
    const w3 = await w3ready;
    log('restartMs', Math.round(performance.now() - t3));
    await w3.terminate();
    try { await w2.terminate(); } catch {}
}

await main().then(() => {
    console.log('SPIKE-DONE ' + JSON.stringify(out));
    process.exit(0);
}, (e) => {
    console.log('SPIKE-FAIL', e?.stack ?? e);
    process.exit(1);
});
