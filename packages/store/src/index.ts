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
    beginImportStatus,
    cancelImportStatus,
    IMPORT_STATUS_NAME,
    IMPORT_STATUS_VERSION,
    type ImportStatus,
    type ImportStatusHandle,
    type ImportStatusOptions,
    type ImportState,
    orphanedImport,
    plannedImportBytes,
    readImportStatus,
    STATUS_STALE_SECONDS,
    statusFile,
    writeImportStatus,
} from './import-status.ts';
export {
    importSources,
    type ImportFailure,
    type ImportMode,
    type ImportOptions,
    type ImportProgress,
    type ImportResult,
} from './importer.ts';
export {
    addressesComplete,
    addressRows,
    backfillAddresses,
    backfillAll,
    ensureAddresses,
} from './addresses-db.ts';
export {
    bucketRange,
    DAY_UNIT_MAX_DAYS,
    type PeopleOptions,
    peopleList,
    type Person,
    personScope,
    type PersonName,
    periodScope,
    timeline,
    type Timeline,
    type TimelineBucket,
    type TimelineUnit,
} from './people.ts';
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
    queryScope,
    readMessage,
    removeMessage,
    rollbackBatch,
    SCHEMA_VERSION,
    type SearchHit,
    searchHits,
    searchMessages,
    type SearchOptions,
    type SignatureQuery,
    signatureHashes,
    verdictHashes,
} from './index-db.ts';
export { statementFor } from './statements.ts';
export {
    indexDocumentSource,
    type IndexDocumentSource,
    type IndexSourceDocument,
    type IndexSourceEntry,
} from './document-source.ts';
export {
    readSemanticSetting,
    type SemanticProbeRecord,
    type SemanticSetting,
    SEMANTIC_SETTING_NAME,
    SEMANTIC_SETTING_VERSION,
    semanticSettingFile,
    writeSemanticSetting,
} from './semantic-setting.ts';
export {
    readSemanticRunStatus,
    type SemanticPauseReason,
    type SemanticRunState,
    type SemanticRunStatus,
    SEMANTIC_STATUS_NAME,
    SEMANTIC_STATUS_STALE_SECONDS,
    SEMANTIC_STATUS_VERSION,
    semanticStatusFile,
    staleSemanticRun,
    writeSemanticRunStatus,
} from './semantic-status.ts';
export {
    appendLog,
    digest,
    eachLogEntry,
    type ImportLogEntry,
    type LogSource,
    logSources,
    mailboxHashes,
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
    type AlteredVerdict,
    type AlterationCount,
    type AlterationReason,
    type CaseReport,
    type CaseReportOptions,
    type CaveatCount,
    caseReport,
    caveatCounts,
    type ConfirmationShare,
    confirmationShare,
    firstVerdictCounts,
    type KeyDemand,
    type MailboxReport,
    mailboxReports,
    type MissingSelector,
    missingSelectors,
    keyDemand,
    type SigningDomain,
    signingDomains,
    alterationCounts,
    type UnverifiableReasonCount,
    unverifiableReasonCounts,
    type VerdictCount,
    verdictCounts,
} from './report.ts';
