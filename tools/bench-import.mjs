#!/usr/bin/env node
// Measures `importSources` throughput and peak RSS on Node, against a synthetic archive:
//
//   node tools/make-load-archive.mjs /tmp/sload 5000
//   node --experimental-strip-types tools/bench-import.mjs /tmp/sload
//
// For GJS, time the bundle instead (see docs in make-load-archive.mjs):
//   /usr/bin/time -v gjsify run app/dist/stamped.gjs.mjs import <case> <mbox> --key … --no-lookup --quiet
//
// The case folder is created under the archive directory and deleted afterwards.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { KeyStore, recordFromPem } from '../packages/core/src/index.ts';
import { importSources, openCase } from '../packages/store/src/index.ts';

const dir = process.argv[2];
if (!dir) {
    console.error('usage: bench-import.mjs <dir with load.mbox and keys/>');
    process.exit(2);
}

const keys = new KeyStore();
for (const name of readdirSync(join(dir, 'keys'))) {
    const dns = name.replace(/\.pub\.pem$/, '');
    keys.add(dns, recordFromPem(readFileSync(join(dir, 'keys', name), 'utf8')), 'operator');
}

const root = mkdtempSync(join(dir, 'case-'));
let peak = 0;
const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
}, 200);

const started = Date.now();
const result = await importSources(openCase(root), [join(dir, 'load.mbox')], { keys });
const seconds = (Date.now() - started) / 1000;
clearInterval(sample);
peak = Math.max(peak, process.memoryUsage().rss);

console.log(
    JSON.stringify({
        read: result.read,
        indexed: result.indexed,
        seconds: Number(seconds.toFixed(1)),
        mailsPerSecond: Number((result.read / seconds).toFixed(1)),
        peakRssMiB: Math.round(peak / 1048576),
        mboxMiB: Math.round(statSync(join(dir, 'load.mbox')).size / 1048576),
    }),
);
rmSync(root, { recursive: true, force: true });
