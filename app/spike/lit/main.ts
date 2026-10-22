import { Worker } from 'node:worker_threads';
const w = new Worker(new URL('./lit-worker.ts', import.meta.url));
w.on('message', (m: unknown) => { console.log('got', JSON.stringify(m)); process.exit(0); });
w.on('error', (e: unknown) => { console.log('err', String(e)); process.exit(1); });
await new Promise(() => {});
