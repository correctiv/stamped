/**
 * The embedder the WINDOW indexes with, and whether this runtime has one at all.
 *
 * Separate from `embedder.ts`, which is the search command's seam: the window asks a different
 * question (can this machine index, and if not, why?) and must keep answering it without ever
 * throwing — a case window that dies because a model is missing has made a background feature
 * louder than the foreground one.
 *
 * ON BOTH RUNTIMES the model is found through {@link resolveEmbeddingModelFromEnv} and run by the
 * llama embedder, imported dynamically so nothing native is loaded until somebody switches the
 * feature on. GJS reaches the same prebuilt addon as Node, by its own route — that branch lives in
 * `@stamped/semantic/llama-embedder` and is not this file's business.
 *
 * WHAT IS LEFT OF "no runtime here" is the machine nobody built a binary for: llama.cpp ships as
 * prebuilt shared objects per platform and architecture, and a host outside that list cannot embed
 * whatever runtime it runs. {@link hasPrebuiltBins} is a table lookup, so the dialog can ask it.
 */

import type { Embedder } from '@stamped/semantic';
import { hasPrebuiltBins } from '@stamped/semantic/prebuilt-bins';

import { resolveEmbeddingModelFromEnv } from './model-path.ts';

/** Why there is no embedder, or `ready` when there is one to try. */
export type EmbedderAvailability = 'ready' | 'runtime' | 'model';

type Env = Record<string, string | undefined>;

/** A cheap look (a stat or two), safe to call while a dialog is being built. */
export function embedderAvailability(
    env: Env = process.env,
    bins: boolean = hasPrebuiltBins(),
): EmbedderAvailability {
    if (!bins) return 'runtime';
    try {
        return resolveEmbeddingModelFromEnv(env) === undefined ? 'model' : 'ready';
    } catch {
        return 'model';
    }
}

/** The embedder, or `undefined` for any reason at all; never rejects. */
export async function createGuiEmbedder(
    env: Env = process.env,
    bins: boolean = hasPrebuiltBins(),
): Promise<Embedder | undefined> {
    try {
        if (!bins) return undefined;
        const model = resolveEmbeddingModelFromEnv(env);
        if (model === undefined) return undefined;
        // A LITERAL specifier, so both bundles carry the embedder: under GJS it is reached through
        // `@gjsify/napi`, and a bundle that never followed the import would have nothing to reach.
        const { createLlamaEmbedder } = await import('@stamped/semantic/llama-embedder');
        return await createLlamaEmbedder({ modelPath: model.path });
    } catch {
        return undefined;
    }
}
