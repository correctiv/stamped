/**
 * The search box's half of the assistance: the drawing rules, the key rules and the edit a
 * taken suggestion makes. No widget — the window only carries these answers to GTK.
 */

import { describe, expect, it } from '@gjsify/unit';
import { highlightSearch, type SearchCompletion, type SearchSpan } from '@stamped/store';

import {
    applyCompletion,
    byteOffsets,
    characterAt,
    firstSpanError,
    searchBoxKey,
    spanAttributes,
    SPAN_STYLES,
    unitAt,
} from '../../src/lib/search-box.ts';

const completion = (start: number, end: number, ...inserts: string[]): SearchCompletion => ({
    start,
    end,
    options: inserts.map((insert) => ({ label: insert, insert })),
});

export default async () => {
    await describe('span styles', async () => {
        await it('names a colour and never writes one', async () => {
            for (const style of Object.values(SPAN_STYLES)) {
                expect(JSON.stringify(style).includes('#')).toBe(false);
            }
            expect(SPAN_STYLES.operator).toStrictEqual({ colour: 'accent', bold: true });
            expect(SPAN_STYLES.error).toStrictEqual({ squiggle: true });
        });

        await it('leaves the text colour alone on an error', async () => {
            expect(SPAN_STYLES.error.colour).toBe(undefined);
            expect(SPAN_STYLES.error.squiggle).toBe(true);
        });
    });

    await describe('byteOffsets', async () => {
        await it('is the identity for ASCII', async () => {
            expect(byteOffsets('from:ada')).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        });

        await it('counts a two-byte character as two', async () => {
            // `Mü` — the umlaut is one UTF-16 unit and two bytes.
            expect(byteOffsets('Mü!')).toStrictEqual([0, 1, 3, 4]);
        });

        await it('maps both halves of a surrogate pair to the character', async () => {
            expect(byteOffsets('a\u{1f600}b')).toStrictEqual([0, 1, 1, 5, 6]);
        });
    });

    await describe('unitAt and characterAt', async () => {
        await it('agree with the index while the text is plain', async () => {
            for (let at = 0; at <= 8; at += 1) {
                expect(unitAt('from:ada', at)).toBe(at);
                expect(characterAt('from:ada', at)).toBe(at);
            }
        });

        await it('counts a surrogate pair as one character and two units', async () => {
            const text = 'a\u{1f600}b';
            expect(text.length).toBe(4);
            expect(unitAt(text, 2)).toBe(3);
            expect(unitAt(text, 3)).toBe(4);
            expect(characterAt(text, 3)).toBe(2);
            expect(characterAt(text, 4)).toBe(3);
        });

        await it('is unmoved by an umlaut, which is one of each', async () => {
            expect(unitAt('Müller', 3)).toBe(3);
            expect(characterAt('Müller', 3)).toBe(3);
        });

        await it('clamps instead of running off the end', async () => {
            expect(unitAt('abc', 99)).toBe(3);
            expect(unitAt('abc', -1)).toBe(0);
            expect(characterAt('abc', 99)).toBe(3);
            expect(characterAt('abc', -1)).toBe(0);
        });

        await it('never answers inside a surrogate pair', async () => {
            // Index 1 is the high half of the emoji; the character after it is the only
            // position a caret may take.
            expect(characterAt('a\u{1f600}b', 2)).toBe(2);
        });
    });

    await describe('spanAttributes', async () => {
        await it('places an operator after an umlaut by bytes, not by index', async () => {
            const text = 'tag:Müller from:ada';
            const spans = highlightSearch(text);
            const attributes = spanAttributes(text, spans);
            const operators = attributes.filter((attribute) => attribute.bold === true);
            expect(operators.length > 0).toBe(true);
            // `from:` begins at index 11 and at byte 12 — the umlaut is the one byte between.
            expect(attributes.some((attribute) => attribute.startByte === 12)).toBe(true);
            expect(attributes.some((attribute) => attribute.startByte === 11)).toBe(false);
        });

        await it('clamps a span the text no longer holds', async () => {
            const spans: SearchSpan[] = [{ start: 2, end: 99, kind: 'operator' }];
            expect(spanAttributes('abcd', spans)).toStrictEqual([
                { colour: 'accent', bold: true, startByte: 2, endByte: 4 },
            ]);
        });

        await it('drops a span with nothing in it', async () => {
            const spans: SearchSpan[] = [
                { start: 2, end: 2, kind: 'operator' },
                { start: 9, end: 12, kind: 'value' },
            ];
            expect(spanAttributes('abcd', spans)).toStrictEqual([]);
        });
    });

    await describe('firstSpanError', async () => {
        await it('is the message of the first error span', async () => {
            const spans: SearchSpan[] = [
                { start: 0, end: 3, kind: 'operator' },
                { start: 4, end: 9, kind: 'error', message: 'second' },
                { start: 9, end: 12, kind: 'error', message: 'third' },
            ];
            expect(firstSpanError(spans)).toBe('second');
        });

        await it('is nothing when the query parses', async () => {
            expect(firstSpanError(highlightSearch('from:ada'))).toBe(undefined);
        });

        await it('reads the sentence the parser gives for an unsupported operator', async () => {
            const message = firstSpanError(highlightSearch('filename:report.pdf'));
            expect(typeof message === 'string' && message.length > 0).toBe(true);
        });
    });

    await describe('searchBoxKey', async () => {
        await it('does nothing at all while no list is up', async () => {
            for (const key of ['up', 'down', 'tab', 'enter', 'escape'] as const) {
                expect(searchBoxKey(key, 0, -1)).toStrictEqual({ handled: false });
            }
        });

        await it('walks down through the options and back to nothing chosen', async () => {
            expect(searchBoxKey('down', 2, -1)).toStrictEqual({ handled: true, select: 0 });
            expect(searchBoxKey('down', 2, 0)).toStrictEqual({ handled: true, select: 1 });
            expect(searchBoxKey('down', 2, 1)).toStrictEqual({ handled: true, select: -1 });
        });

        await it('walks up from nothing chosen to the last option', async () => {
            expect(searchBoxKey('up', 2, -1)).toStrictEqual({ handled: true, select: 1 });
            expect(searchBoxKey('up', 2, 1)).toStrictEqual({ handled: true, select: 0 });
            expect(searchBoxKey('up', 2, 0)).toStrictEqual({ handled: true, select: -1 });
        });

        await it('takes the first option on Tab when none is chosen', async () => {
            expect(searchBoxKey('tab', 3, -1)).toStrictEqual({ handled: true, accept: 0 });
            expect(searchBoxKey('tab', 3, 2)).toStrictEqual({ handled: true, accept: 2 });
        });

        await it('hands Enter on when none is chosen, so the search still runs', async () => {
            expect(searchBoxKey('enter', 3, -1)).toStrictEqual({ handled: false });
            expect(searchBoxKey('enter', 3, 1)).toStrictEqual({ handled: true, accept: 1 });
        });

        await it('closes on Escape without taking anything', async () => {
            expect(searchBoxKey('escape', 3, 1)).toStrictEqual({ handled: true, close: true });
        });
    });

    await describe('applyCompletion', async () => {
        await it('replaces the word and puts the cursor just past it', async () => {
            expect(applyCompletion('ve', completion(0, 2, 'verdict:'), 0)).toStrictEqual({
                text: 'verdict:',
                caret: 8,
            });
        });

        await it('keeps what follows and does not jump to the end', async () => {
            expect(applyCompletion('fr ada', completion(0, 2, 'from:'), 0)).toStrictEqual({
                text: 'from: ada',
                caret: 5,
            });
        });

        await it('takes a quoted value as the option spells it', async () => {
            const edit = applyCompletion('mailbox:ad', completion(8, 10, '"ada lovelace"'), 0);
            expect(edit).toStrictEqual({ text: 'mailbox:"ada lovelace"', caret: 22 });
        });

        await it('is nothing when there is no such option', async () => {
            expect(applyCompletion('ve', completion(0, 2, 'verdict:'), 1)).toBe(undefined);
            expect(applyCompletion('ve', completion(0, 2), 0)).toBe(undefined);
        });
    });
};
