/**
 * The embedder the WINDOW indexes with, and whether this runtime has one at all.
 *
 * Separate from `embedder.ts`, which is the search command's seam: the window asks a different
 * question (can this machine index, and if not, why?) and must keep answering it without ever
 * throwing — a case window that dies because a model is missing has made a background feature
 * louder than the foreground one.
 *
 * ON BOTH RUNTIMES the model is found through {@link resolveEmbeddingModelFromEnv} and run by the
 * llama embedder. The embedder is NOT imported here but registered by `semantic-embedder-llama.ts`,
 * which the entry point imports statically: node-llama-cpp deadlocks when the bundler wraps it in
 * a lazy initialiser, and any module reachable through `await import()` that also imports it gets
 * wrapped. This file is reachable from the window, so it must stay free of that import. GJS
 * reaches the same prebuilt addon as Node, by its own route — that branch lives in
 * `@stamped/semantic/llama-embedder` and is not this file's business.
 *
 * WHAT IS LEFT OF "no runtime here" is the machine nobody built a binary for: llama.cpp ships as
 * prebuilt shared objects per platform and architecture, and a host outside that list cannot embed
 * whatever runtime it runs. {@link hasPrebuiltBins} is a table lookup, so the dialog can ask it.
 */

import type { Embedder } from '@stamped/semantic';
import { hasPrebuiltBins } from '@stamped/semantic/prebuilt-bins';

import { resolveEmbeddingModelFromEnv } from './model-path.ts';

type CreateLlama = (options: { modelPath: string }) => Promise<Embedder>;

let createLlama: CreateLlama | undefined;

/** Called once by `semantic-embedder-llama.ts`; until then there is no embedder to create. */
export function registerLlamaEmbedder(create: CreateLlama): void {
    createLlama = create;
}

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
        if (createLlama === undefined) return undefined;
        return await createLlama({ modelPath: model.path });
    } catch (error) {
        // Never thrown on, but not silent either: "not available" with no word on stderr is how a
        // model that would not load looked like a missing feature.
        console.error(error);
        return undefined;
    }
}
