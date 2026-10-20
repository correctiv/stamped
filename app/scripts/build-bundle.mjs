// Builds the stamped bundle: `node scripts/build-bundle.mjs <gjs|node>`.
//
// Not a plain `gjsify build` line because of the catalogues: `gjsify ship` reads
// `gjsify.ship.localeDir` and hard-fails on a directory that holds no .mo, so a release built
// from a tree that never compiled them would not get as far as a package. Compiling here means
// every build path goes through it, not just the one a release engineer remembers.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'gjs' && target !== 'node') {
    console.error('usage: build-bundle.mjs <gjs|node>');
    process.exit(2);
}

// The script itself skips (with a warning) when msgfmt is missing — a build without gettext
// installed runs in English, which is the source language.
const i18nScript = fileURLToPath(new URL('../../dev/i18n.sh', import.meta.url));
const catalogues = spawnSync(i18nScript, ['compile'], { stdio: 'inherit' });
if (catalogues.status !== 0) process.exit(catalogues.status ?? 1);

const result = spawnSync(
    'gjsify',
    ['build', 'src/index.ts', '--app', target, '--outfile', `dist/stamped.${target}.mjs`],
    { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
