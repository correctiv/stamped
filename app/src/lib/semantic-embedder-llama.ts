/**
 * Registers the llama embedder with `semantic-embedder.ts`. Imported STATICALLY by the entry point
 * and by nothing else — see the note there on why this import must not be reachable from the window.
 * Evaluating it loads no model and no addon; that happens in `createLlamaEmbedder`.
 */

import { createLlamaEmbedder } from '@stamped/semantic/llama-embedder';

import { registerLlamaEmbedder } from './semantic-embedder.ts';

registerLlamaEmbedder(createLlamaEmbedder);
