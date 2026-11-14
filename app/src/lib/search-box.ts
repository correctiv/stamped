/**
 * The search box's two helpers as data: how a part of the query is drawn, and which suggestion
 * the keyboard has chosen.
 *
 * Pure, GTK-free and tested on both runtimes. `window.ts` turns a {@link SpanAttribute} into a
 * Pango attribute and a {@link SearchBoxAction} into a popover that moves; neither decision is
 * made there, because a colour rule and a key rule are exactly the things a test can hold still.
 *
 * **Colours are named, never written.** A style here says `accent` or `error`, and the window
 * reads what those mean out of the running theme — measured: an unparented label carrying
 * `.accent` / `.error` / `.warning` answers `get_color()` with the theme's own colour and follows
 * a switch to dark (light `rgb(4,97,190)` → dark `rgb(129,208,255)` for `.accent`). A hex value
 * written here would be the one thing that does not follow it, and a blue operator on a dark
 * background is a query nobody can read. Plain body text is the exception that forced
 * {@link SpanStyle.alpha}: unparented, it answers white in BOTH schemes, so "a shade quieter than
 * the text around it" has to be an alpha on whatever foreground is in effect rather than a colour.
 */

import type { SearchCompletion, SearchSpan, SearchSpanKind } from '@stamped/store';

/** A colour by the name of the style class the theme defines it in. */
export type SpanColour = 'accent' | 'warning' | 'error';

/** How one part of a typed query is drawn. Every field is optional: plain text is `{}`. */
export interface SpanStyle {
    readonly colour?: SpanColour;
    /** Fraction of the normal text alpha — for toning a part down without naming a colour. */
    readonly alpha?: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
    /** A wavy underline in the error colour, and the text's own colour left alone. */
    readonly squiggle?: boolean;
}

/**
 * What each kind of span looks like.
 *
 * The reasoning, one line each:
 * - `operator` and `value` are the query LANGUAGE — accent, the colour the app already uses for
 *   "this is interactive"; the operator carries the weight because it is the word that decides
 *   what the value even means.
 * - `negation` is the one part that REMOVES mail from the answer, so it gets the warning colour:
 *   a `-` lost in a long query is how a journalist concludes a message is not in the leak.
 * - `boolean` and `paren` are structure, not content. They are quieter than the words, told
 *   apart by weight, and deliberately not coloured — three colours in one line is a parser's
 *   view of a query, not a reader's.
 * - `phrase` is literal text: italic says "taken as written" without competing with the accent.
 * - `error` only underlines. Recolouring the text would fight the operator colour underneath it
 *   on the common error — a known operator with a value it cannot take — and the one thing that
 *   must stay legible while it is being fixed is the text itself.
 */
export const SPAN_STYLES: Readonly<Record<SearchSpanKind, SpanStyle>> = {
    operator: { colour: 'accent', bold: true },
    value: { colour: 'accent' },
    negation: { colour: 'warning', bold: true },
    boolean: { bold: true, alpha: 0.75 },
    paren: { alpha: 0.55 },
    phrase: { italic: true },
    error: { squiggle: true },
};

/** One span ready to be drawn: its style, and its place in the text as Pango counts it. */
export interface SpanAttribute extends SpanStyle {
    /** Byte offsets into the UTF-8 text, which is what a `Pango.Attribute` takes. */
    readonly startByte: number;
    readonly endByte: number;
}

/**
 * Where every UTF-16 index of `text` sits in its UTF-8 bytes, plus one past the end.
 *
 * A `SearchSpan` counts UTF-16 units, a `Pango.Attribute` counts bytes, and for anything above
 * US-ASCII the two differ: `Müller` puts its fifth letter at index 4 and at byte 5. Colouring by
 * the index would shift the whole rest of the line, and an umlaut in a mailbox name is not an
 * edge case in a German archive. Both halves of a surrogate pair map to the start of their
 * character, so an index inside one can never land mid-sequence.
 */
export function byteOffsets(text: string): number[] {
    const offsets: number[] = new Array<number>(text.length + 1);
    let bytes = 0;
    let index = 0;
    while (index < text.length) {
        const code = text.codePointAt(index) ?? 0;
        const units = code > 0xffff ? 2 : 1;
        offsets[index] = bytes;
        if (units === 2) offsets[index + 1] = bytes;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        index += units;
    }
    offsets[text.length] = bytes;
    return offsets;
}

/**
 * The UTF-16 index of character number `character` — what `Gtk.Editable` calls a position.
 *
 * The third of the three counts. `Gtk.Editable.get_position` and `set_position` count
 * CHARACTERS, the parser counts UTF-16 units, and Pango counts bytes; all three agree until
 * someone pastes an emoji, after which a caret handed over unconverted sits one place off for
 * the rest of the line. An index past the end clamps to the end.
 */
export function unitAt(text: string, character: number): number {
    if (character <= 0) return 0;
    let seen = 0;
    let index = 0;
    while (index < text.length) {
        if (seen === character) return index;
        const code = text.codePointAt(index) ?? 0;
        index += code > 0xffff ? 2 : 1;
        seen += 1;
    }
    return text.length;
}

/** The character number of UTF-16 index `unit` — the inverse of {@link unitAt}. */
export function characterAt(text: string, unit: number): number {
    const target = Math.max(0, Math.min(unit, text.length));
    let characters = 0;
    let index = 0;
    while (index < target) {
        const code = text.codePointAt(index) ?? 0;
        index += code > 0xffff ? 2 : 1;
        characters += 1;
    }
    return characters;
}

/**
 * The spans of a query as things to draw, dropping the ones with nothing to show.
 *
 * A span reaching past the text is clamped rather than refused: the highlight is recomputed on
 * every keystroke, and a deletion that races the parser must not leave the box uncoloured.
 */
export function spanAttributes(text: string, spans: readonly SearchSpan[]): SpanAttribute[] {
    const offsets = byteOffsets(text);
    const attributes: SpanAttribute[] = [];
    for (const span of spans) {
        const start = Math.max(0, Math.min(span.start, text.length));
        const end = Math.max(start, Math.min(span.end, text.length));
        if (start === end) continue;
        const style = SPAN_STYLES[span.kind];
        const startByte = offsets[start] ?? 0;
        const endByte = offsets[end] ?? startByte;
        if (startByte === endByte) continue;
        attributes.push({ ...style, startByte, endByte });
    }
    return attributes;
}

/** The first error of a query and what is wrong with it, for the hint under the box. */
export function firstSpanError(spans: readonly SearchSpan[]): string | undefined {
    for (const span of spans) {
        if (span.kind === 'error' && span.message !== undefined) return span.message;
    }
    return undefined;
}

/** The keys the suggestion list answers to. Everything else belongs to the entry. */
export type SearchBoxKey = 'up' | 'down' | 'tab' | 'enter' | 'escape';

/** What a key does to the list. `handled` decides whether the entry still sees the key. */
export interface SearchBoxAction {
    readonly handled: boolean;
    /** Where the highlight moves to; `-1` means nothing is chosen. */
    readonly select?: number;
    /** The option to put in the box. */
    readonly accept?: number;
    /** Put the list away and take nothing. */
    readonly close?: boolean;
}

/**
 * What one key does while `count` suggestions are up and `selected` is highlighted.
 *
 * Two rules carry the whole interaction. **Enter with nothing chosen is not ours**: the box is a
 * search box first, and a list that appeared on its own must never swallow the keystroke that
 * runs the search — so Enter is handed on and the search goes out exactly as it did before this
 * feature existed. **Tab is always ours**, and takes the first suggestion when none is chosen,
 * which is the one thing a person expects of Tab in a box that completes.
 *
 * Escape only closes the list. The entry's own Escape — which clears the query — is reached by
 * pressing it again, so nothing that took typing is lost to a key aimed at a popover.
 */
export function searchBoxKey(key: SearchBoxKey, count: number, selected: number): SearchBoxAction {
    if (count <= 0) return { handled: false };
    switch (key) {
        case 'down':
            return { handled: true, select: step(selected, 1, count) };
        case 'up':
            return { handled: true, select: step(selected, -1, count) };
        case 'tab':
            return { handled: true, accept: selected < 0 ? 0 : selected };
        case 'enter':
            return selected < 0 ? { handled: false } : { handled: true, accept: selected };
        case 'escape':
            return { handled: true, close: true };
    }
}

/**
 * The next place of the highlight, walking `-1, 0 … count-1` and round again.
 *
 * `-1` is a position like any other, and keeping it in the cycle is what lets the arrow keys
 * alone undo a choice: pressing Down past the last suggestion gives the box back, so Enter runs
 * the search again without anyone having to know that Escape exists.
 */
function step(selected: number, delta: number, count: number): number {
    const places = count + 1;
    const from = selected < 0 ? 0 : selected + 1;
    return ((((from + delta) % places) + places) % places) - 1;
}

/** The box after a suggestion is taken: the text, and where the cursor goes. */
export interface SearchBoxEdit {
    readonly text: string;
    readonly caret: number;
}

/**
 * Put option `index` into `text`, or nothing when there is no such option.
 *
 * The cursor lands just past what was inserted, never at the end of the line: a query is edited
 * in the middle as often as it is appended to, and a completion that jumps the cursor to the end
 * would quietly move the next keystroke somewhere else. For a completion at the end of the line
 * the two are the same place, which is why the difference is easy to get wrong and never noticed.
 */
export function applyCompletion(
    text: string,
    completion: SearchCompletion,
    index: number,
): SearchBoxEdit | undefined {
    const option = completion.options[index];
    if (option === undefined) return undefined;
    return {
        text: text.slice(0, completion.start) + option.insert + text.slice(completion.end),
        caret: completion.start + option.insert.length,
    };
}
