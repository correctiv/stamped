#!/usr/bin/env node
// WHY THIS FILE EXISTS. Stamped is a tool for journalists who received a leak: thousands to hundreds of
// thousands of mails, often in several languages, and the questions that matter ("who approved the payment
// to the offshore company?") often share almost no word with the mail that answers them. SQLite FTS5 finds
// words, so it finds nothing. A VECTOR SEARCH needs an embedding model — and a journalist's laptop is
// offline, so the model must be small, local and free. The only way to know whether that is realistic on a
// five-year-old MacBook is to MEASURE, on several machines, with the same corpus.
//
// WHAT THIS MEASURES, per model:
//   1. QUALITY — does the model rank the right mail first, when the query shares no words with it?
//   2. THROUGHPUT — how long does it take to embed an archive? (A 100k-mail leak is not a toy.)
//   3. MEMORY — how much RAM does the whole thing need while running?
// The corpus is synthetic (spikes/semantic-search/corpus.mjs) — invented mails, no real leak, ever.
//
// THE THREE MODELS are the candidates that fit "small enough for a laptop": EmbeddingGemma 2 (271M,
// 768 output dimensions, Matryoshka-truncatable), Granite Embedding 278M (multilingual, 768 dimensions,
// no truncation) and Qwen3 Embedding 0.6B (1024 dimensions, Matryoshka-truncatable, 100+ languages).
// Each has its OWN prompt format and its own truncation support, and getting either wrong silently
// destroys the quality numbers — so the formats live next to the model, not in the measurement code.
//
// ONLY THE NETWORK ACCESS is the one-time model download from Hugging Face, into ~/.cache/stamped-spike/models.
// Everything after that is offline. The models are NEVER written inside the repository: a checkout must stay
// clean, and a 300 MB file is not source code.
//
// USAGE: node bench.mjs [--model <key>]... [--cpu] [--threads <n>] [--docs <n>] [--context <n>] [--json <file>]
//   --model <key>  one of embeddinggemma2 | granite278m | qwen3-0.6b; repeatable; default: all three
//   --cpu          force the CPU backend (no GPU offload) — the default is llama.cpp's automatic choice
//   --threads <n>  evaluation threads; default: llama.cpp's own choice
//   --docs <n>     how many mail-sized documents the throughput run embeds; default: 200
//   --context <n>  embedding context size in tokens; default: llama.cpp's "auto", which GREW WITH THE RAM
//                  of the machine it runs on — on a 64 GB box that is gigabytes of KV cache for a model
//                  whose mails are 256 tokens long. Pass an explicit number to see the real footprint.
//   --quality-only skip query latency, throughput and extrapolation; run only the quality part (all prompt/strip variants)
//   --json <file>  write the full result as JSON — SEND THIS BACK, it carries the numbers

import { statSync } from 'node:fs';
import { homedir, cpus, totalmem, platform, arch } from 'node:os';
import { join } from 'node:path';

import { getLlama, resolveModelFile } from 'node-llama-cpp';

import { distractors, mails, pairs, throughputDocs } from './corpus.mjs';

/** Models are downloaded here, never into the repository. */
const MODEL_DIR = join(homedir(), '.cache', 'stamped-spike', 'models');

// Result files get sent around; the home directory would put the sender's login name in them.
const tilde = (path) => path.replace(homedir(), '~');

/**
 * The candidates, each with its OWN prompt format. The formats are not interchangeable: an embedding model
 * trained with "task: search result | query: …" sees a bare question as a different kind of text, and the
 * quality numbers collapse. `mrl256` says whether the model is Matryoshka-trained and may therefore be
 * truncated to 256 dimensions and re-normalised (which is how a 1024d model is made to fit a small index).
 */
const MODELS = {
    embeddinggemma2: {
        label: 'EmbeddingGemma 2 271M (Matryoshka-truncatable)',
        uri: 'hf:ggml-org/embeddinggemma-2-GGUF:Q8_0',
        query: (q) => `task: search result | query: ${q}`,
        doc: (m) => `title: ${m.subject} | text: ${m.body}`,
        mrl256: true,
    },
    granite278m: {
        label: 'Granite Embedding 278M multilingual (no truncation)',
        uri: 'hf:bartowski/granite-embedding-278m-multilingual-GGUF:Q8_0',
        query: (q) => q,
        doc: (m) => `${m.subject}\n${m.body}`,
        mrl256: false,
    },
    'qwen3-0.6b': {
        label: 'Qwen3 Embedding 0.6B (Matryoshka-truncatable)',
        uri: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0',
        query: (q) => `Instruct: Given a search query, retrieve the email that answers it\nQuery:${q}`,
        doc: (m) => `${m.subject}\n${m.body}`,
        mrl256: true,
    },
};

/** The haystack the needles hide in: the mails that answer the queries plus plausible noise. */
const CORPUS = [...mails, ...distractors];

/** Documents of this many tokens are the extrapolation basis — a typical mail is shorter, a long one longer. */
const EXTRAPOLATION_TOKENS_PER_MAIL = 256;

function parseArgs(argv) {
    const options = {
        models: [],
        cpu: false,
        threads: undefined,
        docs: 200,
        context: undefined,
        json: undefined,
        qualityOnly: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--model') {
            options.models.push(argv[++i]);
        } else if (arg === '--cpu') {
            options.cpu = true;
        } else if (arg === '--threads') {
            options.threads = Number.parseInt(argv[++i], 10);
        } else if (arg === '--docs') {
            options.docs = Number.parseInt(argv[++i], 10);
        } else if (arg === '--context') {
            options.context = Number.parseInt(argv[++i], 10);
        } else if (arg === '--quality-only') {
            options.qualityOnly = true;
        } else if (arg === '--json') {
            options.json = argv[++i];
        } else if (arg === '--help' || arg === '-h') {
            console.log(
                'usage: node bench.mjs [--model <key>]... [--cpu] [--threads <n>] [--docs <n>] [--context <n>] [--quality-only] [--json <file>]',
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (options.models.length === 0) {
        options.models = Object.keys(MODELS);
    }
    for (const key of options.models) {
        if (MODELS[key] == null) {
            throw new Error(`Unknown model "${key}". Known: ${Object.keys(MODELS).join(', ')}`);
        }
    }
    if (!Number.isInteger(options.docs) || options.docs < 1) {
        throw new Error(`--docs must be a positive integer`);
    }
    if (options.threads != null && (!Number.isInteger(options.threads) || options.threads < 1)) {
        throw new Error(`--threads must be a positive integer`);
    }
    if (options.context != null && (!Number.isInteger(options.context) || options.context < 1)) {
        throw new Error(`--context must be a positive integer`);
    }
    return options;
}

/** L2-normalises in place; a zero vector stays zero (and is flagged separately as a sanity failure). */
function normalize(vector) {
    let sum = 0;
    for (const value of vector) {
        sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (norm === 0) {
        return vector;
    }
    for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i] / norm;
    }
    return vector;
}

/** Slice to `dims` dimensions and re-normalise — the Matryoshka representation learning trick. */
function truncate(vector, dims) {
    return normalize(vector.slice(0, dims));
}

/** Cosine similarity of two already-normalised vectors. */
function cosine(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

/** Nearest-rank percentile over a small sample; the sample is 12 queries, so interpolation would lie. */
function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1];
}

/** Every vector must be finite and non-zero — EmbeddingGemma 2 is known to produce NaN in float16. */
function checkVector(vector) {
    let nonFinite = 0;
    let sum = 0;
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            nonFinite++;
            continue;
        }
        sum += value * value;
    }
    return { nonFinite, norm: Math.sqrt(sum) };
}

/** Deterministic PRNG (mulberry32): the bootstrap intervals must be the same on every run. */
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 20261021;

/** recall@k and MRR of a list of ranks (1-based; the right mail's position). */
function summarize(ranks) {
    const n = ranks.length;
    const share = (predicate) => ranks.filter(predicate).length / n;
    return {
        queries: n,
        recallAt1: share((rank) => rank <= 1),
        recallAt3: share((rank) => rank <= 3),
        recallAt10: share((rank) => rank <= 10),
        mrr: ranks.reduce((sum, rank) => sum + 1 / rank, 0) / n,
    };
}

/** 95 % percentile-bootstrap interval for recall@3 and MRR; resamples the queries, fixed seed. */
function bootstrap(ranks) {
    const random = seededRandom(BOOTSTRAP_SEED);
    const recall3 = [];
    const mrr = [];
    for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
        let hits = 0;
        let reciprocal = 0;
        for (let j = 0; j < ranks.length; j++) {
            const rank = ranks[Math.floor(random() * ranks.length)];
            if (rank <= 3) {
                hits++;
            }
            reciprocal += 1 / rank;
        }
        recall3.push(hits / ranks.length);
        mrr.push(reciprocal / ranks.length);
    }
    const interval = (values) => {
        const sorted = values.sort((a, b) => a - b);
        return [sorted[Math.floor(0.025 * sorted.length)], sorted[Math.ceil(0.975 * sorted.length) - 1]];
    };
    return {
        recallAt3: interval(recall3),
        mrr: interval(mrr),
        resamples: BOOTSTRAP_RESAMPLES,
        seed: BOOTSTRAP_SEED,
    };
}

/**
 * Ranks every query against every document and reports the quality numbers a journalist cares about:
 * is the right mail FIRST (recall@1), in the top three, in the top ten, and how good is the average
 * position (MRR). The per-language and per-tag breakdowns show where a model is weak (cross-language,
 * hard distractors) and the bootstrap interval says how much a number can be trusted at this sample size.
 */
function measureQuality(docVectors, queryVectors) {
    const ranks = [];
    for (let q = 0; q < pairs.length; q++) {
        const scores = docVectors.map((docVector) => cosine(queryVectors[q], docVector));
        const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
        ranks.push(order.findIndex((entry) => CORPUS[entry.index].id === pairs[q].expect) + 1);
    }

    const group = (key) => {
        const out = {};
        for (const value of new Set(pairs.map((pair) => pair[key]))) {
            const groupRanks = ranks.filter((_, q) => pairs[q][key] === value);
            out[value] = { ...summarize(groupRanks), ci95: bootstrap(groupRanks) };
        }
        return out;
    };

    return {
        ...summarize(ranks),
        ci95: bootstrap(ranks),
        ranks,
        perLang: group('lang'),
        perTag: group('tag'),
    };
}

/**
 * Drops what a reply drags along: the signature (from "-- " on), `>` quote lines, "On … wrote:" /
 * "Am … schrieb …:" lines and an Outlook-style original-message header block. Deliberately simple —
 * the point is to see whether stripping helps at all, not to ship a perfect quote parser.
 */
function stripReplyNoise(body) {
    const cut = body.split(/\n-- ?\n/)[0];
    return cut
        .split('\n')
        .filter(
            (line) =>
                !/^\s*>/.test(line) &&
                !/^\s*(Am .+ schrieb .+:|On .+ wrote:)\s*$/.test(line) &&
                !/^\s*-{3,}.*-{3,}\s*$/.test(line) &&
                !/^\s*(Von|Gesendet|An|Betreff|From|Sent|To|Subject):/.test(line),
        )
        .join('\n')
        .trim();
}

/**
 * The quality variants. `prefix` uses the model's documented prompt format, otherwise the bare text;
 * `strip` removes quotes and signatures from the body before embedding.
 */
const QUALITY_VARIANTS = [
    { name: 'prefix+raw', prefix: true, strip: false },
    { name: 'noprefix+raw', prefix: false, strip: false },
    { name: 'prefix+strip', prefix: true, strip: true },
    { name: 'noprefix+strip', prefix: false, strip: true },
];

/** Runs one model end to end: load, embed, rank, time. Never two models at once — the RAM budget is small. */
async function runModel(key, spec, context) {
    const { llama, threads, docs, contextSize } = context;
    const run = {
        model: key,
        label: spec.label,
        uri: spec.uri,
        threads: threads ?? null,
        contextSizeRequested: contextSize ?? 'auto',
        // llama.cpp reports `false` for "no GPU"; the benchmark talks about backends, so say "cpu".
        backend: llama.gpu === false ? 'cpu' : llama.gpu,
        gpuOffload: llama.gpu !== false,
        buildType: llama.buildType,
        llamaCppRelease: llama.llamaCppRelease,
        systemInfo: llama.systemInfo,
        cpuMathCores: llama.cpuMathCores,
        gpuDeviceNames: null,
        errors: [],
    };

    try {
        run.gpuDeviceNames = await llama.getGpuDeviceNames();
    } catch (err) {
        run.gpuDeviceNames = [`<unavailable: ${err.message}>`];
    }

    const rss = new PeakRss();
    rss.start();
    run.rssBeforeModelBytes = process.memoryUsage().rss;

    let model = null;
    let embeddingContext = null;

    try {
        const resolveStart = performance.now();
        const modelPath = await resolveModelFile(spec.uri, MODEL_DIR);
        run.resolveMs = performance.now() - resolveStart;
        run.modelPath = tilde(modelPath);
        run.modelFileBytes = statSync(modelPath).size;

        const loadStart = performance.now();
        model = await llama.loadModel({ modelPath });
        run.loadMs = performance.now() - loadStart;

        const contextStart = performance.now();
        embeddingContext = await model.createEmbeddingContext({
            ...(threads != null ? { threads } : {}),
            ...(contextSize != null ? { contextSize } : {}),
        });
        run.contextCreateMs = performance.now() - contextStart;
        run.contextSize = embeddingContext._llamaContext?.contextSize ?? null;
        run.trainContextSize = model.trainContextSize;
        const llamaMemory = await llama.getLlamaMemoryUsage();
        run.llamaMemoryBytes = { cpuRam: llamaMemory.cpuRam, gpuVram: llamaMemory.gpuVram };

        // ─── Quality ────────────────────────────────────────────────────────────────────────────────────
        // Every variant embeds the whole corpus again: the prompt prefix and the stripping both change the
        // text the model sees, so nothing can be shared between them.
        const sanity = { vectors: 0, nonFiniteValues: 0, zeroNormVectors: 0 };
        const embedAll = async (texts) => {
            const vectors = [];
            for (const text of texts) {
                const vector = [...(await embeddingContext.getEmbeddingFor(text)).vector];
                const check = checkVector(vector);
                sanity.vectors++;
                sanity.nonFiniteValues += check.nonFinite;
                if (check.norm === 0) {
                    sanity.zeroNormVectors++;
                }
                vectors.push(normalize(vector));
            }
            return vectors;
        };

        const variants = {};
        for (const variant of QUALITY_VARIANTS) {
            const docText = (mail) => {
                const shown = variant.strip ? { ...mail, body: stripReplyNoise(mail.body) } : mail;
                return variant.prefix ? spec.doc(shown) : `${shown.subject}\n${shown.body}`;
            };
            const queryText = (query) => (variant.prefix ? spec.query(query) : query);
            const docVectors = await embedAll(CORPUS.map(docText));
            const queryVectors = await embedAll(pairs.map((pair) => queryText(pair.query)));
            run.dimensions = docVectors[0]?.length ?? null;
            variants[variant.name] = { full: measureQuality(docVectors, queryVectors) };
            if (spec.mrl256 && run.dimensions > 256) {
                variants[variant.name].mrl256 = measureQuality(
                    docVectors.map((vector) => truncate(vector, 256)),
                    queryVectors.map((vector) => truncate(vector, 256)),
                );
            }
            console.log(`  variant ${variant.name} done`);
        }
        run.sanity = { ...sanity, nan: sanity.nonFiniteValues > 0 };
        // The documented format on the raw body stays the headline; the table below reads `full`/`mrl256`.
        run.quality = { ...variants['prefix+raw'], variants };

        if (!context.qualityOnly) {
            // ─── Query latency ───────────────────────────────────────────────────────────────────────────────
            // Two warm-up calls first: the first embedding of a process pays for buffer allocation and page
            // faults, and a journalist's FIRST SEARCH must not be ten times slower than the second.
            await embeddingContext.getEmbeddingFor(spec.query(pairs[0].query));
            await embeddingContext.getEmbeddingFor(spec.query(pairs[0].query));

            const latencies = [];
            for (const pair of pairs) {
                const start = performance.now();
                await embeddingContext.getEmbeddingFor(spec.query(pair.query));
                latencies.push(performance.now() - start);
            }
            run.queryLatencyMs = {
                p50: percentile(latencies, 50),
                p95: percentile(latencies, 95),
                min: Math.min(...latencies),
                max: Math.max(...latencies),
                mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
                all: latencies,
            };

            // ─── Throughput ──────────────────────────────────────────────────────────────────────────────────
            // The number that decides whether this is usable at all: how long does indexing an archive take?
            const throughputDocsList = throughputDocs(docs, 180);
            const tokenCounts = throughputDocsList.map((mail) => model.tokenize(spec.doc(mail)).length);

            // The 3-second calibration runs FIRST, on a cold model, because that is the situation the question
            // is about: an indexer that wants to know "how fast is this machine?" before committing to a full
            // run. It is the first three seconds of embedding, nothing else.
            const calibrationStart = performance.now();
            let calibrationTokens = 0;
            let calibrationDocs = 0;
            for (const mail of throughputDocsList) {
                const before = performance.now() - calibrationStart;
                await embeddingContext.getEmbeddingFor(spec.doc(mail));
                const after = performance.now() - calibrationStart;
                const tokenCount = tokenCounts[calibrationDocs];
                calibrationDocs++;
                if (after <= 3000) {
                    calibrationTokens += tokenCount;
                } else {
                    // The document that straddles the 3-second mark is interpolated, so the result is a RATE
                    // and not an artefact of where a document happened to end.
                    const share = after > before ? (3000 - before) / (after - before) : 1;
                    calibrationTokens += tokenCount * Math.max(0, Math.min(1, share));
                    break;
                }
            }
            const calibrationElapsedMs = performance.now() - calibrationStart;
            const calibrationWindowSeconds = Math.min(3, calibrationElapsedMs / 1000);
            const calibrationTokensPerSecond = calibrationTokens / calibrationWindowSeconds;

            let totalTokens = 0;
            const throughputStart = performance.now();
            for (const mail of throughputDocsList) {
                await embeddingContext.getEmbeddingFor(spec.doc(mail));
                totalTokens += model.tokenize(spec.doc(mail)).length;
            }
            const throughputSeconds = (performance.now() - throughputStart) / 1000;
            const tokensPerSecond = totalTokens / throughputSeconds;

            run.throughput = {
                docs,
                targetWords: 180,
                totalTokens,
                totalSeconds: throughputSeconds,
                tokensPerSecond,
                calibration: {
                    windowSeconds: calibrationWindowSeconds,
                    elapsedMs: calibrationElapsedMs,
                    docs: calibrationDocs,
                    tokens: calibrationTokens,
                    tokensPerSecond: calibrationTokensPerSecond,
                },
                first3sTokensPerSecond: calibrationTokensPerSecond,
                ratio3s: calibrationTokensPerSecond / tokensPerSecond,
                avgTokensPerDoc: totalTokens / docs,
                docsPerSecond: docs / throughputSeconds,
            };

            // ─── Extrapolation ───────────────────────────────────────────────────────────────────────────────
            const hoursFor = (count) => (count * EXTRAPOLATION_TOKENS_PER_MAIL) / tokensPerSecond / 3600;
            run.extrapolation = {
                tokensPerMail: EXTRAPOLATION_TOKENS_PER_MAIL,
                hoursFor10k: hoursFor(10_000),
                hoursFor100k: hoursFor(100_000),
            };
        }
    } catch (err) {
        run.errors.push({ stage: 'run', message: err.message, stack: err.stack });
        console.error(`\n!! ${key} failed: ${err.message}`);
    } finally {
        if (embeddingContext != null) {
            await embeddingContext.dispose();
        }
        if (model != null) {
            await model.dispose();
        }
        rss.stop();
    }

    run.peakRssBytes = rss.peak;
    // The peak of a multi-model run is CUMULATIVE: the allocator keeps the pages of the model that was
    // loaded before. The delta is what THIS model costs on top of an already warm process.
    run.peakRssDeltaBytes = rss.peak - run.rssBeforeModelBytes;
    return run;
}

/** Samples the resident set size while the model runs — the number that decides whether a laptop survives. */
class PeakRss {
    constructor() {
        this.peak = 0;
        this.timer = null;
    }

    start() {
        this.sample();
        this.timer = setInterval(() => this.sample(), 200);
        this.timer.unref?.();
    }

    sample() {
        const rss = process.memoryUsage().rss;
        if (rss > this.peak) {
            this.peak = rss;
        }
    }

    stop() {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.sample();
    }
}

function formatNumber(value, digits = 2) {
    if (value == null || !Number.isFinite(value)) {
        return 'n/a';
    }
    return value.toFixed(digits);
}

function printTable(runs) {
    const header = [
        'model',
        'backend',
        'thr',
        'ctx',
        'load s',
        'R@1',
        'R@3',
        'MRR',
        'R@1@256',
        'R@3@256',
        'NaN',
        'q p50 ms',
        'tok/s',
        '3s ratio',
        'h/100k',
        'peakRSS',
        'ΔRSS',
    ];
    const rows = runs.map((run) => {
        const full = run.quality?.full;
        const mrl = run.quality?.mrl256;
        return [
            run.model,
            run.backend,
            run.threads ?? 'auto',
            run.contextSize ?? 'auto',
            formatNumber((run.loadMs ?? 0) / 1000, 2),
            formatNumber(full?.recallAt1, 3),
            formatNumber(full?.recallAt3, 3),
            formatNumber(full?.mrr, 3),
            mrl ? formatNumber(mrl.recallAt1, 3) : '—',
            mrl ? formatNumber(mrl.recallAt3, 3) : '—',
            run.sanity?.nan ? 'YES' : 'no',
            formatNumber(run.queryLatencyMs?.p50, 1),
            formatNumber(run.throughput?.tokensPerSecond, 1),
            formatNumber(run.throughput?.ratio3s, 3),
            formatNumber(run.extrapolation?.hoursFor100k, 2),
            formatNumber((run.peakRssBytes ?? 0) / 1024 / 1024, 0),
            formatNumber((run.peakRssDeltaBytes ?? 0) / 1024 / 1024, 0),
        ];
    });
    const widths = header.map((title, column) =>
        Math.max(title.length, ...rows.map((row) => String(row[column]).length)),
    );
    const line = (cells) => cells.map((cell, column) => String(cell).padEnd(widths[column])).join('  ');
    console.log(`\n${line(header)}\n${widths.map((width) => '-'.repeat(width)).join('  ')}`);
    for (const row of rows) {
        console.log(line(row));
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    console.log(
        `node-llama-cpp: preparing ${options.models.join(', ')} (${options.cpu ? 'CPU only' : 'auto backend'})`,
    );
    const llama = await getLlama(options.cpu ? { gpu: false } : undefined);
    console.log(
        `backend: ${llama.gpu === false ? 'cpu' : llama.gpu} | build: ${llama.buildType} | llama.cpp: ${llama.llamaCppRelease.release}`,
    );

    const runs = [];
    for (const key of options.models) {
        console.log(`\n=== ${key} ===`);
        const run = await runModel(key, MODELS[key], {
            llama,
            threads: options.threads,
            docs: options.docs,
            contextSize: options.context,
            qualityOnly: options.qualityOnly,
        });
        runs.push(run);
        console.log(
            `backend ${run.backend} | load ${formatNumber((run.loadMs ?? 0) / 1000, 2)}s | dims ${run.dimensions ?? 'n/a'} | context ${run.contextSize ?? 'n/a'}`,
        );
        if (run.quality?.full) {
            console.log(
                `recall@1 ${formatNumber(run.quality.full.recallAt1, 3)} | recall@3 ${formatNumber(run.quality.full.recallAt3, 3)} | MRR ${formatNumber(run.quality.full.mrr, 3)}`,
            );
        }
    }

    printTable(runs);

    const result = {
        schema: 'stamped-semantic-search-spike/1',
        createdAt: new Date().toISOString(),
        host: {
            platform: platform(),
            arch: arch(),
            node: process.version,
            cpuModel: cpus()[0]?.model ?? null,
            cpuCount: cpus().length,
            totalMemBytes: totalmem(),
        },
        options: {
            models: options.models,
            cpu: options.cpu,
            threads: options.threads ?? null,
            docs: options.docs,
            context: options.context ?? 'auto',
            qualityOnly: options.qualityOnly,
        },
        modelDirectory: tilde(MODEL_DIR),
        runs,
    };

    if (options.json) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
        console.log(`\nwrote ${options.json}`);
    }
}

await main();
