#!/usr/bin/env node
// Generates every DKIM test fixture: `node tools/make-fixtures.mjs`.
//
// WHY THIS SCRIPT SIGNS THE MESSAGES ITSELF instead of calling mailauth's signer. The fixtures
// exist to pin how Stamped reads a verifier's output, and fixtures produced BY that verifier
// would agree with it by construction: a canonicalization bug shared between mailauth's signer
// and its verifier is invisible to a test built that way, and the whole worry about
// canonicalization (see packages/verify/src/mailauth.ts) is exactly that kind of bug. So this is
// a second, independent implementation of RFC 6376 § 3.4 and § 3.7, deliberately naive, and the
// suite passing means two implementations agree on the bytes.
//
// WHAT LEAVES THIS SCRIPT. The .eml fixtures, and the PUBLIC half of each key. The private keys
// are generated in memory and never written anywhere — a committed private key is a bad habit
// that outlives the fixture it was made for, and nothing here needs them twice. The price is
// that re-running regenerates every fixture with fresh keys; that is intended, the fixtures are
// a generated tree, reviewed and committed in one go.
//
// NOTHING REAL IS IN HERE. Every address is in a reserved example domain (RFC 2606), every body
// is invented, every key is made on the spot. Stamped is a tool for leaked mail, so a real
// message committed as a fixture could burn a source — see .gitignore.

import { createHash, createSign, generateKeyPairSync, sign as signRaw } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// STAMPED_FIXTURE_DIR lets a run write somewhere else, to pick out a single new fixture without
// touching the keys of the committed ones.
const fixtureDir = process.env.STAMPED_FIXTURE_DIR ?? join(repoRoot, 'app', 'tests', 'fixtures');
const keyDir = join(fixtureDir, 'keys');

/** A fixed timestamp, so a regenerated fixture differs only where a key forced it to. */
const SIGN_TIME = Math.floor(Date.parse('2024-03-05T09:41:00Z') / 1000);

// ── RFC 6376 § 3.4: canonicalization ────────────────────────────────────────────────────────

/** `relaxed` header canonicalization (§ 3.4.2): lowercase name, unfolded, WSP runs collapsed. */
function relaxedHeader(name, value) {
    const unfolded = value
        .replace(/\r?\n/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]+$/, '')
        .replace(/^[ \t]+/, '');
    return `${name.toLowerCase()}:${unfolded}\r\n`;
}

/** `simple` header canonicalization (§ 3.4.1): the header line unchanged. */
function simpleHeader(name, value) {
    return `${name}:${value}\r\n`;
}

/**
 * `relaxed` body canonicalization (§ 3.4.4).
 *
 * Three rules, in this order: WSP runs inside a line become one SP, trailing WSP goes, and empty
 * lines at the END of the body are dropped. A non-empty result ends in exactly one CRLF.
 */
function relaxedBody(body) {
    const lines = body
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

/** `simple` body canonicalization (§ 3.4.3): trailing empty lines go, an empty body is one CRLF. */
function simpleBody(body) {
    let text = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    text = text.replace(/(\r\n)+$/, '');
    return text.length === 0 ? '\r\n' : `${text}\r\n`;
}

// ── RFC 6376 § 3.7: signing ─────────────────────────────────────────────────────────────────

/**
 * Sign one message and return it with the `DKIM-Signature` header prepended.
 *
 * `tamper` runs AFTER the signature is computed and gets the finished message — which is how the
 * body-altered and headers-altered fixtures are made: the signature is genuine, the bytes under
 * it are not, and that is precisely the situation Stamped has to tell apart from a missing key.
 */
function sign({
    headers,
    body,
    key,
    domain,
    selector,
    algorithm,
    canonicalization,
    signedHeaders,
    lengthLimit,
    expiresAt,
}) {
    const [headerCanon, bodyCanon] = canonicalization.split('/');
    const canonHeader = headerCanon === 'simple' ? simpleHeader : relaxedHeader;
    const canonBody = bodyCanon === 'simple' ? simpleBody : relaxedBody;
    const hashName = algorithm.endsWith('sha1') ? 'sha1' : 'sha256';

    let bodyBytes = Buffer.from(canonBody(body), 'binary');
    if (lengthLimit !== undefined) bodyBytes = bodyBytes.subarray(0, lengthLimit);
    const bodyHash = createHash(hashName).update(bodyBytes).digest('base64');

    const tags = [
        'v=1',
        `a=${algorithm}`,
        `c=${canonicalization}`,
        `d=${domain}`,
        `s=${selector}`,
        `t=${SIGN_TIME}`,
        ...(expiresAt === undefined ? [] : [`x=${expiresAt}`]),
        `h=${signedHeaders.join(':')}`,
        ...(lengthLimit === undefined ? [] : [`l=${lengthLimit}`]),
        `bh=${bodyHash}`,
    ];
    const unsignedTags = `${tags.join('; ')}; b=`;

    // The hash input: each signed header in `h=` order, then the DKIM-Signature itself with an
    // EMPTY `b=` and no trailing CRLF (§ 3.7 step 3). The missing CRLF is the single easiest thing
    // to get wrong here, and it fails as "bad signature" with no hint where.
    let hashInput = '';
    for (const name of signedHeaders) {
        const found = headers.find(([header]) => header.toLowerCase() === name.toLowerCase());
        if (!found) throw new Error(`h= names ${name}, which the message does not have`);
        hashInput += canonHeader(found[0], found[1]);
    }
    hashInput += canonHeader('DKIM-Signature', ` ${unsignedTags}`).replace(/\r\n$/, '');

    const signature = signatureOver(Buffer.from(hashInput, 'binary'), key, algorithm, hashName);
    const header = ['DKIM-Signature', ` ${tags.join('; ')}; b=${signature}`];
    return [header, ...headers].map(([name, value]) => `${name}:${value}`).join('\r\n') + `\r\n\r\n${body}`;
}

/**
 * The `b=` value, base64.
 *
 * Ed25519 does NOT sign the canonicalized headers: `ed25519-sha256` signs the SHA-256 DIGEST of
 * them (RFC 8463 § 3), which is what every verifier checks — measured against mailauth's
 * `dkim-verifier.js`, which calls `crypto.verify(null, sha256(canonicalizedHeader), …)`. Signing
 * the headers directly produces a well-formed signature that simply never verifies.
 */
function signatureOver(input, key, algorithm, hashName) {
    if (algorithm.startsWith('ed25519')) {
        return signRaw(null, createHash('sha256').update(input).digest(), key).toString('base64');
    }
    const signer = createSign(hashName);
    signer.update(input);
    return signer.sign(key, 'base64');
}

// ── The keys ────────────────────────────────────────────────────────────────────────────────

/**
 * One key pair, public half written to `<selector>._domainkey.<domain>.pub.pem`.
 *
 * The filename IS the DNS name the verifier asks for, so the test suite can fill its key store
 * from the directory listing with no manifest to keep in sync. `publish: false` writes nothing —
 * that is how the `no key` fixture gets a real signature nobody can check.
 */
function makeKey({ selector, domain, type, bits, publish = true }) {
    const pair =
        type === 'ed25519'
            ? generateKeyPairSync('ed25519')
            : generateKeyPairSync('rsa', { modulusLength: bits });
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    if (publish) {
        writeFileSync(join(keyDir, `${selector}._domainkey.${domain}.pub.pem`), publicPem);
    }
    return { privateKey: pair.privateKey, selector, domain };
}

// ── The messages ────────────────────────────────────────────────────────────────────────────

/** The headers every fixture carries, in the order a real message would have them. */
function headersFor({
    subject,
    from = 'Ada Lovelace <ada@example.com>',
    to = 'Grace Hopper <grace@example.net>',
}) {
    return [
        ['From', ` ${from}`],
        ['To', ` ${to}`],
        ['Subject', ` ${subject}`],
        ['Date', ' Tue, 05 Mar 2024 09:40:00 +0000'],
        ['Message-ID', ' <fixture-01@example.com>'],
        ['MIME-Version', ' 1.0'],
        ['Content-Type', ' text/plain; charset=utf-8'],
    ];
}

const BODY = [
    'The quarterly figures are attached.',
    '',
    'They are provisional until the audit closes.',
    '',
    '-- Ada',
    '',
].join('\r\n');

const SIGNED = ['from', 'to', 'subject', 'date'];

function write(name, content) {
    writeFileSync(join(fixtureDir, name), content, 'binary');
    console.log(`  ${name}`);
}

mkdirSync(keyDir, { recursive: true });

const rsa2048 = makeKey({ selector: 't2048', domain: 'example.com', type: 'rsa', bits: 2048 });
const rsa512 = makeKey({ selector: 't512', domain: 'example.com', type: 'rsa', bits: 512 });
const ed25519 = makeKey({ selector: 'ted', domain: 'example.com', type: 'ed25519' });
const list = makeKey({ selector: 'tlist', domain: 'lists.example.org', type: 'rsa', bits: 2048 });
const other = makeKey({ selector: 'tother', domain: 'other.example', type: 'rsa', bits: 2048 });
const sub = makeKey({ selector: 'tsub', domain: 'mail.example.com', type: 'rsa', bits: 2048 });
// Published nowhere: a genuine signature whose key the operator does not have.
const absent = makeKey({
    selector: 'tmissing',
    domain: 'example.com',
    type: 'rsa',
    bits: 2048,
    publish: false,
});

// Signed with a 1024-bit key; the key published under the same name is a DIFFERENT 2048-bit key
// (a rotated selector). A signature of 128 bytes cannot come from a 256-byte modulus.
const rotatedOld = makeKey({
    selector: 'trotated',
    domain: 'example.com',
    type: 'rsa',
    bits: 1024,
    publish: false,
});
makeKey({ selector: 'trotated', domain: 'example.com', type: 'rsa', bits: 2048 });

// Signed with one 2048-bit key while a DIFFERENT 2048-bit key is published under the same name:
// sizes agree, so only the RSA padding of `b=` can tell that the published key did not sign.
const swapped = makeKey({
    selector: 'tswapped',
    domain: 'example.com',
    type: 'rsa',
    bits: 2048,
    publish: false,
});
makeKey({ selector: 'tswapped', domain: 'example.com', type: 'rsa', bits: 2048 });

// Its own key, so the base64 fixtures do not depend on the bytes of any older key.
const base64Key = makeKey({ selector: 'tb64', domain: 'example.com', type: 'rsa', bits: 2048 });

// Its own key as well: the x= fixtures stand beside the older ones without sharing their bytes.
const expKey = makeKey({ selector: 'texp', domain: 'example.com', type: 'rsa', bits: 2048 });

console.log('fixtures:');

// ── confirmed ───────────────────────────────────────────────────────────────────────────────

write(
    'confirmed.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// `simple/simple` as well as a second key type: the two canonicalizations take different code
// paths in every verifier, and a fixture set that only exercises `relaxed` would not notice.
write(
    'confirmed-ed25519.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: ed25519.privateKey,
        domain: ed25519.domain,
        selector: ed25519.selector,
        algorithm: 'ed25519-sha256',
        canonicalization: 'simple/simple',
        signedHeaders: ['From', 'To', 'Subject', 'Date'],
    }),
);

// ── confirmed with caveats ──────────────────────────────────────────────────────────────────

write(
    'caveat-rsa-sha1.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha1',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

write(
    'caveat-weak-key.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa512.privateKey,
        domain: rsa512.domain,
        selector: rsa512.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// `l=` set to the length of the ORIGINAL canonicalized body, then more text appended: the
// signature verifies and the appended paragraph is unsigned. This is the DKIM weakness a reader
// has to be told about — the message carries a valid signature and a sentence nobody signed.
{
    const signedLength = Buffer.byteLength(relaxedBody(BODY), 'binary');
    const appended = `${BODY}\r\nP.S. Transfer the deposit to the account below. -- A.\r\n`;
    write(
        'caveat-length-limited.eml',
        sign({
            headers: headersFor({ subject: 'Quarterly figures' }),
            body: appended,
            key: rsa2048.privateKey,
            domain: rsa2048.domain,
            selector: rsa2048.selector,
            algorithm: 'rsa-sha256',
            canonicalization: 'relaxed/relaxed',
            signedHeaders: SIGNED,
            lengthLimit: signedLength,
        }),
    );
}

// `h=from` only: To, Subject and Date are present but unsigned, so all three could have been
// changed or added after signing without touching the signature.
write(
    'caveat-unsigned-headers.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: ['from'],
    }),
);

// ── tampering ───────────────────────────────────────────────────────────────────────────────

// The body is edited after signing: the body hash cannot match, and no key is even consulted.
write(
    'body-altered.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }).replace('provisional until the audit closes', 'final and the audit has closed'),
);

// A SIGNED header is edited after signing: the body hash still matches, so what the evidence
// shows is a changed header field and not a changed body. Telling those two apart is the reason
// `@stamped/core` has six verdicts instead of "valid" and "invalid".
write(
    'headers-altered.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }).replace('Subject: Quarterly figures', 'Subject: Quarterly figures (final, approved)'),
);

// Export artefacts: the signature is genuine over the original bytes, then an exporter rewrote
// them. Stamped's retry must find the hash again for these (and say so), and must NOT find it for
// body-altered.eml, where a person changed the words.
{
    const dotBody = [
        'The quarterly figures are attached.',
        '',
        '.Provisional until the audit closes.',
        '',
        '-- Ada',
        '',
    ].join('\r\n');
    const signedDot = sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: dotBody,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    });
    write('export-dot-stuffed.eml', signedDot.replace('\r\n.Provisional', '\r\n..Provisional'));
    // No line-endings-only fixture: mailauth converts bare LF to CRLF before hashing, so such an
    // export still verifies and never reaches body-altered.
    write(
        'export-both.eml',
        signedDot.replace('\r\n.Provisional', '\r\n..Provisional').replace(/\r\n/g, '\n'),
    );
}

// `l=` covers the first part of the body, and a word INSIDE that part was changed: unlike
// caveat-length-limited.eml, the appended text is not the problem.
{
    const signedLength = Buffer.byteLength(relaxedBody(BODY), 'binary');
    write(
        'body-altered-length-limited.eml',
        sign({
            headers: headersFor({ subject: 'Quarterly figures' }),
            body: BODY,
            key: rsa2048.privateKey,
            domain: rsa2048.domain,
            selector: rsa2048.selector,
            algorithm: 'rsa-sha256',
            canonicalization: 'relaxed/relaxed',
            signedHeaders: SIGNED,
            lengthLimit: signedLength,
        }).replace('provisional until', 'final after'),
    );
}

// The body hash matches and the header signature fails, but only because the key in the store is
// not the one that signed: the verdict must be `unverifiable`, never `headers-altered`.
write(
    'unverifiable-key-mismatch.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rotatedOld.privateKey,
        domain: rotatedOld.domain,
        selector: rotatedOld.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// Same size, different key, body intact: the header signature fails because the published key is
// not the signer's. Must be `unverifiable`, not `headers-altered`.
write(
    'unverifiable-key-swapped.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: swapped.privateKey,
        domain: swapped.domain,
        selector: swapped.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// The body is edited AND the published key is not the signer's: the `bh=` in the header is not
// provably the signer's, so nothing may be said about the text.
write(
    'body-altered-key-swapped.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: swapped.privateKey,
        domain: swapped.domain,
        selector: swapped.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }).replace('provisional until the audit closes', 'final and the audit has closed'),
);

// The body is edited and no key exists at all: the claimed body hash is unauthenticated.
write(
    'body-altered-no-key.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: absent.privateKey,
        domain: absent.domain,
        selector: absent.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }).replace('provisional until the audit closes', 'final and the audit has closed'),
);

// Base64 line wrapping: signed with 72 characters per line, then an export re-wrapped to 76. The
// decoded content is identical, the body hash is not.
{
    const wrap = (text, width) => `${text.match(new RegExp(`.{1,${width}}`, 'g')).join('\r\n')}\r\n`;
    const payload = (seed) =>
        Buffer.from(`${seed} `.repeat(40) + 'Provisional figures, not for release.').toString('base64');
    const withContent = (extra) =>
        headersFor({ subject: 'Quarterly figures' })
            .filter(([name]) => name !== 'Content-Type')
            .concat(extra);
    const rewrapped = (headers, bodyOf) => {
        const signed = sign({
            headers,
            body: bodyOf(72),
            key: base64Key.privateKey,
            domain: base64Key.domain,
            selector: base64Key.selector,
            algorithm: 'rsa-sha256',
            canonicalization: 'relaxed/relaxed',
            signedHeaders: SIGNED,
        });
        return signed.slice(0, signed.length - bodyOf(72).length) + bodyOf(76);
    };

    write(
        'export-base64-single.eml',
        rewrapped(
            withContent([
                ['Content-Type', ' application/octet-stream'],
                ['Content-Transfer-Encoding', ' base64'],
            ]),
            (width) => wrap(payload('single'), width),
        ),
    );

    write(
        'export-base64-multipart.eml',
        rewrapped(withContent([['Content-Type', ' multipart/mixed; boundary="OUTER"']]), (width) =>
            [
                '--OUTER',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'Two attachments follow.',
                '--OUTER',
                'Content-Type: application/octet-stream',
                'Content-Transfer-Encoding: base64',
                '',
                wrap(payload('first'), width).replace(/\r\n$/, ''),
                '--OUTER',
                'Content-Type: multipart/mixed; boundary="INNER"',
                '',
                '--INNER',
                'Content-Type: application/octet-stream',
                'Content-Transfer-Encoding: base64',
                '',
                wrap(payload('nested'), width).replace(/\r\n$/, ''),
                '--INNER--',
                '--OUTER--',
                '',
            ].join('\r\n'),
        ),
    );
}

// ── nothing to check against ────────────────────────────────────────────────────────────────

write(
    'unverifiable-no-key.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: absent.privateKey,
        domain: absent.domain,
        selector: absent.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

write(
    'unsigned.eml',
    `${headersFor({ subject: 'Quarterly figures' })
        .map(([name, value]) => `${name}:${value}`)
        .join('\r\n')}\r\n\r\n${BODY}`,
);

// ── two signatures, evaluated individually ──────────────────────────────────────────────────

// A mailing list re-signs what it relays, so one message carries two signatures over two
// different versions of it. Here the list's signature was made over a body with the footer it
// adds, while the delivered message has the author's body: the list signature is broken, the
// author's holds. A tool that reported one verdict per MESSAGE would have to pick, and either
// choice is a false claim.
{
    const listSigned = sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: `${BODY}\r\n--\r\nfigures@lists.example.org -- unsubscribe at lists.example.org\r\n`,
        key: list.privateKey,
        domain: list.domain,
        selector: list.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    });
    const listHeader = listSigned.slice(0, listSigned.indexOf('\r\n'));
    const authorSigned = sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: rsa2048.privateKey,
        domain: rsa2048.domain,
        selector: rsa2048.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    });
    write('multi-signature.eml', `${listHeader}\r\n${authorSigned}`);
}

// ── who signed, versus who wrote ───────────────────────────────────────────────────────────

// `From:` is example.com, but the only signature is d=other.example. The cryptography is flawless
// and says nothing about the author: anybody can sign a forged From with a domain they own.
write(
    'signer-not-author.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: other.privateKey,
        domain: other.domain,
        selector: other.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// The author's signature is over the original body; the list then added a footer and signed THAT.
// The list signature verifies, the author's is body-altered: a message verdict of plain
// `confirmed` here would let a list's signature vouch for the author.
{
    const delivered = `${BODY}\r\n--\r\nfigures@lists.example.org -- unsubscribe at lists.example.org\r\n`;
    const authorHeader = (() => {
        const signed = sign({
            headers: headersFor({ subject: 'Quarterly figures' }),
            body: BODY,
            key: rsa2048.privateKey,
            domain: rsa2048.domain,
            selector: rsa2048.selector,
            algorithm: 'rsa-sha256',
            canonicalization: 'relaxed/relaxed',
            signedHeaders: SIGNED,
        });
        return signed.slice(0, signed.indexOf('\r\n'));
    })();
    const listSigned = sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: delivered,
        key: list.privateKey,
        domain: list.domain,
        selector: list.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    });
    write('multi-signature-author-broken.eml', `${authorHeader}\r\n${listSigned}`);
}

// A subdomain signing for its parent is the same operator: aligned under relaxed alignment.
write(
    'aligned-subdomain.eml',
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body: BODY,
        key: sub.privateKey,
        domain: sub.domain,
        selector: sub.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
    }),
);

// ── signature lifetime (x=) ─────────────────────────────────────────────────────────────────

// x= a day after t=, which is long past: the signature is genuine, only its stated lifetime is over.
const signExpiring = (expiresAt, body = BODY) =>
    sign({
        headers: headersFor({ subject: 'Quarterly figures' }),
        body,
        key: expKey.privateKey,
        domain: expKey.domain,
        selector: expKey.selector,
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: SIGNED,
        expiresAt,
    });

write('caveat-expired.eml', signExpiring(SIGN_TIME + 86400));

// x= BEFORE t=: the header contradicts itself.
write('caveat-lifetime-invalid.eml', signExpiring(SIGN_TIME - 3600));

// An expired x= must not hide an altered body.
write(
    'body-altered-expired.eml',
    signExpiring(SIGN_TIME + 86400).replace(
        'provisional until the audit closes',
        'final and the audit has closed',
    ),
);

console.log(`keys:\n  ${keyDir}`);
