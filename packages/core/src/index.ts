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
    describeCaveat,
    describeUnverifiableReason,
    describeVerdict,
    type KeySource,
    type MessageFinding,
    type SignatureEvidence,
    type SignatureFinding,
    type UnverifiableReason,
    type Verdict,
    VERDICTS,
    verdictRank,
} from './verdict.ts';

export {
    caveatsFor,
    classifyMessage,
    classifySignature,
    hashAlgorithmOf,
    isConfirmed,
    WEAK_RSA_BITS,
} from './classify.ts';

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
