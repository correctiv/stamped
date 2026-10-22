/**
 * `@stamped/core` — the vocabulary and the rules, with nothing underneath them.
 *
 * No imports outside this package, by design: the verdicts are what Stamped claims in public, so
 * they must be testable without a verifier, a mail file, a database or a runtime that has
 * `gi://`. Everything that touches the world lives one layer up (`@stamped/verify`, the app).
 */

export {
    activeCatalogue,
    type Catalogue,
    fmt,
    localeCandidates,
    parseMoCatalogue,
    setCatalogue,
    TEXT_DOMAIN,
    _,
    _n,
    _p,
} from './i18n.ts';

export {
    CAVEAT_BY_UNSIGNED_HEADER,
    CAVEATS,
    type Caveat,
    type ExportArtefact,
    describeCaveat,
    describeUnverifiableReason,
    describeVerdict,
    type KeySource,
    type MessageFinding,
    type SignatureEvidence,
    type SignatureFinding,
    type UnverifiableReason,
    UNVERIFIABLE_REASONS,
    type Verdict,
    VERDICTS,
    verdictRank,
} from './verdict.ts';

export {
    type Explanation,
    explainMessage,
    explainSignature,
    REASON_CODES,
    type ReasonCode,
    type ReasonDetail,
} from './explain.ts';

export {
    caveatsFor,
    classifyMessage,
    classifySignature,
    hashAlgorithmOf,
    isConfirmed,
    keyCannotHaveSigned,
    WEAK_RSA_BITS,
} from './classify.ts';

export {
    decodeBase64,
    type KeyAlgorithm,
    type KeyMaterial,
    parseKeyMaterial,
    type ParsedKey,
    type RevokedKey,
    rsaModulusBits,
} from './keymaterial.ts';

export {
    type AddOutcome,
    KEY_ORIGINS,
    type KeyOrigin,
    type KeyPair,
    keySourceOf,
    KeyVault,
    missingPairs,
    type NewKey,
    type PairCount,
    pairName,
    parsePairList,
    type VaultEntry,
} from './keyvault.ts';

export {
    consentCovers,
    type ConsentText,
    describeConsent,
    type LookupChannel,
    type LookupConsent,
} from './keyconsent.ts';

export {
    ARCHIVE_ENDPOINT,
    type FetchLike,
    type FoundKey,
    LOOKUP_CONCURRENCY,
    lookupArchive,
    lookupDns,
    type LookupResult,
    mapPool,
    RETRY_ATTEMPTS,
    type RetryOptions,
    type TxtResolver,
} from './keylookup.ts';

export {
    type AutoFetchOptions,
    type AutoFetchSummary,
    describeAutoConsent,
    fetchKeys,
    type StoredKey,
} from './autokeys.ts';

export { type KeyRequest, requestTemplate } from './keytemplate.ts';

export {
    type KeyArgument,
    type KeyEntry,
    keyNameFor,
    KeyStore,
    looksLikeKeyRecord,
    looksLikePem,
    normaliseKeyName,
    parseKeyArgument,
    recordFromPem,
} from './keys.ts';
