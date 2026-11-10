/**
 * Prebuilt llama.cpp binary helpers — kept as a stable public subpath.
 *
 * The implementation moved to `@gjsify/embeddings/llama` (ADR 0132). This file keeps
 * the public subpath stable for consumers that imported `@stamped/semantic/prebuilt-bins`.
 *
 * WHY NOT A STRAIGHT RE-EXPORT: `@gjsify/embeddings/llama` static-imports
 * `node-llama-cpp`. Importing it from modules that the window bundle reaches would pull
 * the native addon into that bundle and deadlock the bundler (see `semantic-embedder.ts`).
 * The helpers here are pure table lookups and dynamic imports of the prebuilt packages,
 * so they stay safe.
 */

import { join } from 'node:path';

import {
    hasVulkan,
    parseGpuSetting,
    systemProbe,
    type GpuSetting,
    type MachineProbe,
} from '@gjsify/machine-fit';

import { runningOnGjs } from './runtime.ts';

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
 * with the file into every program that compiles it — the same thing node-llama-cpp does when
 * it imports these packages.
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
 * The Vulkan build is a superset of the CPU one: the same ggml CPU variants plus
 * `libggml-vulkan.so`, so a machine without a usable GPU still runs it on the CPU. There is no
 * arm64 build.
 */
async function loadLinuxX64Vulkan(): Promise<BinsPackage> {
    // @ts-ignore TS7016: no type declarations for this prebuilt package
    return import('@node-llama-cpp/linux-x64-vulkan');
}

/**
 * The prebuilt-binary packages, by build target — which is also the name of the directory the
 * binary sits in (node-llama-cpp's `getBuildFolderNameForBuildOptions` appends nothing while the
 * GPU is off, and `-<gpu>` when it is on). `<platform>-<arch>` is the CPU build.
 *
 * Static specifiers in a table, not one computed specifier: a bundler can only follow a module
 * name it can read, and a GJS bundle that resolved this at run time would carry no binary at all.
 */
const PREBUILT_BINS: Record<string, (() => Promise<BinsPackage>) | undefined> = {
    'linux-x64': loadLinuxX64,
    'linux-x64-vulkan': loadLinuxX64Vulkan,
    'linux-arm64': loadLinuxArm64,
};

/** This machine, as node-llama-cpp names its binary directories. */
export function currentTarget(processImpl: { platform: string; arch: string } = process): string {
    return `${processImpl.platform}-${processImpl.arch}`;
}

/**
 * Is there a prebuilt binary for this machine? A table lookup, so it is free to ask.
 *
 * `true` does not promise that the model will load — only that the program carries something to
 * load it with. The one thing it rules out is the machine nobody built a binary for.
 *
 * TWO ANSWERS, BECAUSE THE RUNTIMES REACH THE BINARY DIFFERENTLY. Under GJS the embedder is handed
 * a directory, so only the targets in {@link PREBUILT_BINS} can work. Under Node `getLlama()`
 * looks for the binary itself, and answering from the GJS table there switched semantic search
 * off on every Mac and every Windows PC: the app said "not available here" with the model beside it.
 */
export function hasPrebuiltBins(target: string = currentTarget(), onGjs: boolean = runningOnGjs()): boolean {
    return onGjs ? PREBUILT_BINS[target] !== undefined : NODE_PREBUILT_TARGETS.has(target);
}

/**
 * The machines node-llama-cpp ships a prebuilt binary for, which `getLlama()` finds on its own.
 * macOS (Metal on Apple silicon, CPU on Intel) and Windows are here and nowhere in
 * {@link PREBUILT_BINS}: that table exists for the GJS route, which has to be handed a path.
 */
const NODE_PREBUILT_TARGETS: ReadonlySet<string> = new Set([
    'darwin-arm64',
    'darwin-x64',
    'win32-arm64',
    'win32-x64',
    'linux-arm64',
    'linux-x64',
]);

/** `STAMPED_SEMANTIC_GPU=off` is the escape hatch; `on` lifts the CPU pin a GPU hang leaves behind. */
export const GPU_ENV = 'STAMPED_SEMANTIC_GPU';

/**
 * Read the legacy Stamped GPU setting.
 *
 * Prefer {@link parseGpuSetting} for new code; this wrapper keeps callers that passed
 * `process.env` working.
 */
export function gpuSetting(env: Readonly<Record<string, string | undefined>> = process.env): GpuSetting {
    return parseGpuSetting(env[GPU_ENV]);
}

export { hasVulkan, systemProbe, type GpuSetting, type MachineProbe };

/**
 * The builds to try on this machine, best first; the last entry is always the CPU build, which is
 * what a failed GPU build falls back to. One entry means there is nothing to try before it.
 *
 * Only Linux x64 under GJS has more than one: macOS and Windows reach llama.cpp through
 * `getLlama()`, which does its own detection. Not asking `getLlama()` here is deliberate — it
 * `fork`s a second interpreter to self-test the binary, and GJS cannot.
 */
export function backendCandidates(
    target: string = currentTarget(),
    probe: MachineProbe = systemProbe(),
): string[] {
    const gpu = `${target}-vulkan`;
    if (PREBUILT_BINS[gpu] === undefined) return [target];
    if (gpuSetting(probe.env) === 'off') return [target];
    return hasVulkan(probe) ? [gpu, target] : [target];
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
