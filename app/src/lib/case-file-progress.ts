/**
 * The progress `stamped case pack|unpack --progress=jsonl` prints, and how the window reads it.
 *
 * ONE STEP, MEASURED IN BYTES: packing and unpacking each walk the members once, so a single
 * `done` of `total` says it all — unlike the report, there are no phases of different weight.
 * Like the report's lines these are SNAPSHOTS: a line that is lost costs the reader nothing.
 * NUMBERS ONLY, plus the final path the caller asked for — never a member name or a message.
 */

/** How far the run is. `total` is 0 when it cannot say. */
export interface CaseFileProgressLine {
    readonly phase: 'working';
    readonly done: number;
    readonly total: number;
}

/** The last line: the file or the folder is written and complete. */
export interface CaseFileDoneLine {
    readonly phase: 'done';
    readonly path: string;
    readonly members: number;
    readonly bytes: number;
}

export type CaseFileEvent = CaseFileProgressLine | CaseFileDoneLine;

export function caseFileProgressLine(done: number, total: number): CaseFileProgressLine {
    return { phase: 'working', done, total };
}

/** One line of the subprocess's stdout, or `undefined` for anything that is not ours. */
export function parseCaseFileLine(line: string): CaseFileEvent | undefined {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.phase === 'done') {
        const { path, members, bytes } = record;
        return typeof path === 'string' && typeof members === 'number' && typeof bytes === 'number'
            ? { phase: 'done', path, members, bytes }
            : undefined;
    }
    if (record.phase === 'working' && typeof record.done === 'number' && typeof record.total === 'number') {
        return { phase: 'working', done: record.done, total: record.total };
    }
    return undefined;
}

/** 0 … 1; a step that cannot say how far it is reads as 0. */
export function caseFileFraction(event: CaseFileEvent): number {
    if (event.phase === 'done') return 1;
    if (event.total <= 0) return 0;
    return Math.min(1, Math.max(0, event.done / event.total));
}

/**
 * Wrap a line writer so it speaks at most once per `everyMs`, and always for the last chunk.
 *
 * The store reports once per chunk it moves, which on a large case is thousands of times a
 * second; a pipe nobody drains that fast is a subprocess that stalls on its own stdout. The clock
 * is a parameter so a test does not have to sleep.
 */
export function throttledProgress(
    write: (line: CaseFileProgressLine) => void,
    everyMs = 200,
    now: () => number = Date.now,
): (done: number, total: number) => void {
    let last = Number.NEGATIVE_INFINITY;
    return (done, total) => {
        const at = now();
        const finished = total > 0 && done >= total;
        if (!finished && at - last < everyMs) return;
        last = at;
        write(caseFileProgressLine(done, total));
    };
}
