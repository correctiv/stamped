// Opt-in integration test for the llama embedder, on BOTH runtimes.
//
// Runs only when STAMPED_EMBED_MODEL points at an EmbeddingGemma 2 GGUF; otherwise it exits 0
// without loading anything. It is not part of `gjsify test`, which has to stay a suite anyone can
// run from a fresh checkout — this one needs a 296 MiB model file on disk.
//
//   npm run -w stamped-cli test:embedder        # node, straight from source
//   npm run -w stamped-cli test:embedder:gjs    # gjs, through a bundle
//
// THE GJS RUN GOES THROUGH A BUNDLE because that is the only way GJS reaches the addon: the
// embedder's `@gjsify/napi` route needs the alias map and the prebuilt-bins specifiers the
// bundler resolves. Running this file unbundled under gjs would fail on the imports, not on the
// embedder, and would prove nothing about either.
//
// SYNTHETIC DATA ONLY.
import assert from 'node:assert/strict';

import { createLlamaEmbedder } from '@stamped/semantic/llama-embedder';

const modelPath = process.env.STAMPED_EMBED_MODEL;
if (!modelPath) {
    console.log('STAMPED_EMBED_MODEL not set — skipping the embedder integration test');
    process.exit(0);
}

const norm = (v: ArrayLike<number>): number => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i], 0);

// The default: whatever backend the machine offers. Which one is machine-specific, so it is
// printed, and asserted only when STAMPED_EXPECT_BACKEND (gpu | cpu) says what to expect. It runs
// BEFORE the forced-CPU blocks so that a GPU build and a CPU build are loaded one after the
// other in this process — the fallback path does exactly that.
const auto = await createLlamaEmbedder({ modelPath });
try {
    const started = Date.now();
    const [a, b] = await auto.embedDocuments([
        { subject: 'Invoice approved', body: 'The finance director signed off the invoice.' },
        { subject: 'Picnic', body: 'The office picnic is moved to Friday.' },
    ]);
    assert.ok(Array.from(a).every(Number.isFinite) && Array.from(b).every(Number.isFinite));
    assert.ok(Math.abs(norm(a) - 1) < 1e-4);
    console.log(`auto: backend=${auto.backend} (${Date.now() - started} ms for 2 documents, incl. warm-up)`);
    const expected = process.env.STAMPED_EXPECT_BACKEND;
    if (expected) assert.equal(auto.backend, expected);
} finally {
    await auto.dispose();
}

const embedder = await createLlamaEmbedder({ modelPath, gpu: false, threads: 4 });
try {
    // Forced CPU must not need a compiler: macOS on Apple silicon has only a Metal prebuilt, and
    // asking node-llama-cpp for a CPU build there compiled llama.cpp from source.
    assert.equal(embedder.backend, 'cpu');
    const query = await embedder.embedQuery('who approved the payment to the supplier');
    const [relevant, unrelated] = await embedder.embedDocuments([
        {
            subject: 'Invoice approved',
            body: 'The finance director signed off the invoice and released the transfer to the supplier.',
        },
        { subject: 'Picnic', body: 'The office picnic is moved to Friday because of the rain forecast.' },
    ]);
    for (const v of [query, relevant, unrelated]) {
        assert.equal(v.length, 768);
        assert.ok(Array.from(v).every(Number.isFinite));
        assert.ok(Math.abs(norm(v) - 1) < 1e-4);
    }
    const good = dot(query, relevant);
    const bad = dot(query, unrelated);
    console.log(
        `768d: norm=${norm(query).toFixed(6)} relevant=${good.toFixed(4)} unrelated=${bad.toFixed(4)}`,
    );
    assert.ok(good > bad, 'the relevant document must outscore the unrelated one');
    assert.equal(embedder.backend, 'cpu');
} finally {
    await embedder.dispose();
}

const small = await createLlamaEmbedder({ modelPath, gpu: false, threads: 4, dimensions: 256 });
try {
    const v = await small.embedQuery('budget approval');
    assert.equal(v.length, 256);
    assert.ok(Math.abs(norm(v) - 1) < 1e-4);
    console.log(`256d: length=${v.length} norm=${norm(v).toFixed(6)}`);
} finally {
    await small.dispose();
}
console.log('embedder integration test passed');
