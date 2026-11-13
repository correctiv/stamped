/**
 * Run `stamped case pack` or `stamped case unpack` for the window, behind a progress dialog.
 *
 * A SEPARATE PROCESS, like the import and the report: both walk every member of the case, which
 * on a real case is minutes of synchronous disk work, and the window must keep repainting. The
 * dialog is modal on purpose — an unpack has nothing else to wait for and a pack reads the case,
 * so letting the person change it underneath would seal a moving target.
 *
 * CANCELLING TAKES THE HALF-WRITTEN PART WITH IT: a pack writes `<file>.part`, an unpack stages
 * into `<folder>.unpacking`, and an unpack that finds a leftover refuses to run again. A stopped
 * process cannot clean up after itself, so the window does.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import { _ } from '@stamped/core';

import { caseFileFraction, parseCaseFileLine, type CaseFileDoneLine } from '../lib/case-file-progress.ts';

export interface CaseFileJob {
    /** The whole command line, `--progress=jsonl` included. */
    readonly argv: readonly string[];
    /** The title of the dialog, e.g. "Saving the case file…". */
    readonly heading: string;
    /** What a stopped job leaves half-done; removed on cancel, and only then. */
    readonly partial: readonly string[];
    /** The reason shown when the process failed without saying why. */
    readonly failed: string;
}

/**
 * The finished run, or `undefined` when the person cancelled. Anything else that goes wrong
 * throws with the reason the process gave.
 */
export async function runCaseFileJob(
    parent: Gtk.Window,
    job: CaseFileJob,
): Promise<CaseFileDoneLine | undefined> {
    const bar = new Gtk.ProgressBar({ showText: false });
    const dialog = new Adw.AlertDialog({ heading: job.heading, body: _('This can take a few minutes.') });
    dialog.set_extra_child(bar);
    dialog.add_response('cancel', _('Cancel'));
    dialog.set_close_response('cancel');

    let cancelled = false;
    let finished = false;
    const proc = Gio.Subprocess.new(
        [...job.argv],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    );
    dialog.connect('response', () => {
        if (finished) return;
        cancelled = true;
        try {
            proc.force_exit();
        } catch {
            // already gone
        }
    });
    // Pulses until the first line says how far it is: a bar at 0 for the length of the check
    // that precedes the first chunk reads as stuck.
    let pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        bar.pulse();
        return GLib.SOURCE_CONTINUE;
    });
    const stopPulse = (): void => {
        if (pulse === 0) return;
        GLib.source_remove(pulse);
        pulse = 0;
    };
    dialog.present(parent);

    const state: { done?: CaseFileDoneLine; note?: string } = {};
    const stdout = proc.get_stdout_pipe();
    const decoder = new TextDecoder();
    const reading = (async () => {
        if (stdout === null) return;
        const reader = new Gio.DataInputStream({ base_stream: stdout });
        try {
            for (;;) {
                const [bytes] = (await reader.read_line_async(GLib.PRIORITY_DEFAULT, null)) as unknown as [
                    Uint8Array | null,
                    number,
                ];
                if (bytes === null) break;
                const text = decoder.decode(bytes);
                const event = parseCaseFileLine(text);
                if (event === undefined) {
                    if (text.trim() !== '') state.note = text.trim();
                } else if (event.phase === 'done') {
                    state.done = event;
                } else if (event.total > 0) {
                    stopPulse();
                    bar.set_fraction(caseFileFraction(event));
                }
            }
        } catch {
            // the pipe went with the process
        }
    })();

    let failure: unknown;
    try {
        await Promise.all([reading, proc.wait_check_async(null)]);
    } catch (error) {
        failure = error;
    }
    finished = true;
    stopPulse();
    dialog.force_close();

    if (cancelled) {
        for (const path of job.partial) removeLeftover(path);
        return undefined;
    }
    if (failure === undefined && state.done !== undefined) return state.done;
    // Not cleaned up here: a job that fails by itself removes its own staging, and one that
    // refused to start because of a leftover must not delete what it did not write.
    throw new Error(state.note?.slice(0, 300) ?? job.failed);
}

/** Remove a file or a folder tree the job was still writing; there may be none. */
function removeLeftover(path: string): void {
    const walk = (file: Gio.File): void => {
        try {
            if (
                file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) ===
                Gio.FileType.DIRECTORY
            ) {
                const children = file.enumerate_children(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null,
                );
                for (let info = children.next_file(null); info !== null; info = children.next_file(null)) {
                    walk(file.get_child(info.get_name()));
                }
            }
            file.delete(null);
        } catch {
            // not there, or not ours to remove
        }
    };
    walk(Gio.File.new_for_path(path));
}
