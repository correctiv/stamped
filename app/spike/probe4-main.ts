import { Worker } from 'node:worker_threads';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node';
const BIG = process.env.SPIKE_BIG_DB!;
let last = performance.now(), maxGap = 0;
setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 50);
function once(w: Worker, msg: any): Promise<any> {
    return new Promise((res) => { const h = (m: any) => { if (m.id === msg.id) { w.off('message', h); res(m); } }; w.on('message', h); w.postMessage(msg); });
}
const w = new Worker(new URL('./worker.mjs', import.meta.url));
await sleep(1200);
for (const n of [10000, 20000]) {
    maxGap = 0; last = performance.now();
    const t = performance.now();
    const r = await once(w, { id: n, op: 'query', path: BIG, sql: `SELECT * FROM big LIMIT ${n}` });
    console.log(`[${rt}] transfer rows=${n} totalMs=${Math.round(performance.now() - t)} workerMs=${Math.round(r.workMs)} maxParentGapMs=${maxGap.toFixed(0)}`);
}
await w.terminate();
const w2 = new Worker(new URL('./probe2-worker.mjs', import.meta.url));
await sleep(1200);
const r2 = await new Promise<any>((res) => { w2.on('message', (m: any) => { if (m.id === 3) res(m); }); w2.postMessage({ id: 3, op: 'u8' }); });
const x = r2.result ?? {};
const d = (v: any) => v === undefined ? "MISSING" : `${v?.constructor?.name}:${typeof v === "bigint" ? String(v) : JSON.stringify(v)}`;
console.log(`[${rt}] clone u=${d(x.u)} ab=${d(x.ab)} d=${d(x.d)} m=${d(x.m)} keys=${Object.keys(x)}`);
await w2.terminate();
process.exit(0);
