/**
 * The gettext runtime, in TypeScript, with no imports at all.
 *
 * English is the source language: every msgid in this repo is English and German arrives as a
 * catalogue (`po/de.po`). A missing catalogue is therefore not an error state — every lookup
 * falls back to the msgid, so an installation without a compiled `de.po` shows correct English
 * rather than empty strings.
 *
 * WHY NOT GJS's `gettext` module: curlew is dual-runtime. The same sources build to a GJS bundle
 * and to a Node one (`build:node`, plus the darwin/win32 ship targets), and the test suite runs
 * both. `import Gettext from 'gettext'` resolves only under GJS, so binding the catalogue there
 * would translate the GJS build and silently leave Node English — the half-translated state that
 * is worse than none. A `.mo` file is a documented, stable format; parsing it here costs ~100
 * lines and buys one behaviour for both runtimes.
 *
 * This module stays import-free on purpose: `@curlew/telegram` may only reach for `@curlew/protocol`
 * and `@curlew/store`, and reading a file is a host concern. Whoever owns the filesystem —
 * `app/src/core/lib/i18n.ts` — parses the bytes and hands the result to {@link setCatalogue}.
 */

/** The gettext domain. One domain for the whole repo: app sources and every `packages/*`. */
export const TEXT_DOMAIN = 'stamped';

/** Separator between msgctxt and msgid inside a `.mo` key, per the gettext format. */
const CONTEXT_GLUE = '\u0004';

/** Separator between the singular and the plural msgid inside a `.mo` key. */
const PLURAL_GLUE = '\u0000';

/** A parsed catalogue: the lookup table plus the target language's plural rule. */
export interface Catalogue {
    /** `.mo` key (`msgid`, `ctx\u0004msgid`, `sing\u0000plur`) to its translation forms. */
    readonly messages: ReadonlyMap<string, readonly string[]>;
    /** How many plural forms the language has. 2 when the catalogue does not say. */
    readonly nplurals: number;
    /** Which form index to use for `n`. English's rule when the catalogue does not say. */
    readonly plural: (n: number) => number;
}

/** The English plural rule, and the fallback whenever a catalogue declares none. */
const ENGLISH_PLURAL = (n: number): number => (n === 1 ? 0 : 1);

let catalogue: Catalogue | undefined;

/**
 * Install the catalogue every later `_()` resolves against, or `undefined` for English.
 *
 * Call before the first translated string is produced: a message already formatted keeps the
 * language it was built in.
 */
export function setCatalogue(next: Catalogue | undefined): void {
    catalogue = next;
}

/** The installed catalogue, or `undefined` when none is — mostly for tests and diagnostics. */
export function activeCatalogue(): Catalogue | undefined {
    return catalogue;
}

/** Translate one string. */
export function _(msgid: string): string {
    return lookup(msgid, 0) ?? msgid;
}

/**
 * Translate a counted string, letting the target language pick its own plural form.
 *
 * Never build this from an `n === 1` check at the call site: German agrees with English here, but
 * the rule is a property of the language and belongs in the catalogue.
 */
export function _n(singular: string, plural: string, n: number): string {
    const key = `${singular}${PLURAL_GLUE}${plural}`;
    const forms = catalogue?.messages.get(key);
    if (forms && forms.length > 0) {
        const index = clampForm(catalogue!.plural(n), forms.length);
        const form = forms[index];
        if (form) return form;
    }
    return ENGLISH_PLURAL(n) === 0 ? singular : plural;
}

/**
 * Translate with a disambiguating context.
 *
 * For the case where one English word is two different German ones — "Archive" the folder and
 * "Archive" the action — which a translator cannot resolve from the string alone.
 */
export function _p(context: string, msgid: string): string {
    return lookup(`${context}${CONTEXT_GLUE}${msgid}`, 0) ?? msgid;
}

/**
 * Fill `{name}` placeholders in an already translated string.
 *
 * Named, not `%s`, so a translation can reorder them — German puts the verb last and the count
 * elsewhere than English does. An unknown name is left as written rather than printed as
 * `undefined`, so a typo in a translation shows up as `{acount}` instead of a lie.
 */
export function fmt(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in values ? String(values[name]) : whole,
    );
}

function lookup(key: string, form: number): string | undefined {
    const forms = catalogue?.messages.get(key);
    return forms?.[form] || undefined;
}

function clampForm(index: number, available: number): number {
    if (!Number.isFinite(index) || index < 0) return 0;
    return index >= available ? available - 1 : Math.floor(index);
}

/**
 * The locale names to try, most specific first, from the POSIX environment chain.
 *
 * `LANGUAGE` is a colon-separated priority list and wins — but only while the locale itself is
 * not `C`/`POSIX`, which is how `LC_ALL=C` can pin a test run to English even on a German
 * desktop. Then `LC_ALL`, `LC_MESSAGES`, `LANG`, exactly as gettext reads them. Each entry is
 * expanded from most to least specific (`de_DE.UTF-8@euro` → `de_DE@euro`, `de_DE`, `de`), so a
 * repo that ships only `de` still serves a `de_AT` session.
 */
export function localeCandidates(env: Record<string, string | undefined>): string[] {
    const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
    const bare = locale.split('.')[0]?.split('@')[0];
    const neutral = bare === 'C' || bare === 'POSIX' || bare === '';

    const names: string[] = [];
    if (!neutral && env.LANGUAGE) names.push(...env.LANGUAGE.split(':'));
    if (!neutral) names.push(locale);

    const out: string[] = [];
    for (const name of names) {
        for (const expanded of expandLocale(name)) {
            if (expanded && !out.includes(expanded)) out.push(expanded);
        }
    }
    return out;
}

/** `de_DE.UTF-8@euro` → `de_DE@euro`, `de_DE`, `de@euro`, `de`. */
function expandLocale(name: string): string[] {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const [beforeModifier = '', modifier] = trimmed.split('@', 2);
    const withoutCodeset = beforeModifier.split('.')[0] ?? '';
    const language = withoutCodeset.split('_')[0] ?? '';

    const out: string[] = [];
    const add = (base: string, withModifier: boolean) => {
        if (!base) return;
        const value = withModifier && modifier ? `${base}@${modifier}` : base;
        if (!out.includes(value)) out.push(value);
    };
    add(withoutCodeset, true);
    add(withoutCodeset, false);
    add(language, true);
    add(language, false);
    return out;
}

/**
 * Parse a compiled `.mo` file into a {@link Catalogue}.
 *
 * The format (GNU gettext manual, "The Format of GNU MO Files"): a magic number that also tells
 * the byte order, then two parallel tables of `(length, offset)` pairs — original strings and
 * translations — sorted by original. The empty msgid carries the metadata header, where
 * `Plural-Forms` lives.
 *
 * Throws on anything that is not a `.mo`, so a caller that passed a `.po` by mistake hears about
 * it rather than running with an empty catalogue.
 */
export function parseMoCatalogue(bytes: Uint8Array): Catalogue {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 28) throw new Error('not a .mo file: shorter than its header');

    const magic = view.getUint32(0, true);
    let littleEndian: boolean;
    if (magic === 0x950412de) littleEndian = true;
    else if (magic === 0xde120495) littleEndian = false;
    else throw new Error('not a .mo file: bad magic number');

    const u32 = (offset: number) => view.getUint32(offset, littleEndian);
    const count = u32(8);
    const originalsTable = u32(12);
    const translationsTable = u32(16);

    const decoder = new TextDecoder('utf-8');
    const read = (tableOffset: number, index: number): string => {
        const entry = tableOffset + index * 8;
        const length = u32(entry);
        const offset = u32(entry + 4);
        if (offset + length > bytes.byteLength) throw new Error('corrupt .mo file: string out of range');
        return decoder.decode(bytes.subarray(offset, offset + length));
    };

    const messages = new Map<string, readonly string[]>();
    let header = '';
    for (let i = 0; i < count; i++) {
        const original = read(originalsTable, i);
        const translation = read(translationsTable, i);
        if (original === '') {
            header = translation;
            continue;
        }
        messages.set(original, translation.split(PLURAL_GLUE));
    }

    const { nplurals, plural } = parsePluralForms(header);
    return { messages, nplurals, plural };
}

/** Read `Plural-Forms: nplurals=2; plural=n != 1;` out of a catalogue header. */
function parsePluralForms(header: string): { nplurals: number; plural: (n: number) => number } {
    const line = header.split('\n').find((entry) => entry.toLowerCase().startsWith('plural-forms:'));
    if (!line) return { nplurals: 2, plural: ENGLISH_PLURAL };

    const value = line.slice(line.indexOf(':') + 1);
    const nplurals = Number(/nplurals\s*=\s*(\d+)/.exec(value)?.[1] ?? 2);
    const expression = /plural\s*=\s*([^;]+)/.exec(value)?.[1];
    if (!expression) return { nplurals, plural: ENGLISH_PLURAL };

    try {
        const compiled = compilePluralExpression(expression);
        return { nplurals: nplurals > 0 ? nplurals : 2, plural: compiled };
    } catch {
        // A header we cannot read is not worth failing a whole run over: the catalogue's singular
        // forms are still correct, and English's rule is the closest guess available.
        return { nplurals: nplurals > 0 ? nplurals : 2, plural: ENGLISH_PLURAL };
    }
}

/**
 * Compile a `Plural-Forms` expression into a function of `n`.
 *
 * A recursive-descent parser over the C subset gettext allows — `?:`, `||`, `&&`, `==`, `!=`,
 * `<`, `>`, `<=`, `>=`, `+`, `-`, `*`, `/`, `%`, `!`, parentheses, integer literals and the one
 * variable `n`. Hand-written rather than `new Function(...)`: the expression comes out of a data
 * file, and a catalogue must never be able to execute code. Evaluates C semantics, so a
 * comparison yields 0 or 1 and `/` truncates.
 */
function compilePluralExpression(source: string): (n: number) => number {
    const tokens = tokenizePlural(source);
    let position = 0;

    const peek = () => tokens[position];
    const eat = (token: string): boolean => {
        if (tokens[position] === token) {
            position++;
            return true;
        }
        return false;
    };
    const expect = (token: string): void => {
        if (!eat(token)) throw new Error(`plural expression: expected "${token}"`);
    };

    type Node = (n: number) => number;

    const parseExpression = (): Node => parseTernary();

    const parseTernary = (): Node => {
        const condition = parseBinary(0);
        if (!eat('?')) return condition;
        const whenTrue = parseExpression();
        expect(':');
        const whenFalse = parseTernary();
        return (n) => (condition(n) ? whenTrue(n) : whenFalse(n));
    };

    // Lowest precedence first, mirroring C.
    const LEVELS: readonly (readonly string[])[] = [
        ['||'],
        ['&&'],
        ['==', '!='],
        ['<', '>', '<=', '>='],
        ['+', '-'],
        ['*', '/', '%'],
    ];

    const parseBinary = (level: number): Node => {
        if (level >= LEVELS.length) return parseUnary();
        let left = parseBinary(level + 1);
        for (;;) {
            const operator = LEVELS[level]!.find((candidate) => peek() === candidate);
            if (!operator) return left;
            position++;
            const right = parseBinary(level + 1);
            left = combine(operator, left, right);
        }
    };

    const parseUnary = (): Node => {
        if (eat('!')) {
            const operand = parseUnary();
            return (n) => (operand(n) ? 0 : 1);
        }
        if (eat('-')) {
            const operand = parseUnary();
            return (n) => -operand(n);
        }
        return parsePrimary();
    };

    const parsePrimary = (): Node => {
        if (eat('(')) {
            const inner = parseExpression();
            expect(')');
            return inner;
        }
        const token = peek();
        if (token === undefined) throw new Error('plural expression: unexpected end');
        position++;
        if (token === 'n') return (n) => n;
        if (/^\d+$/.test(token)) {
            const literal = Number(token);
            return () => literal;
        }
        throw new Error(`plural expression: unexpected token "${token}"`);
    };

    const compiled = parseExpression();
    if (position !== tokens.length) throw new Error('plural expression: trailing tokens');
    return (n) => {
        const result = compiled(n);
        return Number.isFinite(result) ? Math.trunc(result) : 0;
    };
}

function combine(
    operator: string,
    left: (n: number) => number,
    right: (n: number) => number,
): (n: number) => number {
    switch (operator) {
        case '||':
            return (n) => (left(n) || right(n) ? 1 : 0);
        case '&&':
            return (n) => (left(n) && right(n) ? 1 : 0);
        case '==':
            return (n) => (left(n) === right(n) ? 1 : 0);
        case '!=':
            return (n) => (left(n) !== right(n) ? 1 : 0);
        case '<':
            return (n) => (left(n) < right(n) ? 1 : 0);
        case '>':
            return (n) => (left(n) > right(n) ? 1 : 0);
        case '<=':
            return (n) => (left(n) <= right(n) ? 1 : 0);
        case '>=':
            return (n) => (left(n) >= right(n) ? 1 : 0);
        case '+':
            return (n) => left(n) + right(n);
        case '-':
            return (n) => left(n) - right(n);
        case '*':
            return (n) => left(n) * right(n);
        case '/':
            return (n) => {
                const divisor = right(n);
                return divisor === 0 ? 0 : Math.trunc(left(n) / divisor);
            };
        case '%':
            return (n) => {
                const divisor = right(n);
                return divisor === 0 ? 0 : left(n) % divisor;
            };
        default:
            throw new Error(`plural expression: unknown operator "${operator}"`);
    }
}

const PLURAL_OPERATORS = [
    '<=',
    '>=',
    '==',
    '!=',
    '&&',
    '||',
    '?',
    ':',
    '<',
    '>',
    '+',
    '-',
    '*',
    '/',
    '%',
    '!',
    '(',
    ')',
] as const;

function tokenizePlural(source: string): string[] {
    const tokens: string[] = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index]!;
        if (/\s/.test(char)) {
            index++;
            continue;
        }
        if (/\d/.test(char)) {
            let end = index;
            while (end < source.length && /\d/.test(source[end]!)) end++;
            tokens.push(source.slice(index, end));
            index = end;
            continue;
        }
        if (char === 'n') {
            tokens.push('n');
            index++;
            continue;
        }
        const operator = PLURAL_OPERATORS.find((candidate) => source.startsWith(candidate, index));
        if (!operator) throw new Error(`plural expression: unexpected character "${char}"`);
        tokens.push(operator);
        index += operator.length;
    }
    return tokens;
}
