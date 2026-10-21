# Semantic search: findings

The benchmark lives in [`spikes/semantic-search/`](../../spikes/semantic-search/) — `bench.mjs`,
a synthetic corpus, and the raw JSON per run in `results/`.

**Decision: EmbeddingGemma 2 (text-only, 270M, Q8_0 GGUF, Apache 2.0) through llama.cpp, as an
optional layer on top of FTS5 that indexes in the background.**

## The question

Can a journalist's MacBook — new or several years old — embed a leak of up to ~100k messages
locally, so a search finds the mail that answers a question even when it shares no word with it?
"Locally" is not negotiable: Stamped is offline by default, and an embedding API would receive the
leak itself.

## What was measured

Three models, all as GGUF through `node-llama-cpp` 3.22.2. Twelve queries (German, English, and
three across the language) each have one target mail that shares (almost) no word with it, hidden
among 28 mails. Throughput over 200 mail-shaped bodies of ~180 words; hours extrapolated at 256
tokens per mail.

Linux, Intel i9-10900K, AMD Radeon RX 6600 (Vulkan):

| Model | recall@1 / @3 | query p50 | CPU 10 threads: tok/s → 100k | CPU 2 threads | Vulkan: tok/s → 100k |
|---|---|---|---|---|---|
| EmbeddingGemma 2 | 0.75 / 0.92 | 21 ms | 912 → 7.8 h | 366 → 19.4 h | 9,126 → 0.8 h |
| granite-embedding-278m-multilingual | 0.75 / 0.83 | 9 ms | 1,757 → 4.0 h | – | 15,251 → 0.5 h |
| Qwen3-Embedding-0.6B | 0.67 / 0.92 | 82 ms | 391 → 18.2 h | – | 5,645 → 1.3 h |

- **No NaN or zero vector in any run**, CPU or Vulkan. EmbeddingGemma 2's model card warns that
  float16 silently yields NaN or degraded vectors; Metal has not been measured yet.
- **Truncating EmbeddingGemma 2 to 256 dimensions** keeps recall@1 at 0.75 but drops recall@3 to
  0.75. Not free — keep 768 until a larger corpus says otherwise.
- **Context size must be set explicitly.** Left to `auto`, node-llama-cpp sized Qwen3's context to
  32k and reserved 4.2 GB; with 512 it needs 690 MB. EmbeddingGemma 2 needs ~335 MB either way.
- **A 3-second calibration predicts the full run within ±5 % in most runs, but one was off by 32 %.**
  A single short probe is good enough to switch the feature on or off; the remaining-time estimate
  has to be re-measured while indexing.

## Why EmbeddingGemma 2 when granite tied

With twelve queries one hit is 8 %, so the quality columns cannot separate the two. The choice
rests on what the corpus cannot show: EmbeddingGemma 2 is built for on-device use, covers 100+
languages, takes 8K tokens per input, and supports Matryoshka truncation if the index ever has to
shrink. granite is twice as fast on the CPU; if older Intel Macs turn out too slow, it is the
fallback. The index records model id and dimension, so switching means a reindex, not a migration.

**EmbeddingGemma 1 was ruled out on its licence.** The Gemma Terms of Use require every
redistribution to pass the use restrictions on as an enforceable provision (§ 3.1) — an
additional restriction the AGPL forbids — and the Prohibited Use Policy bars processing sensitive
personal information without "all consents", which is what a leak is. EmbeddingGemma 2 is Apache
2.0: ship the licence text and NOTICE with the model.

## Quality check (v2)

EmbeddingGemma 2 only, CPU, 4 threads, context 512, no throughput numbers
(`results/linux-i9-10900k-quality-v2.json`). 80 queries (36 de→de, 28 en→en, 8 de→en, 8 en→de;
67 plain, 6 with a close hard distractor, 7 lexical) among 80 target mails and 157 distractors,
237 documents in all. Brackets are 95 % bootstrap intervals (2000 resamples, fixed seed).

| Variant | dims | recall@1 | recall@3 | recall@10 | MRR |
|---|---|---|---|---|---|
| prefixes, raw body | 768 | 0.500 | 0.700 [0.600, 0.800] | 0.850 | 0.634 [0.551, 0.719] |
| prefixes, raw body | 256 | 0.487 | 0.662 [0.563, 0.762] | 0.875 | 0.612 [0.531, 0.699] |
| no prefixes, raw body | 768 | 0.425 | 0.700 [0.600, 0.800] | 0.863 | 0.594 [0.513, 0.676] |
| no prefixes, raw body | 256 | 0.463 | 0.713 [0.613, 0.813] | 0.838 | 0.602 [0.518, 0.689] |
| prefixes, quotes/signature stripped | 768 | 0.475 | 0.700 [0.600, 0.800] | 0.863 | 0.619 [0.538, 0.703] |
| prefixes, quotes/signature stripped | 256 | 0.463 | 0.662 [0.563, 0.762] | 0.863 | 0.597 [0.516, 0.683] |
| no prefixes, stripped | 768 | 0.400 | 0.700 [0.600, 0.800] | 0.850 | 0.579 [0.500, 0.660] |
| no prefixes, stripped | 256 | 0.450 | 0.713 [0.625, 0.813] | 0.838 | 0.591 [0.507, 0.680] |

Per language (prefixes, raw, 768d): en→en recall@3 0.89, de→de 0.61, de→en 0.63 (n=8),
en→de 0.50 (n=8). Lexical queries: 1.00 on all measures; they say nothing about semantic quality.

- **768 vs 256 dimensions:** all intervals overlap, so the data shows no difference worth acting on.
- **Prefixes:** they raise recall@1 (0.50 vs 0.43) and MRR slightly at 768d, but the intervals overlap, so this is a hint, not a finding.
- **Stripping:** it did not help (MRR 0.619 vs 0.634); only five target mails carry quotes, so the test has little power here.
- **Overall:** the right mail is first in half the cases and in the top ten in about 85 %. German queries are clearly weaker than English ones, and the cross-language groups are too small (n=8) to be read.

## Open

- **Metal on Apple Silicon**: throughput and, above all, NaN. The app guards against it either
  way: every vector is checked, and a non-finite one switches the embedder to CPU.
- **An older Intel MacBook**: decides where the "too slow, off by default" threshold sits.
- **Loading `node-llama-cpp` under GJS** through `@gjsify/napi`. On macOS Stamped runs on Node, so
  this only matters for Linux.
- A larger query set (50–100) before reading anything into the quality columns.
