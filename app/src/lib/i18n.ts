/**
 * Where the catalogues are and which one this run speaks.
 *
 * The split is deliberate: `@stamped/core`'s `i18n.ts` owns the gettext RUNTIME and imports
 * nothing, because every package may reach for it and none of them may touch a filesystem. This
 * module is the host half — it finds the `.mo`, reads the bytes, and hands them over.
 *
 * Call {@link initI18n} once, before the first translatable string is produced: a message already
 * formatted keeps the language it was built in. That is why it is the first statement of
 * `src/index.ts`, ahead of yargs — every `describe` string is evaluated while the parser is built.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localeCandidates, parseMoCatalogue, setCatalogue, TEXT_DOMAIN } from '@stamped/core';

/**
 * Load the catalogue matching the environment's locale and install it.
 *
 * Returns the `.mo` path that was loaded, or `undefined` for English — which is every case where
 * nothing matched: a `C`/unset locale, a language we do not ship, or an installation without
 * compiled catalogues. None of those is an error: a missing catalogue resolves every lookup to
 * its English msgid, so the output stays correct rather than going blank.
 */
export function initI18n(env: Record<string, string | undefined> = process.env): string | undefined {
    const dirs = localeDirs(env);
    for (const language of localeCandidates(env)) {
        for (const dir of dirs) {
            const path = join(dir, language, 'LC_MESSAGES', `${TEXT_DOMAIN}.mo`);
            const catalogue = tryLoad(path);
            if (catalogue) {
                setCatalogue(catalogue);
                return path;
            }
        }
    }
    setCatalogue(undefined);
    return undefined;
}

/**
 * The directories to search, most specific first.
 *
 * `GJSIFY_LOCALE_DIR` is what the `gjsify ship` launcher exports, so a packaged install points at
 * its own prefix. The bundle-relative `./locale` is the one that is easy to forget: `gjsify run
 * dist/stamped.gjs.mjs` sets no environment at all, so without it a developer on a German desktop
 * sees English while the shipped package is correct — the kind of mismatch that gets diagnosed as
 * "translations do not work" long after the catalogue was fine. `/usr/share/locale` last, for a
 * distro package that installed the catalogues the ordinary way.
 */
function localeDirs(env: Record<string, string | undefined>): string[] {
    const dirs: string[] = [];
    const shipped = env.GJSIFY_LOCALE_DIR?.trim();
    if (shipped) dirs.push(shipped);

    const fileUrl = import.meta.url;
    if (fileUrl.startsWith('file:')) {
        // bundled: <app>/dist/stamped.<runtime>.mjs → <app>/dist/locale
        dirs.push(join(dirname(fileURLToPath(fileUrl)), 'locale'));
    }

    dirs.push('/usr/share/locale');
    return dirs;
}

/**
 * Read and parse one `.mo`, or `undefined` when it is not there.
 *
 * A missing file is the normal case — most of these paths do not exist on any given machine — so
 * it must not throw. A file that IS there but unreadable as a catalogue is swallowed too: a broken
 * install should degrade to English, not take the whole CLI down on a cosmetic concern.
 */
function tryLoad(path: string) {
    try {
        return parseMoCatalogue(new Uint8Array(readFileSync(path)));
    } catch {
        return undefined;
    }
}
