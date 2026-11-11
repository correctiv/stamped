#!/usr/bin/env node
// Generates the key-rotation fixtures: `node tools/make-rotation-fixtures.mjs`.
//
// SEPARATE FROM make-fixtures.mjs ON PURPOSE, for the reason make-archive-fixtures.mjs gives: that
// script mints fresh keys on every run and rewrites every committed fixture together. These
// messages stand beside the others, and the keys live under `rotation/` rather than `keys/` so
// that `fixtureKeys()` does not hand every other suite a second record for one name.
//
// WHAT IS IN HERE. One selector, `trot._domainkey.example.com`, with two keys that never signed
// in the same period, the shape of a real rotation:
//
//   rotation/old.pub.pem, new.pub.pem          the two public keys (private halves are discarded)
//   rotated-old-1.eml, rotated-old-2.eml       signed by the OLD key, January and March 2019
//   rotated-new-1.eml, rotated-new-2.eml       signed by the NEW key, February and April 2024
//   rotated-stray.eml                          signed by the OLD key in March 2024: with it the
//                                              eras overlap, which is what must stay a conflict
//   rotated-altered.eml                        signed by the NEW key, body changed afterwards:
//                                              verifies under neither key
//
// The signer is deliberately naive (relaxed/relaxed, rsa-sha256 only); make-fixtures.mjs carries
// the independent implementation and the explanation of why it is not mailauth's.
//
// NOTHING REAL IS IN HERE. Reserved example domains (RFC 2606), invented bodies, keys made on the
// spot.

import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(repoRoot, 'app', 'tests', 'fixtures');
const keyDir = join(fixtureDir, 'rotation');
mkdirSync(keyDir, { recursive: true });

const DOMAIN = 'example.com';
const SELECTOR = 'trot';
const SIGNED = ['from', 'to', 'subject', 'date'];

function makeKey(file, bits) {
    const pair = generateKeyPairSync('rsa', { modulusLength: bits });
    writeFileSync(join(keyDir, file), pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    return pair.privateKey;
}

const oldKey = makeKey('old.pub.pem', 1024);
const newKey = makeKey('new.pub.pem', 2048);

function relaxedHeader(name, value) {
    const unfolded = value
        .replace(/[ \t]+/g, ' ')
        .replace(/^ /, '')
        .replace(/ $/, '');
    return `${name.toLowerCase()}:${unfolded}\r\n`;
}

function relaxedBody(body) {
    const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

/** One message, signed by `key`; `tamper` edits the finished text to break the body hash. */
function message({ n, date, key, tamper }) {
    const headers = [
        ['From', ' Ada Lovelace <ada@example.com>'],
        ['To', ' Grace Hopper <grace@example.net>'],
        ['Subject', ` Status report ${n}`],
        ['Date', ` ${date}`],
        ['Message-ID', ` <rotation-${n}@example.com>`],
        ['MIME-Version', ' 1.0'],
        ['Content-Type', ' text/plain; charset=utf-8'],
    ];
    const body = `Status report ${n}.\r\n\r\nNothing to add.\r\n`;
    const bodyHash = createHash('sha256').update(relaxedBody(body)).digest('base64');
    const tags = [
        'v=1',
        'a=rsa-sha256',
        'c=relaxed/relaxed',
        `d=${DOMAIN}`,
        `s=${SELECTOR}`,
        `h=${SIGNED.join(':')}`,
        `bh=${bodyHash}`,
    ];
    let input = '';
    for (const name of SIGNED) {
        const found = headers.find(([header]) => header.toLowerCase() === name);
        input += relaxedHeader(found[0], found[1]);
    }
    input += relaxedHeader('DKIM-Signature', ` ${tags.join('; ')}; b=`).replace(/\r\n$/, '');
    const signer = createSign('sha256');
    signer.update(input);
    const signature = signer.sign(key, 'base64');
    const text =
        [['DKIM-Signature', ` ${tags.join('; ')}; b=${signature}`], ...headers]
            .map(([name, value]) => `${name}:${value}`)
            .join('\r\n') + `\r\n\r\n${body}`;
    return tamper ? text.replace('Nothing to add.', 'Nothing to add. Send the money.') : text;
}

const files = {
    'rotated-old-1.eml': { n: 1, date: 'Thu, 10 Jan 2019 09:00:00 +0000', key: oldKey },
    'rotated-old-2.eml': { n: 2, date: 'Wed, 20 Mar 2019 09:00:00 +0000', key: oldKey },
    'rotated-new-1.eml': { n: 3, date: 'Thu, 01 Feb 2024 09:00:00 +0000', key: newKey },
    'rotated-new-2.eml': { n: 4, date: 'Mon, 15 Apr 2024 09:00:00 +0000', key: newKey },
    'rotated-stray.eml': { n: 5, date: 'Fri, 01 Mar 2024 09:00:00 +0000', key: oldKey },
    'rotated-altered.eml': { n: 6, date: 'Mon, 10 May 2021 09:00:00 +0000', key: newKey, tamper: true },
};
console.log('rotation fixtures:');
for (const [name, spec] of Object.entries(files)) {
    writeFileSync(join(fixtureDir, name), message(spec), 'binary');
    console.log(`  ${name}`);
}
