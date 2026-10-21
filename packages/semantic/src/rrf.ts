/**
 * Reciprocal Rank Fusion: the meeting point of the two searches.
 *
 * WHY FUSION AND NOT A SCORE: FTS5 gives a relevance rank, the vector search gives a cosine
 * similarity. The two numbers are not comparable — a cosine of 0.83 and an FTS5 rank of 1
 * mean nothing to each other — so ranking by them together would mean inventing a weighting
 * that is wrong in a different way for every query. RRF only looks at the RANKS, so neither
 * list has to be normalised, and a half-indexed case (half the messages have vectors) fuses
 * just as well as a complete one.
 *
 * THE SCORE: every appearance of a document contributes 1 / (k + its rank), summed over the
 * lists. k = 60 is the constant the original paper uses: it flattens the curve so that the
 * difference between rank 1 and rank 10 matters less than the difference between appearing in
 * two lists and appearing in one.
 */

/**
 * Fuse ranked lists into one ranking.
 *
 * Every list is an array of hashes in rank order. The result holds each hash once, ordered by
 * its fused score.
 *
 * TIES ARE STABLE: two documents with the same score keep the order in which they were first
 * seen, so the same query always returns the same list. A result list that reshuffles
 * between two runs reads as a bug in the ranking, even when the ranking is equally good.
 */
export function fuseRrf(lists: readonly (readonly string[])[], k = 60): string[] {
    const scores = new Map<string, number>();
    const seenAt = new Map<string, number>();
    let counter = 0;

    for (const list of lists) {
        // A hash repeated inside one list is one document, not two: it must not score twice.
        const counted = new Set<string>();
        for (const hash of list) {
            if (counted.has(hash)) continue;
            counted.add(hash);
            const rank = counted.size;
            scores.set(hash, (scores.get(hash) ?? 0) + 1 / (k + rank));
            if (!seenAt.has(hash)) seenAt.set(hash, counter++);
        }
    }

    return [...scores.keys()].sort((a, b) => {
        const difference = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
        if (difference !== 0) return difference;
        const first = (seenAt.get(a) ?? 0) - (seenAt.get(b) ?? 0);
        if (first !== 0) return first;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}
