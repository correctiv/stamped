#!/usr/bin/env node
// Check a built Stamped .app on macOS for the defects that only appear without Homebrew.
//
// Two halves:
//   1. STATIC — scan the bundle on disk: Mach-O load commands must not hard-link a build
//      host's absolute library path (that is the defect checkPrebuildDir catches in gjsify);
//      the relocated rpath that names the build host's prefix is a SEARCH path dyld skips
//      silently when it is absent, so it is reported as a warning, not a failure.
//      Plus: the fontconfig config and the GTK/libadwaita catalogs must be present.
//   2. RUNTIME — launch the app under a sandbox that denies /opt/homebrew, /usr/local and
//      /opt/local, with an empty HOME/XDG tree (so no real case is reopened), and assert
//      via lsof that none of those prefixes is touched, that AdwaitaSans is mapped, and
//      that no "Fontconfig error" is printed.
//
// Usage: node app/tests/macos/check-app.mjs [--no-launch] [--app] <path-to-.app>
// Exit code: 0 if every FAIL check passes (warnings allowed), 1 otherwise.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HOST_PREFIXES = ['/opt/homebrew', '/usr/local', '/opt/local'];
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcafebabf]);

const args = process.argv.slice(2);
let appPath = null;
let noLaunch = false;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-launch') {
        noLaunch = true;
        continue;
    }
    if (args[i] === '--app') {
        appPath = args[++i];
        continue;
    }
    if (!appPath) appPath = args[i];
}
if (!appPath) {
    console.error('usage: check-app.mjs [--no-launch] [--app] <path-to-.app>');
    process.exit(2);
}
appPath = resolve(appPath);
if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    console.error(`not a directory: ${appPath}`);
    process.exit(2);
}

let failed = 0;
let warned = 0;
function pass(msg) {
    console.log(`PASS  ${msg}`);
}
function fail(msg) {
    console.log(`FAIL  ${msg}`);
    failed++;
}
function warn(msg) {
    console.log(`WARN  ${msg}`);
    warned++;
}

// --- helpers ---------------------------------------------------------------

function walk(dir, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) walk(p, out);
        else if (st.isFile()) out.push(p);
    }
    return out;
}

function isMachO(file) {
    try {
        const b = readFileSync(file);
        if (b.length < 4) return false;
        const magic = b.readUInt32LE(0);
        return MACHO_MAGICS.has(magic);
    } catch {
        return false;
    }
}

function otoolLines(file, flag) {
    const r = spawnSync('otool', [flag, file], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout.split('\n');
}

function underPrefix(p) {
    return HOST_PREFIXES.some((pref) => p === pref || p.startsWith(pref + '/'));
}

// --- static: Mach-O load commands -----------------------------------------

const machos = walk(appPath).filter(isMachO);
let hardLoads = 0;
let hostRpaths = 0;
for (const m of machos) {
    // LC_LOAD_DYLIB / LC_ID_DYLIB: a hard dependency on an absolute host path aborts the load.
    for (const line of otoolLines(m, '-L')) {
        const match = line.match(/^\s*(\/\S+)/);
        if (!match) continue;
        const dep = match[1];
        if (dep.startsWith('/') && underPrefix(dep)) {
            hardLoads++;
            fail(`hard-linked host path in ${m}: ${dep}`);
        }
    }
    // LC_RPATH: a search path, reported not failed (see header).
    for (const line of otoolLines(m, '-l')) {
        const m2 = line.match(/path\s+(\S+)\s+\(offset/);
        if (m2 && m2[1].startsWith('/') && underPrefix(m2[1])) {
            hostRpaths++;
            warn(`host LC_RPATH in ${m}: ${m2[1]} (dyld skips it if absent)`);
        }
    }
}
if (hardLoads === 0) pass(`no absolute host load commands across ${machos.length} Mach-O files`);
if (hostRpaths > 0) console.log(`      (${hostRpaths} host rpath entries, all non-fatal)`);

// --- static: fontconfig config --------------------------------------------

const prebuildsRoot = join(appPath, 'Contents', 'Resources', 'native', 'node-gi', 'prebuilds');
const prebuildDirs = existsSync(prebuildsRoot)
    ? readdirSync(prebuildsRoot)
          .filter((n) => /^darwin-(arm64|x64)$/.test(n))
          .map((n) => join(prebuildsRoot, n))
          .filter((p) => statSync(p).isDirectory())
    : [];

let fontsChecked = 0;
for (const d of prebuildDirs) {
    const conf = join(d, 'gtk', 'etc', 'fonts', 'fonts.conf');
    if (!existsSync(conf)) {
        fail(`missing ${conf}`);
        continue;
    }
    const text = readFileSync(conf, 'utf8');
    fontsChecked++;
    if (HOST_PREFIXES.some((p) => text.includes(p))) fail(`fonts.conf names a host prefix: ${conf}`);
    else pass(`fonts.conf present and host-free: ${conf}`);
}
if (prebuildDirs.length === 0) fail('no darwin-* prebuild directory found');

// --- static: gettext catalogs ---------------------------------------------

for (const d of prebuildDirs) {
    const loc = join(d, 'gtk', 'share', 'locale', 'de', 'LC_MESSAGES');
    for (const name of ['gtk40.mo', 'libadwaita.mo', 'glib20.mo']) {
        const p = join(loc, name);
        if (existsSync(p)) pass(`catalog present: ${p}`);
        else fail(`missing catalog: ${p}`);
    }
}

if (noLaunch) {
    console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${failed} fail, ${warned} warn (launch skipped)`);
    process.exit(failed === 0 ? 0 : 1);
}

// --- runtime: sandboxed launch --------------------------------------------

const execs = walk(join(appPath, 'Contents', 'MacOS')).filter((p) => statSync(p).isFile());
if (execs.length === 0) {
    fail('no executable in Contents/MacOS');
    process.exit(1);
}
// `gjsify ship` places a `node` binary beside the real launcher; the launcher is the
// one named after the app (or the only other file).
const execPath = execs.find((p) => !p.endsWith('/node')) || execs[0];

const home = mkdtempSync(join(tmpdir(), 'stamped-check-home-'));
const profile = join(home, 'nobrew.sb');
writeFileSync(
    profile,
    '(version 1)\n(allow default)\n' +
        HOST_PREFIXES.map((p) => `(deny file-read* (subpath "${p}"))`).join('\n') +
        '\n',
);

const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    LANG: 'de_DE.UTF-8',
};
const child = spawn('sandbox-exec', ['-f', profile, execPath], {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => {
    stderr += c.toString();
});

// wait for the node process that actually runs the bundle
function findBundlePid() {
    const r = spawnSync('pgrep', ['-f', `${appPath}/Contents/Resources/lib/stamped.node.mjs`], {
        encoding: 'utf8',
    });
    return r.stdout.trim().split('\n').filter(Boolean).pop() || null;
}

let bundlePid = null;
const deadline = Date.now() + 20000;
while (Date.now() < deadline && !bundlePid) {
    bundlePid = findBundlePid();
    if (!bundlePid) await new Promise((r) => setTimeout(r, 500));
}

// give it a moment to map fonts + open catalogs
if (bundlePid) await new Promise((r) => setTimeout(r, 4000));

let lsofOut = '';
if (bundlePid) {
    const r = spawnSync('lsof', ['-p', bundlePid], { encoding: 'utf8' });
    lsofOut = r.stdout || '';
}

// kill everything
function killAll() {
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {}
    try {
        child.kill('SIGTERM');
    } catch {}
    // kill any leftover bundle process
    const p = findBundlePid();
    if (p)
        try {
            process.kill(Number(p), 'SIGTERM');
        } catch {}
}
process.on('exit', killAll);
process.on('SIGINT', () => {
    killAll();
    process.exit(130);
});

if (!bundlePid) {
    fail('app did not start a bundle process within 20 s');
} else {
    const opened = lsofOut
        .split('\n')
        .map((l) => l.trim().split(/\s+/).pop())
        .filter(Boolean);
    const bad = opened.filter((p) => HOST_PREFIXES.some((pref) => p === pref || p.startsWith(pref + '/')));
    if (bad.length === 0) pass(`no file under ${HOST_PREFIXES.join(', ')} opened (pid ${bundlePid})`);
    else {
        fail(`${bad.length} host-prefix files opened`);
        bad.slice(0, 5).forEach((p) => console.log(`      ${p}`));
    }
    const fonts = new Set(
        opened.map((p) => p.split('/').pop()).filter((n) => /^AdwaitaSans.*\.ttf$/i.test(n)),
    );
    if (fonts.size > 0) pass(`AdwaitaSans mapped: ${[...fonts].join(', ')}`);
    else fail('no AdwaitaSans*.ttf mapped');
    // GTK and libadwaita bind their catalogs to the build host's prefix at init, so a
    // catalog present in the bundle proves nothing until the process has it mapped.
    for (const domain of ['gtk40', 'libadwaita']) {
        const mapped = opened.some((p) => p.endsWith(`/gtk/share/locale/de/LC_MESSAGES/${domain}.mo`));
        if (mapped) pass(`${domain}.mo mapped from the bundle`);
        else fail(`${domain}.mo not mapped from the bundle`);
    }
    if (/Fontconfig error/i.test(stderr)) fail('stderr contains "Fontconfig error"');
    else pass('no Fontconfig error on stderr');
}

killAll();
rmSync(home, { recursive: true, force: true });

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${failed} fail, ${warned} warn`);
process.exit(failed === 0 ? 0 : 1);
