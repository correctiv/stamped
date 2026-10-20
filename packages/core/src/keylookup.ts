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
    /** Pairs for which nothing usable came back, with a reason. */
    readonly misses: { readonly pair: KeyPair; readonly reason: string }[];
}

function refuse(pair: KeyPair): Error {
    return new Error(
        fmt(_('No consent for looking up {name}.'), { name: keyNameFor(pair.domain, pair.selector) }),
    );
}

export async function lookupArchive(
    consent: LookupConsent,
    pairs: readonly KeyPair[],
    fetchImpl: FetchLike,
): Promise<LookupResult> {
    const result: LookupResult = { found: [], misses: [] };
    for (const pair of pairs) {
        if (!consentCovers(consent, 'archive.prove.email', pair)) throw refuse(pair);
        const url = `${ARCHIVE_ENDPOINT}?domain=${encodeURIComponent(pair.domain)}&selector=${encodeURIComponent(pair.selector)}`;
        let rows: unknown;
        try {
            const response = await fetchImpl(url);
            if (!response.ok) {
                result.misses.push({
                    pair,
                    reason: fmt(_('archive.prove.email answered HTTP {status}.'), {
                        status: response.status,
                    }),
                });
                continue;
            }
            rows = await response.json();
        } catch (error) {
            result.misses.push({
                pair,
                reason: error instanceof Error ? error.message : String(error),
            });
            continue;
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
    }
    return result;
}

export async function lookupDns(
    consent: LookupConsent,
    pairs: readonly KeyPair[],
    resolveTxt: TxtResolver,
): Promise<LookupResult> {
    const result: LookupResult = { found: [], misses: [] };
    for (const pair of pairs) {
        if (!consentCovers(consent, 'dns', pair)) throw refuse(pair);
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
            result.misses.push({
                pair,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}
