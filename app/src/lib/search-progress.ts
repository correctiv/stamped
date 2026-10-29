/**
 * What a search is still busy with, and what the meaning adds to a list the words already filled.
 *
 * A search in this window is TWO searches that finish at different times: FTS5 answers in
 * milliseconds, the meaning first has to load a model, embed the query and scan the vectors.
 * Three rules follow from that, and all three live here so they can be tested on both runtimes:
 *
 * - The list shows the text half AS SOON AS IT HAS IT. Waiting for the count first — which for a
 *   text query is a full search of its own — left the pane empty while the answer was already
 *   there to show.
 * - The meaning's hits are APPENDED, never swapped in. A journalist reading row four may not
 *   have row four turn into another message under the pointer, and a list that rebuilds loses
 *   the selection and the scroll position with it.
 * - An answer belongs to the run that asked for it. Every await is a place where another letter
 *   was typed or a filter was flipped, and what lands afterwards is about a list that is gone.
 *
 * Nothing here touches a widget. The words belong to `gui/view/semantic.ts`.
 */

/** What the search is waiting for; `idle` means both halves have answered. */
export type SearchPhase = 'idle' | 'text' | 'loading-model' | 'meaning';

/**
 * How long a phase must last before the person is told about it.
 *
 * A search that answers at once must draw nothing: a row that appears and disappears on every
 * keystroke is noise, and noise in a progress indicator teaches people to ignore the one that
 * matters. The delay is the whole difference between "this is taking a moment" and a flicker.
 */
export const PROGRESS_DELAY_MS = 250;

/**
 * Which run of the search is the current one.
 *
 * One number is the whole mechanism: a chain takes a token when it starts and drops whatever it
 * is holding once the token is no longer current. It has to be re-checked after EVERY await, not
 * just the first — the text page, the model, the vector scan and the count are four separate
 * places to come back from, and a stale answer landing in a fresh list is how a search for one
 * word ends up showing the results of another.
 *
 * `cancel` supersedes without starting anything, for closing a case or emptying the list.
 */
export class SearchRuns {
    private current = 0;

    /** Begin a run and take its token. */
    start(): number {
        return ++this.current;
    }

    /** The token of the run in progress, for a chain that joins one instead of starting it. */
    get token(): number {
        return this.current;
    }

    /** Is this token still the run the window is showing? */
    isCurrent(token: number): boolean {
        return token === this.current;
    }

    /** Supersede every run in flight without beginning one. */
    cancel(): void {
        this.current++;
    }
}

/** The phase a string names, or nothing when it names none — what a screenshot hook is given. */
export function searchPhaseOf(name: string): Exclude<SearchPhase, 'idle'> | undefined {
    return name === 'text' || name === 'loading-model' || name === 'meaning' ? name : undefined;
}

/** What the meaning adds to the list the words already filled. */
export interface SemanticMerge<T> {
    /** The hits to APPEND, in the fused order, none of them on screen already. */
    readonly append: readonly T[];
    /** How long the list is once they are appended. */
    readonly total: number;
}

/**
 * The hits of a fused search that are not on screen yet, in the order the fusion put them.
 *
 * The rows already shown keep their places — that is the point, see the module note — so the
 * meaning's contribution is the tail: everything it found that the words did not. A hash that
 * the fusion lists twice is appended once.
 */
export function mergeSemantic<T extends { readonly hash: string }>(
    shown: readonly string[],
    merged: readonly T[],
): SemanticMerge<T> {
    const have = new Set(shown);
    const append: T[] = [];
    for (const hit of merged) {
        if (have.has(hit.hash)) continue;
        have.add(hit.hash);
        append.push(hit);
    }
    return { append, total: shown.length + append.length };
}

/**
 * Did the meaning find anything the words did not already have?
 *
 * A fused result in which every hit is a text hit is the text result over again: merging it
 * would redraw the list to change nothing, so the list is left exactly as it stands.
 */
export function addsMeaning(merged: readonly { readonly match: string }[]): boolean {
    return merged.some((hit) => hit.match !== 'text');
}
