// Opt-in integration test for the llama embedder, Node only.
//
// Runs only when STAMPED_EMBED_MODEL points at an EmbeddingGemma 2 GGUF; otherwise it exits 0
// without loading anything. It is NOT part of `gjsify test`: that bundles for GJS too, and
// node-llama-cpp neither bundles nor loads there (gjsify/gjsify#2331).
//
//   STAMPED_EMBED_MODEL=/path/model.gguf node --experimental-strip-types tests/embedder.integration.mts
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

const embedder = await createLlamaEmbedder({ modelPath, gpu: false, threads: 4 });
try {
    const query = await embedder.embedQuery('who approved the payment to the supplier');
    const [relevant, unrelated] = await embedder.embedDocuments([
        'The finance director signed off the invoice and released the transfer to the supplier.',
        'The office picnic is moved to Friday because of the rain forecast.',
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
