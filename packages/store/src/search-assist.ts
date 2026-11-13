/**
 * Help while the search box is being typed: colouring (`highlightSearch`) and completion
 * (`completeSearch`). PURE, GTK-free, no database: the caller feeds it the text, the caret and the
 * names it knows (mailboxes, tags).
 *
 * Highlighting reads the query with the very parser `parseSearch` uses, so an `error` span carries
 * the sentence `parseSearch` would return, and the two cannot disagree. Completion is a plain
 * scanner over the text around the caret; it never needs the query to be valid.
 *
 * The operator and value NAMES are syntax and stay English; only the error sentences are translated.
 * The attachment operators (`filename:`, `ext:`, …) are not supported and are never offered.
 */

import { analyseSearch, SEARCH_OPERATORS, SEARCH_VALUES } from './search-query.ts';
import type { SearchSpan } from './search-query.ts';

export type { SearchSpan, SearchSpanKind } from './search-query.ts';

/** What the caller knows about the case that the query language cannot. */
export interface SearchContext {
    readonly mailboxes: readonly string[];
    readonly tags: readonly string[];
}

/** One thing to put in the box: `label` is what a list shows, `insert` what replaces the word. */
export interface SearchCompletionOption {
    readonly label: string;
    readonly insert: string;
}

/** Replace `input[start, end)` with the `insert` of the chosen option. */
export interface SearchCompletion {
    readonly start: number;
    readonly end: number;
    readonly options: readonly SearchCompletionOption[];
}

/** No list is longer than this: a box that scrolls is not a hint any more. */
export const MAX_COMPLETIONS = 8;

/**
 * The parts of a query, sorted by position and never overlapping; text between them is plain
 * words. A query written the old way is highlighted as well, parentheses and all. Never throws.
 */
export function highlightSearch(input: string): readonly SearchSpan[] {
    return analyseSearch(input).spans;
}

interface Word {
    /** Where the word starts, after a negating `-`. */
    readonly start: number;
    readonly end: number;
    /** A quoted phrase, or an operator whose value is quoted. */
    readonly quoted: boolean;
    /** The lowercased operator name and the index just past its colon. */
    readonly operator?: { readonly name: string; readonly colon: number };
}

/** The words of the input the way the parser cuts them, with enough to find the one at the caret. */
function wordAt(input: string, caret: number): Word | undefined {
    let index = 0;
    while (index < input.length) {
        const here = input[index] ?? '';
        if (/\s/.test(here) || here === '(' || here === ')') {
            index++;
            continue;
        }
        // A minus negates when something follows it.
        const start = here === '-' && /\S/.test(input[index + 1] ?? '') ? index + 1 : index;
        const first = input[start] ?? '';
        if (first === '(' || first === ')') {
            index = start;
            continue;
        }
        let word: Word;
        if (first === '"') {
            const close = input.indexOf('"', start + 1);
            word = { start, end: close < 0 ? input.length : close + 1, quoted: true };
        } else {
            const operator = /^([A-Za-z]+):/.exec(input.slice(start));
            if (operator === null) {
                const plain = /^[^\s()]+/.exec(input.slice(start));
                word = { start, end: start + (plain?.[0].length ?? 1), quoted: false };
            } else {
                const colon = start + operator[0].length;
                const name = (operator[1] ?? '').toLowerCase();
                if (input[colon] === '"') {
                    const close = input.indexOf('"', colon + 1);
                    word = {
                        start,
                        end: close < 0 ? input.length : close + 1,
                        quoted: true,
                        operator: { name, colon },
                    };
                } else {
                    const value = /^[^\s()]*/.exec(input.slice(colon));
                    word = {
                        start,
                        end: colon + (value?.[0].length ?? 0),
                        quoted: false,
                        operator: { name, colon },
                    };
                }
            }
        }
        if (word.start < caret && caret <= word.end) return word;
        if (word.start >= caret) return undefined;
        index = word.end;
    }
    return undefined;
}

/** A value as the box takes it back: quoted when a space or a parenthesis would cut it short. */
function insertable(value: string): string | undefined {
    // There is no way to write a quote inside a quoted value, so such a name cannot be offered.
    if (value === '' || value.includes('"')) return undefined;
    return /[\s()]/.test(value) ? `"${value}"` : value;
}

function optionsFor(prefix: string, values: readonly string[], quote: boolean): SearchCompletionOption[] {
    const wanted = prefix.toLowerCase();
    const options: SearchCompletionOption[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (!value.toLowerCase().startsWith(wanted)) continue;
        const insert = quote ? insertable(value) : value;
        if (insert === undefined || seen.has(insert)) continue;
        seen.add(insert);
        options.push({ label: value, insert });
        if (options.length === MAX_COMPLETIONS) break;
    }
    return options;
}

/**
 * What to offer at the caret, or `undefined`. A partial word offers operator names; after
 * `verdict:`, `dkim:`, `is:` or `sort:` the fixed values; after `mailbox:` or `tag:` the names in
 * `context`. Nothing inside a quote, after `before:`/`after:`, or when the only option is what is
 * already typed. A caret in the middle of a word completes the whole word.
 */
export function completeSearch(
    input: string,
    caret: number,
    context: SearchContext,
): SearchCompletion | undefined {
    const at = Math.max(0, Math.min(caret, input.length));
    const word = wordAt(input, at);
    if (word === undefined) return undefined;
    // Inside quotes (a phrase, or the quoted value of an operator) nothing is offered.
    if (word.quoted && (word.operator === undefined || at > word.operator.colon)) return undefined;

    const operator = word.operator;
    if (operator === undefined || at < operator.colon) {
        // Still on the name: offer operators, replacing the name (and a colon already there).
        const nameEnd = operator === undefined ? word.end : operator.colon;
        const prefix = input.slice(word.start, at);
        if (prefix === '') return undefined;
        const options = optionsFor(
            prefix,
            SEARCH_OPERATORS.map((name) => `${name}:`),
            false,
        );
        return finish(input, word.start, nameEnd, options);
    }

    const choices = SEARCH_VALUES[operator.name];
    const names =
        choices !== undefined
            ? choices
            : operator.name === 'mailbox'
              ? context.mailboxes
              : operator.name === 'tag'
                ? context.tags
                : undefined;
    if (names === undefined) return undefined;
    const prefix = input.slice(operator.colon, at);
    return finish(input, operator.colon, word.end, optionsFor(prefix, names, choices === undefined));
}

function finish(
    input: string,
    start: number,
    end: number,
    options: readonly SearchCompletionOption[],
): SearchCompletion | undefined {
    if (options.length === 0) return undefined;
    const only = options.length === 1 ? options[0] : undefined;
    if (only !== undefined && only.insert === input.slice(start, end)) return undefined;
    return { start, end, options };
}
