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

import { embedAcross } from './context-pool.ts';
import { checkVector, normalize } from './embedder.ts';
import type { EmbedDocument, Embedder } from './embedder.ts';
import { gpuGuard } from './gpu-guard.ts';
import {
    BUILD_METADATA_FILE,
    GPU_ENV,
    backendCandidates,
    currentTarget,
    gpuSetting,
    prebuiltBinsDir,
} from './prebuilt-bins.ts';
import { documentPrompt, fitTokens, queryPrompt, truncateVector } from './prompts.ts';
import { collectGarbage, runningOnGjs } from './runtime.ts';

export const EMBEDDING_GEMMA_MODEL_ID = 'ggml-org/embeddinggemma-2-GGUF:Q8_0';

/**
 * Fixed, not "auto": auto sizing grows with the RAM of the machine (gigabytes of KV cache on a
 * 64 GB box) for a model whose mails are at most a few hundred tokens long.
 */
const CONTEXT_SIZE = 512;

/** Two, not "all cores": the indexer runs for hours next to the journalist's own work. */
export const DEFAULT_THREADS = 2;

/**
 * Embedding contexts that evaluate side by side on a GPU. One context holds ONE sequence, and
 * node-llama-cpp serialises every call on it behind a lock, so a lone context leaves the device
 * idle between calls. Measured on an RX 6600, 400 mails in batches of 16: one context 24.6
 * mails/s, two 27.5, four and six no more than two. Each context adds only its own small KV
 * cache; the model's weights are shared. The CPU keeps one: there the threads are the budget.
 */
export const DEFAULT_GPU_CONTEXTS = 2;

export interface LlamaEmbedderOptions {
    /** Path of the GGUF file; the embedder never downloads. */
    modelPath: string;
    /** `'auto'` lets llama.cpp pick a GPU backend; `false` forces the CPU. Default `'auto'`. */
    gpu?: 'auto' | false;
    /** CPU threads for the model. Default {@link DEFAULT_THREADS}: indexing is background work. */
    threads?: number;
    /** 768 is the model's native size; 256 is the Matryoshka truncation. Default 768. */
    dimensions?: 768 | 256;
    /** Contexts that embed side by side on a GPU. Default {@link DEFAULT_GPU_CONTEXTS}; the CPU uses one. */
    gpuContexts?: number;
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
    tokenize(text: string): readonly number[];
    detokenize(tokens: readonly number[]): string;
    createEmbeddingContext(options: { contextSize: number; threads?: number }): Promise<EmbeddingContextLike>;
    dispose(): Promise<void>;
}
interface LlamaLike {
    gpu: false | string;
    loadModel(options: { modelPath: string; gpuLayers?: number }): Promise<ModelLike>;
    dispose(): Promise<void>;
}

interface Session {
    llama: LlamaLike;
    model: ModelLike;
    contexts: EmbeddingContextLike[];
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
 * WHICH BUILD is the caller's choice ({@link backendCandidates}): `getLlama()`'s own detection is
 * not available here, so the Vulkan build is picked by looking for the loader and a driver, and
 * what `llama.gpu` says after loading is the truth.
 */
async function createLlamaOnGjs(target: string, options: LlamaEmbedderOptions): Promise<LlamaLike> {
    const [{ loadAddon }, binsDir] = await Promise.all([import('@gjsify/napi'), prebuiltBinsDir(target)]);
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

/**
 * The Node route: `getLlama()` finds, tests and loads the binary, and chooses the backend.
 *
 * `onCpu` says the model must compute on the CPU even though the instance may report a GPU.
 * Asking `getLlama({ gpu: false })` is the obvious way, but it wants a CPU-only prebuilt, and
 * macOS on Apple silicon has none: the one prebuilt there is the Metal build. node-llama-cpp then
 * COMPILES llama.cpp from source — cmake and Xcode, four minutes, and a failure on every machine
 * that has no toolchain, which is every journalist's. So the CPU request is tried against the
 * prebuilts only (`build: 'never'`), and when none fits, the Metal build is loaded and the model
 * kept off the GPU with `gpuLayers: 0` (see {@link openOn}); that build carries the CPU kernels.
 */
async function createLlamaOnNode(
    options: LlamaEmbedderOptions,
    forceCpu: boolean,
): Promise<{ llama: LlamaLike; onCpu: boolean }> {
    if (!forceCpu && options.gpu !== false) {
        return { llama: (await getLlama({ gpu: 'auto' })) as unknown as LlamaLike, onCpu: false };
    }
    try {
        return {
            llama: (await getLlama({
                gpu: false,
                build: 'never',
                logLevel: LlamaLogLevel.error,
            })) as unknown as LlamaLike,
            onCpu: false,
        };
    } catch {
        const llama = (await getLlama({ gpu: 'auto', build: 'never' })) as unknown as LlamaLike;
        return { llama, onCpu: llama.gpu !== false };
    }
}

async function openOn(llama: LlamaLike, options: LlamaEmbedderOptions, onCpu = false): Promise<Session> {
    const gpu = llama.gpu !== false && !onCpu;
    const count = gpu ? Math.max(1, Math.trunc(options.gpuContexts ?? DEFAULT_GPU_CONTEXTS)) : 1;
    const model = await llama.loadModel({
        modelPath: options.modelPath,
        ...(llama.gpu !== false && onCpu ? { gpuLayers: 0 } : {}),
    });
    const contexts: EmbeddingContextLike[] = [];
    try {
        for (let i = 0; i < count; i++) {
            contexts.push(
                await model.createEmbeddingContext({
                    contextSize: CONTEXT_SIZE,
                    threads: options.threads ?? DEFAULT_THREADS,
                }),
            );
        }
        return { llama, model, contexts, gpu };
    } catch (err) {
        await Promise.all(contexts.map((context) => context.dispose().catch(() => undefined)));
        await model.dispose();
        throw err;
    }
}

/**
 * The GPU build first when the machine looks like it has one, the CPU build when that build does
 * not come up, comes up without a GPU (a loader but no usable device), or cannot run the model.
 * `candidates.at(-1)` is the CPU build and has nothing to fall back to, so its error is thrown.
 */
async function openSessionOnGjs(options: LlamaEmbedderOptions, forceCpu: boolean): Promise<Session> {
    const candidates = forceCpu || options.gpu === false ? [currentTarget()] : backendCandidates();
    for (const [index, target] of candidates.entries()) {
        const last = index === candidates.length - 1;
        let llama: LlamaLike | undefined;
        try {
            llama = await createLlamaOnGjs(target, options);
            if (!last && llama.gpu === false) throw new Error(`${target} found no GPU`);
            return await openOn(llama, options);
        } catch (err) {
            await llama?.dispose().catch(() => undefined);
            if (last) throw err;
        }
    }
    throw new Error('no llama.cpp build to try');
}

/**
 * Does an earlier GPU hang pin this machine to the CPU? Said once per process, on stderr: the user
 * is told why a fast machine got slow and how to lift it. `STAMPED_SEMANTIC_GPU=on` lifts it.
 */
let pinReported = false;
function gpuPinned(): boolean {
    const setting = gpuSetting();
    const guard = gpuGuard();
    if (setting === 'on') {
        guard.clear();
        return false;
    }
    if (setting === 'off') return true;
    const pin = guard.pin();
    if (pin === undefined) return false;
    if (!pinReported) {
        pinReported = true;
        console.error(
            `The GPU is switched off: process ${pin.pid} died while using it (${pin.at}). ` +
                `Set ${GPU_ENV}=on to try it again.`,
        );
    }
    return true;
}

async function openSession(options: LlamaEmbedderOptions, forceCpu: boolean): Promise<Session> {
    const cpuOnly = forceCpu || options.gpu === false || gpuPinned();
    const open = async (): Promise<Session> => {
        if (runningOnGjs()) return openSessionOnGjs(options, cpuOnly);
        const { llama, onCpu } = await createLlamaOnNode(options, cpuOnly);
        return openOn(llama, options, onCpu);
    };
    // A CPU session cannot lose a device; only the GPU attempt is marked.
    return cpuOnly ? open() : gpuGuard().during(open);
}

async function closeSession(session: Session): Promise<void> {
    const close = async (): Promise<void> => {
        await Promise.all(session.contexts.map((context) => context.dispose()));
        await session.model.dispose();
        await session.llama.dispose();
    };
    await (session.gpu ? gpuGuard().during(close) : close());
}

export async function createLlamaEmbedder(options: LlamaEmbedderOptions): Promise<LlamaEmbedder> {
    const dimensions = options.dimensions ?? 768;
    let session = await openSession(options, false);

    const embedOnce = async (
        on: Session,
        context: EmbeddingContextLike,
        text: string,
    ): Promise<Float32Array> => {
        const { vector } = await context.getEmbeddingFor(fitTokens(on.model, text, CONTEXT_SIZE));
        checkVector(vector);
        return dimensions === 768 ? normalize(vector) : truncateVector(vector, dimensions);
    };

    // A GPU backend can return NaN or zeros for this model (float16 overflow). The pool has let
    // every context settle by then, so the session is reopened on the CPU, which embeds what is
    // missing; there a bad vector is a real error and is thrown.
    const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const current = session;
        const { vectors, failure } = await embedAcross(current.contexts, texts, (context, text) =>
            embedOnce(current, context, text),
        );
        if (failure !== undefined) {
            if (!current.gpu) throw failure.error;
            await closeSession(current);
            session = await openSession(options, true);
            for (const [index, text] of texts.entries()) {
                vectors[index] ??= await embedOnce(session, session.contexts[0], text);
            }
        }
        return vectors as Float32Array[];
    };

    // One marker per call, not per text: the batch is what a hang interrupts, and a file per
    // message would be hundreds of writes a second for nothing.
    const guarded = <T>(work: () => Promise<T>): Promise<T> =>
        session.gpu ? gpuGuard().during(work) : work();

    return {
        modelId: EMBEDDING_GEMMA_MODEL_ID,
        dimensions,
        get backend(): 'gpu' | 'cpu' {
            return session.gpu ? 'gpu' : 'cpu';
        },
        async embedQuery(text: string): Promise<Float32Array> {
            const [vector] = await guarded(() => embed([queryPrompt(text)]));
            return vector;
        },
        async embedDocuments(documents: readonly EmbedDocument[]): Promise<Float32Array[]> {
            const out = await guarded(() =>
                embed(documents.map((doc) => documentPrompt(doc.subject, doc.body))),
            );
            // The embedder is called outside any transaction (the indexer writes after it returns).
            collectGarbage();
            return out;
        },
        async dispose(): Promise<void> {
            await closeSession(session);
        },
    };
}
