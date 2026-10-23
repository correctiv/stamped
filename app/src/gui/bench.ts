/**
 * Measurement hook for the message list, off in every normal run.
 *
 * `STAMPED_BENCH=<file>` makes the window, once the first page of the list is up, load 25 pages
 * (5,000 rows), select the last row, and append one JSON line of timings to `<file>` before it
 * quits. Run it on a synthetic case (`scripts/make-bench-case.mts`) under `scripts/headless-run`.
 * CPU comes from `/proc`, split into the main thread and everything else, so "the GUI thread does
 * the work" is a number rather than a feeling.
 */

import GLib from 'gi://GLib';
import { appendFileSync, readFileSync } from 'node:fs';

export const BENCH_FILE = GLib.getenv('STAMPED_BENCH');

const STARTED = GLib.get_monotonic_time();
const TICKS_PER_SECOND = 100;

/** Milliseconds since this module loaded. */
export function sinceStart(): number {
    return (GLib.get_monotonic_time() - STARTED) / 1000;
}

function ticks(path: string): number {
    // Fields after the `(comm)`: utime and stime are the 14th and 15th of the whole line.
    const text = readFileSync(path, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
}

/** CPU milliseconds used so far by the main thread and by all the other threads together. */
export function cpuMs(): { main: number; other: number } {
    const pid = readFileSync('/proc/self/stat', 'utf8').split(' ')[0];
    const all = ticks('/proc/self/stat');
    const main = ticks(`/proc/self/task/${pid}/stat`);
    const scale = 1000 / TICKS_PER_SECOND;
    return { main: main * scale, other: (all - main) * scale };
}

/** Resident set size in MiB. */
export function rssMb(): number {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'));
    return match ? Math.round(Number(match[1]) / 1024) : 0;
}

/** Wall and CPU of a stretch of work: `const lap = startLap(); … lap()`. */
export function startLap(): () => { wallMs: number; mainCpuMs: number; otherCpuMs: number } {
    const wall = GLib.get_monotonic_time();
    const cpu = cpuMs();
    return () => {
        const now = cpuMs();
        return {
            wallMs: Math.round((GLib.get_monotonic_time() - wall) / 1000),
            mainCpuMs: Math.round(now.main - cpu.main),
            otherCpuMs: Math.round(now.other - cpu.other),
        };
    };
}

/** Let the main loop run for `ms` and resolve — the idle stretch an interaction settles in. */
export function settle(ms: number): Promise<void> {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function report(result: Record<string, unknown>): void {
    if (BENCH_FILE !== null) appendFileSync(BENCH_FILE, `${JSON.stringify(result)}\n`);
}
