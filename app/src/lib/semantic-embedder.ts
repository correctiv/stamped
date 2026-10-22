/**
 * The embedder the WINDOW indexes with, and whether this runtime has one at all.
 *
 * Separate from `embedder.ts`, which is the search command's seam: the window asks a different
 * question (can this machine index, and if not, why?) and must keep answering it without ever
 * throwing — a case window that dies because a model is missing has made a background feature
 * louder than the foreground one.
 *
 * ON NODE the model is found through {@link resolveEmbeddingModelFromEnv} and run by the llama
 * embedder, imported dynamically so nothing native is loaded until somebody switches the feature
 * on. UNDER GJS there is no runtime yet and the answer is "none".
 */

import type { Embedder } from '@stamped/semantic';

import { resolveEmbeddingModelFromEnv } from './model-path.ts';

/** Why there is no embedder, or `ready` when there is one to try. */
export type EmbedderAvailability = 'ready' | 'runtime' | 'model';

type Env = Record<string, string | undefined>;

/** Is this GJS? Node has no `imports`. */
export function runningOnGjs(): boolean {
    return typeof (globalThis as { imports?: unknown }).imports !== 'undefined';
}

/** A cheap look (a stat or two), safe to call while a dialog is being built. */
export function embedderAvailability(
    env: Env = process.env,
    gjs: boolean = runningOnGjs(),
): EmbedderAvailability {
    if (gjs) return 'runtime';
    try {
        return resolveEmbeddingModelFromEnv(env) === undefined ? 'model' : 'ready';
    } catch {
        return 'model';
    }
}

/** The embedder, or `undefined` for any reason at all; never rejects. */
export async function createGuiEmbedder(
    env: Env = process.env,
    gjs: boolean = runningOnGjs(),
): Promise<Embedder | undefined> {
    try {
        // Issue #76 wires the model runtime under GJS; until then the window has none.
        if (gjs) return undefined;
        const model = resolveEmbeddingModelFromEnv(env);
        if (model === undefined) return undefined;
        // A variable specifier: the GJS bundle must not follow the import into the native runtime.
        const specifier = ['@stamped/semantic', 'llama-embedder'].join('/');
        const { createLlamaEmbedder } = (await import(specifier)) as typeof import('@stamped/semantic/llama-embedder');
        return await createLlamaEmbedder({ modelPath: model.path });
    } catch {
        return undefined;
    }
}
