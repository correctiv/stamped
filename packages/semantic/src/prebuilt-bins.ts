/**
 * Where the prebuilt llama.cpp binaries for this machine are — and whether there are any.
 *
 * SEPARATE FROM THE EMBEDDER because the two are asked at different moments. The window has to
 * know whether it can offer the feature at all while it is building a dialog row, and that answer
 * must not cost a model load. Nothing here imports node-llama-cpp: a bins package holds one
 * function that returns a path.
 */

import { existsSync, readdirSync } from 'node:fs';
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

/** What {@link backendCandidates} needs to know about the machine; injected so it is testable. */
export interface MachineProbe {
    env: Readonly<Record<string, string | undefined>>;
    exists(path: string): boolean;
    /** File names in a directory, empty when it is missing. */
    list(dir: string): string[];
}

export function systemProbe(): MachineProbe {
    return {
        env: process.env,
        exists: (path) => existsSync(path),
        list: (dir) => {
            try {
                return readdirSync(dir);
            } catch {
                return [];
            }
        },
    };
}

const GPU_OFF_VALUES = new Set(['off', '0', 'false', 'no', 'cpu']);
const GPU_ON_VALUES = new Set(['on', '1', 'true', 'yes', 'gpu']);

/**
 * `STAMPED_SEMANTIC_GPU=off` is the escape hatch: a driver that misbehaves must not be a dead end.
 * `on` is its counterpart: it lifts the CPU pin a GPU hang leaves behind (`gpu-guard.ts`).
 */
export const GPU_ENV = 'STAMPED_SEMANTIC_GPU';

export type GpuSetting = 'off' | 'on' | 'auto';

export function gpuSetting(env: Readonly<Record<string, string | undefined>> = process.env): GpuSetting {
    const value = (env[GPU_ENV] ?? '').trim().toLowerCase();
    if (GPU_OFF_VALUES.has(value)) return 'off';
    return GPU_ON_VALUES.has(value) ? 'on' : 'auto';
}

const LIBRARY_DIRS = [
    '/usr/lib',
    '/usr/lib64',
    '/lib',
    '/lib64',
    '/usr/lib/x86_64-linux-gnu',
    '/lib/x86_64-linux-gnu',
];

function pathList(value: string | undefined): string[] {
    return (value ?? '').split(':').filter((entry) => entry !== '');
}

/**
 * Is there a Vulkan loader AND a driver for it? The loader alone is on every desktop (it is a
 * dependency of Mesa and of the browsers); the ICD manifest is what says a driver is installed.
 * Both are only a hint — `llama.gpu` after loading is the truth, and the embedder reopens on the
 * CPU when it disagrees.
 */
export function hasVulkan(probe: MachineProbe = systemProbe()): boolean {
    const { env } = probe;
    const libraryDirs = [...pathList(env.LD_LIBRARY_PATH), ...LIBRARY_DIRS];
    if (!libraryDirs.some((dir) => probe.exists(`${dir}/libvulkan.so.1`))) return false;
    // The loader's own overrides name the driver directly.
    if (pathList(env.VK_DRIVER_FILES).length > 0 || pathList(env.VK_ICD_FILENAMES).length > 0) return true;
    const dataDirs = [
        env.XDG_DATA_HOME ?? (env.HOME ? `${env.HOME}/.local/share` : ''),
        ...pathList(env.XDG_DATA_DIRS),
        '/usr/local/share',
        '/usr/share',
    ].filter((dir) => dir !== '');
    const icdDirs = [
        '/etc/vulkan/icd.d',
        ...dataDirs.map((dir) => `${dir}/vulkan/icd.d`),
        // The freedesktop Flatpak runtime keeps its GL extension's drivers here.
        '/usr/lib/x86_64-linux-gnu/GL/vulkan/icd.d',
    ];
    return icdDirs.some((dir) => probe.list(dir).some((name) => name.endsWith('.json')));
}

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
