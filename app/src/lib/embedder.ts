/**
 * The embedder the app searches with — the seam where the model arrives.
 *
 * WHY A FACTORY AND NOT AN EMBEDDER: the model runtime is a packaging question. The GGUF has to
 * be found inside the bundle on macOS, in a cache in a development checkout, and — under GJS —
 * behind a native addon that does not exist yet (issue #45, steps 4 and 5). None of that belongs
 * in the search: what the search needs is the `Embedder` interface of `@stamped/semantic` and
 * nothing more. So every layer above this file is written against that interface, and the tests
 * write against a fake — no model, no download, no GPU, and the same suite on gjs and node.
 *
 * WHY IT RETURNS NOTHING TODAY: this build ships no model, so the factory has none to offer.
 * That is not a failure mode but the normal one, and the whole design is built around it: a
 * search that cannot embed asks for a text search, and the text search is always there. A case
 * without a model is not a broken case.
 *
 * THE MODEL ID AND THE DIMENSION COUNT come with the embedder, and they are what the case's
 * vector table was built with — the two must agree, or the table is meaningless. They travel
 * together so that a caller cannot pick one and leave the other.
 */

import type { Embedder } from '@stamped/semantic';

/**
 * The embedder this build can search with, or `undefined` when it has none.
 *
 * ASYNC, because loading a model is: the real factory has to find the GGUF, read it and open
 * a context before the first query can be embedded. Callers await it; a build without a model
 * settles at once.
 */
export async function createEmbedder(): Promise<Embedder | undefined> {
    // No model ships with this build yet — issue #45 step 4 puts the GGUF into the bundle and
    // step 5 wires the runtime under GJS. Until then the search is a text search, which is the
    // behaviour a case without vectors has had all along.
    return undefined;
}
