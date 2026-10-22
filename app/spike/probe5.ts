import { Worker } from 'node:worker_threads';
const rt = typeof (globalThis as any).imports !== 'undefined' ? 'gjs' : 'node';
const code = `const { parentPort } = require('node:worker_threads'); parentPort.postMessage('eval-ok');`;
const code2 = `import('node:worker_threads').then(({parentPort}) => parentPort.postMessage('eval-import-ok'));`;
for (const c of [code2]) {
    const w = new Worker(c, { eval: true });
    const r = await Promise.race([
        new Promise((res) => { w.on('message', res); w.on('error', (e: any) => res('error:' + e?.message)); }),
        new Promise((res) => setTimeout(() => res('timeout'), 4000)),
    ]);
    console.log(`[${rt}] eval ${r}`);
    await w.terminate();
}
process.exit(0);
