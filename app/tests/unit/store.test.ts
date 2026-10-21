/**
 * The case folder: the raw store, the import log, the index, and the report over them.
 *
 * THE TRUST ORDER IS WHAT IS BEING TESTED. `raw/` is the evidence, `import-log.jsonl` the chain of
 * custody, `index.db` a cache that can be thrown away. So the assertions that matter are the ones
 * about bytes and provenance — a message comes back out of the store byte for byte, the same
 * message twice is one file, and the log says which archive and which offset it came from. The
 * index assertions are about a cache behaving like one.
 *
 * Every case runs in a temporary directory, never in the checkout. A case folder in the repo is
 * exactly what `.gitignore` is the second line of defence against; the first is that nothing
 * writes one there.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@gjsify/unit';
import { CAVEATS, type MessageFinding, type Verdict, VERDICTS } from '@stamped/core';
import { decodeLatin1, encodeLatin1, summarise } from '@stamped/import';
import {
    appendLog,
    caseReport,
    caveatCounts,
    CASE_VERSION,
    casePaths,
    type CasePaths,
    digest,
    type ImportLogEntry,
    indexMessage,
    importSources,
    isCase,
    isIndexed,
    keyDemand,
    listMessages,
    logSources,
    messageCount,
    openCase,
    openIndex,
    rawPath,
    readMessage,
    readRaw,
    removeMessage,
    searchMessages,
    sourceHashes,
    store,
    verdictCounts,
} from '@stamped/store';

import { archive, fixtureKeys } from './fixtures.ts';

/** A fresh case folder under the system temporary directory, removed when `body` returns. */
async function withCase(body: (paths: CasePaths, root: string) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'stamped-case-'));
    try {
        await body(openCase(root), root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** An in-memory index with the current schema — enough for the pure query functions. */
function withIndex(body: (db: DatabaseSync) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'stamped-index-'));
    try {
        const db = openIndex(casePaths(root));
        try {
            body(db);
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** A message as bytes, from a subject and a body — enough to be summarised and indexed. */
function message(subject: string, body: string, from = 'Ada Lovelace <ada@example.com>'): Uint8Array {
    return encodeLatin1(
        [
            `From: ${from}`,
            'To: Grace Hopper <grace@example.net>',
            `Subject: ${subject}`,
            'Date: Tue, 05 Mar 2024 09:40:00 +0000',
            `Message-ID: <${subject.replace(/\W+/g, '-').toLowerCase()}@example.com>`,
            '',
            body,
            '',
        ].join('\n'),
    );
}

/**
 * A finding, without running a verifier.
 *
 * The index stores what a classification concluded; what the classification IS has its own suite
 * (`classify.test.ts`). Building one here by hand keeps this suite about the storage.
 */
function finding(verdict: Verdict, signatures: { domain: string; selector: string }[] = []): MessageFinding {
    return {
        verdict,
        caveats: [],
        signatures: signatures.map((signature) => ({
            verdict,
            caveats: [],
            evidence: {
                domain: signature.domain,
                selector: signature.selector,
                algorithm: 'rsa-sha256',
                canonicalization: 'relaxed/relaxed',
                signedHeaders: ['from', 'to', 'subject', 'date'],
                bodyHashOk: verdict !== 'body-altered',
                signatureOk: verdict === 'confirmed',
                authorDomain: signature.domain,
                aligned: true,
                keyBits: 2048,
                keySource: 'operator',
            },
        })),
    };
}

/** Put one message in the index under its own hash, and give that hash back. */
function put(
    db: DatabaseSync,
    raw: Uint8Array,
    verdict: Verdict,
    signatures: { domain: string; selector: string }[] = [],
): string {
    const hash = digest(raw);
    indexMessage(db, {
        hash,
        bytes: raw.length,
        summary: summarise(raw),
        finding: finding(verdict, signatures),
    });
    return hash;
}

export default async () => {
    await describe('the case folder', async () => {
        await it('creates the marker and the raw store', async () => {
            await withCase((paths, root) => {
                expect(existsSync(paths.marker)).toBe(true);
                expect(existsSync(paths.raw)).toBe(true);
                expect(isCase(root)).toBe(true);
                const marker = JSON.parse(readFileSync(paths.marker, 'utf8')) as Record<string, unknown>;
                expect(marker.kind).toBe('stamped-case');
                expect(marker.version).toBe(CASE_VERSION);
            });
        });

        await it('opens an existing case again without changing it', async () => {
            await withCase((paths, root) => {
                const before = readFileSync(paths.marker, 'utf8');
                openCase(root);
                expect(readFileSync(paths.marker, 'utf8')).toBe(before);
            });
        });

        await it('refuses a case folder written by a newer Stamped', async () => {
            // Refusing rather than writing into it: an older build ignoring a field it does not
            // know produces an index disagreeing with the store, and that shows up as messages
            // missing from a search — indistinguishable from "it is not in the leak".
            await withCase((paths, root) => {
                writeFileSync(
                    paths.marker,
                    JSON.stringify({
                        kind: 'stamped-case',
                        version: CASE_VERSION + 1,
                        created: '2026-01-01',
                    }),
                );
                let refused = false;
                try {
                    openCase(root);
                } catch {
                    refused = true;
                }
                expect(refused).toBe(true);
            });
        });

        await it('does not call an ordinary directory a case', async () => {
            const plain = mkdtempSync(join(tmpdir(), 'stamped-plain-'));
            try {
                expect(isCase(plain)).toBe(false);
            } finally {
                rmSync(plain, { recursive: true, force: true });
            }
        });
    });

    await describe('the raw store', async () => {
        await it('stores a message under the hash of its own bytes', async () => {
            await withCase((paths) => {
                const raw = message('Harbour contract', 'The contract is signed.');
                const result = store(paths, raw);
                expect(result.stored).toBe(true);
                expect(result.hash).toBe(digest(raw));
                // The name IS the checksum, so anyone can re-hash the file and catch a store that
                // quietly re-encoded a message.
                expect(result.path).toBe(rawPath(paths, result.hash));
                expect(new Uint8Array(readFileSync(result.path))).toStrictEqual(raw);
            });
        });

        await it('fans the store out by the first two hex characters', async () => {
            await withCase((paths) => {
                const hash = digest(message('One', 'body'));
                expect(rawPath(paths, hash)).toBe(join(paths.raw, hash.slice(0, 2), `${hash}.eml`));
            });
        });

        await it('recognises the same bytes as already stored', async () => {
            await withCase((paths) => {
                const raw = message('Harbour contract', 'The contract is signed.');
                expect(store(paths, raw).stored).toBe(true);
                const again = store(paths, raw);
                expect(again.stored).toBe(false);
                expect(again.hash).toBe(digest(raw));
            });
        });

        await it('leaves no .part behind', async () => {
            await withCase((paths) => {
                const result = store(paths, message('One', 'body'));
                expect(existsSync(`${result.path}.part`)).toBe(false);
            });
        });

        await it('reads a stored message back, and says nothing about a hash it has not got', async () => {
            // The window re-verifies from these bytes rather than trusting the index, so a read
            // that quietly returned something else would make the evidence pane a fiction.
            await withCase((paths) => {
                const raw = message('Harbour contract', 'The contract is signed.');
                const { hash } = store(paths, raw);
                expect(readRaw(paths, hash)).toStrictEqual(raw);
                expect(readRaw(paths, 'f'.repeat(64))).toBe(undefined);
            });
        });

        await it('writes the import log as one JSON object per line', async () => {
            // JSON Lines and not a table: the chain of custody must survive the index being
            // deleted and be readable with `tail` on a machine with no tooling.
            await withCase((paths) => {
                const entries: ImportLogEntry[] = [
                    {
                        hash: 'a'.repeat(64),
                        source: '/archive/inbox.mbox',
                        offset: 0,
                        kind: 'mbox',
                        bytes: 120,
                        at: '2026-01-01T00:00:00.000Z',
                        duplicate: false,
                    },
                    {
                        hash: 'b'.repeat(64),
                        source: '/archive/inbox.mbox',
                        offset: 120,
                        kind: 'mbox',
                        bytes: 90,
                        at: '2026-01-01T00:00:01.000Z',
                        duplicate: true,
                    },
                ];
                appendLog(paths, entries);
                appendLog(paths, []);
                const lines = readFileSync(paths.log, 'utf8').trim().split('\n');
                expect(lines.length).toBe(2);
                const second = JSON.parse(lines[1] ?? '') as ImportLogEntry;
                expect(second.offset).toBe(120);
                expect(second.duplicate).toBe(true);
            });
        });
    });

    await describe('the provenance of a case', async () => {
        await it('groups the import log by source, most mail first', async () => {
            await withCase(async (paths) => {
                await importSources(paths, [archive('inbox.mbox'), archive('maildir')], {
                    keys: fixtureKeys(),
                });
                const sources = logSources(paths);
                // One mbox of five reads, and the two Maildir messages as one source each: the
                // importer logs the file it read, and a Maildir message is its own file.
                expect(sources.length).toBe(3);
                expect(sources[0]?.messages).toBe(5);
                expect(sources[0]?.kind).toBe('mbox');
                expect(sources[0]?.source.endsWith('inbox.mbox')).toBe(true);
                // The duplicate inside the mbox is reported, not netted off: the same mail twice
                // is a fact about the archive.
                expect(sources[0]?.duplicates).toBe(1);
            });
        });

        await it('answers an unimported case with no sources rather than failing', async () => {
            await withCase((paths) => {
                expect(logSources(paths).length).toBe(0);
                expect(sourceHashes(paths, '/archive/inbox.mbox').size).toBe(0);
            });
        });

        await it('skips a log line a crash truncated', async () => {
            // The log is append-only, so the last line is the one that can be half-written. A
            // reader that threw on it would make a whole case unopenable.
            await withCase((paths) => {
                appendLog(paths, [
                    {
                        hash: 'a'.repeat(64),
                        source: '/archive/inbox.mbox',
                        offset: 0,
                        kind: 'mbox',
                        bytes: 120,
                        at: '2026-01-01T00:00:00.000Z',
                        duplicate: false,
                    },
                ]);
                writeFileSync(paths.log, `${readFileSync(paths.log, 'utf8')}{"hash":"bb`, { flag: 'w' });
                const sources = logSources(paths);
                expect(sources.length).toBe(1);
                expect(sources[0]?.messages).toBe(1);
            });
        });

        await it('gives the hashes one source contributed, overlaps included', async () => {
            // Sources do NOT partition a case: the same message out of two archives belongs to
            // both, which is how an archive's overlap with another is reconstructed.
            await withCase(async (paths) => {
                const mbox = archive('inbox.mbox');
                const elsewhere = mkdtempSync(join(tmpdir(), 'stamped-second-'));
                try {
                    // The same archive under another name — the everyday case of one mailbox
                    // handed over twice.
                    const copy = join(elsewhere, 'second.mbox');
                    writeFileSync(copy, readFileSync(mbox));
                    await importSources(paths, [mbox, copy], { keys: fixtureKeys() });

                    const first = sourceHashes(paths, mbox);
                    const second = sourceHashes(paths, copy);
                    // Four distinct messages out of five reads: the mbox holds one of them twice.
                    expect(first.size).toBe(4);
                    expect(second.size).toBe(4);
                    // Sources do NOT partition a case. A message out of two archives belongs to
                    // both, and a filter that handed it to only the first would hide from which
                    // archive a message is available — which is how provenance is reconstructed.
                    expect([...second].every((hash) => first.has(hash))).toBe(true);
                } finally {
                    rmSync(elsewhere, { recursive: true, force: true });
                }
            });
        });
    });

    await describe('the index', async () => {
        await it('finds a message by a word in its body', async () => {
            withIndex((db) => {
                const hash = put(db, message('Tender', 'the lighthouse survey follows'), 'unsigned');
                const hits = searchMessages(db, 'lighthouse');
                expect(hits.length).toBe(1);
                expect(hits[0]?.hash).toBe(hash);
                expect(hits[0]?.verdict).toBe('unsigned');
            });
        });

        await it('searches one field on its own', async () => {
            withIndex((db) => {
                put(db, message('Invoice', 'nothing about an invoice in the body'), 'unsigned');
                expect(searchMessages(db, 'subject : invoice').length).toBe(1);
                expect(searchMessages(db, 'subject : lighthouse').length).toBe(0);
            });
        });

        await it('passes a phrase and a boolean query through to FTS5', async () => {
            // Unescaped on purpose: `AND`, `"a phrase"` and `column : word` are what archive work
            // needs, and a layer that escaped them would take the capability away while looking
            // like it worked.
            withIndex((db) => {
                put(db, message('One', 'the harbour contract is signed'), 'unsigned');
                put(db, message('Two', 'the lighthouse survey'), 'unsigned');
                expect(searchMessages(db, '"harbour contract"').length).toBe(1);
                expect(searchMessages(db, 'harbour AND contract').length).toBe(1);
                expect(searchMessages(db, 'harbour OR lighthouse').length).toBe(2);
            });
        });

        await it('searches what FTS5 cannot parse as literal words', async () => {
            // An address, a domain and a reply subject are the first things typed into an
            // archive search, and each is an FTS5 syntax error as written.
            withIndex((db) => {
                put(db, message('Re: Angebot', 'mail from chef@firma.de about the offer'), 'unsigned');
                expect(searchMessages(db, 'chef@firma.de').length).toBe(1);
                expect(searchMessages(db, 'firma.de').length).toBe(1);
                expect(searchMessages(db, 'Re: Angebot').length).toBe(1);
                expect(searchMessages(db, 'chef@other.de').length).toBe(0);
            });
        });

        await it('answers an empty query with nothing rather than everything', async () => {
            withIndex((db) => {
                put(db, message('One', 'body'), 'unsigned');
                expect(searchMessages(db, '   ').length).toBe(0);
            });
        });

        await it('honours the limit and clamps a nonsensical one', async () => {
            withIndex((db) => {
                for (let i = 0; i < 5; i++) put(db, message(`Note ${i}`, 'the harbour again'), 'unsigned');
                expect(searchMessages(db, 'harbour', 2).length).toBe(2);
                expect(searchMessages(db, 'harbour', 0).length).toBe(1);
                expect(searchMessages(db, 'harbour', -7).length).toBe(1);
            });
        });

        await it('replaces a row rather than duplicating it when re-indexed', async () => {
            // The same message verified again after a key arrives must end up with the NEW
            // verdict and one row, not two.
            withIndex((db) => {
                const raw = message('Tender', 'the harbour contract');
                const hash = put(db, raw, 'unverifiable');
                put(db, raw, 'confirmed');
                expect(messageCount(db)).toBe(1);
                const hits = searchMessages(db, 'harbour');
                expect(hits.length).toBe(1);
                expect(hits[0]?.verdict).toBe('confirmed');
                expect(isIndexed(db, hash)).toBe(true);
            });
        });

        await it('forgets a message from every table at once', async () => {
            withIndex((db) => {
                const hash = put(db, message('Tender', 'the harbour contract'), 'confirmed', [
                    { domain: 'example.com', selector: 'sel' },
                ]);
                removeMessage(db, hash);
                expect(isIndexed(db, hash)).toBe(false);
                expect(messageCount(db)).toBe(0);
                expect(searchMessages(db, 'harbour').length).toBe(0);
                expect(keyDemand(db).length).toBe(0);
            });
        });

        await it('lists the case newest first, with the messages it could not date last', async () => {
            // The window's list before anything is typed. A message whose `Date` was unreadable
            // must not sort to 1970: a gap in the data would then read as a fact about the mail.
            withIndex((db) => {
                const dated = (subject: string, date: string) =>
                    encodeLatin1(`Subject: ${subject}\nDate: ${date}\n\nbody of ${subject}\n`);
                put(db, dated('Middle', 'Wed, 06 Mar 2024 09:40:00 +0000'), 'unsigned');
                put(db, dated('Oldest', 'Tue, 05 Mar 2024 09:40:00 +0000'), 'unsigned');
                put(db, dated('Newest', 'Fri, 08 Mar 2024 16:30:45 +0000'), 'unsigned');
                put(db, dated('Undated', 'whenever'), 'unsigned');
                const subjects = listMessages(db).map((hit) => hit.subject);
                expect(subjects).toStrictEqual(['Newest', 'Middle', 'Oldest', 'Undated']);
            });
        });

        await it('narrows the list to one verdict and to one source', async () => {
            withIndex((db) => {
                const one = put(db, message('One', 'body one'), 'confirmed');
                put(db, message('Two', 'body two'), 'confirmed');
                put(db, message('Three', 'body three'), 'unverifiable');
                expect(listMessages(db, { verdict: 'confirmed' }).length).toBe(2);
                expect(listMessages(db, { verdict: 'body-altered' }).length).toBe(0);
                // What a folder filter is: the hashes one archive contributed.
                const only = listMessages(db, { hashes: new Set([one]) });
                expect(only.length).toBe(1);
                expect(only[0]?.hash).toBe(one);
                // Both at once, and a filter that matches nothing is empty rather than everything.
                expect(listMessages(db, { verdict: 'unverifiable', hashes: new Set([one]) }).length).toBe(0);
            });
        });

        await it('honours the list limit and clamps a nonsensical one', async () => {
            withIndex((db) => {
                for (let i = 0; i < 5; i++) put(db, message(`Note ${i}`, `body ${i}`), 'unsigned');
                expect(listMessages(db, { limit: 2 }).length).toBe(2);
                expect(listMessages(db, { limit: 0 }).length).toBe(1);
                expect(listMessages(db, { limit: -7 }).length).toBe(1);
            });
        });

        await it('reads one message out of the index, and nothing for a hash it has not got', async () => {
            withIndex((db) => {
                const raw = message('Harbour contract', 'the contract is signed');
                const hash = put(db, raw, 'confirmed', [{ domain: 'example.com', selector: 'sel' }]);
                const found = readMessage(db, hash);
                expect(found?.subject).toBe('Harbour contract');
                expect(found?.from).toBe('Ada Lovelace <ada@example.com>');
                expect(found?.to).toBe('Grace Hopper <grace@example.net>');
                expect(found?.verdict).toBe('confirmed');
                expect(found?.bytes).toBe(raw.length);
                expect(found?.fromDomain).toBe('example.com');
                expect(readMessage(db, 'f'.repeat(64))).toBe(undefined);
            });
        });

        await it('reports a header the message never had as absent, not as the word null', async () => {
            // A nullable TEXT column read with String() gives "null", which in a pane about what
            // a message says would be a header field this tool invented.
            withIndex((db) => {
                const hash = put(db, encodeLatin1('Subject: Bare\n\nbody\n'), 'unsigned');
                const found = readMessage(db, hash);
                expect(found?.messageId).toBe(undefined);
                expect(found?.fromDomain).toBe(undefined);
                expect(found?.from).toBe('');
                expect(found?.date).toBe('');
            });
        });

        await it('opens a never-imported case as an empty index, not as a failure', async () => {
            // Searching one must say "no results"; a missing table would read like a broken
            // installation.
            withIndex((db) => {
                expect(messageCount(db)).toBe(0);
                expect(searchMessages(db, 'harbour').length).toBe(0);
            });
        });
    });

    await describe('the report', async () => {
        await it('counts every verdict, including the ones with no messages', async () => {
            // A table showing four of the six would read as if the other two had not been looked
            // for — and the missing one would sooner or later be `body-altered`.
            withIndex((db) => {
                put(db, message('One', 'body one'), 'confirmed');
                put(db, message('Two', 'body two'), 'confirmed');
                put(db, message('Three', 'body three'), 'body-altered');
                const counts = verdictCounts(db);
                expect(counts.length).toBe(VERDICTS.length);
                expect(counts.map((count) => count.verdict)).toStrictEqual([...VERDICTS]);
                const by = new Map(counts.map((count) => [count.verdict, count.messages]));
                expect(by.get('confirmed')).toBe(2);
                expect(by.get('body-altered')).toBe(1);
                expect(by.get('unsigned')).toBe(0);
            });
        });

        await it('counts confirmed-with-caveats as confirmed per pair, and breaks the caveats down', async () => {
            withIndex((db) => {
                const sig = [{ domain: 'example.com', selector: 'sel' }];
                put(db, message('One', 'body one'), 'confirmed', sig);
                const raw = message('Two', 'body two');
                const caveated = finding('confirmed-with-caveats', sig);
                indexMessage(db, {
                    hash: digest(raw),
                    bytes: raw.length,
                    summary: summarise(raw),
                    finding: { ...caveated, caveats: ['archive-key', 'unsigned-date'] },
                });
                const raw2 = message('Three', 'body three');
                indexMessage(db, {
                    hash: digest(raw2),
                    bytes: raw2.length,
                    summary: summarise(raw2),
                    finding: { ...caveated, caveats: ['archive-key'] },
                });
                const demand = keyDemand(db);
                expect(demand[0]?.confirmed).toBe(3);
                expect(demand[0]?.withCaveats).toBe(2);
                const caveats = caveatCounts(db);
                expect(caveats.length).toBe(CAVEATS.length);
                const by = new Map(caveats.map((c) => [c.caveat, c.messages]));
                expect(by.get('archive-key')).toBe(2);
                expect(by.get('unsigned-date')).toBe(1);
                expect(by.get('rsa-sha1')).toBe(0);
                expect(caseReport(db).caveats.length).toBe(CAVEATS.length);
            });
        });

        await it('ranks the (domain, selector) pairs by how much mail depends on them', async () => {
            withIndex((db) => {
                put(db, message('One', 'body one'), 'unverifiable', [
                    { domain: 'example.com', selector: 'big' },
                ]);
                put(db, message('Two', 'body two'), 'unverifiable', [
                    { domain: 'example.com', selector: 'big' },
                ]);
                put(db, message('Three', 'body three'), 'confirmed', [
                    { domain: 'example.net', selector: 'small' },
                ]);
                const demand = keyDemand(db);
                expect(demand.length).toBe(2);
                expect(demand[0]?.selector).toBe('big');
                expect(demand[0]?.messages).toBe(2);
                // The number that actually ranks the work: how much of the prize is unclaimed.
                expect(demand[0]?.unverifiable).toBe(2);
                expect(demand[1]?.confirmed).toBe(1);
                expect(demand[1]?.unverifiable).toBe(0);
            });
        });

        await it('counts a message signed twice by one pair once', async () => {
            // Over signature ROWS it would count twice, and a list that re-signs would climb the
            // work list on duplicate signatures rather than on mail.
            withIndex((db) => {
                put(db, message('One', 'body one'), 'unverifiable', [
                    { domain: 'example.com', selector: 'sel' },
                    { domain: 'example.com', selector: 'sel' },
                ]);
                const demand = keyDemand(db);
                expect(demand.length).toBe(1);
                expect(demand[0]?.messages).toBe(1);
            });
        });

        await it('reports an empty case without inventing a date range', async () => {
            // A SQL aggregate over no rows is NULL, not zero — and a 1970 in a date range would
            // read as a fact about the archive.
            withIndex((db) => {
                const report = caseReport(db);
                expect(report.messages).toBe(0);
                expect(report.bytes).toBe(0);
                expect(report.keys.length).toBe(0);
                expect(report.earliest).toBe(undefined);
                expect(report.latest).toBe(undefined);
                expect(report.verdicts.length).toBe(VERDICTS.length);
            });
        });

        await it('reports the totals and the span of the dates it could read', async () => {
            withIndex((db) => {
                const early = encodeLatin1('Subject: Early\nDate: Tue, 05 Mar 2024 09:40:00 +0000\n\nbody\n');
                const late = encodeLatin1('Subject: Late\nDate: Fri, 08 Mar 2024 16:30:45 +0000\n\nbody\n');
                const undated = encodeLatin1('Subject: Undated\nDate: whenever\n\nbody\n');
                put(db, early, 'unsigned');
                put(db, late, 'unsigned');
                put(db, undated, 'unsigned');
                const report = caseReport(db);
                expect(report.messages).toBe(3);
                expect(report.bytes).toBe(early.length + late.length + undated.length);
                expect(report.earliest).toBe(Date.UTC(2024, 2, 5, 9, 40, 0));
                expect(report.latest).toBe(Date.UTC(2024, 2, 8, 16, 30, 45));
            });
        });
    });

    await describe('importing an archive', async () => {
        await it('reads an mbox, stores each message once and logs where it came from', async () => {
            await withCase(async (paths) => {
                const source = archive('inbox.mbox');
                const result = await importSources(paths, [source], { keys: fixtureKeys() });
                // Five separators in the fixture, the last message byte-identical to the first.
                expect(result.read).toBe(5);
                expect(result.stored).toBe(4);
                expect(result.duplicates).toBe(1);
                expect(result.indexed).toBe(4);
                expect(result.failed).toBe(0);

                const log = readFileSync(paths.log, 'utf8')
                    .trim()
                    .split('\n')
                    .map((line) => JSON.parse(line) as ImportLogEntry);
                expect(log.length).toBe(5);
                expect(log.every((entry) => entry.source === source)).toBe(true);
                expect(log.every((entry) => entry.kind === 'mbox')).toBe(true);
                // The offsets must climb — each names the separator line of its message, which is
                // where an auditor seeks in the original archive.
                expect(log[0]?.offset).toBe(0);
                expect((log[1]?.offset ?? 0) > 0).toBe(true);
                expect(log[4]?.duplicate).toBe(true);
                expect(log[4]?.hash).toBe(log[0]?.hash);
            });
        });

        await it('restores a body line the mbox writer escaped', async () => {
            // THE ASSERTION THIS SUITE EXISTS FOR. A `>From ` left in the body is a byte the
            // sender never sent, so the body hash is not the signed one and a good message reports
            // as `body-altered` — Stamped's strongest accusation, produced by its own reader.
            await withCase(async (paths) => {
                await importSources(paths, [archive('inbox.mbox')], { keys: fixtureKeys() });
                const db = openIndex(paths);
                try {
                    const hits = searchMessages(db, 'subject : Quoting');
                    expect(hits.length).toBe(1);
                    // Read as bytes and decoded here rather than with an encoding argument: GJS's
                    // TextDecoder has no 'binary'/'latin1' label, and the point is the octets.
                    const raw = decodeLatin1(
                        new Uint8Array(readFileSync(rawPath(paths, String(hits[0]?.hash)))),
                    );
                    expect(raw.includes('\n>From a previous mail, quoted:')).toBe(true);
                    expect(raw.includes('\n>>From a previous mail')).toBe(false);
                    // The deeper quoting loses exactly one `>` and no more.
                    expect(raw.includes('\n>> the tender closes on Friday')).toBe(true);
                    // And the line that is not a separator stayed in the body it belongs to.
                    expect(raw.startsWith('From: ')).toBe(true);
                } finally {
                    db.close();
                }
            });
        });

        await it('indexes the decoded subject and the decoded parts', async () => {
            await withCase(async (paths) => {
                await importSources(paths, [archive('inbox.mbox')], { keys: fixtureKeys() });
                const db = openIndex(paths);
                try {
                    // An RFC 2047 subject split across two encoded words: the compound must come
                    // back unbroken or it is unsearchable.
                    const encoded = searchMessages(db, 'Hafen\u00fcberwachungsbeh\u00f6rde');
                    expect(encoded.length).toBe(1);
                    expect(encoded[0]?.subject).toBe('Hafen\u00fcberwachungsbeh\u00f6rde');
                    // The quoted-printable part and the base64 HTML part of the same message.
                    expect(searchMessages(db, '\u00d6resund').length).toBe(1);
                    expect(searchMessages(db, 'pierhead').length).toBe(1);
                    // …and the CSS inside that part's <style> block reached nothing.
                    expect(searchMessages(db, 'scarlet').length).toBe(0);
                } finally {
                    db.close();
                }
            });
        });

        await it('does not cut a message in half at a body line starting "From "', async () => {
            await withCase(async (paths) => {
                const result = await importSources(paths, [archive('not-a-separator.mbox')], {
                    keys: fixtureKeys(),
                });
                expect(result.read).toBe(1);
                expect(result.stored).toBe(1);
            });
        });

        await it('reads a Maildir from new and cur, and never from tmp', async () => {
            // A message in `tmp/` is one a delivery agent has not finished writing. Importing it
            // puts half a message in the case folder under a hash that will never match the
            // finished file.
            await withCase(async (paths) => {
                const result = await importSources(paths, [archive('maildir')], { keys: fixtureKeys() });
                expect(result.read).toBe(2);
                expect(result.stored).toBe(2);
                const db = openIndex(paths);
                try {
                    expect(messageCount(db)).toBe(2);
                    expect(searchMessages(db, 'subject : schedule').length).toBe(1);
                    expect(searchMessages(db, 'subject : results').length).toBe(1);
                    expect(searchMessages(db, '"must not be imported"').length).toBe(0);
                } finally {
                    db.close();
                }
            });
        });

        await it('runs twice over the same archive without adding anything', async () => {
            // What makes an interrupted import simply runnable again rather than something to
            // clean up first.
            await withCase(async (paths) => {
                const source = archive('inbox.mbox');
                await importSources(paths, [source], { keys: fixtureKeys() });
                const again = await importSources(paths, [source], { keys: fixtureKeys() });
                expect(again.read).toBe(5);
                expect(again.stored).toBe(0);
                expect(again.duplicates).toBe(5);
                expect(again.indexed).toBe(0);
                const db = openIndex(paths);
                try {
                    expect(messageCount(db)).toBe(4);
                } finally {
                    db.close();
                }
                // The log keeps both runs: it records what was READ, which happened twice.
                expect(readFileSync(paths.log, 'utf8').trim().split('\n').length).toBe(10);
            });
        });

        await it('collapses the same message met in two different archives', async () => {
            await withCase(async (paths) => {
                const result = await importSources(paths, [archive('inbox.mbox'), archive('maildir')], {
                    keys: fixtureKeys(),
                });
                expect(result.read).toBe(7);
                expect(result.stored).toBe(6);
            });
        });

        await it('reaches a verdict for every message it imported', async () => {
            await withCase(async (paths) => {
                await importSources(paths, [archive('inbox.mbox')], { keys: fixtureKeys() });
                const db = openIndex(paths);
                try {
                    const report = caseReport(db);
                    expect(report.messages).toBe(4);
                    const by = new Map(report.verdicts.map((count) => [count.verdict, count.messages]));
                    // The archive fixtures carry no DKIM signature at all, so every message is
                    // `unsigned` — and no key is needed to say so.
                    expect(by.get('unsigned')).toBe(4);
                    expect(report.keys.length).toBe(0);
                } finally {
                    db.close();
                }
            });
        });

        await it('imports a single .eml by its content, whatever it is called', async () => {
            await withCase(async (paths) => {
                const result = await importSources(paths, [archive('maildir', 'new')], {
                    keys: fixtureKeys(),
                });
                expect(result.read).toBe(1);
                expect(result.stored).toBe(1);
                const log = JSON.parse(readFileSync(paths.log, 'utf8').trim()) as ImportLogEntry;
                expect(log.kind).toBe('eml');
                expect(log.offset).toBe(0);
            });
        });
    });
};
