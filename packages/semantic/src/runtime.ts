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

/**
 * Run SpiderMonkey's garbage collector now; a no-op on Node, which sizes its own.
 *
 * WHY THE INDEXER NEEDS IT: GJS decides when to collect from the JS heap alone, and the embedder's
 * garbage is mostly NATIVE memory held by small wrapper objects (the llama addon's buffers behind
 * `@gjsify/napi`). The heap looks small, so no collection comes, and the subprocess climbed from
 * 0.85 GB to 1.8 GB in a 1500-message run (#115). One collection per batch holds it flat at
 * 0.85 GB at no cost in throughput.
 *
 * NEVER CALL IT INSIDE A DATABASE TRANSACTION: a collection there has broken commits before.
 */
export function collectGarbage(): void {
    const system = (globalThis as { imports?: { system?: { gc?: () => void } } }).imports?.system;
    system?.gc?.();
}
