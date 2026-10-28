/**
 * @stamped/semantic — public API
 */

export type { EmbedDocument, Embedder } from './embedder.ts';
export { checkVector, normalize } from './embedder.ts';
export { documentText } from './prepare.ts';
export { documentPrompt, queryPrompt, truncateVector } from './prompts.ts';
export type { VectorDbOptions, VectorSearchHit } from './vector-db.ts';
export {
    openVectorDb,
    openVectorDbForSearch,
    putVector,
    putVectors,
    hasVector,
    countVectors,
    missingVectors,
    searchVectors,
    sqliteVectorSource,
    vectorDbMatches,
    VECTOR_SCHEMA_VERSION,
} from './vector-db.ts';
export type { VectorHit, VectorIndexOptions, VectorRow, VectorRowSource } from './vector-index.ts';
export { DEFAULT_LOAD_BATCH, VectorIndex } from './vector-index.ts';
export type { ResidentState, ResidentVectorsOptions } from './resident-vectors.ts';
export { ResidentVectors } from './resident-vectors.ts';
export { fuseRrf } from './rrf.ts';
export type {
    DocumentSource,
    Indexer,
    IndexerOptions,
    IndexerProgress,
    IndexerResult,
    IndexerState,
    SourceDocument,
    SourceEntry,
} from './indexer.ts';
export { createIndexer, DEFAULT_BATCH_SIZE, DEFAULT_PAGE_SIZE, DEFAULT_POLL_MS } from './indexer.ts';
export type { ProbeResult } from './probe.ts';
export {
    estimateTokens,
    probeEmbedder,
    PROBE_MAX_ARCHIVE_HOURS,
    PROBE_SAMPLE_SIZE,
    sampleForProbe,
} from './probe.ts';
export { onBattery, onBatteryMac } from './power.ts';
