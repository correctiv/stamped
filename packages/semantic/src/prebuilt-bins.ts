/**
 * Where the prebuilt llama.cpp binaries for this machine are — and whether there are any.
 *
 * SEPARATE FROM THE EMBEDDER because the two are asked at different moments. The window has to
 * know whether it can offer the feature at all while it is building a dialog row, and that answer
 * must not cost a model load. Nothing here imports node-llama-cpp: a bins package holds one
 * function that returns a path.
 */

import { join } from 'node:path';

/** The build description node-llama-cpp writes beside every prebuilt binary. */
export const BUILD_METADATA_FILE = '_nlcBuildMetadata.json';

interface BinsLocation {
    readonly binsDir: string;
    readonly packageVersion: string;
}

interface BinsPackage {
    getBinsDir(): BinsLocation;
}

/**
 * node-llama-cpp's prebuilt packages ship JavaScript without type declarations — an ambient
 * `declare module` would only cover whichever program's `include` happens to list it, and a
 * consumer workspace that type-checks these files by following the import graph (as `app` does
 * through `@stamped/semantic`) would not see it. A `@ts-ignore` on the import itself travels
 * with the file into every program that compiles it — the same thing node-llama-cpp does when it
 * imports these packages.
 */
async function loadLinuxX64(): Promise<BinsPackage> {
    // @ts-ignore TS7016: no type declarations for this prebuilt package
    return import('@node-llama-cpp/linux-x64');
}

async function loadLinuxArm64(): Promise<BinsPackage> {
    // @ts-ignore TS7016: no type declarations for this prebuilt package
    return import('@node-llama-cpp/linux-arm64');
}

/**
 * The CPU prebuilt-binary packages, by `<platform>-<arch>` — which is also the name of the
 * directory the binary sits in (node-llama-cpp's `getBuildFolderNameForBuildOptions` appends
 * nothing while the GPU is off).
 *
 * Static specifiers in a table, not one computed specifier: a bundler can only follow a module
 * name it can read, and a GJS bundle that resolved this at run time would carry no binary at all.
 */
const PREBUILT_BINS: Record<string, (() => Promise<BinsPackage>) | undefined> = {
    'linux-x64': loadLinuxX64,
    'linux-arm64': loadLinuxArm64,
};

/** This machine, as node-llama-cpp names its binary directories. */
export function currentTarget(): string {
    return `${process.platform}-${process.arch}`;
}

/**
 * Is there a prebuilt binary for this machine? A table lookup, so it is free to ask.
 *
 * `true` does not promise that the model will load — only that the program carries something to
 * load it with. The one thing it rules out is the machine nobody built a binary for.
 */
export function hasPrebuiltBins(target: string = currentTarget()): boolean {
    return PREBUILT_BINS[target] !== undefined;
}

/** The directory holding the addon and its backends, or an error naming the machine. */
export async function prebuiltBinsDir(target: string = currentTarget()): Promise<string> {
    const load = PREBUILT_BINS[target];
    if (load === undefined) {
        throw new Error(`no prebuilt llama.cpp binaries for ${target}`);
    }
    const { binsDir } = (await load()).getBinsDir();
    // The per-platform subdirectory, which `getBinsDir()` does not include.
    return join(binsDir, target);
}
