/**
 * The key bundle: a case's keys as one file, so a verdict stays reproducible in another case or on
 * another machine once the DNS record or the archive it came from is gone.
 *
 * WHAT TRAVELS is the whole provenance of every key: its `origin`, when Stamped obtained it and
 * the window the archive saw it in. Dropping `origin` on the way would turn a key found inside a
 * leak (`archive-key`) into one nobody doubts, which is the one thing a bundle must never do.
 * What does NOT travel is anything about the case: no message, no count, no path. A bundle still
 * names the sender domains the case contains, and the commands say so.
 *
 * The importer trusts the file for provenance and for nothing else: algorithm and bit length are
 * read again from the record, never taken from the bundle's claim.
 *
 * Pure: text in, text or {@link NewKey} out. Reading and writing the file is the app's job.
 */

import { fmt, _ } from './i18n.ts';
import { parseKeyMaterial } from './keymaterial.ts';
import { KEY_ORIGINS, pairName, type KeyOrigin, type KeyVault, type NewKey } from './keyvault.ts';

/** The marker that tells a bundle from the case's own `keys.json`. */
export const KEY_BUNDLE_FORMAT = 'stamped-key-bundle';

/** The only layout this version reads and writes. */
export const KEY_BUNDLE_VERSION = 1;

/** The vault's entries as bundle text, in a stable order so two exports of one vault are equal. */
export function exportKeyBundle(vault: KeyVault): string {
    const entries = [...vault.all()].sort(
        (a, b) => pairName(a).localeCompare(pairName(b)) || a.fetchedAt.localeCompare(b.fetchedAt),
    );
    return `${JSON.stringify({ format: KEY_BUNDLE_FORMAT, version: KEY_BUNDLE_VERSION, entries }, null, 2)}\n`;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Read bundle text into keys ready for {@link KeyVault.add}. Throws on the first thing wrong,
 * before anything is added: a half-imported bundle would leave a case holding keys nobody can
 * account for. `file` is only for the messages.
 */
export function parseKeyBundle(source: string, file: string): NewKey[] {
    let data: unknown;
    try {
        data = JSON.parse(source);
    } catch {
        throw new Error(fmt(_('{file} is not valid JSON.'), { file }));
    }
    const bundle = data as { format?: unknown; version?: unknown; entries?: unknown } | null;
    if (bundle?.format !== KEY_BUNDLE_FORMAT) {
        throw new Error(fmt(_('{file} is not a Stamped key bundle.'), { file }));
    }
    if (bundle.version !== KEY_BUNDLE_VERSION) {
        throw new Error(
            fmt(_('{file} uses key bundle format {version}; this version of Stamped reads {supported}.'), {
                file,
                version: String(bundle.version),
                supported: String(KEY_BUNDLE_VERSION),
            }),
        );
    }
    if (!Array.isArray(bundle.entries)) {
        throw new Error(fmt(_('{file} is not a Stamped key bundle.'), { file }));
    }

    const keys: NewKey[] = [];
    for (const raw of bundle.entries as Record<string, unknown>[]) {
        const domain = text(raw?.domain);
        const selector = text(raw?.selector);
        const record = text(raw?.record);
        const fetchedAt = text(raw?.fetchedAt);
        const origin = raw?.origin as KeyOrigin;
        const name = `${String(selector)}._domainkey.${String(domain)}`;
        const malformed = () => new Error(fmt(_('{file} has a malformed entry for {name}.'), { file, name }));
        if (!domain || !selector || !record || !fetchedAt || !KEY_ORIGINS.includes(origin)) throw malformed();
        let key;
        try {
            key = parseKeyMaterial(record);
        } catch {
            throw malformed();
        }
        if (key.kind !== 'key') throw malformed();
        const seenFrom = text(raw.seenFrom);
        const seenTo = text(raw.seenTo);
        keys.push({
            domain,
            selector,
            key,
            origin,
            fetchedAt,
            ...(seenFrom !== undefined ? { seenFrom } : {}),
            ...(seenTo !== undefined ? { seenTo } : {}),
        });
    }
    return keys;
}
