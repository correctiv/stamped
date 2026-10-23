/**
 * The real embedder: EmbeddingGemma 2 through node-llama-cpp.
 *
 * WHY A SEPARATE MODULE: importing node-llama-cpp loads a native addon. Keeping it out of
 * `index.ts` and importing it lazily means the tests of the pure parts (storage, fusion, text
 * preparation) never touch the addon, and neither does a bundle that never embeds.
 *
 * RUNTIME: both. The same prebuilt addon runs on Node and on GJS, but it has to be REACHED by
 * two different routes — see {@link openSession}.
 *
 * BUNDLING IT NEEDS TWO ALIASES in the app's `gjsify.aliases`, because node-llama-cpp's barrel
 * reaches code neither route here ever runs: `node:child_process` →
 * `@stamped/semantic/child-process` for the `fork`ed binary self-test, and `ipull` →
 * `ipull/node`. The second is a CONDITION mismatch rather than a gap — gjsify resolves with the
 * `browser` condition, and ipull's browser build exports `downloadFileBrowser` where the model
 * downloader imports `downloadFile`, so the bundle fails to LINK over a downloader this embedder
 * never calls. Rolldown resolves exports before it shakes the tree, so importing fewer names
 * does not help, and node-llama-cpp's `exports` map blocks reaching past the barrel.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLlama, Llama, LlamaLogLevel } from 'node-llama-cpp';

import { checkVector, normalize } from './embedder.ts';
import type { EmbedDocument, Embedder } from './embedder.ts';
import { BUILD_METADATA_FILE, prebuiltBinsDir } from './prebuilt-bins.ts';
import { documentPrompt, queryPrompt, truncateVector } from './prompts.ts';
import { runningOnGjs } from './runtime.ts';

export const EMBEDDING_GEMMA_MODEL_ID = 'ggml-org/embeddinggemma-2-GGUF:Q8_0';

/**
 * Fixed, not "auto": auto sizing grows with the RAM of the machine (gigabytes of KV cache on a
 * 64 GB box) for a model whose mails are at most a few hundred tokens long.
 */
const CONTEXT_SIZE = 512;

/** Two, not "all cores": the indexer runs for hours next to the journalist's own work. */
export const DEFAULT_THREADS = 2;

export interface LlamaEmbedderOptions {
    /** Path of the GGUF file; the embedder never downloads. */
    modelPath: string;
    /** `'auto'` lets llama.cpp pick a GPU backend; `false` forces the CPU. Default `'auto'`. */
    gpu?: 'auto' | false;
    /** CPU threads for the model. Default {@link DEFAULT_THREADS}: indexing is background work. */
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

/**
 * The GJS route: load the addon through `@gjsify/napi` and build the instance by hand.
 *
 * `getLlama()` cannot be used here, and neither half of it for the same reason — it is written
 * against Node's module system. It loads the addon with `createRequire`, which has no way to
 * dlopen a `.node`, and it self-tests the binary by `fork`ing a second interpreter, which GJS
 * cannot do at all. `@gjsify/napi` implements the N-API C ABI over SpiderMonkey, so the same
 * prebuilt addon loads directly, and `Llama._create` takes it from there.
 *
 * THE DIRECTORY IS NAMED TWICE on purpose: once as the addon's own path, once as
 * `extBackendsPath`, because the ggml backends are separate shared objects beside it. Without the
 * second the first model load segfaults with "no backends are loaded" rather than failing.
 *
 * CPU ONLY. Picking a GPU backend means node-llama-cpp's own detection across several prebuilt
 * packages; the CPU package is the one measured to work here. {@link LlamaEmbedder.backend}
 * therefore reads `'cpu'` under GJS, and the GPU retry in {@link createLlamaEmbedder} never fires.
 */
async function createLlamaOnGjs(options: LlamaEmbedderOptions): Promise<LlamaLike> {
    const [{ loadAddon }, binsDir] = await Promise.all([import('@gjsify/napi'), prebuiltBinsDir()]);
    const bindingPath = join(binsDir, 'llama-addon.node');
    const create = Llama as unknown as { _create(options: Record<string, unknown>): Promise<LlamaLike> };
    return await create._create({
        bindings: loadAddon(bindingPath),
        bindingPath,
        extBackendsPath: binsDir,
        buildType: 'prebuilt',
        buildMetadata: JSON.parse(readFileSync(join(binsDir, BUILD_METADATA_FILE), 'utf8')) as unknown,
        logLevel: LlamaLogLevel.warn,
        logger: Llama.defaultConsoleLogger,
        maxThreads: options.threads ?? DEFAULT_THREADS,
        vramPadding: 0,
        ramPadding: 0,
        debug: false,
        numa: false,
        tempDir: false,
    });
}

/** The Node route: `getLlama()` finds, tests and loads the binary, and chooses the backend. */
async function createLlamaOnNode(options: LlamaEmbedderOptions, forceCpu: boolean): Promise<LlamaLike> {
    return (await getLlama({
        gpu: forceCpu || options.gpu === false ? false : 'auto',
    })) as unknown as LlamaLike;
}

async function openSession(options: LlamaEmbedderOptions, forceCpu: boolean): Promise<Session> {
    const llama = runningOnGjs()
        ? await createLlamaOnGjs(options)
        : await createLlamaOnNode(options, forceCpu);
    const model = await llama.loadModel({ modelPath: options.modelPath });
    const context = await model.createEmbeddingContext({
        contextSize: CONTEXT_SIZE,
        threads: options.threads ?? DEFAULT_THREADS,
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
