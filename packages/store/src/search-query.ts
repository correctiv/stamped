/**
 * The search box's small query language: `from:ada subject:"budget plan" -draft after:2024-03`.
 *
 * PURE. It turns the text a person typed into two things — an FTS5 expression for the words, and
 * the filters that are not words (verdict, dates, mailbox, order) — and touches no database. The
 * table in `search-query.test.ts` is the specification.
 *
 * TWO MODES, because one of them already existed. A query with no operator in it and no `-term`
 * is handed to FTS5 as it always was (`raw`): `subject : invoice`, `a OR b`, `"a phrase"`, and the
 * literal fallback in `searchHits` for what FTS5 rejects, such as an address. Only a query that
 * uses the new syntax is parsed here. Nobody's old search changes meaning.
 *
 * NO VALUE IS EVER SYNTAX. Every word and every operator value is compiled to a quoted FTS5
 * string, so `"`, `*`, `:` and `NEAR` inside a value cannot reach the FTS5 parser. A trailing `*`
 * is the one exception, and it is added by us, outside the quotes.
 *
 * AN OPERATOR WE DO NOT HAVE IS AN ERROR, NEVER A SILENT TEXT SEARCH. `filename:report.pdf`
 * searched as the words "filename" and "report.pdf" would return a plausible list that answers a
 * different question than the one asked. A word that merely contains a colon (`Re:`, a URL) is
 * not an operator and stays a word.
 *
 * The operator NAMES are syntax, not prose: they stay English in every language. Only the error
 * messages are translated.
 */

import { fmt, _, VERDICTS, type Verdict } from '@stamped/core';

/** The order of a result list. `relevance` is FTS5's own ranking and the default. */
export type SearchOrder = 'relevance' | 'newest' | 'oldest';

/** What a query narrows besides its words. Absent means "not narrowed by this". */
export interface SearchFilters {
    readonly verdict?: Verdict;
    /** Sent on or after this instant (UTC, milliseconds). */
    readonly after?: number;
    /** Sent before this instant (UTC, milliseconds). */
    readonly before?: number;
    /** The name of a mailbox, as the sidebar lists it. Resolved by whoever knows the case. */
    readonly mailbox?: string;
    /** Tags the message must carry, all of them. Resolved against `marks.json` by whoever knows the case. */
    readonly tags?: readonly string[];
    /** Only bookmarked messages (`is:bookmarked`). */
    readonly bookmarked?: true;
    readonly order?: SearchOrder;
}

export interface ParsedSearch {
    /**
     * `true` for a query written in the old way: `fts` is empty and the caller passes `text`
     * to FTS5 as it always did.
     */
    readonly raw: boolean;
    /** The compiled FTS5 expression; empty when the query has only filters, or is raw. */
    readonly fts: string;
    readonly filters: SearchFilters;
    /**
     * The words that say what the message is ABOUT, for a search by meaning. Set only when the
     * query is plain words plus filters; a field, a phrase, a prefix, an exclusion or an OR makes
     * it empty, because those ask for something a vector search would blur or ignore.
     */
    readonly freeText: string;
    /** Translated, one sentence each. A query with errors is not run. */
    readonly errors: readonly string[];
}

/** The messages a person gets back when the query cannot be run. */
export class SearchSyntaxError extends Error {
    readonly errors: readonly string[];
    constructor(errors: readonly string[]) {
        super(errors.join(' '));
        this.name = 'SearchSyntaxError';
        this.errors = errors;
    }
}

/** Operator → the FTS5 column it searches. */
const TEXT_FIELDS: Readonly<Record<string, string>> = {
    from: 'sender',
    to: 'recipients',
    cc: 'cc',
    subject: 'subject',
    body: 'text',
};

const FILTER_OPERATORS = ['verdict', 'dkim', 'before', 'after', 'mailbox', 'tag', 'is', 'sort'] as const;

/** What `is:` can say. One value today; a list so a second one is a line and not a rewrite. */
const IS_VALUES = ['bookmarked'] as const;

/** Operators of the roadmap that do not exist yet. Named so that they fail loudly. */
const UNSUPPORTED_OPERATORS = ['filename', 'ext', 'size', 'has', 'direction'] as const;

const ORDERS: readonly SearchOrder[] = ['relevance', 'newest', 'oldest'];

/** Every operator name, for the help text and for a completion list. */
export const SEARCH_OPERATORS: readonly string[] = [...Object.keys(TEXT_FIELDS), ...FILTER_OPERATORS];

type Node =
    | {
          readonly kind: 'term';
          readonly text: string;
          readonly field?: string;
          readonly prefix: boolean;
          readonly exact: boolean;
      }
    | { readonly kind: 'filter'; readonly name: string; readonly value: string }
    | { readonly kind: 'and' | 'or'; readonly children: readonly Node[] }
    | { readonly kind: 'not'; readonly child: Node };

function isOperator(name: string): boolean {
    return name in TEXT_FIELDS || (FILTER_OPERATORS as readonly string[]).includes(name);
}

function isUnsupported(name: string): boolean {
    return (UNSUPPORTED_OPERATORS as readonly string[]).includes(name);
}

/** `2024`, `2024-03` or `2024-03-05` as the first instant of that period, UTC. */
export function parseSearchDate(value: string): number | undefined {
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
    if (match === null) return undefined;
    const year = Number(match[1]);
    const month = match[2] === undefined ? 1 : Number(match[2]);
    const day = match[3] === undefined ? 1 : Number(match[3]);
    const instant = Date.UTC(year, month - 1, day);
    const check = new Date(instant);
    // Date.UTC rolls 2024-02-31 over to March; a date that is not a date is an error.
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        return undefined;
    }
    return instant;
}

class Parser {
    private position = 0;
    private readonly input: string;
    readonly errors: string[] = [];
    /** Does the query use anything this parser owns: an operator or a negation? */
    structured = false;

    constructor(input: string) {
        this.input = input;
    }

    parse(): Node | undefined {
        const node = this.parseOr();
        this.skipSpace();
        if (this.position < this.input.length) {
            this.errors.push(_('There is a closing parenthesis without an opening one.'));
        }
        return node;
    }

    private skipSpace(): void {
        while (this.position < this.input.length && /\s/.test(this.input[this.position] ?? ''))
            this.position++;
    }

    private peek(): string | undefined {
        this.skipSpace();
        return this.input[this.position];
    }

    /** The next bare word, without consuming it. */
    private peekWord(): string {
        this.skipSpace();
        const match = /^[^\s()]+/.exec(this.input.slice(this.position));
        return match === null ? '' : match[0];
    }

    private parseOr(): Node | undefined {
        const parts: Node[] = [];
        const first = this.parseAnd();
        if (first !== undefined) parts.push(first);
        while (this.peekWord() === 'OR') {
            this.position += 2;
            if (first === undefined && parts.length === 0)
                this.errors.push(_('OR needs a search on both sides.'));
            const next = this.parseAnd();
            if (next === undefined) {
                this.errors.push(_('OR needs a search on both sides.'));
            } else {
                parts.push(next);
            }
        }
        if (parts.length === 0) return undefined;
        return parts.length === 1 ? parts[0] : { kind: 'or', children: parts };
    }

    private parseAnd(): Node | undefined {
        const parts: Node[] = [];
        for (;;) {
            const next = this.peek();
            if (next === undefined || next === ')') break;
            const word = this.peekWord();
            if (word === 'OR') break;
            if (word === 'AND') {
                this.position += 3;
                continue;
            }
            const unary = this.parseUnary();
            if (unary !== undefined) parts.push(unary);
        }
        if (parts.length === 0) return undefined;
        return parts.length === 1 ? parts[0] : { kind: 'and', children: parts };
    }

    private parseUnary(): Node | undefined {
        const next = this.peek();
        const word = this.peekWord();
        if (word === 'NOT') {
            this.position += 3;
            this.structured = true;
            return this.negated();
        }
        // A minus only negates when something follows it: a lone `-` is a word.
        if (next === '-' && /\S/.test(this.input[this.position + 1] ?? '')) {
            this.position += 1;
            this.structured = true;
            return this.negated();
        }
        if (next === '(') {
            this.position += 1;
            const inner = this.parseOr();
            if (this.peek() === ')') {
                this.position += 1;
            } else {
                this.errors.push(_('There is an opening parenthesis without a closing one.'));
            }
            if (inner === undefined) this.errors.push(_('There is nothing between the parentheses.'));
            return inner;
        }
        return this.parseAtom();
    }

    private negated(): Node | undefined {
        const child = this.parseUnary();
        if (child === undefined) {
            this.errors.push(_('NOT and - need something to exclude.'));
            return undefined;
        }
        return { kind: 'not', child };
    }

    private parseAtom(): Node | undefined {
        this.skipSpace();
        const rest = this.input.slice(this.position);
        const operator = /^([A-Za-z]+):/.exec(rest);
        if (operator !== null) {
            const name = (operator[1] ?? '').toLowerCase();
            if (isOperator(name) || isUnsupported(name)) {
                this.position += operator[0].length;
                this.structured = true;
                return this.parseOperator(name);
            }
        }
        return this.parseValue(undefined);
    }

    private parseOperator(name: string): Node | undefined {
        if (isUnsupported(name)) {
            // The value is consumed so the error is said once, not once per word of it.
            this.readValue();
            this.errors.push(fmt(_('The search operator {name}: is not supported yet.'), { name }));
            return undefined;
        }
        if (name in TEXT_FIELDS) return this.parseValue(TEXT_FIELDS[name]);
        const value = this.readValue();
        if (value === undefined || value.text === '') {
            this.errors.push(
                fmt(_('The search operator {name}: needs a value, as in {example}.'), {
                    name,
                    example: exampleOf(name),
                }),
            );
            return undefined;
        }
        return { kind: 'filter', name, value: value.text };
    }

    /** A quoted phrase, or a word up to the next space or parenthesis. */
    private readValue(): { text: string; quoted: boolean } | undefined {
        this.skipSpace();
        const rest = this.input.slice(this.position);
        if (rest === '') return undefined;
        if (rest.startsWith('"')) {
            const end = rest.indexOf('"', 1);
            const text = end < 0 ? rest.slice(1) : rest.slice(1, end);
            this.position += end < 0 ? rest.length : end + 1;
            return { text, quoted: true };
        }
        const word = /^[^\s()]+/.exec(rest);
        if (word === null) return undefined;
        this.position += word[0].length;
        return { text: word[0], quoted: false };
    }

    private parseValue(field: string | undefined): Node | undefined {
        const value = this.readValue();
        if (value === undefined) {
            this.errors.push(_('A search operator needs a value after the colon.'));
            return undefined;
        }
        let text = value.text;
        let prefix = false;
        if (!value.quoted && text.length > 1 && text.endsWith('*')) {
            prefix = true;
            text = text.slice(0, -1);
        }
        if (text === '') {
            this.errors.push(_('A search operator needs a value after the colon.'));
            return undefined;
        }
        return {
            kind: 'term',
            text,
            ...(field === undefined ? {} : { field }),
            prefix,
            exact: value.quoted || prefix,
        };
    }
}

function exampleOf(name: string): string {
    switch (name) {
        case 'verdict':
        case 'dkim':
            return `${name}:body-altered`;
        case 'before':
        case 'after':
            return `${name}:2024-03-05`;
        case 'sort':
            return 'sort:newest';
        case 'is':
            return 'is:bookmarked';
        case 'tag':
            return 'tag:legal';
        default:
            return `${name}:name`;
    }
}

function quote(text: string): string {
    return `"${text.replaceAll('"', '""')}"`;
}

/** The FTS5 text of one node, or `undefined` once an error has been recorded for it. */
function compile(node: Node, errors: string[]): string | undefined {
    switch (node.kind) {
        case 'term': {
            const phrase = quote(node.text) + (node.prefix ? '*' : '');
            return node.field === undefined ? phrase : `${node.field} : ${phrase}`;
        }
        case 'filter':
            // Filters are lifted out of the top level before compiling; one still here is nested.
            errors.push(
                fmt(_('The search operator {name}: cannot be used inside OR, NOT or parentheses.'), {
                    name: node.name,
                }),
            );
            return undefined;
        case 'not':
            if (node.child.kind === 'filter') return compile(node.child, errors);
            errors.push(_('A search for exclusions alone cannot be run. Add a word to look for.'));
            return undefined;
        case 'or': {
            const parts: string[] = [];
            for (const child of node.children) {
                if (child.kind === 'not') {
                    errors.push(
                        _('NOT and - cannot stand directly inside OR. Put the word to look for beside it.'),
                    );
                    continue;
                }
                const text = compile(child, errors);
                if (text !== undefined) parts.push(text);
            }
            return parts.length === 0 ? undefined : `(${parts.join(' OR ')})`;
        }
        case 'and': {
            const positive: string[] = [];
            const negative: string[] = [];
            for (const child of node.children) {
                if (child.kind === 'not') {
                    const text = compile(child.child, errors);
                    if (text !== undefined) negative.push(text);
                } else {
                    const text = compile(child, errors);
                    if (text !== undefined) positive.push(text);
                }
            }
            if (positive.length === 0) {
                // The specific error is already recorded for a failed child; otherwise it is this.
                if (errors.length === 0) {
                    errors.push(_('A search for exclusions alone cannot be run. Add a word to look for.'));
                }
                return undefined;
            }
            // FTS5's NOT is binary: `a NOT b`. Several exclusions are one `NOT (b OR c)`.
            let text = positive.length === 1 ? (positive[0] ?? '') : `(${positive.join(' AND ')})`;
            if (negative.length > 0) text = `(${text} NOT (${negative.join(' OR ')}))`;
            return text;
        }
    }
}

/** The words of a body made of nothing but plain words, or `undefined` if it has anything else. */
function plainWords(node: Node): string[] | undefined {
    if (node.kind === 'term') return node.field === undefined && !node.exact ? [node.text] : undefined;
    if (node.kind !== 'and') return undefined;
    const words: string[] = [];
    for (const child of node.children) {
        const part = plainWords(child);
        if (part === undefined) return undefined;
        words.push(...part);
    }
    return words;
}

function readFilters(nodes: readonly Node[], errors: string[]): SearchFilters {
    const filters: { -readonly [K in keyof SearchFilters]: SearchFilters[K] } = {};
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const node of nodes) {
        if (node.kind !== 'filter') continue;
        const group = node.name === 'dkim' ? 'verdict' : node.name;
        // `tag:` may repeat: each one narrows further, so two tags mean both.
        if (group === 'tag') {
            // Spelled as the marks file spells it (`normaliseTag`): collapsed whitespace.
            tags.push(node.value.replace(/\s+/g, ' ').trim());
            continue;
        }
        if (seen.has(group)) {
            errors.push(fmt(_('The search operator {name}: is given twice.'), { name: node.name }));
            continue;
        }
        seen.add(group);
        const value = node.value.toLowerCase();
        switch (group) {
            case 'verdict':
                if ((VERDICTS as readonly string[]).includes(value)) {
                    filters.verdict = value as Verdict;
                } else {
                    errors.push(
                        fmt(_('{value} is not a verdict. The verdicts are: {list}.'), {
                            value: node.value,
                            list: VERDICTS.join(', '),
                        }),
                    );
                }
                break;
            case 'after':
            case 'before': {
                const instant = parseSearchDate(node.value);
                if (instant === undefined) {
                    errors.push(
                        fmt(_('{value} is not a date. Write it as 2024, 2024-03 or 2024-03-05.'), {
                            value: node.value,
                        }),
                    );
                } else if (group === 'after') {
                    filters.after = instant;
                } else {
                    filters.before = instant;
                }
                break;
            }
            case 'mailbox':
                filters.mailbox = node.value;
                break;
            case 'is':
                if (value === 'bookmarked') {
                    filters.bookmarked = true;
                } else {
                    errors.push(
                        fmt(_('{value} is not something a message can be. The choices are: {list}.'), {
                            value: node.value,
                            list: IS_VALUES.join(', '),
                        }),
                    );
                }
                break;
            case 'sort':
                if ((ORDERS as readonly string[]).includes(value)) {
                    filters.order = value as SearchOrder;
                } else {
                    errors.push(
                        fmt(_('{value} is not a sort order. The orders are: {list}.'), {
                            value: node.value,
                            list: ORDERS.join(', '),
                        }),
                    );
                }
                break;
        }
    }
    if (tags.length > 0) filters.tags = tags;
    return filters;
}

/** Read what a person typed into the search box. Never throws: problems come back in `errors`. */
export function parseSearch(input: string): ParsedSearch {
    const parser = new Parser(input);
    const root = parser.parse();
    if (!parser.structured) {
        return { raw: true, fts: '', filters: {}, freeText: input.trim(), errors: [] };
    }

    const errors = [...parser.errors];
    // Filters apply to the whole query, so they are only valid on its top level.
    const top: readonly Node[] = root === undefined ? [] : root.kind === 'and' ? root.children : [root];
    const filters = readFilters(top, errors);
    const rest = top.filter((node) => node.kind !== 'filter');
    const body: Node | undefined =
        rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : { kind: 'and', children: rest };

    let fts = '';
    if (body !== undefined && errors.length === 0) fts = compile(body, errors) ?? '';
    // A search by meaning can only honour what the filters can also say to it. A field, a
    // phrase, an exclusion or an OR would be lost on the vectors, so those queries stay text.
    const freeText = body === undefined ? '' : (plainWords(body)?.join(' ') ?? '');
    return { raw: false, fts, filters, freeText, errors };
}
