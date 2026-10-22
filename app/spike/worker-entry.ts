import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const dbs = new Map<string, DatabaseSync>();
function db(path: string): DatabaseSync {
    let d = dbs.get(path);
    if (!d) {
        d = new DatabaseSync(path);
        dbs.set(path, d);
    }
    return d;
}

parentPort!.postMessage({ id: 0, ready: true, runtime: typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node', workerData });

parentPort!.on('message', (m: any) => {
    const t0 = performance.now();
    try {
        let result: unknown;
        switch (m.op) {
            case 'ping':
                result = 'pong';
                break;
            case 'query':
                result = db(m.path).prepare(m.sql).all(...(m.params ?? []));
                break;
            case 'exec':
                db(m.path).exec(m.sql);
                result = 'ok';
                break;
            case 'bytes': {
                const u = new Uint8Array(m.n);
                for (let i = 0; i < m.n; i++) u[i] = i & 255;
                result = { u, label: 'bytes' };
                break;
            }
            case 'crash':
                setTimeout(() => {
                    throw new Error('boom from worker');
                }, 0);
                return;
            default:
                throw new Error('unknown op ' + m.op);
        }
        parentPort!.postMessage({ id: m.id, result, workMs: performance.now() - t0 });
    } catch (e: any) {
        parentPort!.postMessage({ id: m.id, error: String(e?.message ?? e), workMs: performance.now() - t0 });
    }
});
