/**
 * The llama embedder's prompt formats and Matryoshka truncation — pure, no model.
 * The model itself is covered by `embedder.integration.mts`.
 */

import { describe, expect, it } from '@gjsify/unit';
import { documentPrompt, fitTokens, queryPrompt, truncateVector } from '@stamped/semantic/prompts';

function norm(v: ArrayLike<number>): number {
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
    return Math.sqrt(sum);
}

export default async () => {
    await describe('llama embedder helpers', async () => {
        await it('cuts a text to the context, and leaves a short one alone', async () => {
            const model = {
                tokenize: (text: string) => Array.from(text, (c) => c.charCodeAt(0)),
                detokenize: (tokens: readonly number[]) => String.fromCharCode(...tokens),
            };
            expect(fitTokens(model, 'short', 512)).toBe('short');
            const cut = fitTokens(model, '1'.repeat(2000), 512);
            expect(cut.length).toBe(504);
        });

        await it('prefixes a query for search', async () => {
            expect(queryPrompt('who approved it')).toBe('task: search result | query: who approved it');
        });

        await it('titles a document with its subject, or "none"', async () => {
            expect(documentPrompt('Budget', 'Please approve.')).toBe('title: Budget | text: Please approve.');
            expect(documentPrompt(undefined, 'Hello')).toBe('title: none | text: Hello');
            expect(documentPrompt('   ', 'Hello')).toBe('title: none | text: Hello');
        });

        await it('truncates to the leading dimensions and renormalises', async () => {
            const out = truncateVector([3, 4, 100, 100], 2);
            expect(out.length).toBe(2);
            expect(Math.abs(norm(out) - 1) < 1e-6).toBe(true);
            expect(Math.abs(out[0] - 0.6) < 1e-6).toBe(true);
            expect(Math.abs(out[1] - 0.8) < 1e-6).toBe(true);
        });

        await it('refuses to truncate upwards', async () => {
            expect(() => truncateVector([1, 0], 4)).toThrow();
        });
    });
};
