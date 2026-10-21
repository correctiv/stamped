# Spike: semantic search over a mail archive, offline

Can Stamped answer a journalist's question — *"who approved the payment to the offshore company?"* —
in an archive of leaked mails that does not contain those words? FTS5 needs the words, so the answer is
an embedding model. This spike measures whether a small enough model runs **locally and offline** on a
laptop, and how good and how fast it is.

Three candidates, all small enough to ship:

| key | model | dimensions | notes |
|---|---|---|---|
| `embeddinggemma2` | [google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2) via `ggml-org/embeddinggemma-2-GGUF` | 768 (Matryoshka → 256) | multilingual, Q8_0 ≈ 295 MB |
| `granite278m` | [ibm-granite/granite-embedding-278m-multilingual](https://huggingface.co/ibm-granite/granite-embedding-278m-multilingual) via `bartowski/granite-embedding-278m-multilingual-GGUF` | 768 (no truncation) | 12 languages incl. German, Q8_0 ≈ 289 MB |
| `qwen3-0.6b` | [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 1024 (Matryoshka → 256) | 100+ languages, Q8_0 ≈ 610 MB |

The corpus is **synthetic** — invented mails and invented queries (`corpus.mjs`), no real leak, no real
mail. Half the queries are German, half English, three cross the language.

## Requirements

- Node.js 20 or newer (Stamped itself runs on Node 24 on macOS).
- ~1.3 GB of free disk for the model cache (the three Q8_0 models together).
- Between 0.7 GB and 4.3 GB of free RAM while a model is loaded — the spread comes from the embedding
  context size, see below. Only one model is ever loaded at a time.

## Run it

```bash
cd spikes/semantic-search
npm install
node bench.mjs --json result-<your-machine>.json
```

That runs all three models with llama.cpp's automatic backend and its default thread count.
On a Mac, llama.cpp picks Metal on Apple Silicon; on an Intel Mac it falls back to the CPU.

Useful flags:

| flag | meaning |
|---|---|
| `--model <key>` | run only this model; repeatable. Keys: `embeddinggemma2`, `granite278m`, `qwen3-0.6b` |
| `--cpu` | force the CPU backend (no GPU offload) |
| `--threads <n>` | evaluation threads — use `2` to measure a background-friendly budget |
| `--docs <n>` | how many mail-sized documents the throughput run embeds (default `200`) |
| `--context <n>` | embedding context size in tokens (default: llama.cpp's `auto`) |
| `--json <file>` | write the full result as JSON |

A run that keeps the machine usable:

```bash
node bench.mjs --cpu --threads 2 --model embeddinggemma2 --json result-mba-air-m2.json
```

### `--context` matters more than it looks

llama.cpp's default context size is `auto`: it takes as much of the machine's RAM as it thinks it can.
On the 63 GiB Linux workstation used for the first measurements that meant **4.2 GB** of KV cache for
Qwen3-0.6B (a 32 768-token context) — while the same model with `--context 512` (enough for a
256-token mail chunk) needs **688 MB**. The `auto` number is therefore a property of the machine, not
of the model, and it says little about a MacBook. Pass an explicit `--context` when the numbers are
about RAM.

## Network access

**One download, once.** The three models are fetched from Hugging Face on the first run and cached in
`~/.cache/stamped-spike/models` (never inside the repository). After that the benchmark is fully
offline — that is the point, because a journalist's archive never leaves the machine and neither may
the model that reads it.

If the machine has no internet at all, copy the cache directory from a machine that does:

```bash
rsync -a ~/.cache/stamped-spike/models/ other-machine:~/.cache/stamped-spike/models/
```

## What is measured

Per model:

- **backend, threads, model file size, load time** — the cost of opening the tool.
- **quality** — every mail and every distractor is embedded as a document, every query is embedded, and
  the expected mail is ranked by cosine similarity. Reported as recall@1 (is the right mail first),
  recall@3 (is it in the top three), MRR (mean reciprocal rank), and a per-language breakdown. Measured
  at full dimension **and** truncated to 256 dimensions (slice + re-normalise, the Matryoshka trick) —
  except for Granite, which is not trained for truncation.
- **sanity** — every vector finite and non-zero. EmbeddingGemma 2 is known to produce NaN in float16;
  a NaN is reported loudly, not averaged away.
- **query latency** — p50/p95 over the 12 queries, after two warm-up calls.
- **throughput** — how fast the archive can be indexed, in tokens/second, over 200 mail-sized documents.
  Also the rate of the **first three seconds alone** and the ratio to the full run: a 3-second
  calibration is only useful if it predicts the rest.
- **extrapolation** — hours to index 10 000 and 100 000 mails at 256 tokens each.
- **peak RSS** — the resident set size while the model was loaded, and `peakRssDeltaBytes`, the marginal
  cost of that model on top of an already warm process (the plain peak is cumulative when several
  models run in one process). `llamaMemoryBytes` breaks the footprint down into what llama.cpp put in
  RAM and what it put in VRAM, and `contextSize` says how large the KV cache actually was.

## Known caveats

- The corpus is 28 short mails and 12 queries. The quality numbers are a **smoke test** — enough to tell
  a working model from a broken one, not a retrieval benchmark. A model that scores recall@1 0.75 here
  may still fail on a real archive of 100 000 mails.
- The 3-second calibration runs **first**, on a cold model, and the full throughput run follows it. The
  ratio of the two is therefore the honest answer to "can I calibrate with three seconds?": a value far
  from 1.0 means the first seconds are not representative.
- `peakRssBytes` is the process peak and grows across models in the same process; use
  `peakRssDeltaBytes` for the footprint of a single model.

## What to send back

The `--json` file — that is where the numbers are. Put it next to this README with a name that says
which machine it came from, e.g. `result-macbook-air-m2-t4.json`, and send it in.

Measured results collected so far live in `results/`, one file per machine and configuration.

Please also report, in one line each:

- the machine (chip, RAM, macOS version) and whether you used `--cpu`,
- how long the whole run took,
- anything that failed or needed a workaround.

The JSON contains the host description, so the machine does not have to be repeated in prose — but the
`--cpu` flag and the free disk space before the run are worth a line, because they change what the
numbers mean.
