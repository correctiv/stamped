/**
 * The embedder the `search` command uses — a thin seam over `semantic-embedder.ts`, kept so the
 * command is written against the `Embedder` interface of `@stamped/semantic` and nothing more.
 *
 * A search that cannot embed asks for a text search, and the text search is always there: a case
 * without a model is not a broken case. THE MODEL ID AND THE DIMENSION COUNT come with the
 * embedder, and they are what the case's vector table was built with — the two must agree, or the
 * table is meaningless.
 */

import type { Embedder } from '@stamped/semantic';

import { createGuiEmbedder } from './semantic-embedder.ts';

/**
 * The embedder this build can search with, or `undefined` when it has none.
 *
 * The same one the window indexes and searches with, so a vector the indexer wrote is compared
 * with a query embedded by the same model. ASYNC, because loading a model is; a runtime without
 * a model or without the addon settles at once with `undefined`, and the search stays a text search.
 */
export async function createEmbedder(): Promise<Embedder | undefined> {
    return createGuiEmbedder();
}
