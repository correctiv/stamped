/**
 * `@stamped/store` — the case folder, and everything that may be said about it.
 *
 * The layering, from the bottom: `case.ts` knows where things go, `raw.ts` owns the evidence and
 * the chain of custody, `index-db.ts` keeps a rebuildable cache of what the evidence says, and
 * `report.ts` aggregates that cache. `importer.ts` is the only module that drives all of them,
 * and the only one that needs a verifier.
 *
 * TRUST ORDER, repeated here because every consumer has to know it: `raw/` is the truth,
 * `import-log.jsonl` is the provenance, `index.db` is a cache. Nothing outside this package may
 * read a verdict out of the index and call it a verification — the index holds what a
 * verification concluded, at the time it ran, against the keys that were then available.
 */

export { casePaths, type CasePaths, CASE_VERSION, isCase, openCase } from './case.ts';
export {
    importSources,
    type ImportFailure,
    type ImportMode,
    type ImportOptions,
    type ImportProgress,
    type ImportResult,
} from './importer.ts';
export {
    type IndexedMessage,
    type IndexEntry,
    beginBatch,
    type BrowseOptions,
    browseMessages,
    commitBatch,
    type CountOptions,
    countMessages,
    type HashScope,
    hashScope,
    indexedHashes,
    indexMessage,
    isIndexed,
    type ListOptions,
    listMessages,
    messageCount,
    openIndex,
    readMessage,
    removeMessage,
    rollbackBatch,
    SCHEMA_VERSION,
    type SearchHit,
    searchHits,
    searchMessages,
    type SearchOptions,
} from './index-db.ts';
export {
    appendLog,
    digest,
    eachLogEntry,
    type ImportLogEntry,
    type LogSource,
    logSources,
    rawPath,
    readRaw,
    sourceHashes,
    store,
    type StoreResult,
} from './raw.ts';
export {
    missingKeyPairs,
    reverifyPairs,
    type ReverifyResult,
    unappliedKeyPairs,
    type VerdictChange,
} from './reverify.ts';
export {
    type CaseReport,
    type CaveatCount,
    caseReport,
    caveatCounts,
    type KeyDemand,
    keyDemand,
    type VerdictCount,
    verdictCounts,
} from './report.ts';
