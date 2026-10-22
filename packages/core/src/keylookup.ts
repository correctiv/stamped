/**
 * The two network lookups for a missing key: archive.prove.email and the public DNS.
 *
 * Both take their transport as a parameter (`fetch`, a TXT resolver) so this stays pure and the
 * tests stay offline, and both refuse any pair the {@link LookupConsent} does not list.
 *
 * archive.prove.email's API (zkemail/archive.prove.email, `src/app/api/key/route.ts`, checked
 * against the live service): `GET /api/key?domain=<d>[&selector=<s>]` answers a JSON array of
 * `{domain, selector, firstSeenAt, lastSeenAt, value, id, observations[]}`. `value` is the TXT
 * record; the first/last-seen pair is when the archive's own DNS snapshots saw it. `domain`
 * matches subdomains too, so rows are filtered back to the exact pair. The records are unsigned
 * snapshots (no DNSSEC), hence the `archive` key source and the `archive-key` caveat.
 */

import { consentCovers, type LookupConsent } from './keyconsent.ts';
import { parseKeyMaterial, type ParsedKey } from './keymaterial.ts';
import { fmt, _ } from './i18n.ts';
import { normaliseKeyName, keyNameFor } from './keys.ts';
import type { KeyPair, KeyOrigin } from './keyvault.ts';

export const ARCHIVE_ENDPOINT = 'https://archive.prove.email/api/key';

export type FetchLike = (url: string) => Promise<{
    ok: boolean;
    status: number;
    /** Read for `Retry-After` on a 429; a transport that has none is treated as "no hint". */
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
}>;

/** Resolves a TXT name to its records, each record being its string parts (Node's shape). */
export type TxtResolver = (name: string) => Promise<string[][]>;

export interface FoundKey {
    readonly pair: KeyPair;
    readonly key: ParsedKey;
    readonly origin: KeyOrigin;
    readonly seenFrom?: string;
    readonly seenTo?: string;
}

export interface LookupResult {
    readonly found: FoundKey[];
    /** Pairs the source ANSWERED for with nothing usable, with a reason. Never an error. */
    readonly misses: { readonly pair: KeyPair; readonly reason: string }[];
    /**
     * Pairs the source could not be asked or did not answer (rate limit, 5xx, timeout, network).
     * They are unknown, not absent: a run must report them apart and offer a retry.
     */
    readonly errors: { readonly pair: KeyPair; readonly reason: string }[];
}

/** How many lookups run at once. Small on purpose: archive.prove.email is a volunteer service. */
export const LOOKUP_CONCURRENCY = 8;

/**
 * `fn` over `items` with at most `limit` in flight, results in the order of `items`.
 *
 * The order matters: the misses and finds are reported per pair, and a run that printed them in
 * completion order would differ from one run to the next. `onEach` is the opposite on purpose:
 * it fires in COMPLETION order, so a caller that saves work as it arrives can, while the merged
 * result stays pair-ordered.
 */
export async function mapPool<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
    onEach?: (result: R) => void,
): Promise<R[]> {
    const results: R[] = Array.from({ length: items.length });
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            const result = await fn(items[index] as T);
            results[index] = result;
            onEach?.(result);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

/** Merge per-pair results into one, in pair order. */
function merge(parts: readonly LookupResult[]): LookupResult {
    return {
        found: parts.flatMap((p) => p.found),
        misses: parts.flatMap((p) => p.misses),
        errors: parts.flatMap((p) => p.errors),
    };
}

function refuse(pair: KeyPair): Error {
    return new Error(
        fmt(_('No consent for looking up {name}.'), { name: keyNameFor(pair.domain, pair.selector) }),
    );
}

/** How the archive lookup waits and retries. Every field is overridable so tests run instantly. */
export interface RetryOptions {
    /** Tries per pair before it is reported as an error. */
    readonly attempts?: number;
    /** First backoff without a `Retry-After`; doubles per try. */
    readonly backoffMs?: number;
    /** Upper bound for any single wait, `Retry-After` included. */
    readonly maxWaitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

export const RETRY_ATTEMPTS = 5;

const realSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        globalThis.setTimeout(resolve, ms);
    });

/** `Retry-After` is delta-seconds or an HTTP date; anything else is no hint. */
function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
    if (value === null || value === undefined || value.trim() === '') return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** 429, 408 and 5xx are worth another try; any other non-OK status is final. */
function isTransient(status: number): boolean {
    return status === 429 || status === 408 || status >= 500;
}

/**
 * Archive lookups with at most `concurrency` in flight.
 *
 * A rate limit (HTTP 429, measured: archive.prove.email lets about ten requests through, then
 * answers 429 with `Retry-After: 58`) is NOT "no key". The pause is shared: when one request is
 * told to wait, every worker waits, instead of each one burning its tries against a closed door.
 * A pair that is still unanswered after its tries lands in `errors`, never in `misses`.
 */
export async function lookupArchive(
    consent: LookupConsent,
    pairs: readonly KeyPair[],
    fetchImpl: FetchLike,
    concurrency: number = LOOKUP_CONCURRENCY,
    retry: RetryOptions = {},
    onPairDone?: (one: LookupResult) => void,
): Promise<LookupResult> {
    // Every pair is checked against the consent BEFORE the first request goes out.
    for (const pair of pairs) {
        if (!consentCovers(consent, 'archive.prove.email', pair)) throw refuse(pair);
    }
    const gate = { until: 0 };
    return merge(
        await mapPool(
            pairs,
            concurrency,
            (pair) => lookupArchiveOne(pair, fetchImpl, retry, gate),
            onPairDone,
        ),
    );
}

async function lookupArchiveOne(
    pair: KeyPair,
    fetchImpl: FetchLike,
    retry: RetryOptions,
    gate: { until: number },
): Promise<LookupResult> {
    const { attempts = RETRY_ATTEMPTS, backoffMs = 2000, maxWaitMs = 120_000 } = retry;
    const sleep = retry.sleep ?? realSleep;
    const now = retry.now ?? Date.now;
    const result: LookupResult = { found: [], misses: [], errors: [] };
    const url = `${ARCHIVE_ENDPOINT}?domain=${encodeURIComponent(pair.domain)}&selector=${encodeURIComponent(pair.selector)}`;
    let rows: unknown;
    let failure = '';
    let answered = false;
    for (let attempt = 0; attempt < attempts && !answered; attempt++) {
        const wait = gate.until - now();
        if (wait > 0) await sleep(wait);
        let hint: number | undefined;
        try {
            const response = await fetchImpl(url);
            if (response.ok) {
                rows = await response.json();
                answered = true;
                break;
            }
            failure = fmt(_('archive.prove.email answered HTTP {status}.'), { status: response.status });
            if (!isTransient(response.status)) {
                // 404 and friends: the archive answered, and the answer is "no".
                result.misses.push({ pair, reason: failure });
                return result;
            }
            hint = retryAfterMs(response.headers?.get('retry-after'), now());
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        const delay = Math.min(hint ?? backoffMs * 2 ** attempt, maxWaitMs);
        gate.until = Math.max(gate.until, now() + delay);
    }
    if (!answered) {
        result.errors.push({ pair, reason: failure });
        return result;
    }
    let hits = 0;
    for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
        if (
            typeof row.value !== 'string' ||
            normaliseKeyName(String(row.domain)) !== normaliseKeyName(pair.domain) ||
            String(row.selector).toLowerCase() !== pair.selector.toLowerCase()
        ) {
            continue;
        }
        try {
            const key = parseKeyMaterial(row.value);
            if (key.kind !== 'key') continue;
            hits++;
            result.found.push({
                pair,
                key,
                origin: 'archive.prove.email',
                ...(typeof row.firstSeenAt === 'string' ? { seenFrom: row.firstSeenAt } : {}),
                ...(typeof row.lastSeenAt === 'string' ? { seenTo: row.lastSeenAt } : {}),
            });
        } catch {
            // an unparseable archive row is a miss for this pair, not a failure of the run
        }
    }
    if (hits === 0) result.misses.push({ pair, reason: _('The archive holds no key for it.') });
    return result;
}

export async function lookupDns(
    consent: LookupConsent,
    pairs: readonly KeyPair[],
    resolveTxt: TxtResolver,
    concurrency: number = LOOKUP_CONCURRENCY,
    onPairDone?: (one: LookupResult) => void,
): Promise<LookupResult> {
    for (const pair of pairs) {
        if (!consentCovers(consent, 'dns', pair)) throw refuse(pair);
    }
    return merge(await mapPool(pairs, concurrency, (pair) => lookupDnsOne(pair, resolveTxt), onPairDone));
}

async function lookupDnsOne(pair: KeyPair, resolveTxt: TxtResolver): Promise<LookupResult> {
    const result: LookupResult = { found: [], misses: [], errors: [] };
    try {
        const records = await resolveTxt(keyNameFor(pair.domain, pair.selector));
        const key = records
            .map((parts) => parts.join(''))
            .filter((text) => /(^|;)\s*p\s*=/i.test(text))
            .map((text) => parseKeyMaterial(text))[0];
        if (key?.kind === 'key') {
            result.found.push({ pair, key, origin: 'dns' });
        } else {
            result.misses.push({
                pair,
                reason: key ? _('The record is empty: the key was withdrawn.') : _('No key record found.'),
            });
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // "No such name" is an answer; a timeout or a failing resolver is not.
        (isNoRecord(error) ? result.misses : result.errors).push({ pair, reason });
    }
    return result;
}

function isNoRecord(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /NXDOMAIN|NODATA|ENOTFOUND|ENODATA|not known|no dns record|no such host/i.test(message);
}
