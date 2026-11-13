/**
 * Colouring and completing the search box. Highlight tables read `[text, kind]`, the text being
 * the slice of the input a span covers, so the offsets are checked by what they point at. Error
 * sentences are translated and are compared with what `parseSearch` says, never quoted.
 */

import { describe, expect, it } from '@gjsify/unit';
import {
    completeSearch,
    highlightSearch,
    MAX_COMPLETIONS,
    parseSearch,
    SEARCH_OPERATORS,
    type SearchContext,
} from '@stamped/store';

type Shown = readonly [string, string];

function shown(input: string): Shown[] {
    return highlightSearch(input).map((span): Shown => [input.slice(span.start, span.end), span.kind]);
}

const CONTEXT: SearchContext = {
    mailboxes: ['ada@example.com', 'Project X', 'Überlauf', 'grace@example.com'],
    tags: ['legal', 'Legal review', 'urgent'],
};

const NONE: SearchContext = { mailboxes: [], tags: [] };

/** What a completion would leave in the box. */
function applied(input: string, caret: number, context: SearchContext = CONTEXT): string[] | undefined {
    const found = completeSearch(input, caret, context);
    if (found === undefined) return undefined;
    return found.options.map(
        (option) => input.slice(0, found.start) + option.insert + input.slice(found.end),
    );
}

/** Completion at the end of the input. */
function atEnd(input: string, context: SearchContext = CONTEXT): string[] | undefined {
    return applied(input, input.length, context);
}

const HIGHLIGHTED: readonly (readonly [string, readonly Shown[]])[] = [
    [
        'from:ada',
        [
            ['from:', 'operator'],
            ['ada', 'value'],
        ],
    ],
    [
        'FROM:Ada',
        [
            ['FROM:', 'operator'],
            ['Ada', 'value'],
        ],
    ],
    [
        'from: ada',
        [
            ['from:', 'operator'],
            ['ada', 'value'],
        ],
    ],
    ['plain words only', []],
    ['-draft x', [['-', 'negation']]],
    ['NOT draft x', [['NOT', 'negation']]],
    ['a OR b', [['OR', 'boolean']]],
    ['a AND b', [['AND', 'boolean']]],
    ['"exact phrase" other', [['"exact phrase"', 'phrase']]],
    [
        'subject:"budget plan"',
        [
            ['subject:', 'operator'],
            ['"budget plan"', 'value'],
        ],
    ],
    [
        '(a OR b)',
        [
            ['(', 'paren'],
            ['OR', 'boolean'],
            [')', 'paren'],
        ],
    ],
    [
        'verdict:unsigned',
        [
            ['verdict:', 'operator'],
            ['unsigned', 'value'],
        ],
    ],
    [
        'invoice -draft from:ada after:2024-03',
        [
            ['-', 'negation'],
            ['from:', 'operator'],
            ['ada', 'value'],
            ['after:', 'operator'],
            ['2024-03', 'value'],
        ],
    ],
    [
        '-from:ada x',
        [
            ['-', 'negation'],
            ['from:', 'operator'],
            ['ada', 'value'],
        ],
    ],
    ['Re: hi', []],
    ['a - b', []],
];

/** Input → the problem span and what it covers; the sentence is checked against parseSearch. */
const BROKEN: readonly (readonly [string, string])[] = [
    ['filename:report.pdf', 'filename:'],
    ['ext:pdf from:ada', 'ext:'],
    ['size:>1mb', 'size:'],
    ['has:attachment', 'has:'],
    ['direction:in', 'direction:'],
    ['verdict:', 'verdict:'],
    ['from:', 'from:'],
    ['from: ', 'from:'],
    ['is:', 'is:'],
    ['verdict:nonsense', 'nonsense'],
    ['dkim:fine', 'fine'],
    ['is:read', 'read'],
    ['sort:random', 'random'],
    ['after:2024-02-31', '2024-02-31'],
    ['before:yesterday', 'yesterday'],
    ['before:2024-13', '2024-13'],
    ['from:ada (', '('],
    ['from:ada )', ')'],
    ['from:ada ()', '()'],
    ['verdict:unsigned verdict:confirmed', 'verdict:'],
    ['after:2024 after:2025', 'after:'],
    ['from:ada OR', 'OR'],
    ['OR from:ada', 'OR'],
    ['-draft', '-'],
    ['from:ada OR verdict:unsigned', 'verdict:'],
    ['-verdict:unsigned harbour', 'verdict:'],
];

const ODD: readonly string[] = [
    '',
    ' ',
    '-',
    '--',
    '- -',
    '"unterminated',
    '"',
    '""',
    '((',
    '))',
    ')(',
    '()',
    'a OR',
    'OR a',
    'a OR OR b',
    'AND OR NOT',
    'NOT NOT',
    'NOT (NOT (NOT x))',
    'from:',
    'from:"',
    'from:""',
    'from:(',
    'from:)',
    'from:-',
    '-from:',
    ':',
    '::',
    'Re: hi',
    'https://example.com/a?b=c',
    'from:ada "unclosed',
    'from:Müller 😀 -draft 😀)',
    '😀(😀',
    'verdict:\u0000 \u0007',
    'filename:"a b" ext:',
    '\n\t from:\n ada',
];

export default async () => {
    await describe('search highlighting', async () => {
        await it('marks operators, values, negations, booleans, phrases and parentheses', async () => {
            for (const [input, expected] of HIGHLIGHTED) {
                expect([input, shown(input)]).toStrictEqual([input, expected]);
            }
        });

        await it('marks the part that causes a problem, with the sentence parseSearch gives', async () => {
            for (const [input, covered] of BROKEN) {
                const errors = highlightSearch(input).filter((span) => span.kind === 'error');
                expect([input, errors.map((span) => input.slice(span.start, span.end))]).toStrictEqual([
                    input,
                    [covered],
                ]);
                const message = errors[0]?.message;
                expect(typeof message).toBe('string');
                expect(parseSearch(input).errors.includes(message ?? '')).toBe(true);
            }
        });

        await it('marks unbalanced parentheses also in a query written the old way', async () => {
            // Nothing here uses an operator or a negation, so parseSearch hands it to FTS5 and
            // reports no error; the box still shows the person where the parenthesis is open.
            expect(parseSearch('(a OR b').raw).toBe(true);
            expect(shown('(a OR b')).toStrictEqual([
                ['(', 'error'],
                ['OR', 'boolean'],
            ]);
            expect(shown('a b)')).toStrictEqual([[')', 'error']]);
        });

        await it('keeps the rest of a broken query coloured', async () => {
            expect(shown('filename:report.pdf')).toStrictEqual([
                ['filename:', 'error'],
                ['report.pdf', 'value'],
            ]);
            expect(shown('verdict:nonsense')).toStrictEqual([
                ['verdict:', 'operator'],
                ['nonsense', 'error'],
            ]);
            expect(shown('verdict:unsigned verdict:confirmed')).toStrictEqual([
                ['verdict:', 'operator'],
                ['unsigned', 'value'],
                ['verdict:', 'error'],
                ['confirmed', 'value'],
            ]);
        });

        await it('gives only error spans a message', async () => {
            for (const input of [...ODD, ...BROKEN.map(([text]) => text)]) {
                for (const span of highlightSearch(input)) {
                    expect([input, span.kind === 'error', typeof span.message === 'string']).toStrictEqual([
                        input,
                        span.kind === 'error',
                        span.kind === 'error',
                    ]);
                }
            }
        });

        await it('counts offsets in UTF-16 units, so umlauts and emoji point at the right text', async () => {
            const umlaut = 'from:Müller -Straße to:Jürgen';
            expect(highlightSearch(umlaut)).toStrictEqual([
                { start: 0, end: 5, kind: 'operator' },
                { start: 5, end: 11, kind: 'value' },
                { start: 12, end: 13, kind: 'negation' },
                { start: 20, end: 23, kind: 'operator' },
                { start: 23, end: 29, kind: 'value' },
            ]);

            // The emoji is two UTF-16 units: everything after it moves by two, not by one.
            const emoji = '😀 verdict:😀 (from:😀x OR "😀 y")';
            expect(shown(emoji)).toStrictEqual([
                ['verdict:', 'operator'],
                ['😀', 'error'],
                ['(', 'paren'],
                ['from:', 'operator'],
                ['😀x', 'value'],
                ['OR', 'boolean'],
                ['"😀 y"', 'phrase'],
                [')', 'paren'],
            ]);
            const first = highlightSearch(emoji)[0];
            expect(first?.start).toBe(3);
            expect(first?.end).toBe(11);

            const broken = '😀 (Müller';
            expect(shown(broken)).toStrictEqual([['(', 'error']]);
            expect(highlightSearch(broken)[0]?.start).toBe(3);
        });

        await it('returns spans sorted, in range and never overlapping, whatever was typed', async () => {
            const inputs = [...ODD, ...BROKEN.map(([text]) => text), ...HIGHLIGHTED.map(([text]) => text)];
            for (const input of inputs) {
                const spans = highlightSearch(input);
                let end = 0;
                for (const span of spans) {
                    expect([
                        input,
                        span.start >= end,
                        span.end > span.start,
                        span.end <= input.length,
                    ]).toStrictEqual([input, true, true, true]);
                    end = span.end;
                }
            }
        });

        await it('does not change what parseSearch says', async () => {
            const parsed = parseSearch('from:ada -draft verdict:nonsense');
            expect(parsed.raw).toBe(false);
            expect(parsed.errors.length).toBe(1);
            expect(parseSearch('Re: hi').raw).toBe(true);
        });
    });

    await describe('search completion', async () => {
        await it('completes an operator name from the first typed character', async () => {
            expect(completeSearch('ve', 2, NONE)).toStrictEqual({
                start: 0,
                end: 2,
                options: [{ label: 'verdict:', insert: 'verdict:' }],
            });
            expect(atEnd('t')).toStrictEqual(['to:', 'tag:']);
            expect(atEnd('VE')).toStrictEqual(['verdict:']);
            expect(atEnd('s')).toStrictEqual(['subject:', 'sort:']);
            expect(atEnd('d')).toStrictEqual(['dkim:']);
        });

        await it('offers nothing for an empty word, a non-operator or a quoted phrase', async () => {
            expect(atEnd('')).toBe(undefined);
            expect(atEnd('from:ada ')).toBe(undefined);
            expect(atEnd('xyz')).toBe(undefined);
            expect(atEnd('Re')).toBe(undefined);
            expect(atEnd('"ve')).toBe(undefined);
            expect(atEnd('"ve"')).toBe(undefined);
            expect(applied('"ve ro"', 3)).toBe(undefined);
            expect(atEnd('-')).toBe(undefined);
            expect(atEnd('(')).toBe(undefined);
        });

        await it('never offers the operators that are not supported yet', async () => {
            for (const name of ['filename', 'ext', 'size', 'has', 'direction']) {
                for (let length = 1; length <= name.length; length++) {
                    const result = atEnd(name.slice(0, length)) ?? [];
                    expect(result.some((text) => text.startsWith(name))).toBe(false);
                }
                expect(atEnd(`${name}:`)).toBe(undefined);
            }
            for (const operator of SEARCH_OPERATORS) {
                expect(atEnd(operator.slice(0, 1))?.includes(`${operator}:`)).toBe(true);
            }
        });

        await it('completes the fixed values of verdict:, dkim:, is: and sort:', async () => {
            expect(atEnd('verdict:')?.length).toBe(6);
            expect(atEnd('verdict:b')).toStrictEqual(['verdict:body-altered']);
            expect(atEnd('VERDICT:B')).toStrictEqual(['VERDICT:body-altered']);
            expect(atEnd('verdict:confirmed')).toStrictEqual([
                'verdict:confirmed',
                'verdict:confirmed-with-caveats',
            ]);
            expect(atEnd('dkim:un')).toStrictEqual(['dkim:unverifiable', 'dkim:unsigned']);
            expect(atEnd('is:')).toStrictEqual(['is:bookmarked']);
            expect(atEnd('sort:')).toStrictEqual(['sort:relevance', 'sort:newest', 'sort:oldest']);
            expect(atEnd('sort:n')).toStrictEqual(['sort:newest']);
            expect(atEnd('from:ada sort:o')).toStrictEqual(['from:ada sort:oldest']);
        });

        await it('offers nothing when the only option is what is typed, or nothing matches', async () => {
            expect(atEnd('verdict:body-altered')).toBe(undefined);
            expect(atEnd('is:bookmarked')).toBe(undefined);
            expect(atEnd('sort:newest')).toBe(undefined);
            expect(atEnd('verdict:zzz')).toBe(undefined);
            expect(atEnd('from:')).toBe(undefined);
            expect(atEnd('verdict:')).not.toBe(undefined);
        });

        await it('completes mailbox: and tag: from the context, case-insensitively', async () => {
            expect(atEnd('mailbox:')).toStrictEqual([
                'mailbox:ada@example.com',
                'mailbox:"Project X"',
                'mailbox:Überlauf',
                'mailbox:grace@example.com',
            ]);
            expect(atEnd('mailbox:ADA')).toStrictEqual(['mailbox:ada@example.com']);
            expect(atEnd('mailbox:ü')).toStrictEqual(['mailbox:Überlauf']);
            expect(atEnd('mailbox:pro')).toStrictEqual(['mailbox:"Project X"']);
            expect(atEnd('tag:le')).toStrictEqual(['tag:legal', 'tag:"Legal review"']);
            expect(atEnd('tag:u')).toStrictEqual(['tag:urgent']);
            expect(atEnd('tag:legal')).toStrictEqual(['tag:legal', 'tag:"Legal review"']);
            expect(atEnd('tag:urgent')).toBe(undefined);
            expect(atEnd('mailbox:x', NONE)).toBe(undefined);
            expect(completeSearch('mailbox:pro', 11, CONTEXT)?.options[0]).toStrictEqual({
                label: 'Project X',
                insert: '"Project X"',
            });
        });

        await it('quotes names that parentheses or spaces would cut, and skips names with a quote', async () => {
            const tricky: SearchContext = {
                mailboxes: ['a (b)', 'say "hi"', 'plain', '', 'plain'],
                tags: [],
            };
            expect(atEnd('mailbox:', tricky)).toStrictEqual(['mailbox:"a (b)"', 'mailbox:plain']);
        });

        await it('offers nothing for dates, fields and unknown operators', async () => {
            expect(atEnd('before:')).toBe(undefined);
            expect(atEnd('after:20')).toBe(undefined);
            expect(atEnd('from:a')).toBe(undefined);
            expect(atEnd('subject:v')).toBe(undefined);
            expect(atEnd('https:')).toBe(undefined);
            expect(atEnd('Re:')).toBe(undefined);
        });

        await it('offers nothing inside an open quote, or inside a quoted value', async () => {
            expect(atEnd('from:"ve')).toBe(undefined);
            expect(atEnd('mailbox:"Pro')).toBe(undefined);
            expect(atEnd('mailbox:"Project X"')).toBe(undefined);
            expect(applied('mailbox:"Pro ject"', 14)).toBe(undefined);
            expect(atEnd('"mailbox:')).toBe(undefined);
            expect(atEnd('"a" ve')).toStrictEqual(['"a" verdict:']);
        });

        await it('completes the word under the caret, also in the middle of it', async () => {
            expect(completeSearch('verdict x', 4, NONE)).toStrictEqual({
                start: 0,
                end: 7,
                options: [{ label: 'verdict:', insert: 'verdict:' }],
            });
            expect(completeSearch('verdict:confirmed', 11, NONE)).toStrictEqual({
                start: 8,
                end: 17,
                options: [
                    { label: 'confirmed', insert: 'confirmed' },
                    { label: 'confirmed-with-caveats', insert: 'confirmed-with-caveats' },
                ],
            });
            expect(applied('ve from:x', 2)).toStrictEqual(['verdict: from:x']);
            expect(applied('from:ada ve from:x', 11)).toStrictEqual(['from:ada verdict: from:x']);
            expect(applied('ver from:x', 3)).toStrictEqual(['verdict: from:x']);
            // The caret on the name of a finished operator: only `verdict:` fits, and it is there.
            expect(applied('verdict:body-altered', 3)).toBe(undefined);
            expect(applied('ve:body-altered', 2)).toStrictEqual(['verdict:body-altered']);
            // The caret at the start of a word has typed nothing of it yet.
            expect(applied('ve x', 0)).toBe(undefined);
        });

        await it('sees through a negation and parentheses', async () => {
            expect(completeSearch('-ve', 3, NONE)).toStrictEqual({
                start: 1,
                end: 3,
                options: [{ label: 'verdict:', insert: 'verdict:' }],
            });
            expect(completeSearch('(ve', 3, NONE)?.start).toBe(1);
            expect(applied('(verdict:b)', 10)).toStrictEqual(['(verdict:body-altered)']);
            expect(applied('-tag:u OR b', 6)).toStrictEqual(['-tag:urgent OR b']);
        });

        await it('counts offsets in UTF-16 units, so umlauts and emoji do not shift the replacement', async () => {
            const input = '😀 Müller mailbox:Ü';
            const found = completeSearch(input, input.length, CONTEXT);
            expect(found?.start).toBe(input.length - 1);
            expect(found?.end).toBe(input.length);
            expect(applied(input, input.length)).toStrictEqual(['😀 Müller mailbox:Überlauf']);
            expect(applied('😀 ve', 5)).toStrictEqual(['😀 verdict:']);
            expect(applied('Ärger ve 😀', 8)).toStrictEqual(['Ärger verdict: 😀']);
        });

        await it('offers at most eight options, and clamps a caret outside the text', async () => {
            const many: SearchContext = {
                mailboxes: Array.from({ length: 12 }, (_unused, index) => `box-${index}`),
                tags: [],
            };
            expect(MAX_COMPLETIONS).toBe(8);
            expect(completeSearch('mailbox:', 8, many)?.options.length).toBe(8);
            expect(atEnd('ve')?.length).toBe(1);
            expect(applied('ve', 99)).toStrictEqual(['verdict:']);
            expect(applied('ve', -5)).toBe(undefined);
        });

        await it('answers for every caret of every odd input without throwing', async () => {
            for (const input of ODD) {
                for (let caret = -1; caret <= input.length + 1; caret++) {
                    const found = completeSearch(input, caret, CONTEXT);
                    if (found === undefined) continue;
                    expect([
                        input,
                        caret,
                        found.start >= 0,
                        found.start <= found.end,
                        found.end <= input.length,
                        found.options.length > 0,
                        found.options.length <= MAX_COMPLETIONS,
                    ]).toStrictEqual([input, caret, true, true, true, true, true]);
                }
            }
        });
    });
};
