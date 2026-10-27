/**
 * A GPU that hangs takes the whole process with it, and this is how the next start knows.
 *
 * WHY A FILE. A driver that loses the device (`vk::DeviceLostError`, a Metal command-buffer error)
 * makes llama.cpp call `abort()`: no `try/catch`, no `exit` handler, nothing runs afterwards. The
 * only thing a dead process can leave behind is what it wrote BEFORE. So a process writes a marker
 * for as long as it is using the GPU and removes it again; a marker whose process is gone is the
 * proof that a GPU session did not end cleanly, and the CPU is pinned from then on.
 *
 * THE MARKER COVERS A CALL, NOT THE SESSION. A GUI window holds its query embedder for hours; a
 * marker for that whole time would also turn a `kill -9` of an idle window into a verdict on the
 * GPU. Opening, embedding and closing are the moments a device is lost, so those are the ones
 * wrapped — one marker per process, counted, so overlapping calls share it.
 *
 * PER USER, NOT PER CASE: the GPU and its driver belong to the machine. The pin is lifted by
 * `STAMPED_SEMANTIC_GPU=on` (see `prebuilt-bins.ts`), which is the "I fixed the driver" switch.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GpuPin {
    /** When the dead session was noticed, ISO 8601. */
    at: string;
    /** The process that died with the GPU in use. */
    pid: number;
}

export interface GpuGuardOptions {
    /** Where the pin and the markers live. */
    dir: string;
    pid?: number;
    /** Is a process still there? Injected so a test does not need a second process. */
    alive?: (pid: number) => boolean;
    now?: () => Date;
}

export interface GpuGuard {
    /** The pin when an earlier GPU session died without closing, after sweeping dead markers. */
    pin(): GpuPin | undefined;
    /** Run `work` with this process marked as using the GPU. */
    during<T>(work: () => Promise<T>): Promise<T>;
    /** Lift the pin; the GPU is tried again. */
    clear(): void;
    /** Drop this process's marker; for the `exit` hook, where a counted call can no longer finish. */
    release(): void;
}

const PIN_FILE = 'gpu-pin.json';
const MARKER_DIR = 'gpu-sessions';

/** `EPERM` means the process exists and belongs to somebody else. */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as { code?: string }).code === 'EPERM';
    }
}

/** `$XDG_STATE_HOME/stamped`, else `~/.local/state/stamped`; `%LOCALAPPDATA%\stamped` on Windows. */
export function defaultGuardDir(env: Record<string, string | undefined> = process.env): string {
    if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== '')
        return join(env.XDG_STATE_HOME, 'stamped');
    if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'stamped');
    return join(env.HOME ?? env.USERPROFILE ?? '.', '.local', 'state', 'stamped');
}

/**
 * The guard NEVER makes embedding fail: a state directory that cannot be written (a read-only
 * home, a full disk) means no protection, not no search.
 */
export function createGpuGuard(options: GpuGuardOptions): GpuGuard {
    const pid = options.pid ?? process.pid;
    const alive = options.alive ?? processAlive;
    const now = options.now ?? (() => new Date());
    const markerDir = join(options.dir, MARKER_DIR);
    const markerPath = join(markerDir, `${pid}.json`);
    let busy = 0;

    const attempt = (work: () => void): void => {
        try {
            work();
        } catch {
            /* see above */
        }
    };

    const readPin = (): GpuPin | undefined => {
        try {
            return JSON.parse(readFileSync(join(options.dir, PIN_FILE), 'utf8')) as GpuPin;
        } catch {
            return undefined;
        }
    };

    /** A marker of a process that is gone becomes the pin. */
    const sweep = (): void => {
        let names: string[];
        try {
            names = readdirSync(markerDir);
        } catch {
            return;
        }
        for (const name of names) {
            const other = Number.parseInt(name, 10);
            if (!Number.isInteger(other) || other === pid || alive(other)) continue;
            attempt(() => {
                mkdirSync(options.dir, { recursive: true });
                const pin: GpuPin = { at: now().toISOString(), pid: other };
                writeFileSync(join(options.dir, PIN_FILE), JSON.stringify(pin, null, 2));
                rmSync(join(markerDir, name), { force: true });
            });
        }
    };

    const enter = (): void => {
        if (busy++ > 0) return;
        attempt(() => {
            mkdirSync(markerDir, { recursive: true });
            writeFileSync(markerPath, JSON.stringify({ pid, at: now().toISOString() }));
        });
    };

    const leave = (): void => {
        if (--busy > 0) return;
        busy = 0;
        attempt(() => rmSync(markerPath, { force: true }));
    };

    return {
        pin(): GpuPin | undefined {
            sweep();
            return readPin();
        },
        async during<T>(work: () => Promise<T>): Promise<T> {
            enter();
            try {
                return await work();
            } finally {
                leave();
            }
        },
        clear(): void {
            attempt(() => rmSync(join(options.dir, PIN_FILE), { force: true }));
        },
        release(): void {
            busy = 0;
            attempt(() => rmSync(markerPath, { force: true }));
        },
    };
}

let shared: GpuGuard | undefined;

/** The process-wide guard; the `exit` hook is installed with it, once. */
export function gpuGuard(): GpuGuard {
    if (shared === undefined) {
        const guard = createGpuGuard({ dir: defaultGuardDir() });
        // `process.exit()` inside a counted call (a SIGTERM handler, say) is a clean end, not a hang.
        process.on('exit', () => guard.release());
        shared = guard;
    }
    return shared;
}
