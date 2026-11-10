/**
 * The real embedder: EmbeddingGemma 2 through `@gjsify/embeddings`.
 *
 * WHY A SEPARATE MODULE: `@gjsify/embeddings/llama` static-imports `node-llama-cpp`,
 * which loads a native addon. Keeping that import out of `index.ts` means the pure
 * parts (storage, fusion, text preparation) never touch the addon, and neither does a
 * bundle that never embeds.
 *
 * RUNTIME: both. The same `@gjsify/embeddings` engine runs on Node and on GJS; the
 * package picks the route.
 */

import { Embedder, type EmbedDocument } from '@gjsify/embeddings';
import {
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_GPU_CONTEXTS,
    DEFAULT_THREADS,
    EMBEDDING_MODELS,
    llamaEmbeddings,
    type EmbeddingModelEntry,
} from '@gjsify/embeddings/llama';
import { parseGpuSetting } from '@gjsify/machine-fit';
import { ModelStore } from '@gjsify/model-store';

import { checkVector } from './embedder.ts';
import type { Embedder as StampedEmbedder, EmbedDocument as StampedEmbedDocument } from './embedder.ts';
import { queryPrompt } from './prompts.ts';

export const EMBEDDING_GEMMA_MODEL_ID = 'ggml-org/embeddinggemma-2-GGUF:Q8_0' as const;

export { DEFAULT_GPU_CONTEXTS, DEFAULT_THREADS };

export interface LlamaEmbedderOptions {
    /**
     * Path of a directory containing the model files. When omitted the engine searches
     * {@link appDataDirs}, then the cache, then falls back to the default store location.
     * The embedder itself never downloads.
     */
    modelPath?: string;
    /**
     * Directories the app ships models in, read-only, searched before the cache. Each entry
     * should contain a subdirectory named after the model id (e.g. `embeddinggemma-2-q8_0`).
     */
    appDataDirs?: readonly string[];
    /**
     * Directories an older release cached models into. A matching file is moved into the
     * current cache layout the first time it is looked up.
     */
    legacyDirs?: readonly string[] | (() => readonly string[]);
    /** `'auto'` lets the engine pick a GPU backend; `false` forces the CPU. Default `'auto'`. */
    gpu?: 'auto' | false;
    /** CPU threads for the model. Default {@link DEFAULT_THREADS}: indexing is background work. */
    threads?: number;
    /** 768 is the model's native size; 256 is the Matryoshka truncation. Default 768. */
    dimensions?: 768 | 256;
    /** Contexts that embed side by side on a GPU. Default {@link DEFAULT_GPU_CONTEXTS}; the CPU uses one. */
    gpuContexts?: number;
}

export interface LlamaEmbedder extends StampedEmbedder {
    /** `'gpu'` when the engine is on the GPU, `'cpu'` otherwise. */
    readonly backend: 'gpu' | 'cpu';
    dispose(): Promise<void>;
}

function toPackageDocument(doc: StampedEmbedDocument): EmbedDocument {
    return {
        title: doc.subject,
        text: doc.body,
    };
}

function toStampedBackend(backend: 'gpu' | 'cpu' | undefined): 'gpu' | 'cpu' {
    return backend ?? 'cpu';
}

function createStore(options: LlamaEmbedderOptions): ModelStore<EmbeddingModelEntry> {
    return new ModelStore({
        capability: 'embeddings',
        models: EMBEDDING_MODELS,
        appDataDirs: options.appDataDirs,
        legacyDirs: options.legacyDirs,
    });
}

export async function createLlamaEmbedder(options: LlamaEmbedderOptions = {}): Promise<LlamaEmbedder> {
    const dimensions = options.dimensions ?? 768;
    const engine = llamaEmbeddings({
        model: DEFAULT_EMBEDDING_MODEL,
        modelPath: options.modelPath,
        store: createStore(options),
        dimensions,
        gpu: options.gpu === false ? 'off' : parseGpuSetting(process.env.STAMPED_SEMANTIC_GPU),
        threads: options.threads ?? DEFAULT_THREADS,
        gpuContexts: options.gpuContexts ?? DEFAULT_GPU_CONTEXTS,
    });

    const embedder = await Embedder.create({ engine });

    if (embedder.modelId !== EMBEDDING_GEMMA_MODEL_ID) {
        throw new Error(`unexpected embedding model ${embedder.modelId}`);
    }
    if (embedder.dimensions !== dimensions) {
        throw new Error(`unexpected dimensions ${embedder.dimensions}`);
    }

    return {
        modelId: embedder.modelId,
        dimensions: embedder.dimensions,
        get backend(): 'gpu' | 'cpu' {
            return toStampedBackend(embedder.backend);
        },
        async embedQuery(text: string): Promise<Float32Array> {
            const vector = await embedder.embedQuery(queryPrompt(text));
            checkVector(vector);
            return vector;
        },
        async embedDocuments(documents: readonly StampedEmbedDocument[]): Promise<Float32Array[]> {
            if (documents.length === 0) return [];
            const vectors = await embedder.embedDocuments(documents.map(toPackageDocument));
            for (const vector of vectors) {
                checkVector(vector);
            }
            return vectors;
        },
        async dispose(): Promise<void> {
            await embedder.destroy();
        },
    };
}

export { EMBEDDING_MODELS };

export type { EmbeddingModelEntry } from '@gjsify/embeddings/llama';
export { ModelStore };
