/**
 * Where the embedding model is — and why the answer is a lookup and not a constant.
 *
 * THE MODEL SHIPS WITH THE APP. The AppImage and the macOS `.app` carry
 * `share/models/embeddinggemma-2-Q8_0.gguf` beside the rest of the app's data, so semantic search
 * works offline from the first start (issue #45, step 4). The file is ~296 MiB, so it is NOT in
 * git: `app/scripts/fetch-model.mts` downloads it at a PINNED revision and checks its sha256.
 *
 * ONE EXPRESSION FOR BOTH ARTIFACTS. The launcher `gjsify ship` writes exports `XDG_DATA_DIRS`,
 * with the app's OWN data directory FIRST, and `share/` lands in that directory in every layout:
 * `$APPDIR/usr/share` in the AppImage, `Stamped.app/Contents/Resources/share` in the `.app`. So
 * the bundled model is at `<first XDG_DATA_DIRS entry>/models/embeddinggemma-2-Q8_0.gguf` — one
 * path, one expression, no operating-system branch in the app.
 *
 * THE ORDER IS A DECISION. An explicit environment variable comes first (the operator's own model
 * wins over anything this app shipped), then what the artifact carries, then the development
 * cache. Nothing here downloads anything: an app that cannot find a model says so, and the
 * feature stays optional.
 *
 * WHY A SIZE CHECK AND NOT A HASH. The file is 296 MiB; hashing it on every start would cost
 * seconds of CPU for a check the artifact's own provenance already guarantees (the file was
 * fetched at a pinned revision and verified once, by the script that put it there). The size
 * catches the one thing that can still go wrong — a half-written download — and costs a stat.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The GGUF file name inside the `models/` directory. */
export const EMBEDDING_MODEL_FILE = 'embeddinggemma-2-Q8_0.gguf';

/** The pinned file's size in bytes — the cheap proof that it is not half a download. */
export const EMBEDDING_MODEL_BYTES = 309855456;

/** The environment variable that overrides every other place. */
export const EMBEDDING_MODEL_ENV = 'STAMPED_EMBED_MODEL';

/** The upstream repository the file comes from. */
export const EMBEDDING_MODEL_REPO = 'ggml-org/embeddinggemma-2-GGUF';

/** The pinned revision — a commit sha, never a branch. */
export const EMBEDDING_MODEL_REVISION = '58faf90940886df2d62be555c8765d00dac362c5';

/** The sha256 of the pinned file. */
export const EMBEDDING_MODEL_SHA256 = '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135';

/** The licence the model is under — carried beside the file, in the artifact and here. */
export const EMBEDDING_MODEL_LICENSE = 'Apache-2.0';

/** The licence text, shipped next to the model. */
export const EMBEDDING_MODEL_LICENSE_FILE = 'embeddinggemma-2-LICENSE.txt';

/** The notice, shipped next to the model. */
export const EMBEDDING_MODEL_NOTICE_FILE = 'embeddinggemma-2-NOTICE.txt';

/** Where a resolved model was found. */
export type EmbeddingModelSource = 'env' | 'bundled' | 'cache';

export interface EmbeddingModelLocation {
    /** The absolute path of the GGUF file. */
    readonly path: string;
    /** Which of the three places it came from. */
    readonly source: EmbeddingModelSource;
}

export interface ModelPathOptions {
    /** The environment. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
    /**
     * The app's own data directory — the FIRST entry of `XDG_DATA_DIRS`, which the launcher
     * exports. This is where `share/` lands in every layout.
     */
    dataDir?: string;
    /**
     * Every entry of `XDG_DATA_DIRS`, in order, searched after {@link dataDir}. The app's own
     * directory is NOT always first: the GTK runtime of the macOS and Windows apps puts its own
     * `share` in front at startup, so "the first entry" was the GTK one and the bundled model was
     * never found.
     */
    dataDirs?: readonly string[];
    /** The mounted AppImage root (`APPDIR`), for a run that has no launcher exports. */
    appDir?: string;
    /** The development cache directory — `$XDG_CACHE_HOME/stamped/models`. */
    cacheDir?: string;
    /** Existence probe. Defaults to `existsSync`. */
    exists?: (path: string) => boolean;
    /** Size probe. Defaults to `statSync(path).size`. */
    size?: (path: string) => number;
}

/**
 * The app's own data directory: the first `XDG_DATA_DIRS` entry.
 *
 * The launcher PREPENDS the app's directory, so the first entry is the app's own — the icons, the
 * schemas and the locale catalogues are all found the same way. A host that exports nothing gets
 * `undefined`, and the bundled candidate is simply not there.
 */
export function bundledDataDir(env: Record<string, string | undefined>): string | undefined {
    const first = (env.XDG_DATA_DIRS ?? '').split(':')[0]?.trim();
    return first === undefined || first === '' ? undefined : first;
}

/** Every `XDG_DATA_DIRS` entry, in order — see {@link ModelPathOptions.dataDirs} for why not just the first. */
export function bundledDataDirs(env: Record<string, string | undefined>): string[] {
    return (env.XDG_DATA_DIRS ?? '')
        .split(':')
        .map((dir) => dir.trim())
        .filter((dir) => dir !== '');
}

/** The development cache: `$XDG_CACHE_HOME/stamped/models`, else `~/.cache/stamped/models`. */
export function developmentCacheDir(
    env: Record<string, string | undefined>,
    home: string = homedir(),
): string {
    const base = env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== ''
        ? env.XDG_CACHE_HOME
        : join(home, '.cache');
    return join(base, 'stamped', 'models');
}

/**
 * The directories a bundled model may live in, most specific first.
 *
 * The first is the app's own data directory — one expression for every layout. The second is the
 * AppImage's mount point, for a run that has the image but no launcher exports (`APPDIR` is set
 * by the AppImage runtime itself, so it survives even a hand-started binary).
 */
function bundledModelDirs(options: ModelPathOptions): string[] {
    const dirs: string[] = [];
    for (const dir of [options.dataDir, ...(options.dataDirs ?? [])]) {
        if (dir === undefined || dir === '') continue;
        const models = join(dir, 'models');
        if (!dirs.includes(models)) dirs.push(models);
    }
    if (options.appDir !== undefined && options.appDir !== '') {
        dirs.push(join(options.appDir, 'usr', 'share', 'models'));
    }
    return dirs;
}

/**
 * Find the embedding model, or say there is none.
 *
 * Returns `undefined` rather than throwing: a missing model is a normal state (the feature is
 * optional, and a package build may ship without it), and the caller falls back to text search.
 *
 * EVERY CANDIDATE IS SIZE-CHECKED, the environment variable included: the override names a FILE,
 * and the size is what proves that file is the pinned one rather than a half-written copy. A
 * different quantisation is therefore not accepted — the vector index records the model id, so
 * another model would need a reindex anyway.
 */
export function resolveEmbeddingModel(options: ModelPathOptions = {}): EmbeddingModelLocation | undefined {
    const env = options.env ?? {};
    const exists = options.exists ?? existsSync;
    const size = options.size ?? fileSize;
    const candidates: EmbeddingModelLocation[] = [];
    const override = env[EMBEDDING_MODEL_ENV];
    if (override !== undefined && override !== '') {
        candidates.push({ path: override, source: 'env' });
    }
    for (const dir of bundledModelDirs(options)) {
        candidates.push({ path: join(dir, EMBEDDING_MODEL_FILE), source: 'bundled' });
    }
    if (options.cacheDir !== undefined && options.cacheDir !== '') {
        candidates.push({ path: join(options.cacheDir, EMBEDDING_MODEL_FILE), source: 'cache' });
    }
    for (const candidate of candidates) {
        if (!exists(candidate.path)) continue;
        if (size(candidate.path) !== EMBEDDING_MODEL_BYTES) continue;
        return candidate;
    }
    return undefined;
}

/** The size of a file, or `-1` when it cannot be read — a missing file is not an error here. */
function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return -1;
    }
}

/**
 * The same lookup, with the environment read for the caller.
 *
 * The three injected values are exactly what the environment knows: the app's own data directory
 * (the launcher's `XDG_DATA_DIRS`), the AppImage mount point (`APPDIR`) and the development cache.
 */
export function resolveEmbeddingModelFromEnv(
    env: Record<string, string | undefined> = process.env,
): EmbeddingModelLocation | undefined {
    return resolveEmbeddingModel({
        env,
        dataDir: bundledDataDir(env),
        dataDirs: bundledDataDirs(env),
        appDir: env.APPDIR,
        cacheDir: developmentCacheDir(env),
    });
}
