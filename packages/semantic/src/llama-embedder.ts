/**
 * The real embedder: EmbeddingGemma 2 through node-llama-cpp.
 *
 * WHY A SEPARATE MODULE: importing node-llama-cpp loads a native addon. Keeping it out of
 * `index.ts` and importing it lazily means the tests of the pure parts (storage, fusion, text
 * preparation) never touch the addon, and neither does a bundle that never embeds.
 *
 * RUNTIME: Node only for now. node-llama-cpp under GJS needs @gjsify/napi to load the addon,
 * which is blocked on gjsify/gjsify#2331 — do not try to make it run there from this package.
 */

import { checkVector, normalize } from './embedder.ts';
import type { EmbedDocument, Embedder } from './embedder.ts';
import { documentPrompt, queryPrompt, truncateVector } from './prompts.ts';

export const EMBEDDING_GEMMA_MODEL_ID = 'ggml-org/embeddinggemma-2-GGUF:Q8_0';

/**
 * Fixed, not "auto": auto sizing grows with the RAM of the machine (gigabytes of KV cache on a
 * 64 GB box) for a model whose mails are at most a few hundred tokens long.
 */
const CONTEXT_SIZE = 512;

export interface LlamaEmbedderOptions {
    /** Path of the GGUF file; the embedder never downloads. */
    modelPath: string;
    /** `'auto'` lets llama.cpp pick a GPU backend; `false` forces the CPU. Default `'auto'`. */
    gpu?: 'auto' | false;
    threads?: number;
    /** 768 is the model's native size; 256 is the Matryoshka truncation. Default 768. */
    dimensions?: 768 | 256;
}

export interface LlamaEmbedder extends Embedder {
    /** `'gpu'` until a bad vector forced the fallback, `'cpu'` afterwards or when forced. */
    readonly backend: 'gpu' | 'cpu';
    dispose(): Promise<void>;
}

// Only the parts of node-llama-cpp this module touches.
interface EmbeddingContextLike {
    getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }>;
    dispose(): Promise<void>;
}
interface ModelLike {
    createEmbeddingContext(options: { contextSize: number; threads?: number }): Promise<EmbeddingContextLike>;
    dispose(): Promise<void>;
}
interface LlamaLike {
    gpu: false | string;
    loadModel(options: { modelPath: string }): Promise<ModelLike>;
    dispose(): Promise<void>;
}

interface Session {
    llama: LlamaLike;
    model: ModelLike;
    context: EmbeddingContextLike;
    gpu: boolean;
}

async function openSession(options: LlamaEmbedderOptions, forceCpu: boolean): Promise<Session> {
    const { getLlama } = await import('node-llama-cpp');
    // For the GJS bring-up: the probe there had to hand `loadBackends()` the prebuilt bins
    // directory explicitly, or the model load segfaulted with "no backends are loaded".
    const llama = (await getLlama({
        gpu: forceCpu || options.gpu === false ? false : 'auto',
    })) as unknown as LlamaLike;
    const model = await llama.loadModel({ modelPath: options.modelPath });
    const context = await model.createEmbeddingContext({
        contextSize: CONTEXT_SIZE,
        ...(options.threads != null ? { threads: options.threads } : {}),
    });
    return { llama, model, context, gpu: llama.gpu !== false };
}

async function closeSession(session: Session): Promise<void> {
    await session.context.dispose();
    await session.model.dispose();
    await session.llama.dispose();
}

export async function createLlamaEmbedder(options: LlamaEmbedderOptions): Promise<LlamaEmbedder> {
    const dimensions = options.dimensions ?? 768;
    let session = await openSession(options, false);

    const embedOnce = async (text: string): Promise<Float32Array> => {
        const { vector } = await session.context.getEmbeddingFor(text);
        checkVector(vector);
        return dimensions === 768 ? normalize(vector) : truncateVector(vector, dimensions);
    };

    // A GPU backend can return NaN or zeros for this model (float16 overflow). The one retry
    // reopens on the CPU; on the CPU a bad vector is a real error and is thrown.
    const embed = async (text: string): Promise<Float32Array> => {
        try {
            return await embedOnce(text);
        } catch (err) {
            if (!session.gpu) throw err;
            await closeSession(session);
            session = await openSession(options, true);
            return embedOnce(text);
        }
    };

    return {
        modelId: EMBEDDING_GEMMA_MODEL_ID,
        dimensions,
        get backend(): 'gpu' | 'cpu' {
            return session.gpu ? 'gpu' : 'cpu';
        },
        embedQuery(text: string): Promise<Float32Array> {
            return embed(queryPrompt(text));
        },
        async embedDocuments(documents: readonly EmbedDocument[]): Promise<Float32Array[]> {
            const out: Float32Array[] = [];
            for (const doc of documents) out.push(await embed(documentPrompt(doc.subject, doc.body)));
            return out;
        },
        async dispose(): Promise<void> {
            await closeSession(session);
        },
    };
}
