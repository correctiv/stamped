import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

import type { HelperChannel } from '../lib/embed-client.ts';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

/**
 * Start `stamped semantic embed` with a pipe each way. Its stderr is the window's, so the GPU
 * guard's notice reaches a terminal; its stdout is the wire, read one line at a time.
 */
export function spawnEmbedHelper(argv: string[], onLine: (line: string) => void): HelperChannel {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    const stdin = proc.get_stdin_pipe();
    const stdout = proc.get_stdout_pipe();
    const exited = new Promise<void>((resolve) => {
        proc.wait_async(null, () => resolve());
    });
    const decoder = new TextDecoder();
    if (stdout !== null) {
        const reader = new Gio.DataInputStream({ base_stream: stdout });
        void (async () => {
            try {
                for (;;) {
                    const [bytes] = (await reader.read_line_async(
                        GLib.PRIORITY_DEFAULT,
                        null,
                    )) as unknown as [Uint8Array | null, number];
                    if (bytes === null) break;
                    onLine(decoder.decode(bytes));
                }
            } catch {
                // the pipe went with the process
            }
        })();
    }
    const encoder = new TextEncoder();
    return {
        send: (line) => {
            stdin?.write_all(encoder.encode(`${line}\n`), null);
        },
        close: () => {
            try {
                stdin?.close(null);
            } catch {
                // already closed
            }
        },
        kill: () => {
            try {
                proc.send_signal(9);
            } catch {
                // already gone
            }
        },
        exited,
    };
}
