#!/usr/bin/env node
// Writes a synthetic mbox for load testing `stamped import`:
//
//   node tools/make-load-archive.mjs <out-dir> [count=5000] [--seed=1]
//
// Produces <out-dir>/load.mbox plus <out-dir>/keys/<selector>._domainkey.<domain>.pub.pem.
//
// NOTHING REAL IS IN HERE. Reserved example domains (RFC 2606), generated words, a key minted
// on the spot whose private half never reaches the disk. Like make-fixtures.mjs it signs with
// its own RFC 6376 canonicalization, independent of mailauth.
//
// THE MIX: mostly short text mails, some long threads, some multipart with a base64
// "attachment" of 20-300 KiB, a few oversized (1-2 MiB) ones, one in four DKIM-signed (relaxed/
// relaxed rsa-sha256). Deterministic for a given seed, so before/after runs index the same mail.

import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith('--'));
const outDir = positional[0];
const count = Number(positional[1] ?? 5000);
const seed = Number(args.find((arg) => arg.startsWith('--seed='))?.slice(7) ?? 1);
if (!outDir || !Number.isInteger(count) || count < 1) {
    console.error('usage: make-load-archive.mjs <out-dir> [count] [--seed=N]');
    process.exit(2);
}

// mulberry32: tiny seeded PRNG, enough for a reproducible mix.
let state = seed >>> 0;
function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

const WORDS =
    'harbour ledger invoice quarterly archive delivery contract meeting schedule budget report ' +
    'review figures draft proposal minutes agenda payment transfer account balance forecast ' +
    'supplier shipment warehouse inventory customer contact follow update summary attached'.split(' ');

function sentence() {
    const words = Array.from({ length: between(6, 16) }, () => pick(WORDS));
    return `${words.join(' ')}.`;
}

function paragraphs(approxBytes) {
    const lines = [];
    let size = 0;
    while (size < approxBytes) {
        const line = Array.from({ length: between(1, 4) }, sentence).join(' ');
        lines.push(line, '');
        size += line.length + 2;
    }
    return lines.join('\r\n');
}

function base64Block(bytes) {
    const raw = Buffer.alloc(Math.ceil(bytes / 4) * 4);
    for (let i = 0; i < raw.length; i += 4) raw.writeUInt32LE(Math.floor(random() * 4294967296), i);
    return raw
        .toString('base64')
        .replace(/.{1,76}/g, '$&\r\n')
        .trimEnd();
}

// ── DKIM (RFC 6376 relaxed/relaxed, rsa-sha256) ─────────────────────────────────────────────

const SELECTOR = 'tload';
const DOMAIN = 'example.com';
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function relaxedHeader(name, value) {
    const unfolded = value
        .replace(/\r?\n/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/^ /, '')
        .replace(/ $/, '');
    return `${name.toLowerCase()}:${unfolded}\r\n`;
}

function relaxedBody(body) {
    const lines = body
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

function sign(headers, body) {
    const signed = ['from', 'to', 'subject', 'date'];
    const bodyHash = createHash('sha256')
        .update(Buffer.from(relaxedBody(body), 'binary'))
        .digest('base64');
    const tags = [
        'v=1',
        'a=rsa-sha256',
        'c=relaxed/relaxed',
        `d=${DOMAIN}`,
        `s=${SELECTOR}`,
        't=1709631600',
        `h=${signed.join(':')}`,
        `bh=${bodyHash}`,
    ];
    let input = '';
    for (const name of signed) {
        const found = headers.find(([header]) => header.toLowerCase() === name);
        input += relaxedHeader(found[0], found[1]);
    }
    input += relaxedHeader('DKIM-Signature', ` ${tags.join('; ')}; b=`).replace(/\r\n$/, '');
    const signer = createSign('sha256');
    signer.update(Buffer.from(input, 'binary'));
    return [
        ['DKIM-Signature', ` ${tags.join('; ')}; b=${signer.sign(keyPair.privateKey, 'base64')}`],
        ...headers,
    ];
}

// ── The messages ────────────────────────────────────────────────────────────────────────────

function build(index) {
    const roll = random();
    const headers = [
        ['From', ` Person ${index % 97} <sender${index % 97}@example.com>`],
        ['To', ` Person ${index % 31} <rcpt${index % 31}@example.net>`],
        ['Subject', ` ${pick(WORDS)} ${pick(WORDS)} #${index}`],
        ['Date', ` ${new Date(1709631600000 + index * 60000).toUTCString()}`],
        ['Message-ID', ` <load-${seed}-${index}@example.com>`],
        ['MIME-Version', ' 1.0'],
    ];
    let body;
    if (roll < 0.6) {
        headers.push(['Content-Type', ' text/plain; charset=utf-8']);
        body = paragraphs(between(300, 3000));
    } else if (roll < 0.75) {
        headers.push(['Content-Type', ' text/plain; charset=utf-8']);
        body = paragraphs(between(20_000, 120_000));
    } else {
        const boundary = `=_load_${index}`;
        headers.push(['Content-Type', ` multipart/mixed; boundary="${boundary}"`]);
        const size = roll < 0.99 ? between(20_000, 300_000) : between(1_000_000, 2_000_000);
        body = [
            `--${boundary}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            paragraphs(between(300, 2000)),
            `--${boundary}`,
            'Content-Type: application/octet-stream; name="data.bin"',
            'Content-Transfer-Encoding: base64',
            'Content-Disposition: attachment; filename="data.bin"',
            '',
            base64Block(size),
            `--${boundary}--`,
            '',
        ].join('\r\n');
    }
    const finished = index % 4 === 0 ? sign(headers, body) : headers;
    return `${finished.map(([name, value]) => `${name}:${value}`).join('\r\n')}\r\n\r\n${body}`;
}

mkdirSync(join(outDir, 'keys'), { recursive: true });
writeFileSync(
    join(outDir, 'keys', `${SELECTOR}._domainkey.${DOMAIN}.pub.pem`),
    keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
);

const out = createWriteStream(join(outDir, 'load.mbox'));
for (let index = 0; index < count; index++) {
    const raw = build(index);
    // mboxrd: `From ` and `>From ` body lines gain one `>`.
    const quoted = raw.replace(/^(>*From )/gm, '>$1');
    const chunk = `From sender@example.com Tue Mar  5 09:41:00 2024\n${quoted.replace(/\r\n/g, '\n')}\n\n`;
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
}
await new Promise((resolve) => out.end(resolve));
console.log(`wrote ${count} messages to ${join(outDir, 'load.mbox')}`);
