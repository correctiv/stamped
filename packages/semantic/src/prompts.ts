/**
 * The pure half of the llama embedder: the prompt formats EmbeddingGemma 2 was trained on and
 * the Matryoshka truncation. Separate from `llama-embedder.ts` so a bundle (or a test) can use
 * them without pulling node-llama-cpp and its native addon in.
 */

import { normalize } from './embedder.ts';
import { documentText } from './prepare.ts';

export function queryPrompt(query: string): string {
    return `task: search result | query: ${query}`;
}

export function documentPrompt(subject: string | undefined, body: string): string {
    const title = subject && subject.trim() ? subject.trim() : 'none';
    return `title: ${title} | text: ${documentText(subject, body)}`;
}

/** Matryoshka truncation: keep the leading dimensions and renormalise. */
export function truncateVector(vector: ArrayLike<number>, dimensions: number): Float32Array {
    if (vector.length < dimensions) {
        throw new Error(`cannot truncate a ${vector.length}-dimensional vector to ${dimensions}`);
    }
    return normalize(Array.prototype.slice.call(vector, 0, dimensions) as number[]);
}
