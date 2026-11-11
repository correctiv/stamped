/**
 * The search box's query language. The table below is the specification: input → what the
 * parser makes of it. Errors are counted rather than quoted, because their words are translated.
 */

import { describe, expect, it } from '@gjsify/unit';
import { parseSearch, parseSearchDate, SEARCH_OPERATORS } from '@stamped/store';

const MARCH = Date.UTC(2024, 2, 1);

/** Input → the FTS5 text it compiles to. */
const COMPILED: readonly (readonly [string, string])[] = [
    ['from:ada', 'sender : "ada"'],
    ['FROM:Ada', 'sender : "Ada"'],
    ['from: ada', 'sender : "ada"'],
    ['to:grace', 'recipients : "grace"'],
    ['cc:grace', 'cc : "grace"'],
    ['body:harbour', 'text : "harbour"'],
    ['subject:"budget plan"', 'subject : "budget plan"'],
    ['subject:ada*', 'subject : "ada"*'],
    ['subject:"x*"', 'subject : "x*"'],
    ['from:ada subject:invoice', '(sender : "ada" AND subject : "invoice")'],
    ['from:ada AND subject:invoice', '(sender : "ada" AND subject : "invoice")'],
    ['invoice -draft from:ada', '(("invoice" AND sender : "ada") NOT ("draft"))'],
    ['from:ada -draft -spam', '(sender : "ada" NOT ("draft" OR "spam"))'],
    ['from:ada NOT draft', '(sender : "ada" NOT ("draft"))'],
    ['from:ada OR from:grace', '(sender : "ada" OR sender : "grace")'],
    ['(harbour OR contract) from:ada', '(("harbour" OR "contract") AND sender : "ada")'],
    ['verdict:unsigned', ''],
    ['verdict:unsigned after:2024', ''],
];

/** Input → a query written the old way, handed to FTS5 untouched. */
const RAW: readonly string[] = [
    'invoice',
    'subject : invoice',
    'harbour AND contract',
    'harbour OR contract',
    '(harbour OR contract)',
    '"exact phrase"',
    'near(a b)',
    'chef@firma.de',
    'Re: Angebot',
    'https://example.com/path',
    'a:b',
    'harbour*',
    "O'Brien & Co.",
];

/** Input → it uses the new syntax and it is wrong. */
const WRONG: readonly string[] = [
    'from:',
    'from: ',
    'verdict:',
    'verdict:nonsense',
    'dkim:fine',
    'after:2024-02-31',
    'after:yesterday',
    'before:2024-13',
    'sort:random',
    'filename:report.pdf',
    'ext:pdf from:ada',
    'size:>1mb',
    'has:attachment',
    'direction:in',
    'verdict:unsigned verdict:confirmed',
    'verdict:unsigned dkim:confirmed',
    '-draft',
    'NOT draft',
    'from:ada OR -draft',
    'from:ada OR verdict:unsigned',
    '-verdict:unsigned harbour',
    'from:ada (',
    'from:ada )',
    'from:ada ()',
    'from:ada OR',
    'OR from:ada',
];

/** Things a person might type half-way. The parser must answer, never throw or hang. */
const ODD: readonly string[] = [
    '',
    ' ',
    '(',
    ')',
    '((((',
    '))))',
    '-',
    '--',
    '- -',
    'NOT',
    'NOT NOT',
    'AND',
    'OR',
    'AND OR NOT',
    '"',
    '""',
    'from:"',
    'from:""',
    'from:(',
    'from:)',
    'from:-',
    ':',
    '::',
    'from::',
    '*',
    'from:*',
    'a:',
    '-from:',
    'from:ada "unclosed',
    'from:ada NOT (NOT (NOT x))',
    '\u0000',
    'from:äöü',
];

export default async () => {
    await describe('search query', async () => {
        await it('compiles the operators to FTS5 columns and booleans', async () => {
            for (const [input, fts] of COMPILED) {
                const parsed = parseSearch(input);
                expect([input, parsed.errors.length, parsed.raw, parsed.fts]).toStrictEqual([
                    input,
                    0,
                    false,
                    fts,
                ]);
            }
        });

        await it('leaves a query without the new syntax to FTS5 as it was', async () => {
            for (const input of RAW) {
                const parsed = parseSearch(input);
                expect([input, parsed.raw, parsed.errors.length, parsed.fts]).toStrictEqual([
                    input,
                    true,
                    0,
                    '',
                ]);
                expect(parsed.filters).toStrictEqual({});
            }
        });

        await it('reports a mistake in the new syntax instead of searching for it', async () => {
            for (const input of WRONG) {
                const parsed = parseSearch(input);
                expect([input, parsed.raw, parsed.errors.length > 0]).toStrictEqual([input, false, true]);
            }
        });

        await it('names an unsupported operator once, not once per word', async () => {
            expect(parseSearch('filename:annual report.pdf').errors.length).toBe(1);
            expect(parseSearch('filename:"annual report.pdf"').errors.length).toBe(1);
        });

        await it('never lets a value become FTS5 syntax', async () => {
            expect(parseSearch('subject:a:b from:ada').fts).toBe('(subject : "a:b" AND sender : "ada")');
            expect(parseSearch('subject:"NEAR(a b)"').fts).toBe('subject : "NEAR(a b)"');
            expect(parseSearch('from:ada AND OR').errors.length > 0).toBe(true);
        });

        await it('reads the filters', async () => {
            expect(parseSearch('verdict:Body-Altered').filters).toStrictEqual({ verdict: 'body-altered' });
            expect(parseSearch('dkim:confirmed harbour').filters).toStrictEqual({ verdict: 'confirmed' });
            expect(parseSearch('after:2024-03').filters).toStrictEqual({ after: MARCH });
            expect(parseSearch('before:2024-03-05').filters).toStrictEqual({ before: Date.UTC(2024, 2, 5) });
            expect(parseSearch('mailbox:ada@example.com harbour').filters).toStrictEqual({
                mailbox: 'ada@example.com',
            });
            expect(parseSearch('mailbox:"ada@example.com (2)" harbour').filters).toStrictEqual({
                mailbox: 'ada@example.com (2)',
            });
            expect(parseSearch('sort:newest harbour').filters).toStrictEqual({ order: 'newest' });
            expect(parseSearch('sort:OLDEST harbour').filters).toStrictEqual({ order: 'oldest' });
            expect(parseSearch('sort:relevance harbour').filters).toStrictEqual({ order: 'relevance' });
        });

        await it('reads a date as the first instant of its period, in UTC', async () => {
            expect(parseSearchDate('2024')).toBe(Date.UTC(2024, 0, 1));
            expect(parseSearchDate('2024-03')).toBe(MARCH);
            expect(parseSearchDate('2024-03-05')).toBe(Date.UTC(2024, 2, 5));
            expect(parseSearchDate('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
            expect(parseSearchDate('2023-02-29')).toBe(undefined);
            expect(parseSearchDate('2024-02-31')).toBe(undefined);
            expect(parseSearchDate('2024-00')).toBe(undefined);
            expect(parseSearchDate('24-03')).toBe(undefined);
            expect(parseSearchDate('')).toBe(undefined);
        });

        await it('hands the vectors the plain words and nothing that would be lost on them', async () => {
            expect(parseSearch('invoice harbour').freeText).toBe('invoice harbour');
            expect(parseSearch('  why did they leave ').freeText).toBe('why did they leave');
            expect(parseSearch('invoice harbour after:2024').freeText).toBe('invoice harbour');
            expect(parseSearch('verdict:unsigned why did they leave').freeText).toBe('why did they leave');
            expect(parseSearch('from:ada invoice').freeText).toBe('');
            expect(parseSearch('invoice -draft').freeText).toBe('');
            expect(parseSearch('"exact phrase" after:2024').freeText).toBe('');
            expect(parseSearch('harbour* after:2024').freeText).toBe('');
            expect(parseSearch('harbour OR contract after:2024').freeText).toBe('');
            expect(parseSearch('verdict:unsigned').freeText).toBe('');
        });

        await it('lists the operators it knows', async () => {
            expect(SEARCH_OPERATORS.includes('from')).toBe(true);
            expect(SEARCH_OPERATORS.includes('verdict')).toBe(true);
            expect(SEARCH_OPERATORS.includes('filename')).toBe(false);
        });

        await it('answers every odd input and does not throw', async () => {
            for (const input of ODD) {
                const parsed = parseSearch(input);
                expect([input, Array.isArray(parsed.errors)]).toStrictEqual([input, true]);
            }
        });
    });
};
