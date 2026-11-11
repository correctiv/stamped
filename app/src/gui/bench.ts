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

/** A stretch in which the main loop did not come back: when it began and how long it lasted. */
export interface Stall {
    readonly atMs: number;
    readonly ms: number;
}

const WATCH_INTERVAL_MS = 8;
/** Gaps at or above this are kept: below it a window still feels like it answers. */
const STALL_FLOOR_MS = 50;
const stalls: Stall[] = [];
const marks: { atMs: number; label: string }[] = [];
let longest = 0;

/**
 * Watch the main loop from now on: an 8 ms timeout whose lateness is the stall. The longest gap
 * between two ticks is the time in which a GTK window neither repaints nor answers a click, which
 * is what "sluggish" means (#182) — measured instead of judged by eye.
 */
function watchStalls(): void {
    let last = GLib.get_monotonic_time();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_INTERVAL_MS, () => {
        const now = GLib.get_monotonic_time();
        const gap = (now - last) / 1000 - WATCH_INTERVAL_MS;
        if (gap > longest) longest = Math.round(gap);
        if (gap >= STALL_FLOOR_MS)
            stalls.push({ atMs: Math.round((last - STARTED) / 1000), ms: Math.round(gap) });
        last = now;
        return GLib.SOURCE_CONTINUE;
    });
}

if (BENCH_FILE !== null) watchStalls();

/** Name a moment on the same clock as the stalls, so a stall can be read against what ran. */
export function mark(label: string): void {
    if (BENCH_FILE !== null) marks.push({ atMs: Math.round(sinceStart()), label });
}

/** The longest the loop may stay away once the window is up, in ms. Beyond it a click feels late. */
export const STALL_BUDGET_MS = 150;

/**
 * What the watch saw: the longest gap, how many reached the floor, and the marks to read them by.
 *
 * `withinBudget` leaves out what happens before the first pane is filled: building the window and
 * opening the index are one synchronous stretch that the loading page covers.
 */
export function stallReport(): {
    longestMs: number;
    over50Ms: number;
    longestAfterOpenMs: number;
    withinBudget: boolean;
    stalls: Stall[];
    marks: typeof marks;
} {
    const opened = marks[0]?.atMs ?? Number.POSITIVE_INFINITY;
    const longestAfterOpenMs = Math.max(
        0,
        ...stalls.filter((stall) => stall.atMs >= opened).map((stall) => stall.ms),
    );
    return {
        longestMs: longest,
        over50Ms: stalls.length,
        longestAfterOpenMs,
        withinBudget: longestAfterOpenMs <= STALL_BUDGET_MS,
        stalls: stalls.slice(0, 40),
        marks,
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
