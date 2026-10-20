/**
 * The TXT resolver for `keys fetch --dns`, over `node:dns` (Gio.Resolver on GJS).
 *
 * gjsify's `node:dns/promises` has no `resolveTxt`, but `resolve(name, 'TXT')` works on both
 * runtimes. The shapes differ: Node answers `string[][]`, GJS hands back each record as the
 * unpacked `(as)` variant, i.e. `[[parts]]` — one level deeper. Both are normalised to parts.
 */

import { resolve } from 'node:dns/promises';

export async function resolveTxt(name: string): Promise<string[][]> {
    const records = (await resolve(name, 'TXT')) as unknown[];
    return records.map((record) => {
        const list = Array.isArray(record) ? record : [record];
        const inner = list.length === 1 && Array.isArray(list[0]) ? list[0] : list;
        return (inner as unknown[]).map(String);
    });
}
