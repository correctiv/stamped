#!/usr/bin/env node
// Does semantic search work in a built macOS .app, with nothing but what the .app carries?
//
//   node app/tests/macos/check-semantic.mjs path/to/Stamped.app
//
// It runs the .app's own launcher against a SYNTHETIC case (generated here, never a real mail):
// import → probe → index → ask the query helper for a meaning that shares no word with the mail.
// Every step has failed in a macOS build before, and `check-app.mjs` cannot see any of them
// because it only starts the window:
//
//   - the app took Node with node-gi for GJS and reported "no model here";
//   - the model lookup read only the first XDG_DATA_DIRS entry, which is GTK's;
//   - the CPU fallback compiled llama.cpp from source, which needs a toolchain;
//   - the case window asked for `query-worker.gjs.mjs`, which a Node bundle does not carry.
//
// The environment is scrubbed on purpose: no STAMPED_EMBED_MODEL, no inherited XDG_*, a private
// HOME. Exit code 0 only when every check passes.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const appPath = resolve(process.argv[2] ?? '');
const launcher = join(appPath, 'Contents', 'MacOS', 'stamped');
if (!existsSync(launcher)) {
    console.error(`usage: check-semantic.mjs <Stamped.app> — ${launcher} not found`);
    process.exit(2);
}

let failures = 0;
const pass = (what) => console.log(`PASS  ${what}`);
const fail = (what, detail = '') => {
    failures++;
    console.log(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'stamped-semantic-'));
const env = {
    PATH: '/usr/bin:/bin',
    HOME: join(scratch, 'home'),
    XDG_STATE_HOME: join(scratch, 'state'),
    LANG: 'C',
};
mkdirSync(env.HOME, { recursive: true });

// Two topics, written in different words from the queries below, so only meaning can match.
const topics = [
    [
        'Garage bill for the van',
        'The mechanic replaced the brake pads and the invoice for the vehicle repair is attached.',
    ],
    ['Office picnic moved', 'The summer outing is postponed to Friday because of the rain forecast.'],
    ['Wire transfer approved', 'The finance director released the payment to the supplier this morning.'],
    ['Flight to Lisbon', 'Your booking for the morning plane to Portugal is confirmed, seat 14C.'],
];
let mbox = '';
let n = 0;
for (const [subject, body] of topics) {
    for (let i = 0; i < 8; i++) {
        n++;
        mbox +=
            `From sender${n}@example.com Mon Jan  5 10:00:00 2026\nFrom: Person ${n} <sender${n}@example.com>\n` +
            `To: desk@example.org\nSubject: ${subject} ${i + 1}\nDate: Mon, 05 Jan 2026 10:${String(n).padStart(2, '0')}:00 +0000\n` +
            `Message-ID: <check-${n}@example.com>\n\n${body} (ref ${n})\n\n`;
    }
}
const source = join(scratch, 'source');
const caseDir = join(scratch, 'case');
mkdirSync(source);
writeFileSync(join(source, 'synthetic.mbox'), mbox);

const run = (args, timeout = 180000) =>
    spawnSync(launcher, args, { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });

function finish() {
    rmSync(scratch, { recursive: true, force: true });
    console.log(failures === 0 ? 'OK: semantic search works in the .app' : `FAILED: ${failures} check(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

// The window loads a case through a worker file that sits beside the bundle.
for (const file of ['stamped.node.mjs', 'query-worker.node.mjs']) {
    if (existsSync(join(appPath, 'Contents', 'Resources', 'lib', file))) pass(`${file} is in the bundle`);
    else fail(`${file} is missing from Contents/Resources/lib`);
}

const imported = run(['import', '--case', caseDir, source]);
if (imported.status === 0) pass('import');
else {
    fail('import', (imported.stderr || imported.stdout).slice(-300));
    finish();
}

// A cold launch loads the model: the probe is the first thing that needs it.
const started = Date.now();
const probe = run(['semantic', 'probe', '--case', caseDir]);
const probeText = `${probe.stdout}${probe.stderr}`;
if (/\d+ (tokens\/s|Token\/s)/.test(probeText))
    pass(`probe measured a rate (${Math.round((Date.now() - started) / 1000)} s)`);
else {
    fail('probe found no model or no runtime', probeText.slice(-400));
    finish();
}

// The CPU path must work without a compiler: no build directory may appear.
const cpu = spawnSync(launcher, ['semantic', 'probe', '--case', caseDir], {
    env: { ...env, STAMPED_SEMANTIC_GPU: 'off' },
    encoding: 'utf8',
    timeout: 180000,
});
const localBuilds = join(
    appPath,
    'Contents',
    'Resources',
    'lib',
    'node_modules',
    'node-llama-cpp',
    'llama',
    'localBuilds',
);
if (cpu.status === 0 && !existsSync(localBuilds)) pass('CPU fallback runs without compiling');
else
    fail(
        'CPU fallback',
        existsSync(localBuilds) ? 'llama.cpp was compiled from source' : (cpu.stderr || '').slice(-300),
    );

// Switch it on the way the window does, then index.
const settingPath = join(caseDir, 'semantic.json');
const setting = JSON.parse(readFileSync(settingPath, 'utf8'));
writeFileSync(settingPath, JSON.stringify({ ...setting, enabled: true }));
const indexed = run(['semantic', 'index', '--case', caseDir]);
const status = JSON.parse(readFileSync(join(caseDir, 'semantic-status.json'), 'utf8'));
if (indexed.status === 0 && status.state === 'ready' && status.done === n)
    pass(`indexed ${status.done}/${status.total} on ${status.backend}`);
else {
    fail(`index ended ${status.state} (${status.done}/${status.total})`, (indexed.stderr || '').slice(-300));
    finish();
}

// The query helper, as the window starts it: JSON lines over a pipe.
const helper = spawn(launcher, ['semantic', 'embed', '--case', caseDir], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
});
const answers = new Map();
let buffer = '';
helper.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
            const message = JSON.parse(line);
            if (message.id !== undefined) answers.set(message.id, message);
        } catch {}
    }
});
const asks = [
    [1, 'automobile maintenance expense', 'Garage bill'],
    [2, 'outdoor staff party delayed', 'Office picnic'],
];
for (const [id, text] of asks) helper.stdin.write(`${JSON.stringify({ id, text, limit: 3 })}\n`);
const deadline = Date.now() + 90000;
while (answers.size < asks.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
helper.stdin.end();

// Hashes → subjects, read from the case's own index: the answer must be about the right topic.
const index = new DatabaseSync(join(caseDir, 'index.db'), { readOnly: true });
const subjectOf = (hash) =>
    index.prepare('SELECT subject FROM messages WHERE hash = ?').get(hash)?.subject ?? '';
for (const [id, text, expected] of asks) {
    const hits = answers.get(id)?.hits;
    if (!hits || hits.length === 0) {
        fail(`"${text}" got no answer from the helper`);
        continue;
    }
    const subjects = hits.map((h) => subjectOf(h.hash));
    if (subjects.every((s) => s.startsWith(expected))) pass(`"${text}" → ${subjects[0]}…`);
    else fail(`"${text}" found the wrong mails`, subjects.join(' | '));
}

finish();
