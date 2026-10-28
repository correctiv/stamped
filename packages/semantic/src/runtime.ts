/**
 * Which JavaScript runtime this is — the one branch the model runtime cannot avoid.
 *
 * The llama embedder reaches the SAME native addon on both runtimes, but it has to get there by
 * two different routes (see `llama-embedder.ts`), so the answer belongs next to it rather than in
 * the app: the package that needs the branch owns the question.
 */

/** What {@link runningOnGjs} looks at; injected so the Node-with-node-gi case is testable. */
export interface RuntimeHost {
    imports?: unknown;
    process?: { versions?: { gjs?: string } };
}

/**
 * Is this GJS?
 *
 * NOT "is there an `imports`": node-gi defines `globalThis.imports` (with `gi`) on NODE as well, so
 * that GJS-style code can run there, and the macOS and Windows apps are exactly that — Node plus
 * node-gi. Asking only for `imports` sent them down the GJS route (`@gjsify/napi`, which Node
 * cannot load), and the model reported itself "not available here" on every Mac. gjsify's
 * `process.versions.gjs` is the marker `self-argv.ts` already trusts to tell the two apart.
 */
export function runningOnGjs(host: RuntimeHost = globalThis as RuntimeHost): boolean {
    return host.imports !== undefined && host.process?.versions?.gjs !== undefined;
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
