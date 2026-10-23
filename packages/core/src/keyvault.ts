/**
 * The persistent key store: every public key Stamped has ever been given for a case, with where
 * it came from and when.
 *
 * ONE FILE PER CASE, not one per user. The list of (domain, selector) pairs is itself the case's
 * secret — a user-level store would accumulate every domain this journalist ever examined, across
 * every story, in one readable file on a laptop that can be lost or shared. A key is public data,
 * but WHICH keys somebody collected is not. The file lives in the case folder, which is the unit
 * that will be encrypted; re-fetching a key for a second case costs one consented lookup.
 *
 * A key is NEVER overwritten silently. A second, differing record for the same pair is kept next
 * to the first and flagged: it is either a legitimate key rotation or a forged key, and the
 * journalist needs to know which pairs have the question, not have it decided for them.
 *
 * Pure: the vault is data plus JSON. Reading and writing the file is the app's job.
 */

import { fmt, _ } from './i18n.ts';
import { keyFingerprint } from './keymaterial.ts';
import type { KeyAlgorithm, ParsedKey } from './keymaterial.ts';
import { KeyStore, keyNameFor, normaliseKeyName } from './keys.ts';
import type { KeySource } from './verdict.ts';

/**
 * Where a vault entry came from. Finer than {@link KeySource}, which is only what the verifier
 * needs: `operator` and `dns` map straight across, both archives map to `archive`.
 */
export type KeyOrigin =
    /** Typed, pasted or loaded from a file by the operator, e.g. a provider's answer. */
    | 'operator'
    /** A live DNS lookup, with the operator's consent. Not DNSSEC-validated by Stamped. */
    | 'dns'
    /** archive.prove.email: its own DNS snapshots, unsigned — a third party's word. */
    | 'archive.prove.email'
    /** Shipped with the leak itself. */
    | 'archive'
    /** Recovered mathematically from DKIM signatures of this sender. */
    | 'recovered';

export const KEY_ORIGINS: readonly KeyOrigin[] = [
    'operator',
    'dns',
    'archive.prove.email',
    'archive',
    'recovered',
];

/** A (domain, selector) pair a message was signed with. */
export interface KeyPair {
    readonly domain: string;
    readonly selector: string;
}

export interface VaultEntry extends KeyPair {
    /** Canonical TXT record, `v=DKIM1; k=…; p=…`. */
    readonly record: string;
    readonly algorithm: KeyAlgorithm;
    /** RSA modulus length; 256 for Ed25519. */
    readonly bits: number;
    readonly origin: KeyOrigin;
    /** ISO time Stamped obtained the record. */
    readonly fetchedAt: string;
    /** For archive keys: the time range the archive saw this exact record (ISO). */
    readonly seenFrom?: string;
    readonly seenTo?: string;
}

export interface NewKey extends KeyPair {
    readonly key: ParsedKey;
    readonly origin: KeyOrigin;
    readonly fetchedAt: string;
    readonly seenFrom?: string;
    readonly seenTo?: string;
}

export interface AddOutcome {
    /**
     * `added` — the pair was unknown. `unchanged` — the same record from the same origin was
     * already there (its seen range may have widened). `conflict` — the pair already holds a
     * DIFFERENT record; both are kept.
     */
    readonly status: 'added' | 'unchanged' | 'conflict';
    readonly entry: VaultEntry;
    /** For `conflict`: the records that were already there. */
    readonly others: readonly VaultEntry[];
}

/** Trust order when one name must map to one record: your own word beats a third party's. */
const PRECEDENCE: Record<KeyOrigin, number> = {
    operator: 3,
    dns: 2,
    'archive.prove.email': 1,
    archive: 0,
    recovered: 0,
};

/** The verifier's provenance for a vault origin — what the `archive-key` caveat reads. */
export function keySourceOf(origin: KeyOrigin): KeySource {
    if (origin === 'operator' || origin === 'dns') return origin;
    if (origin === 'recovered') return 'recovered';
    return 'archive';
}

export function pairName(pair: KeyPair): string {
    return keyNameFor(pair.domain, pair.selector);
}

function normalisePair(pair: KeyPair): KeyPair {
    return {
        domain: normaliseKeyName(pair.domain),
        selector: pair.selector.trim().toLowerCase(),
    };
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
    return a === undefined ? b : b === undefined ? a : a < b ? a : b;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
    return a === undefined ? b : b === undefined ? a : a > b ? a : b;
}

/**
 * Entries of one pair, grouped by decoded key fingerprint: every formatted variant of one key
 * lands in the same group. A record that fails to decode gets its own singleton group — two
 * unparseable records must never be read as "the same key" by both fingerprinting to nothing.
 */
function fingerprintGroups(entries: readonly VaultEntry[]): Map<string, VaultEntry[]> {
    const groups = new Map<string, VaultEntry[]>();
    let anonymous = 0;
    for (const e of entries) {
        const fingerprint = keyFingerprint(e.record) ?? `#unparseable-${anonymous++}`;
        (groups.get(fingerprint) ?? groups.set(fingerprint, []).get(fingerprint)!).push(e);
    }
    return groups;
}

/** The precedence-best entry of a fingerprint group, same ordering as {@link recordsFor}. */
function bestOf(group: readonly VaultEntry[]): VaultEntry {
    return [...group].sort(
        (a, b) => PRECEDENCE[b.origin] - PRECEDENCE[a.origin] || (a.fetchedAt < b.fetchedAt ? 1 : -1),
    )[0] as VaultEntry;
}

/** The union of a fingerprint group's `seenFrom`/`seenTo`: how wide the group's own era is known. */
function groupWindow(group: readonly VaultEntry[]): { from?: string; to?: string } {
    let from: string | undefined;
    let to: string | undefined;
    for (const e of group) {
        from = earlier(from, e.seenFrom);
        to = later(to, e.seenTo);
    }
    return { from, to };
}

function windowsOverlap(a: { from?: string; to?: string }, b: { from?: string; to?: string }): boolean {
    if (a.from === undefined || a.to === undefined || b.from === undefined || b.to === undefined) {
        return true;
    }
    return a.from <= b.to && b.from <= a.to;
}

/**
 * Can every group of a multi-key pair be told apart by era alone? Only when EVERY group's own
 * window is fully bounded (a record with no seen range at all is "always", which nothing can be
 * told apart from) and no two groups' windows overlap — a message falling in an overlap, or
 * carrying no time, could be either group's, and that is exactly the human question {@link
 * conflicts} must keep surfacing.
 */
function eraResolvable(groups: readonly (readonly VaultEntry[])[]): boolean {
    const windows = groups.map(groupWindow);
    if (windows.some((w) => w.from === undefined || w.to === undefined)) return false;
    for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
            if (
                windowsOverlap(
                    windows[i] as { from?: string; to?: string },
                    windows[j] as { from?: string; to?: string },
                )
            ) {
                return false;
            }
        }
    }
    return true;
}

export class KeyVault {
    private entries: VaultEntry[] = [];

    get size(): number {
        return this.entries.length;
    }

    all(): readonly VaultEntry[] {
        return this.entries;
    }

    /** Every record held for a pair, best origin first. */
    recordsFor(pair: KeyPair): VaultEntry[] {
        const name = pairName(pair);
        return this.entries
            .filter((e) => pairName(e) === name)
            .sort(
                (a, b) => PRECEDENCE[b.origin] - PRECEDENCE[a.origin] || (a.fetchedAt < b.fetchedAt ? 1 : -1),
            );
    }

    /** Add a key; never replaces a differing one. */
    add(input: NewKey): AddOutcome {
        const pair = normalisePair(input);
        const existing = this.recordsFor(pair);
        const same = existing.find((e) => e.record === input.key.record && e.origin === input.origin);
        if (same) {
            const widened: VaultEntry = {
                ...same,
                fetchedAt: later(same.fetchedAt, input.fetchedAt) ?? same.fetchedAt,
                ...rangeOf(earlier(same.seenFrom, input.seenFrom), later(same.seenTo, input.seenTo)),
            };
            this.entries[this.entries.indexOf(same)] = widened;
            return { status: 'unchanged', entry: widened, others: [] };
        }
        const entry: VaultEntry = {
            ...pair,
            record: input.key.record,
            algorithm: input.key.algorithm,
            bits: input.key.bits,
            origin: input.origin,
            fetchedAt: input.fetchedAt,
            ...rangeOf(input.seenFrom, input.seenTo),
        };
        this.entries.push(entry);
        const others = existing.filter((e) => e.record !== entry.record);
        return { status: others.length > 0 ? 'conflict' : 'added', entry, others };
    }

    /**
     * Pairs holding more than one distinct KEY (decoded material, not record text) whose eras
     * cannot tell them apart: rotation or forgery, both worth a human look. Two records that
     * decode to the same key are never a conflict, whatever their formatting. Two records that
     * decode to DIFFERENT keys are not a conflict either, exactly when every one of them carries
     * a fully bounded `seenFrom`/`seenTo` window and no two windows overlap — a message's own
     * time then picks the one record that could have signed it, with no human guess involved.
     * An unbounded window, or two windows that overlap, is the genuine case: a message falling in
     * the overlap (or with no time at all) could be either record's, and `toKeyStore` must not
     * pick for it. See the file header: this is the invariant the whole module exists to keep.
     */
    conflicts(): KeyPair[] {
        const byPair = new Map<string, VaultEntry[]>();
        const pairs = new Map<string, KeyPair>();
        for (const e of this.entries) {
            const name = pairName(e);
            pairs.set(name, { domain: e.domain, selector: e.selector });
            (byPair.get(name) ?? byPair.set(name, []).get(name)!).push(e);
        }
        const out: KeyPair[] = [];
        for (const [name, pair] of pairs) {
            const groups = [...fingerprintGroups(byPair.get(name) ?? []).values()];
            if (groups.length > 1 && !eraResolvable(groups)) out.push(pair);
        }
        return out;
    }

    /**
     * The store the verifier is fed.
     *
     * A pair with one key (whatever its formatting history) feeds one record, best origin and
     * newest first on a tie. A pair with several KEYS whose eras partition cleanly feeds every
     * one of them as an era candidate ({@link KeyStore.addEra}), so a lookup with a message time
     * picks the record whose window covers it — never a guess, see {@link conflicts}. A pair
     * still in {@link conflicts} PICKS one as before, unless `skipConflicts` leaves it out
     * entirely, so that a rotation-or-forgery question can never turn a verdict into a
     * confirmation.
     */
    toKeyStore(options: { skipConflicts?: boolean } = {}): KeyStore {
        const store = new KeyStore();
        const seen = new Set<string>();
        const conflicted = new Set(options.skipConflicts ? this.conflicts().map(pairName) : []);
        for (const e of this.entries) {
            const name = pairName(e);
            if (seen.has(name) || conflicted.has(name)) continue;
            seen.add(name);
            const entries = this.recordsFor(e);
            const groups = [...fingerprintGroups(entries).values()];
            if (groups.length > 1 && eraResolvable(groups)) {
                for (const group of groups) {
                    const best = bestOf(group);
                    const window = groupWindow(group);
                    store.addEra(name, best.record, keySourceOf(best.origin), {
                        since: best.seenFrom ?? best.fetchedAt,
                        ...(window.from !== undefined ? { seenFrom: window.from } : {}),
                        ...(window.to !== undefined ? { seenTo: window.to } : {}),
                    });
                }
                continue;
            }
            const best = entries[0] ?? e;
            store.add(name, best.record, keySourceOf(best.origin), best.seenFrom ?? best.fetchedAt);
        }
        return store;
    }

    /**
     * One representative entry per DISTINCT key held for a pair (the best-origin record of each
     * {@link fingerprintGroups} group) — what a human choosing among candidates (`stamped keys
     * resolve`) is shown, so two differently-formatted copies of the same key are offered as one
     * choice rather than two.
     */
    distinctKeys(pair: KeyPair): VaultEntry[] {
        return [...fingerprintGroups(this.recordsFor(pair)).values()].map(bestOf);
    }

    /**
     * The human decision {@link conflicts} surfaces: keep every candidate that is the SAME key
     * as `chosen` (same decoded material) for this pair, and discard every other one. Never
     * automatic — a caller picks `chosen` from {@link distinctKeys}, which is what `stamped keys
     * resolve` and its report line are for.
     */
    keepOnly(pair: KeyPair, chosen: VaultEntry): void {
        const name = pairName(pair);
        const fingerprint = keyFingerprint(chosen.record);
        this.entries = this.entries.filter((e) => {
            if (pairName(e) !== name) return true;
            return fingerprint !== undefined ? keyFingerprint(e.record) === fingerprint : e === chosen;
        });
    }

    toJson(): string {
        const sorted = [...this.entries].sort(
            (a, b) => pairName(a).localeCompare(pairName(b)) || a.fetchedAt.localeCompare(b.fetchedAt),
        );
        return `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`;
    }

    static fromJson(text: string): KeyVault {
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(_('The key store file is not valid JSON.'));
        }
        const list = (data as { version?: unknown; entries?: unknown } | null)?.entries;
        if ((data as { version?: unknown } | null)?.version !== 1 || !Array.isArray(list)) {
            throw new Error(_('The key store file has an unknown format.'));
        }
        const vault = new KeyVault();
        for (const raw of list as Record<string, unknown>[]) {
            const origin = raw.origin as KeyOrigin;
            if (
                typeof raw.domain !== 'string' ||
                typeof raw.selector !== 'string' ||
                typeof raw.record !== 'string' ||
                typeof raw.bits !== 'number' ||
                typeof raw.fetchedAt !== 'string' ||
                (raw.algorithm !== 'rsa' && raw.algorithm !== 'ed25519') ||
                !KEY_ORIGINS.includes(origin)
            ) {
                throw new Error(
                    fmt(_('The key store file has a malformed entry for {name}.'), {
                        name: String(raw.selector) + '._domainkey.' + String(raw.domain),
                    }),
                );
            }
            vault.entries.push({
                domain: raw.domain,
                selector: raw.selector,
                record: raw.record,
                algorithm: raw.algorithm,
                bits: raw.bits,
                origin,
                fetchedAt: raw.fetchedAt,
                ...rangeOf(asString(raw.seenFrom), asString(raw.seenTo)),
            });
        }
        return vault;
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function rangeOf(from: string | undefined, to: string | undefined): { seenFrom?: string; seenTo?: string } {
    return {
        ...(from !== undefined ? { seenFrom: from } : {}),
        ...(to !== undefined ? { seenTo: to } : {}),
    };
}

/** An input pair with the number of messages that need it, as `stamped report` will produce. */
export interface PairCount extends KeyPair {
    readonly mails?: number;
}

/** The pairs the vault holds no key for, most-needed first. */
export function missingPairs(pairs: readonly PairCount[], vault: KeyVault): PairCount[] {
    const seen = new Set<string>();
    const out: PairCount[] = [];
    for (const raw of pairs) {
        const pair = { ...normalisePair(raw), ...(raw.mails !== undefined ? { mails: raw.mails } : {}) };
        const name = pairName(pair);
        if (seen.has(name) || vault.recordsFor(pair).length > 0) continue;
        seen.add(name);
        out.push(pair);
    }
    return out.sort((a, b) => (b.mails ?? 0) - (a.mails ?? 0));
}

/**
 * Parse a pair list: one `domain<TAB>selector[<TAB>mail count]` per line, `#` comments. This is
 * the same two-column TSV archive.prove.email's own scrapers write.
 */
export function parsePairList(text: string): PairCount[] {
    const out: PairCount[] = [];
    for (const [i, line] of text.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const [domain, selector, count] = trimmed.split(/\t|\s{2,}|,/).map((c) => c.trim());
        if (!domain || !selector) {
            throw new Error(fmt(_('Pair list line {line}: expected domain and selector.'), { line: i + 1 }));
        }
        const mails = count !== undefined && /^\d+$/.test(count) ? Number(count) : undefined;
        out.push({ domain, selector, ...(mails !== undefined ? { mails } : {}) });
    }
    return out;
}
