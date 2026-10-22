import { Worker } from 'node:worker_threads';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rt = typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node';
const url = new URL('./probe2-worker.mjs', import.meta.url);
async function spawn() {
    const w = new Worker(url);
    const ev: string[] = [];
    const replies: any[] = [];
    w.on('error', (e: any) => ev.push('error:' + String(e?.message ?? e)));
    w.on('exit', (c: number) => ev.push('exit:' + c));
    w.on('message', (m: any) => replies.push(m));
    await sleep(1200);
    return { w, ev, replies };
}
async function main() {
    for (const n of [100000, 1000000, 3000000, 8000000]) {
        const { w, replies } = await spawn();
        w.postMessage({ id: 1, op: 'cte', n });
        for (let i = 0; i < 100 && replies.length < 2; i++) await sleep(100);
        console.log(`[${rt}] cte n=${n}`, JSON.stringify(replies.slice(1)));
        await w.terminate();
    }
    for (const op of ['throwSync', 'throwTimer', 'rejection']) {
        const { w, ev, replies } = await spawn();
        w.postMessage({ id: 2, op });
        await sleep(1500);
        console.log(`[${rt}] ${op} events=${JSON.stringify(ev)} replies=${JSON.stringify(replies.slice(1))}`);
        await w.terminate();
    }
    {
        const { w, replies } = await spawn();
        w.postMessage({ id: 3, op: 'u8' });
        await sleep(800);
        const r = replies[1]?.result;
        console.log(`[${rt}] clone`, JSON.stringify({ u: r?.u?.constructor?.name, ab: r?.ab?.constructor?.name, d: r?.d?.constructor?.name, m: r?.m?.constructor?.name, big: typeof r?.big, raw: JSON.stringify(r?.u) }));
        await w.terminate();
    }
    // inline contrast: same CTE on main thread
}
await main();
process.exit(0);
