/**
 * Which llama.cpp build the GJS embedder tries, from what the machine looks like.
 *
 * The machine is a fake: a set of existing paths and a table of directory listings, so the
 * answer does not depend on the GPU of whoever runs the suite.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
    backendCandidates,
    GPU_ENV,
    gpuSetting,
    hasVulkan,
    type MachineProbe,
} from '@stamped/semantic/prebuilt-bins';

function machine(
    paths: string[],
    dirs: Record<string, string[]> = {},
    env: Record<string, string> = {},
): MachineProbe {
    return {
        env,
        exists: (path) => paths.includes(path),
        list: (dir) => dirs[dir] ?? [],
    };
}

const LOADER = '/usr/lib64/libvulkan.so.1';
const DRIVER = { '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] };

export default async () => {
    await describe('hasVulkan', async () => {
        await it('needs the loader and a driver manifest', async () => {
            expect(hasVulkan(machine([LOADER], DRIVER))).toBe(true);
        });

        await it('does not count a loader without any driver', async () => {
            expect(hasVulkan(machine([LOADER]))).toBe(false);
        });

        await it('does not count a driver without the loader', async () => {
            expect(hasVulkan(machine([], DRIVER))).toBe(false);
        });

        await it('ignores files in the driver directory that are not manifests', async () => {
            expect(hasVulkan(machine([LOADER], { '/usr/share/vulkan/icd.d': ['README'] }))).toBe(false);
        });

        await it('finds the loader on LD_LIBRARY_PATH and a driver in the user directory', async () => {
            const probe = machine(
                ['/opt/gpu/libvulkan.so.1'],
                { '/home/ada/.local/share/vulkan/icd.d': ['intel_icd.json'] },
                { LD_LIBRARY_PATH: '/opt/gpu', HOME: '/home/ada' },
            );
            expect(hasVulkan(probe)).toBe(true);
        });

        await it('trusts the loader override that names a driver', async () => {
            const probe = machine([LOADER], {}, { VK_DRIVER_FILES: '/opt/gpu/icd.json' });
            expect(hasVulkan(probe)).toBe(true);
        });
    });

    await describe('backendCandidates', async () => {
        await it('tries Vulkan first on linux-x64 and keeps the CPU build as the fallback', async () => {
            expect(backendCandidates('linux-x64', machine([LOADER], DRIVER))).toStrictEqual([
                'linux-x64-vulkan',
                'linux-x64',
            ]);
        });

        await it('is the CPU build alone when the machine has no Vulkan', async () => {
            expect(backendCandidates('linux-x64', machine([]))).toStrictEqual(['linux-x64']);
        });

        await it('is the CPU build alone where there is no Vulkan build, whatever the machine', async () => {
            expect(backendCandidates('linux-arm64', machine([LOADER], DRIVER))).toStrictEqual([
                'linux-arm64',
            ]);
        });

        await it('honours the escape hatch', async () => {
            for (const value of ['off', 'OFF', '0', 'false', ' cpu ']) {
                const probe = machine([LOADER], DRIVER, { [GPU_ENV]: value });
                expect(backendCandidates('linux-x64', probe)).toStrictEqual(['linux-x64']);
            }
        });

        await it('does not treat any other value of the escape hatch as off', async () => {
            const probe = machine([LOADER], DRIVER, { [GPU_ENV]: 'on' });
            expect(backendCandidates('linux-x64', probe)).toStrictEqual(['linux-x64-vulkan', 'linux-x64']);
        });
    });

    await describe('gpuSetting', async () => {
        await it('reads off, on and everything else as auto', async () => {
            expect(gpuSetting({ [GPU_ENV]: ' Off ' })).toBe('off');
            expect(gpuSetting({ [GPU_ENV]: 'ON' })).toBe('on');
            expect(gpuSetting({ [GPU_ENV]: 'maybe' })).toBe('auto');
            expect(gpuSetting({})).toBe('auto');
        });
    });
};
