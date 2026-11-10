/**
 * GPU hang guard — re-exported from `@gjsify/machine-fit`.
 *
 * The implementation moved to the shared machine-fit package (ADR 0132). This file
 * keeps the public subpath stable for consumers that imported `@stamped/semantic/gpu-guard`.
 */

export {
    createGpuGuard,
    processAlive,
    type GpuGuard,
    type GpuGuardOptions,
    type GpuPin,
} from '@gjsify/machine-fit';

import { createGpuGuard as createGuard } from '@gjsify/machine-fit';
import { defaultGuardDir as packageGuardDir } from '@gjsify/machine-fit';

/** The process-wide guard; the `exit` hook is installed with it, once. */
export function gpuGuard(): ReturnType<typeof createGuard> {
    if (shared === undefined) {
        const guard = createGuard({ dir: defaultGuardDir() });
        // `process.exit()` inside a counted call (a SIGTERM handler, say) is a clean end, not a hang.
        process.on('exit', () => guard.release());
        shared = guard;
    }
    return shared;
}

let shared: ReturnType<typeof createGuard> | undefined;

/** `$XDG_STATE_HOME/stamped`, else `~/.local/state/stamped`; `%LOCALAPPDATA%\\stamped` on Windows. */
export function defaultGuardDir(
    env: Record<string, string | undefined> = process.env,
    platform: string = process.platform,
): string {
    return packageGuardDir('stamped', env, platform);
}
