/**
 * The window's view models — everything the GUI decides before a widget is involved.
 *
 * WHY THIS SUITE EXISTS. A GTK window cannot be asserted on in CI, so the part of it that can be
 * wrong in a way that matters is kept out of the widgets: which badge a verdict gets, what a row
 * says, whether a header field is escaped, how the key work list is ranked. Those are claims
 * about mail, and they are tested here as data. What is left in the `.blp` files and the row
 * builders is layout, which a screenshot checks.
 *
 * Three things are being guarded above all:
 *
 * - **Escaping.** A subject or a From line reaches a Pango parser, and `<ada@example.com>` makes
 *   that parser drop the rest of the string. A From line vanishing from a row is a message that
 *   reads as having no sender.
 * - **The six verdicts stay six.** No merging, no empty rows dropped, and `unverifiable` never
 *   coloured as a failure.
 * - **Nothing leaves the machine unasked.** The consent dialog shows every pair it would send.
 */

import { describe, expect, it } from '@gjsify/unit';
import { classifyMessage, describeVerdict, VERDICTS, type SignatureEvidence } from '@stamped/core';
import type { CaseReport, KeyDemand, LogSource, SearchHit, IndexedMessage } from '@stamped/store';

import { channelLabel, consentDialog, LOOKUP_CHANNELS } from '../../src/gui/view/consent.ts';
import { caveatsHeading, signatureCards, verdictCard } from '../../src/gui/view/evidence.ts';
import { formatBytes, groupDigits, shortDate, shortHash } from '../../src/gui/view/format.ts';
import { importSummary } from '../../src/gui/view/import.ts';
import { explainKey, keyRows, keySummary, lookupPairs, lookupSummary } from '../../src/gui/view/keys.ts';
import { escapeLine, escapeMarkup, plainText } from '../../src/gui/view/markup.ts';
import { emptyList, headerFields, messageRow, rawHeaders } from '../../src/gui/view/message.ts';
import {
    overviewHeadline,
    overviewNextStep,
    overviewStats,
    verdictShares,
} from '../../src/gui/view/overview.ts';
import { allSources, baseName, sourceRows } from '../../src/gui/view/sources.ts';
import { explainVerdict, verdictFilters, verdictLook } from '../../src/gui/view/verdict.ts';

/** A signature that verified cleanly, as the baseline every case below varies. */
function good(overrides: Partial<SignatureEvidence> = {}): SignatureEvidence {
    return {
        domain: 'example.com',
        selector: 'sel',
        algorithm: 'rsa-sha256',
        canonicalization: 'relaxed/relaxed',
        signedHeaders: ['from', 'to', 'subject', 'date'],
        bodyHashOk: true,
        signatureOk: true,
        authorDomain: 'example.com',
        aligned: true,
        keyBits: 2048,
        keySource: 'operator',
        bodyHash: 'AAAAhashOfTheBodyAsItStands=',
        ...overrides,
    };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
        hash: 'a'.repeat(64),
        subject: 'Harbour contract',
        from: 'Ada Lovelace <ada@example.com>',
        date: 'Tue, 05 Mar 2024 09:40:00 +0000',
        sentAt: Date.UTC(2024, 2, 5, 9, 40),
        verdict: 'confirmed',
        ...overrides,
    };
}

function indexed(overrides: Partial<IndexedMessage> = {}): IndexedMessage {
    return {
        hash: 'b'.repeat(64),
        bytes: 4096,
        from: 'Ada Lovelace <ada@example.com>',
        to: 'Grace Hopper <grace@example.net>',
        cc: '',
        subject: 'Harbour contract',
        date: 'Tue, 05 Mar 2024 09:40:00 +0000',
        verdict: 'confirmed',
        caveats: [],
        ...overrides,
    };
}

function demand(overrides: Partial<KeyDemand> = {}): KeyDemand {
    return {
        domain: 'example.com',
        selector: 'sel',
        messages: 10,
        unverifiable: 10,
        confirmed: 0,
        ...overrides,
    };
}

function report(overrides: Partial<CaseReport> = {}): CaseReport {
    return {
        messages: 0,
        bytes: 0,
        verdicts: VERDICTS.map((verdict) => ({ verdict, messages: 0 })),
        keys: [],
        ...overrides,
    };
}

/** A report with a count per verdict, the rest at zero. */
function counted(
    counts: Partial<Record<(typeof VERDICTS)[number], number>>,
    keys: KeyDemand[] = [],
): CaseReport {
    const verdicts = VERDICTS.map((verdict) => ({ verdict, messages: counts[verdict] ?? 0 }));
    let messages = 0;
    for (const count of verdicts) messages += count.messages;
    return { messages, bytes: messages * 1000, verdicts, keys };
}

export default async () => {
    await describe('markup escaping', async () => {
        await it('escapes the ampersand before the angle brackets', async () => {
            // The other order turns `<` into `&lt;` and then that `&` into `&amp;lt;`.
            expect(escapeMarkup('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
        });

        await it('keeps a folded header on one line', async () => {
            expect(escapeLine('Re:\n\tthe  tender')).toBe('Re: the tender');
        });

        await it('undoes exactly what it escaped, for the widgets that take no markup', async () => {
            // `Adw.WindowTitle` renders `&amp;` literally, so a case folder named `Mail & Co`
            // would read as `Mail &amp;amp; Co` in the header bar without this.
            expect(plainText(escapeMarkup('Mail & Co <2024>'))).toBe('Mail & Co <2024>');
            // `&amp;` last, so a literal `&amp;lt;` in the SOURCE text survives the round trip
            // instead of decaying into `<`.
            expect(plainText(escapeMarkup('&lt;'))).toBe('&lt;');
        });
    });

    await describe('how a verdict looks', async () => {
        await it('says the sentence @stamped/core declares, never its own', async () => {
            for (const verdict of VERDICTS) {
                expect(verdictLook(verdict).sentence).toBe(describeVerdict(verdict));
            }
        });

        await it('does not colour an unverifiable message as a failure', async () => {
            // The absence of a finding is not a finding. A red badge here reads as "forged",
            // which is the mistake that gets a true story spiked.
            expect(verdictLook('unverifiable').cssClass).toBe('accent');
            expect(verdictLook('unsigned').cssClass).toBe('dimmed');
            expect(verdictLook('confirmed').cssClass).toBe('success');
        });

        await it('keeps the two kinds of tampering apart', async () => {
            const body = verdictLook('body-altered');
            const headers = verdictLook('headers-altered');
            // One colour, because both are positive findings of tampering…
            expect(body.cssClass).toBe('error');
            expect(headers.cssClass).toBe('error');
            // …but never one badge: which of the two was found is the distinction the whole
            // vocabulary exists for.
            expect(body.label === headers.label).toBe(false);
            expect(body.icon === headers.icon).toBe(false);
        });

        await it('lists all six filters with their zeroes, plus an all-messages row', async () => {
            const filters = verdictFilters([
                { verdict: 'confirmed', messages: 2 },
                { verdict: 'unsigned', messages: 1 },
            ]);
            expect(filters.length).toBe(VERDICTS.length + 1);
            expect(filters[0]?.verdict).toBe(undefined);
            expect(filters[0]?.count).toBe(3);
            const byVerdict = new Map(filters.slice(1).map((filter) => [filter.verdict, filter.count]));
            expect(byVerdict.get('confirmed')).toBe(2);
            // A row a filter list hid would read as a verdict nobody looked for.
            expect(byVerdict.get('body-altered')).toBe(0);
            expect(filters.slice(1).every((filter) => (filter.explanation ?? '').length > 0)).toBe(true);
        });
    });

    await describe('formatting', async () => {
        await it('takes a row’s date from the header as written, not from a time zone', async () => {
            // Half past midnight in Helsinki is still the previous evening in UTC. The day a
            // message says it was sent is evidence; a day computed from it is not.
            expect(shortDate('Mon, 04 Mar 2019 00:30:00 +0200', Date.UTC(2019, 2, 3, 22, 30))).toBe(
                '2019-03-04',
            );
            expect(shortDate('5 Mar 2024 09:40:00 +0000')).toBe('2024-03-05');
        });

        await it('falls back to the parsed instant, and says so when there is neither', async () => {
            expect(shortDate('whenever', Date.UTC(2024, 2, 5, 9, 40))).toBe('2024-03-05');
            expect(shortDate('').includes('no date')).toBe(true);
        });

        await it('groups digits and sizes', async () => {
            // A narrow no-break space, not a comma and not an ordinary space: the group must not
            // wrap mid-number, and a comma reads as a decimal point to half of Europe.
            expect(groupDigits(1204)).toBe('1\u202f204');
            expect(groupDigits(999)).toBe('999');
            expect(groupDigits(1234567)).toBe('1\u202f234\u202f567');
            expect(formatBytes(999)).toBe('999 B');
            expect(formatBytes(1500)).toBe('1.5 kB');
            expect(formatBytes(4_200_000)).toBe('4.2 MB');
        });

        await it('shortens a hash to the twelve characters the CLI prints', async () => {
            expect(shortHash('a'.repeat(64))).toBe('a'.repeat(12));
        });
    });

    await describe('a message row', async () => {
        await it('escapes the sender’s angle brackets', async () => {
            // THE ASSERTION THIS MODULE EXISTS FOR: unescaped, the parser drops everything from
            // the `<` onwards and the row shows a message with no sender.
            const row = messageRow(hit());
            expect(row.subtitle.includes('&lt;ada@example.com&gt;')).toBe(true);
            expect(row.subtitle.includes('<')).toBe(false);
            expect(row.subtitle.includes('2024-03-05')).toBe(true);
        });

        await it('marks an empty subject and an empty sender rather than showing a blank row', async () => {
            const row = messageRow(hit({ subject: '', from: '' }));
            expect(row.title.includes('no subject')).toBe(true);
            expect(row.subtitle.includes('no sender')).toBe(true);
        });

        await it('carries the badge and the full sentence as the tooltip', async () => {
            const row = messageRow(hit({ verdict: 'body-altered' }));
            expect(row.badge).toBe(verdictLook('body-altered').label);
            expect(row.tooltip).toBe(escapeLine(describeVerdict('body-altered')));
            expect(row.cssClass).toBe('error');
        });
    });

    await describe('the header block of a message', async () => {
        await it('quotes the Date header as it stands', async () => {
            const fields = headerFields(indexed());
            const date = fields.find((field) => field.label === 'Date');
            expect(date?.value).toBe('Tue, 05 Mar 2024 09:40:00 +0000');
        });

        await it('leaves Cc out when the message had none', async () => {
            // An empty row would read as "nobody was copied" where the field was simply absent.
            expect(headerFields(indexed()).some((field) => field.label === 'Cc')).toBe(false);
            const withCc = headerFields(indexed({ cc: 'Alan Turing <alan@example.org>' }));
            expect(withCc.some((field) => field.label === 'Cc')).toBe(true);
            expect(withCc.find((field) => field.label === 'Cc')?.value.includes('&lt;alan@')).toBe(true);
        });

        await it('names the message by the hash the CLI uses', async () => {
            const fields = headerFields(indexed());
            const hash = fields.find((field) => field.label === 'SHA-256');
            expect(hash?.value).toBe('b'.repeat(12));
            expect(hash?.monospace).toBe(true);
            expect(fields.find((field) => field.label === 'Size')?.value).toBe('4.1 kB');
        });

        await it('copies the whole hash although it shows twelve characters of it', async () => {
            // The displayed form is what fits a row; the clipboard is what goes into a note to
            // a colleague, and a truncated hash there names no message.
            const hash = headerFields(indexed({ hash: 'b'.repeat(64) })).find(
                (field) => field.label === 'SHA-256',
            );
            expect(hash?.value).toBe('b'.repeat(12));
            expect(hash?.copy).toBe('b'.repeat(64));
        });

        await it('copies a Message-ID unescaped, because a clipboard takes no markup', async () => {
            const message = indexed({ messageId: '<2024-07@example.com>' });
            const field = headerFields(message).find((f) => f.label === 'Message-ID');
            expect(field?.value).toBe('&lt;2024-07@example.com&gt;');
            expect(field?.copy).toBe('<2024-07@example.com>');
        });

        await it('offers no copy button on the fields that are prose', async () => {
            const from = headerFields(indexed()).find((field) => field.label === 'From');
            expect(from?.copy).toBe(undefined);
        });
    });

    await describe('the raw header block', async () => {
        await it('cuts at the first empty line, whatever the line endings', async () => {
            const raw = 'From: ada@example.com\r\nSubject: hi\r\n\r\nBody line\r\n\r\nmore body\r\n';
            expect(rawHeaders(raw)).toBe('From: ada@example.com\nSubject: hi');
        });

        await it('keeps a header-only message whole', async () => {
            // No empty line means no body: the verifier sees the same thing, so the expander
            // must not silently show nothing.
            expect(rawHeaders('From: ada@example.com\n')).toBe('From: ada@example.com');
        });

        await it('returns the text unescaped, because a TextView takes no markup', async () => {
            expect(rawHeaders('From: Ada <ada@example.com>\n\nbody')).toBe('From: Ada <ada@example.com>');
        });
    });

    await describe('an empty message list', async () => {
        await it('always says how big the haystack was', async () => {
            // ZERO RESULTS IS THE DANGEROUS ANSWER here: it reads as "the mail is not in the
            // leak". The case size is what keeps it from being read that way.
            const search = emptyList(1204, 'lighthouse');
            expect(search.description.includes('1 204')).toBe(true);
            const filtered = emptyList(1204);
            expect(filtered.description.includes('1 204')).toBe(true);
            expect(filtered.title === search.title).toBe(false);
        });

        await it('says an empty case is empty instead of implying an answer', async () => {
            const empty = emptyList(0);
            expect(empty.description.includes('Import')).toBe(true);
            expect(empty.title.includes('No messages')).toBe(true);
        });
    });

    await describe('the verdict card and the evidence chain', async () => {
        await it('shows the verdict sentence and how many signatures were looked at', async () => {
            const card = verdictCard(classifyMessage([good(), good({ domain: 'lists.example.org' })]));
            expect(card.sentence).toBe(escapeLine(describeVerdict('confirmed')));
            expect(card.summary.includes('2')).toBe(true);
            expect(card.note).toBe(undefined);
        });

        await it('says on the card when the signature is not the author’s domain', async () => {
            // The caveat that decides whether the CEO's mail reads as the CEO's, so it may not
            // sit two expanders deep.
            const finding = classifyMessage([
                good({ domain: 'mailer.example.net', authorDomain: 'example.com', aligned: false }),
            ]);
            const card = verdictCard(finding);
            expect(card.verdict).toBe('confirmed-with-caveats');
            expect(card.note?.includes('mailer.example.net')).toBe(true);
            expect(card.note?.includes('example.com')).toBe(true);
        });

        await it('tells an unsigned message apart from a message with no verdict', async () => {
            const unsigned = verdictCard(classifyMessage([]));
            expect(unsigned.verdict).toBe('unsigned');
            expect(unsigned.summary.includes('No DKIM signature')).toBe(true);
            const unverifiable = verdictCard(
                classifyMessage([
                    good({ signatureOk: false, bodyHashOk: false, unverifiableBecause: 'no-key' }),
                ]),
            );
            expect(unverifiable.verdict).toBe('unverifiable');
            expect(unverifiable.cssClass).toBe('accent');
        });

        await it('gives every signature its own card, numbered and with its own verdict', async () => {
            // A forwarder's passing signature says nothing about the originator's.
            const cards = signatureCards(
                classifyMessage([
                    good({ bodyHashOk: false, signatureOk: false }),
                    good({ domain: 'lists.example.org', authorDomain: 'example.com', aligned: false }),
                ]),
            );
            expect(cards.length).toBe(2);
            expect(cards[0]?.verdict).toBe('body-altered');
            expect(cards[1]?.verdict).toBe('confirmed-with-caveats');
            expect(cards[0]?.heading.includes('1')).toBe(true);
            expect(cards[0]?.heading.includes('2')).toBe(true);
        });

        await it('carries every fact the CLI prints, including both body hashes', async () => {
            const cards = signatureCards(
                classifyMessage([
                    good({
                        bodyHashOk: false,
                        signatureOk: false,
                        bodyHash: 'whatThisMessageHashesTo=',
                        bodyHashExpected: 'whatTheSignerCommittedTo=',
                    }),
                ]),
            );
            const facts = cards[0]?.facts ?? [];
            const value = (label: string) => facts.find((fact) => fact.label === label)?.value ?? '';
            expect(value('domain')).toBe('example.com');
            expect(value('selector')).toBe('sel');
            expect(value('algorithm')).toBe('rsa-sha256');
            expect(value('signed headers')).toBe('from:to:subject:date');
            expect(value('key').includes('2048')).toBe(true);
            // Both hashes, or the reader is asked to take Stamped's word for it.
            expect(value('body hash').includes('whatThisMessageHashesTo=')).toBe(true);
            expect(value('body hash').includes('whatTheSignerCommittedTo=')).toBe(true);
        });

        await it('escapes a verifier note that contains markup', async () => {
            const cards = signatureCards(
                classifyMessage([
                    good({
                        signatureOk: false,
                        unverifiableBecause: 'bad-key',
                        note: 'no key for <sel._domainkey.example.com>',
                    }),
                ]),
            );
            const note = cards[0]?.facts.find((fact) => fact.label === 'verifier says')?.value ?? '';
            expect(note.includes('&lt;sel._domainkey.example.com&gt;')).toBe(true);
            expect(note.includes('<')).toBe(false);
        });

        await it('counts the caveats in the expander title and never calls them problems', async () => {
            // A caveat limits what a verified signature proves; it is not a defect. "2 caveats"
            // invites reading them where "problems" would invite discarding a genuine message.
            expect(caveatsHeading(1).includes('1')).toBe(true);
            expect(caveatsHeading(2).includes('2')).toBe(true);
            expect(caveatsHeading(2).toLowerCase().includes('problem')).toBe(false);
        });

        await it('lists the caveats with the identifier a test can hold on to', async () => {
            const cards = signatureCards(classifyMessage([good({ algorithm: 'rsa-sha1' })]));
            const caveats = cards[0]?.caveats.map((caveat) => caveat.caveat) ?? [];
            expect(caveats.includes('rsa-sha1')).toBe(true);
            expect((cards[0]?.caveats[0]?.text ?? '').length > 0).toBe(true);
        });
    });

    await describe('the key work list', async () => {
        await it('puts the missing keys first, by how much mail is waiting on them', async () => {
            // keyDemand ranks by total mail — the size of the prize. This pane ranks by the
            // UNCLAIMED part of it, or the next hour of work goes to the one domain with none.
            const rows = keyRows(
                [
                    demand({ selector: 'big', messages: 4000, unverifiable: 0, confirmed: 4000 }),
                    demand({ selector: 'small', messages: 40, unverifiable: 40 }),
                    demand({ selector: 'done', messages: 900, unverifiable: 900 }),
                ],
                new Set(['done._domainkey.example.com']),
            );
            expect(rows.map((row) => row.selector)).toStrictEqual(['small', 'big', 'done']);
            expect(rows[2]?.have).toBe(true);
            expect(rows[2]?.cssClass).toBe('success');
            expect(rows[0]?.cssClass).toBe('warning');
            expect(rows[0]?.name).toBe('small._domainkey.example.com');
        });

        await it('says how much of the case is waiting on a key', async () => {
            const rows = keyRows([demand({ messages: 500, unverifiable: 500 })], new Set());
            expect(keySummary(rows).includes('500')).toBe(true);
            const done = keyRows(
                [demand({ unverifiable: 0, confirmed: 10 })],
                new Set(['sel._domainkey.example.com']),
            );
            expect(keySummary(done).includes('Every signing key')).toBe(true);
            expect(keySummary([]).includes('no keys are needed')).toBe(true);
        });

        await it('offers a lookup only for the pairs that are missing', async () => {
            const rows = keyRows(
                [demand({ selector: 'a' }), demand({ selector: 'b' })],
                new Set(['b._domainkey.example.com']),
            );
            expect(lookupPairs(rows)).toStrictEqual([{ domain: 'example.com', selector: 'a' }]);
        });
    });

    await describe('the consent dialog', async () => {
        await it('shows every pair it would send, with no elision', async () => {
            // Consent to a list whose tail was summarised is consent to a request nobody saw.
            const pairs = Array.from({ length: 12 }, (_unused, i) => ({
                domain: `d${i}.example.com`,
                selector: 'sel',
            }));
            const dialog = consentDialog('dns', pairs);
            expect(dialog.items.length).toBe(12);
            expect(dialog.items[11]).toBe('sel._domainkey.d11.example.com');
            expect(dialog.pairs.length).toBe(12);
        });

        await it('names the network in the button and in the warning', async () => {
            const dns = consentDialog('dns', [{ domain: 'example.com', selector: 'sel' }]);
            expect(dns.accept.includes('DNS')).toBe(true);
            expect(dns.body.includes('name servers')).toBe(true);
            const archive = consentDialog('archive.prove.email', [
                { domain: 'example.com', selector: 'sel' },
            ]);
            expect(archive.accept.includes('archive.prove.email')).toBe(true);
            expect(archive.channel).toBe('archive.prove.email');
        });

        await it('has a label for every channel the lookup can use', async () => {
            // `LOOKUP_CHANNELS` is what the window builds its menu from, so a channel added to
            // `LookupChannel` without a label here would appear in the UI nameless.
            expect(LOOKUP_CHANNELS.length).toBe(2);
            for (const channel of LOOKUP_CHANNELS) {
                expect(channelLabel(channel).length > 0).toBe(true);
            }
            expect(channelLabel('dns').includes('DNS')).toBe(true);
        });
    });

    await describe('what a lookup run reports', async () => {
        await it('reports a miss instead of swallowing it', async () => {
            // The request DID go out: the disclosure has happened, and the person who agreed to
            // it is owed the result even when it is "nothing published".
            const line = lookupSummary(0, 3, 0);
            expect(line.includes('no published record')).toBe(true);
            expect(lookupSummary(0, 0, 0).includes('nothing was found')).toBe(true);
        });

        await it('never summarises a conflicting key as a successful fetch', async () => {
            // A key that differs from the one the case already held is the finding the tool
            // exists for — either a rotation the archive predates or a substitution.
            const line = lookupSummary(2, 0, 1);
            expect(line.includes('2')).toBe(true);
            expect(line.includes('differs from one this case already held')).toBe(true);
        });

        await it('leaves the conflict clause out when there was none', async () => {
            expect(lookupSummary(2, 0, 0).includes('already held')).toBe(false);
        });
    });

    await describe('the explanations behind the ? buttons', async () => {
        await it('escapes every verdict explanation, so a translator cannot break one', async () => {
            // The popover's label parses markup. These paragraphs carry no `<` today, which is
            // exactly why the escaping has to be asserted rather than eyeballed.
            for (const verdict of VERDICTS) {
                const text = explainVerdict(verdict);
                expect(text.includes('<')).toBe(false);
                expect(text.includes('\n')).toBe(false);
            }
            expect(explainVerdict('unverifiable').includes('fetch the key')).toBe(true);
        });

        await it('escapes the key explanation and names the DNS record it is about', async () => {
            const row = keyRows([demand()], new Set()).find((r) => !r.have);
            expect(row).toBeDefined();
            const text = explainKey(row!);
            expect(text.includes('sel._domainkey.example.com')).toBe(true);
            expect(text.includes('<')).toBe(false);
        });
    });

    await describe('the folder list', async () => {
        await it('names an archive by its file name and keeps the path for the tooltip', async () => {
            const sources: LogSource[] = [
                { source: '/leak/2024/inbox.mbox', kind: 'mbox', messages: 1204, duplicates: 4 },
                { source: '/leak/old/cur/1699.eml', kind: 'maildir', messages: 1, duplicates: 0 },
            ];
            const rows = sourceRows(sources);
            expect(rows[0]?.title).toBe('inbox.mbox');
            expect(rows[0]?.tooltip).toBe('/leak/2024/inbox.mbox');
            expect(rows[0]?.subtitle.includes('1 204')).toBe(true);
            // The duplicate count is shown, not netted off: an overlap between two archives is
            // a fact about the archives.
            expect(rows[0]?.subtitle.includes('4')).toBe(true);
            expect(rows[1]?.subtitle.includes('already in the case')).toBe(false);
        });

        await it('finds the last segment of a path without node:path', async () => {
            expect(baseName('/leak/inbox.mbox')).toBe('inbox.mbox');
            expect(baseName('/leak/maildir/')).toBe('maildir');
            expect(baseName('inbox.mbox')).toBe('inbox.mbox');
            expect(baseName('/')).toBe('/');
        });

        await it('counts archives in the all-archives row, not messages', async () => {
            // The message total belongs to the middle pane's header (`filterSummary`); what this
            // row adds is whether a filtered view is one of two or one of forty.
            const sources: LogSource[] = [
                { source: '/leak/a.mbox', kind: 'mbox', messages: 1204, duplicates: 0 },
                { source: '/leak/b.mbox', kind: 'mbox', messages: 7, duplicates: 0 },
            ];
            const all = allSources(sources);
            expect(all.subtitle.includes('2')).toBe(true);
            expect(all.subtitle.includes('1 204')).toBe(false);
        });

        await it('still offers the way out of a filter for an empty case', async () => {
            expect(allSources([]).subtitle.includes('0')).toBe(true);
        });
    });

    await describe('what an import run reports', async () => {
        await it('reports the counts without netting the duplicates off', async () => {
            const line = importSummary({ read: 7, stored: 4, duplicates: 2, indexed: 4, failed: 1 });
            expect(line.includes('4')).toBe(true);
            expect(line.includes('2')).toBe(true);
            // The failures ARE in the case and have no verdict: a summary that dropped them
            // would let a message vanish from every count while still being in the archive.
            expect(line.includes('1')).toBe(true);
            expect(line.includes('no verdict')).toBe(true);
        });

        await it('leaves out the clauses with nothing to report', async () => {
            const line = importSummary({ read: 4, stored: 4, duplicates: 0, indexed: 4, failed: 0 });
            expect(line.includes('already in the case')).toBe(false);
            expect(line.includes('no verdict')).toBe(false);
        });

        await it('says an empty archive was empty instead of claiming a success', async () => {
            const line = importSummary({ read: 0, stored: 0, duplicates: 0, indexed: 0, failed: 0 });
            expect(line.includes('Nothing imported')).toBe(true);
        });
    });

    await describe('the case overview', async () => {
        await it('keeps all six verdicts, zeroes included', async () => {
            const shares = verdictShares(counted({ confirmed: 3, unsigned: 1 }).verdicts);
            expect(shares.length).toBe(VERDICTS.length);
            expect(shares.map((share) => share.verdict)).toStrictEqual([...VERDICTS]);
            const altered = shares.find((share) => share.verdict === 'body-altered');
            // The zero that says "we checked every message and found no tampering".
            expect(altered?.count).toBe('0');
            expect(altered?.share).toBe(0);
            expect(shares.find((share) => share.verdict === 'confirmed')?.share).toBe(0.75);
        });

        await it('does not divide by an empty case', async () => {
            expect(verdictShares(report().verdicts).every((share) => share.share === 0)).toBe(true);
            expect(overviewHeadline(report()).includes('empty')).toBe(true);
            expect(overviewNextStep(report())).toBe(undefined);
        });

        await it('names the caveats and the two kinds of alteration in the summary sentence', async () => {
            const headline = overviewHeadline(
                counted({
                    confirmed: 800,
                    'confirmed-with-caveats': 12,
                    'body-altered': 2,
                    'headers-altered': 1,
                    unverifiable: 389,
                    unsigned: 0,
                }),
            );
            // The groups are a summary and may be one — but a reader must not be able to take
            // either group for a plain pass or a plain fail.
            expect(headline.includes('812')).toBe(true);
            expect(headline.includes('caveats')).toBe(true);
            expect(headline.includes('3 altered')).toBe(true);
            expect(headline.includes('389')).toBe(true);
        });

        await it('reports a period as the dates in the messages, or as none', async () => {
            const stats = overviewStats({
                ...counted({ unsigned: 2 }),
                earliest: Date.UTC(2019, 2, 4),
                latest: Date.UTC(2021, 10, 30),
            });
            const period = stats.find((stat) => stat.label === 'Period')?.value ?? '';
            expect(period.includes('2019-03-04')).toBe(true);
            expect(period.includes('2021-11-30')).toBe(true);
            // Said as a property of what the archive claims: both ends come from Date headers,
            // which are unsigned in many messages.
            expect(period.includes('dates in the messages')).toBe(true);
            expect(
                (
                    overviewStats(counted({ unsigned: 2 })).find((s) => s.label === 'Period')?.value ?? ''
                ).includes('no readable dates'),
            ).toBe(true);
        });

        await it('points at the keys that would answer the open messages', async () => {
            const next = overviewNextStep(
                counted({ unverifiable: 389, confirmed: 1 }, [
                    demand({ selector: 'a', unverifiable: 300 }),
                    demand({ selector: 'b', unverifiable: 89 }),
                    demand({ selector: 'c', unverifiable: 0, confirmed: 5 }),
                ]),
            );
            expect(next?.includes('389')).toBe(true);
            expect(next?.includes('2')).toBe(true);
        });
    });
};
