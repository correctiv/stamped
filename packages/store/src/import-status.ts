/**
 * The import status file: where a run has got to, as data on disk.
 *
 * A long import used to be visible only in a modal dialog of the window — closing the dialog
 * killed the import, and an import started on a command line was invisible everywhere. The
 * status file fixes both by making progress a FILE in the case folder rather than the property
 * of whoever started the run: `stamped status` reads it, the window polls it, and either works
 * for an import started by the other.
 *
 * WHAT THE FILE IS ALLOWED TO HOLD. Process and progress facts only: the PID, the timestamps,
 * the source paths and the mailbox names the layout produced, and counts. NO message content,
 * no verdicts, no addresses beyond the mailbox names the folder tree already names — the file
 * travels next to a leak and must not become a second place its contents can be read from.
 *
 * WRITTEN AT MOST ABOUT ONCE A SECOND, and always atomically (`tmp` + rename): a reader either
 * sees the previous snapshot or the new one, never a half-written one. The file STAYS with its
 * final state after the run — "what did the last import do" is a question about the case, and a
 * file that vanished on success could not tell the two of "it finished" and "it never ran"
 * apart. A `running` file whose PID is gone or whose last update is stale reads as ORPHANED
 * (`orphanedImport`): the import was killed, or this is another machine's process id.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { planFolder } from '@stamped/import';

import type { CasePaths } from './case.ts';
import type { ImportMode, ImportProgress, ImportResult } from './importer.ts';

/** Bumped when a build would misread a status file an older build wrote. */
export const IMPORT_STATUS_VERSION = 1;

/** The file's name inside the case folder. */
export const IMPORT_STATUS_NAME = 'import-status.json';

/** How long a `running` file may go without an update before the run reads as stalled. */
export const STATUS_STALE_SECONDS = 60;

/** The four states a run is ever in. The file keeps the last one for good. */
export type ImportState = 'running' | 'finished' | 'failed' | 'cancelled';

const STATES: readonly ImportState[] = ['running', 'finished', 'failed', 'cancelled'];

/** One snapshot of a run. Every field is a fact about the process, never about a message. */
export interface ImportStatus {
    readonly version: number;
    readonly state: ImportState;
    /** The importing process — what tells a stalled run from a slow one. */
    readonly pid: number;
    /** When the run started, ISO 8601. */
    readonly startedAt: string;
    /** When the snapshot was written, ISO 8601. */
    readonly updatedAt: string;
    /** The source paths the run was given, as they were given. */
    readonly sources: readonly string[];
    /** The mailbox being imported, when the layout names one. */
    readonly mailbox?: string;
    /** Messages read so far, across the whole run. */
    readonly mailsDone: number;
    /** Messages of the CURRENT source — the one whose bytes are being read right now. */
    readonly mailsTotal: number;
    /** Bytes read so far, across the whole run. */
    readonly bytesRead: number;
    /**
     * Bytes the whole run will read — the sum of the mail files under every source, so the
     * percentage means the archive rather than the file currently being read. 0 when unknown.
     */
    readonly bytesTotal: number;
    /** Messages per second, over the run so far. */
    readonly rate: number;
    /** Bytes per second, over the run so far. */
    readonly bytesRate: number;
    /** Seconds until done, by the byte rate. -1 when it cannot be estimated. */
    readonly eta: number;
    /** Messages that could not be verified. */
    readonly errors: number;
}

/** The file's path inside a case folder. */
export function statusFile(paths: CasePaths): string {
    return join(paths.root, IMPORT_STATUS_NAME);
}

/** The status file's content, or `undefined` when there is none or it cannot be trusted. */
export function readImportStatus(paths: CasePaths): ImportStatus | undefined {
    let text: string;
    try {
        text = readFileSync(statusFile(paths), 'utf8');
    } catch {
        return undefined;
    }
    let parsed: Partial<ImportStatus>;
    try {
        parsed = JSON.parse(text) as Partial<ImportStatus>;
    } catch {
        return undefined;
    }
    // Refused rather than repaired: a file this build cannot fully make sense of is not a
    // progress report but a guess, and the same rule `openCase` applies to a case marker it
    // does not understand. A file from a NEWER build is refused for the same reason.
    if (typeof parsed.version !== 'number' || parsed.version > IMPORT_STATUS_VERSION) return undefined;
    if (typeof parsed.state !== 'string' || !STATES.includes(parsed.state as ImportState)) return undefined;
    const numbers: (keyof ImportStatus)[] = [
        'pid',
        'mailsDone',
        'mailsTotal',
        'bytesRead',
        'bytesTotal',
        'rate',
        'bytesRate',
        'eta',
        'errors',
    ];
    if (typeof parsed.pid !== 'number') return undefined;
    for (const field of numbers) if (typeof parsed[field] !== 'number') return undefined;
    if (typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string') return undefined;
    if (!Array.isArray(parsed.sources)) return undefined;
    return parsed as ImportStatus;
}

/** Write the status atomically: a reader sees the old snapshot or the new one, never a torn one. */
export function writeImportStatus(paths: CasePaths, status: ImportStatus): void {
    const target = statusFile(paths);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, undefined, 2)}\n`);
    renameSync(tmp, target);
}

/**
 * Is a `running` status file describing an import that is no longer running?
 *
 * Two independent reasons, and either one is enough: the process is gone (killed, crashed,
 * another machine's PID that was reused), or the file has not been updated for
 * {@link STATUS_STALE_SECONDS} — the second guard for a PID that has been recycled by an
 * unrelated process. A finished, failed or cancelled file is never orphaned: it is a record.
 */
export function orphanedImport(status: ImportStatus, now: number = Date.now()): boolean {
    if (status.state !== 'running') return false;
    if (status.pid > 0 && !processAlive(status.pid)) return true;
    const at = Date.parse(status.updatedAt);
    if (!Number.isFinite(at)) return true;
    return now - at > STATUS_STALE_SECONDS * 1000;
}

/**
 * Is a process alive?
 *
 * `/proc` first: asking the kernel through the process directory needs no signal semantics. Where
 * there is no `/proc` (macOS), `kill(pid, 0)` asks instead — only `ESRCH` means "gone"; `EPERM`
 * is a live process of another user. Any other failure (Windows, a runtime without `kill`) reads
 * as "alive", never "gone": a wrong "gone" would call every running import interrupted, and the
 * staleness check still catches a dead one within a minute.
 */
export function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        if (existsSync('/proc/self')) return existsSync(`/proc/${pid}`);
    } catch {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown } | null)?.code !== 'ESRCH';
    }
}

/** Mark the running import cancelled. No-op when nothing is running — a record is not rewritten. */
export function cancelImportStatus(paths: CasePaths, now: number = Date.now()): ImportStatus | undefined {
    const status = readImportStatus(paths);
    if (status === undefined || status.state !== 'running') return undefined;
    const next: ImportStatus = { ...status, state: 'cancelled', updatedAt: new Date(now).toISOString() };
    writeImportStatus(paths, next);
    return next;
}

/** How often the handle writes while the run is going. The end states are written at once. */
const WRITE_INTERVAL_MS = 1000;

/** What a caller driving an import wires into it: one method per moment of the run. */
export interface ImportStatusHandle {
    /** Called with every progress snapshot; throttled to about one write per second. */
    update(progress: ImportProgress): void;
    /** The run is over and produced a result. The file keeps this state. */
    finish(result: ImportResult): void;
    /** The run threw. The file says `failed`; the error itself is reported by the caller. */
    fail(): void;
    /** The caller stopped the run and wants the file to say so. */
    cancel(): void;
}

export interface ImportStatusOptions {
    /** Defaults to the current process. 0 when the runtime does not say — staleness still works. */
    readonly pid?: number;
    /** The clock, injectable so the throttle and the timestamps are testable. */
    readonly now?: () => number;
    /** How the sources will be read. `sources` unless the caller says otherwise. */
    readonly mode?: ImportMode;
    /** Bytes of the whole run, when the caller already measured them; measured here otherwise. */
    readonly bytesTotal?: number;
}

/**
 * Begin writing the status file for a run about to start.
 *
 * Writes the `running` snapshot immediately — a reader that polls before the first message is
 * read must find a file rather than nothing, or a fast import and a never-started one look
 * alike. The caller passes {@link ImportStatusHandle.update} as the import's progress hook;
 * nothing here reaches into the importer.
 */
export function beginImportStatus(
    paths: CasePaths,
    sources: readonly string[],
    options: ImportStatusOptions = {},
): ImportStatusHandle {
    const now = options.now ?? Date.now;
    const pid = options.pid ?? (typeof process.pid === 'number' ? process.pid : 0);
    const bytesTotal = options.bytesTotal ?? plannedImportBytes(sources, options.mode);
    const started = new Date(now()).toISOString();
    let snapshot: ImportStatus = {
        version: IMPORT_STATUS_VERSION,
        state: 'running',
        pid,
        startedAt: started,
        updatedAt: started,
        sources: [...sources],
        mailsDone: 0,
        mailsTotal: 0,
        bytesRead: 0,
        bytesTotal,
        rate: 0,
        bytesRate: 0,
        eta: -1,
        errors: 0,
    };
    // The latest progress, kept apart from the last one WRITTEN: the throttle drops writes, not
    // facts, and the final state must carry the counts of the very last message.
    let latest: ImportProgress | undefined;
    let writtenAt = now();
    writeImportStatus(paths, snapshot);

    return {
        update(progress: ImportProgress): void {
            latest = progress;
            const at = now();
            if (at - writtenAt < WRITE_INTERVAL_MS) return;
            writtenAt = at;
            snapshot = statusAt(snapshot, progress, at);
            writeImportStatus(paths, snapshot);
        },
        finish(result: ImportResult): void {
            const at = now();
            snapshot = {
                ...statusAt(snapshot, latest, at),
                state: 'finished',
                // The estimate is about a run that is over; 0 rather than a leftover number.
                eta: 0,
                // Every source was consumed; a part that yielded less than its file size (From
                // lines, separators) must not leave the finished run at 97 %.
                bytesRead: Math.max(snapshot.bytesTotal, latest?.bytesRead ?? 0),
                mailsDone: result.read,
                errors: result.failed,
            };
            writeImportStatus(paths, snapshot);
        },
        fail(): void {
            const at = now();
            snapshot = { ...statusAt(snapshot, latest, at), state: 'failed', eta: 0 };
            writeImportStatus(paths, snapshot);
        },
        cancel(): void {
            const at = now();
            snapshot = { ...statusAt(snapshot, latest, at), state: 'cancelled', eta: 0 };
            writeImportStatus(paths, snapshot);
        },
    };
}

/**
 * The snapshot one progress line produces, rates and estimate included.
 *
 * The rates are over the WHOLE run, not a moving average: a moving average needs a history the
 * snapshot does not carry, and an ETA that swings is an ETA nobody believes. The ETA is by
 * BYTES, because the byte total spans every source while `total` is the current one's.
 */
function statusAt(base: ImportStatus, progress: ImportProgress | undefined, at: number): ImportStatus {
    const updatedAt = new Date(at).toISOString();
    if (progress === undefined) return { ...base, updatedAt };
    const elapsed = Math.max((at - Date.parse(base.startedAt)) / 1000, 0.001);
    const bytesRead = progress.bytesRead ?? 0;
    const bytesRate = Math.round(bytesRead / elapsed);
    const remaining = Math.max(base.bytesTotal - bytesRead, 0);
    return {
        ...base,
        updatedAt,
        mailsDone: progress.read,
        mailsTotal: progress.total,
        bytesRead,
        rate: Math.round((progress.read / elapsed) * 10) / 10,
        bytesRate,
        eta: base.bytesTotal > 0 && bytesRate > 0 ? Math.round(remaining / bytesRate) : -1,
        errors: progress.failed,
        ...(progress.mailbox === undefined ? {} : { mailbox: progress.mailbox }),
    };
}

/**
 * How many bytes a run over these sources will read.
 *
 * The sum of the MAIL files under every source — a folder of mailboxes adds the size of every
 * part, a Maildir the messages in `new/` and `cur/`. A file that cannot be measured adds 0,
 * which lowers the total rather than lying high: the estimate is an ETA's denominator, and a
 * percentage that can exceed 100 is worse than one that stalls short of it. Both readers agree
 * on what a mail file is, so the same tree plan answers for the plain mode and the folder mode
 * alike — with one walk instead of one per mode to keep in sync.
 */
export function plannedImportBytes(sources: readonly string[], mode: ImportMode = 'sources'): number {
    void mode; // Both modes read the same mail files; the mode decides how they are GROUPED.
    let total = 0;
    for (const source of sources) total += sourceBytes(source);
    return total;
}

/** The bytes one source contributes: the file itself, or the mail files under a directory. */
function sourceBytes(source: string): number {
    let stats: ReturnType<typeof statSync>;
    try {
        stats = statSync(source);
    } catch {
        return 0;
    }
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
    let total = 0;
    try {
        for (const mailbox of planFolder(source).mailboxes) {
            for (const part of mailbox.parts) {
                total += part.kind === 'maildir' ? maildirBytes(part.path) : part.bytes;
            }
        }
    } catch {
        // An unreadable tree contributes nothing rather than ending the run before it started;
        // the importer will report why when it gets there.
    }
    return total;
}

/** The messages in a Maildir's `new/` and `cur/` — `tmp/` is a half-delivered message. */
function maildirBytes(path: string): number {
    let total = 0;
    for (const box of ['new', 'cur']) {
        let entries: string[];
        try {
            entries = readdirSync(join(path, box));
        } catch {
            continue;
        }
        for (const entry of entries) {
            try {
                const stats = statSync(join(path, box, entry));
                if (stats.isFile()) total += stats.size;
            } catch {
                // A message that vanished mid-plan is the delivery agent's tmp move, not an error.
            }
        }
    }
    return total;
}
