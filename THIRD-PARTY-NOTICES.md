# Third-party notices

Stamped itself is AGPL-3.0-or-later (© CORRECTIV). The artifacts additionally **redistribute**
third-party material, and this file says what and under which licence. The same notice travels
inside the artifacts, next to the file it is about.

## EmbeddingGemma 2 — GGUF (Q8_0)

| | |
|---|---|
| What | `embeddinggemma-2-Q8_0.gguf` — the embedding model, quantized to Q8_0 (~296 MiB) |
| Model | [google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2) |
| Redistributed from | [ggml-org/embeddinggemma-2-GGUF](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) |
| Pinned revision | `58faf90940886df2d62be555c8765d00dac362c5` |
| sha256 | `2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135` |
| Licence | Apache License 2.0 — [text](app/models/embeddinggemma-2-LICENSE.txt), [notice](app/models/embeddinggemma-2-NOTICE.txt) |

Where it ships: the **AppImage** and the **macOS `.app`**, in `share/models/` — the app's own data
directory in every layout (`$APPDIR/usr/share` in the AppImage,
`Stamped.app/Contents/Resources/share` in the `.app`). The `.deb`, the `.rpm` and the Windows
artifacts carry no model.

The GGUF conversion is the work of the [llama.cpp](https://github.com/ggml-org/llama.cpp)
project.

## How the file gets there

The model is not in git. `app/scripts/fetch-model.mts` downloads the pinned revision, verifies the
sha256 above, and the release caches it under that hash — so a cache hit can only ever be the file
the pin names.
