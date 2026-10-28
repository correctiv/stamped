/**
 * Where the embedding model is found — and where it is NOT.
 *
 * The model ships inside the AppImage and the macOS `.app`, and the app must find it there
 * without a path per operating system, without hashing 296 MiB on every start, and without
 * pretending that a file which is not there is.
 *
 * The files here are SPARSE: a file of the right SIZE is written, not a file of the right
 * content. The resolver checks the size and not the hash, and the test says so.
 */

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@gjsify/unit';

import {
    bundledDataDir,
    bundledDataDirs,
    developmentCacheDir,
    EMBEDDING_MODEL_BYTES,
    EMBEDDING_MODEL_ENV,
    EMBEDDING_MODEL_FILE,
    resolveEmbeddingModel,
} from '../../src/lib/model-path.ts';

/** A sparse file of the pinned size — the resolver's proof that a file is the real one. */
function modelFile(dir: string, name: string = EMBEDDING_MODEL_FILE): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    // The file has to EXIST before it can be truncated: `truncate` grows a file, it does not
    // create one, and the two runtimes disagree about what they do with a missing path.
    writeFileSync(path, '');
    truncateSync(path, EMBEDDING_MODEL_BYTES);
    return path;
}

/** A scratch directory that is removed again. */
function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'stamped-model-path-'));
}

export default async () => {
    await describe('resolveEmbeddingModel', async () => {
        await it('finds the model the artifact carries, in the app own data directory', async () => {
            const root = scratch();
            try {
                const dataDir = join(root, 'share');
                const expected = modelFile(join(dataDir, 'models'));
                const found = resolveEmbeddingModel({ env: {}, dataDir });
                expect(found?.path).toBe(expected);
                expect(found?.source).toBe('bundled');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('finds the model when the GTK runtime put its own share in front', async () => {
            // The macOS and Windows apps start with `<gtk>/share:<app>/share`: the first entry is
            // GTK's, the app's comes second, and only looking at the first found no model at all.
            const root = scratch();
            try {
                const gtk = join(root, 'gtk', 'share');
                const app = join(root, 'Resources', 'share');
                mkdirSync(gtk, { recursive: true });
                const expected = modelFile(join(app, 'models'));
                const found = resolveEmbeddingModel({
                    env: {},
                    dataDir: gtk,
                    dataDirs: bundledDataDirs({ XDG_DATA_DIRS: `${gtk}:${app}:/usr/share` }),
                });
                expect(found?.path).toBe(expected);
                expect(found?.source).toBe('bundled');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('finds the model in the AppImage mount point, without launcher exports', async () => {
            const root = scratch();
            try {
                const appDir = join(root, 'squashfs-root');
                const expected = modelFile(join(appDir, 'usr', 'share', 'models'));
                const found = resolveEmbeddingModel({ env: {}, appDir });
                expect(found?.path).toBe(expected);
                expect(found?.source).toBe('bundled');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('prefers the environment variable over the artifact and the cache', async () => {
            const root = scratch();
            try {
                const override = modelFile(join(root, 'elsewhere'), 'mine.gguf');
                modelFile(join(root, 'share', 'models'));
                modelFile(join(root, 'cache'));
                const found = resolveEmbeddingModel({
                    env: { [EMBEDDING_MODEL_ENV]: override },
                    dataDir: join(root, 'share'),
                    cacheDir: join(root, 'cache'),
                });
                expect(found?.path).toBe(override);
                expect(found?.source).toBe('env');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('prefers the artifact over the development cache', async () => {
            const root = scratch();
            try {
                const bundled = modelFile(join(root, 'share', 'models'));
                modelFile(join(root, 'cache'));
                const found = resolveEmbeddingModel({
                    env: {},
                    dataDir: join(root, 'share'),
                    cacheDir: join(root, 'cache'),
                });
                expect(found?.path).toBe(bundled);
                expect(found?.source).toBe('bundled');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('falls back to the development cache', async () => {
            const root = scratch();
            try {
                const cached = modelFile(join(root, 'cache'));
                const found = resolveEmbeddingModel({
                    env: {},
                    dataDir: join(root, 'share'),
                    cacheDir: join(root, 'cache'),
                });
                expect(found?.path).toBe(cached);
                expect(found?.source).toBe('cache');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('says there is no model when there is none', async () => {
            const root = scratch();
            try {
                const found = resolveEmbeddingModel({
                    env: {},
                    dataDir: join(root, 'share'),
                    cacheDir: join(root, 'cache'),
                });
                expect(found).toBeUndefined();
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('refuses a file that is not the whole model', async () => {
            const root = scratch();
            try {
                const half = join(root, 'share', 'models', EMBEDDING_MODEL_FILE);
                mkdirSync(join(root, 'share', 'models'), { recursive: true });
                writeFileSync(half, 'half a download');
                const found = resolveEmbeddingModel({ env: {}, dataDir: join(root, 'share') });
                expect(found).toBeUndefined();
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('refuses an environment variable that points at nothing', async () => {
            const root = scratch();
            try {
                const found = resolveEmbeddingModel({
                    env: { [EMBEDDING_MODEL_ENV]: join(root, 'not-there.gguf') },
                    dataDir: join(root, 'share'),
                });
                expect(found).toBeUndefined();
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    await describe('bundledDataDir', async () => {
        await it('takes the FIRST entry — the launcher puts the app own directory there', async () => {
            expect(bundledDataDir({ XDG_DATA_DIRS: '/opt/app/share:/usr/share' })).toBe('/opt/app/share');
        });

        await it('has none when nothing is exported', async () => {
            expect(bundledDataDir({})).toBeUndefined();
            expect(bundledDataDir({ XDG_DATA_DIRS: '' })).toBeUndefined();
        });
    });

    await describe('bundledDataDirs', async () => {
        await it('lists every entry in order and skips the empty ones', async () => {
            expect(bundledDataDirs({ XDG_DATA_DIRS: '/a: /b::/c' })).toStrictEqual(['/a', '/b', '/c']);
            expect(bundledDataDirs({})).toStrictEqual([]);
        });
    });

    await describe('developmentCacheDir', async () => {
        await it('follows XDG_CACHE_HOME', async () => {
            expect(developmentCacheDir({ XDG_CACHE_HOME: '/var/cache' }, '/home/someone')).toBe(
                join('/var/cache', 'stamped', 'models'),
            );
        });

        await it('falls back to the home directory', async () => {
            expect(developmentCacheDir({}, '/home/someone')).toBe(
                join('/home/someone', '.cache', 'stamped', 'models'),
            );
        });
    });
};
