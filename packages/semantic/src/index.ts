/**
 * @stamped/semantic — public API
 */

export type { Embedder } from './embedder.ts';
export { checkVector, normalize } from './embedder.ts';
export { documentText } from './prepare.ts';
export { documentPrompt, queryPrompt, truncateVector } from './prompts.ts';
export type { VectorDbOptions, VectorSearchHit } from './vector-db.ts';
export {
    openVectorDb,
    putVector,
    putVectors,
    hasVector,
    countVectors,
    missingVectors,
    searchVectors,
    VECTOR_SCHEMA_VERSION,
} from './vector-db.ts';
export { fuseRrf } from './rrf.ts';
