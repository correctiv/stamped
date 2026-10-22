import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.SPIKE_BIG_DB!);
parentPort!.on('message', (m: any) => {
    const t0 = performance.now();
    try {
        if (m.op === 'cte') {
            const r = db.prepare(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${m.n}) SELECT count(*) AS n FROM c`).all();
            parentPort!.postMessage({ id: m.id, result: r, workMs: performance.now() - t0 });
        } else if (m.op === 'throwSync') {
            throw new Error('sync boom');
        } else if (m.op === 'throwTimer') {
            setTimeout(() => { throw new Error('timer boom'); }, 0);
        } else if (m.op === 'rejection') {
            Promise.reject(new Error('rejection boom'));
        } else if (m.op === 'u8') {
            parentPort!.postMessage({ id: m.id, result: { u: new Uint8Array([1, 2, 3]), ab: new ArrayBuffer(4), d: new Date(0), m: new Map([[1, 2]]) } });
        } else if (m.op === 'big') {
            parentPort!.postMessage({ id: m.id, result: { big: 5n } });
        }
    } catch (e: any) {
        parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : 'nonError:' + typeof e + ':' + String(e), keys: e && typeof e === 'object' ? Object.keys(e) : [] });
    }
});
parentPort!.postMessage({ ready: true });
