/**
 * `@stamped/verify` — one raw message in, the facts about its DKIM signatures out.
 *
 * The boundary this package draws: it answers what IS (did the body hash match, how long is the
 * key, which headers does `h=` cover) and never what may be SAID about it. The verdicts are
 * `@stamped/core`'s, which is what keeps the rules testable without a verifier and the verifier
 * replaceable without touching a rule.
 *
 * Typical use, offline, with one operator-supplied key:
 *
 * ```ts
 * const keys = new KeyStore();
 * keys.add('sel._domainkey.example.com', record, 'operator');
 * const finding = classifyMessage(await verifyMessage(rawMessage, { keys }));
 * ```
 */

export { type EvidenceContext, evidenceFrom, type RawSignatureResult } from './evidence.ts';
export { type VerifiedSignature, verifyMessage, type VerifyOptions } from './mailauth.ts';
export { explainBodyByRetry, type RetryInput } from './retry.ts';
