/**
 * Which JavaScript runtime this is — the one branch the model runtime cannot avoid.
 *
 * The llama embedder reaches the SAME native addon on both runtimes, but it has to get there by
 * two different routes (see `llama-embedder.ts`), so the answer belongs next to it rather than in
 * the app: the package that needs the branch owns the question.
 */

/** Is this GJS? Node has no `imports`. */
export function runningOnGjs(): boolean {
    return typeof (globalThis as { imports?: unknown }).imports !== 'undefined';
}
