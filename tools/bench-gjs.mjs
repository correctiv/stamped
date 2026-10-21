#!/usr/bin/env node
// The big import benchmark, on the real Gjs bundle (the numbers that matter for the app):
//
//   gjsify workspace stamped-cli bench [count=5000]
//
// Builds a synthetic archive under the system temp directory (nothing is written into the repo),
// imports it with `app/dist/stamped.gjs.mjs` — build it first — and prints mails/s plus the
// resident memory sampled every five seconds, so a leak shows as a curve rather than a number —
// and as one figure, `rssMiBPer1000Mails`: the slope of that curve after the first sample, which
// is ~0 for a pipeline that holds nothing and ~the archive's size per 1000 mails for one that does.
// Not part of `gjsify test`: it takes minutes and needs gigabytes of disk at 30 000 mails.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const count = Number(process.argv[2] ?? 5000);
const bundle = join(root, 'app', 'dist', 'stamped.gjs.mjs');
if (!existsSync(bundle)) {
    console.error('build the bundle first: gjsify workspace stamped-cli build');
    process.exit(2);
}

/** Least-squares slope of the samples after the first (the warm-up), as MiB per 1000 mails. */
function slopePer1000(samples, mailsPerSecond) {
    const settled = samples.slice(1);
    if (settled.length < 3) return null;
    const n = settled.length;
    const mean = (n - 1) / 2;
    const my = settled.reduce((sum, y) => sum + y, 0) / n;
    let num = 0;
    let den = 0;
    settled.forEach((y, i) => {
        num += (i - mean) * (y - my);
        den += (i - mean) ** 2;
    });
    const perSample = num / den;
    return Number(((perSample / (5 * mailsPerSecond)) * 1000).toFixed(2));
}

const work = mkdtempSync(join(tmpdir(), 'stamped-bench-'));
try {
    const made = spawnSync('node', [join(root, 'tools', 'make-load-archive.mjs'), work, String(count)], {
        stdio: 'inherit',
    });
    if (made.status !== 0) process.exit(made.status ?? 1);

    const keys = readdirSync(join(work, 'keys')).flatMap((name) => [
        '--key',
        `${name.replace(/\.pub\.pem$/, '')}=${join(work, 'keys', name)}`,
    ]);
    const started = Date.now();
    const child = spawn(
        'gjsify',
        [
            'run',
            bundle,
            'import',
            '--case',
            join(work, 'case'),
            join(work, 'load.mbox'),
            ...keys,
            '--no-lookup',
            '--quiet',
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const curve = [];
    const sample = setInterval(() => {
        const pids = spawnSync('pgrep', ['-f', `${join(work, 'case')} `])
            .stdout.toString()
            .trim()
            .split('\n');
        const pid = pids.at(-1);
        try {
            const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
            if (rss) curve.push(Math.round(Number(rss) / 1024));
        } catch {
            // the process ended between pgrep and the read
        }
    }, 5000);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    clearInterval(sample);
    const seconds = (Date.now() - started) / 1000;
    const mailsPerSecond = count / seconds;
    console.log(
        JSON.stringify({
            exit: code,
            mails: count,
            seconds: Number(seconds.toFixed(1)),
            mailsPerSecond: Number(mailsPerSecond.toFixed(1)),
            rssMiBEvery5s: curve,
            rssMiBPer1000Mails: slopePer1000(curve, mailsPerSecond),
        }),
    );
} finally {
    rmSync(work, { recursive: true, force: true });
}
