/**
 * Where a case lives on disk, and what each part of it is for.
 *
 * ```
 * <case>/case.json          what this folder is, and which layout version
 * <case>/raw/ab/abcd….eml   the messages, byte for byte as they arrived
 * <case>/import-log.jsonl   one line per message read: where it came from
 * <case>/index.db           SQLite + FTS5, derived from the two above
 * <case>/vectors.db         the semantic layer's vectors, derived and expensive
 * ```
 *
 * THE ORDER OF THAT LIST IS THE TRUST ORDER. `raw/` is the evidence: content-addressed, never
 * rewritten, and the only thing a verdict is ever computed from. `import-log.jsonl` is the chain
 * of custody — which file, which byte offset, when. `index.db` is a CACHE and nothing else; it
 * can be deleted and rebuilt from the other two, which is exactly what makes it safe to change
 * the schema later without asking a journalist to re-import an archive they may no longer have.
 *
 * A case folder is NOT in the repo and must never be: `.gitignore` refuses `cases/` and `*.eml`
 * as a second line of defence, but the real guarantee is that nothing writes here except on an
 * explicit path the operator named.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fmt, _ } from '@stamped/core';

/** Bumped when the on-disk layout changes in a way an older build would misread. */
export const CASE_VERSION = 1;

/** The paths inside one case folder. */
export interface CasePaths {
    readonly root: string;
    readonly raw: string;
    readonly log: string;
    readonly database: string;
    readonly marker: string;
    /** The semantic layer's vector database. Absent until semantic search is switched on. */
    readonly vectors: string;
}

/** What `case.json` holds. Deliberately tiny: everything else is derivable. */
interface CaseMarker {
    readonly kind: 'stamped-case';
    readonly version: number;
    readonly created: string;
}

/** The layout for a case root, without touching the disk. */
export function casePaths(root: string): CasePaths {
    return {
        root,
        raw: join(root, 'raw'),
        log: join(root, 'import-log.jsonl'),
        database: join(root, 'index.db'),
        marker: join(root, 'case.json'),
        // The embeddings live in their OWN file, not in `index.db`: they cost hours to compute
        // and the index is a cache that can be rebuilt in minutes, so the two must be able to
        // come and go independently.
        vectors: join(root, 'vectors.db'),
    };
}

/**
 * Make sure `root` is a case folder, creating it when it is not there yet.
 *
 * Refuses a folder that holds a newer layout rather than writing into it: an older build that
 * silently ignored a field it did not know would produce an index disagreeing with the store,
 * and the disagreement would show up as messages missing from a search — the one failure a
 * journalist cannot distinguish from "it is not in the leak".
 */
export function openCase(root: string): CasePaths {
    const paths = casePaths(root);
    mkdirSync(paths.raw, { recursive: true });

    if (!existsSync(paths.marker)) {
        const marker: CaseMarker = {
            kind: 'stamped-case',
            version: CASE_VERSION,
            created: new Date().toISOString(),
        };
        writeFileSync(paths.marker, `${JSON.stringify(marker, undefined, 2)}\n`);
        return paths;
    }

    const version = markerVersion(paths.marker);
    if (version > CASE_VERSION) {
        throw new Error(
            fmt(_('The case folder {path} was written by a newer version of Stamped.'), {
                path: root,
            }),
        );
    }
    return paths;
}

/** The version in `case.json`, or 0 for a file that does not say — an old or hand-made folder. */
function markerVersion(path: string): number {
    try {
        const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<CaseMarker>;
        return typeof marker.version === 'number' ? marker.version : 0;
    } catch {
        return 0;
    }
}

/** Does this path hold a case folder? Used to tell a mistyped path from an unimported one. */
export function isCase(root: string): boolean {
    return existsSync(casePaths(root).marker);
}
