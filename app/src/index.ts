/**
 * The `stamped` binary.
 *
 * One command so far — `verify` — and the layering that makes the rest of the tool possible:
 * the frontend parses arguments and prints, `@stamped/verify` establishes facts, `@stamped/core`
 * decides what may be claimed from them. The planned desktop frontend is a second consumer of
 * the same two packages, not a second implementation of the rules.
 *
 * EXIT CODES. 0 means a report was produced, whatever it says; 2 means Stamped could not produce
 * one (a bad argument, an unreadable file). A broken signature is NOT a failure of this program —
 * mapping "the body was altered" and "no key available" onto one non-zero code is the exact
 * collapse the six verdicts exist to prevent, and a script that treats them alike would file an
 * unverifiable message as a forgery. The verdict is in the output, where it can be read.
 */

import { _ } from '@stamped/core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { verifyCommand } from './commands/verify.ts';
import { initI18n } from './lib/i18n.ts';

/** Build the parser and run it. Returns the promise yargs settles when the command is done. */
function parse(): Promise<unknown> {
    // FIRST, ahead of the parser: yargs evaluates every `describe` string while it is built, and
    // a message already formatted keeps the language it was built in. Inside a function rather
    // than at the top of the module because ESM hoists imports — a call in the module body would
    // still run after every imported module's own body, so each command is a FUNCTION that is
    // invoked from here, after the catalogue is installed.
    initI18n();

    return (
        yargs(hideBin(process.argv))
            .scriptName('stamped')
            .usage(_('stamped <command> [options]'))
            .command(verifyCommand())
            .demandCommand(1, _('Pick a command — try `stamped verify --help`.'))
            .strict()
            .version('0.1.0')
            .help()
            .wrap(Math.min(110, process.stdout.columns ?? 110))
            // Don't let yargs print its own multi-line usage dump and stack trace on a failure: it
            // doubles with the line `reportError` prints, and a trace through yargs and mailauth
            // tells an operator who mistyped a path nothing about which path. `.fail(false)` makes
            // yargs THROW instead of printing; the full command table is still behind `--help`.
            .fail(false)
            .exitProcess(false)
            .parseAsync()
    );
}

/** The message only, never the stack — see `.fail(false)` above. */
function reportError(error: unknown): void {
    console.error(error instanceof Error ? error.message : String(error));
}

// yargs can throw SYNCHRONOUSLY for some validation failures even with `.fail(false)`, instead
// of rejecting. On GJS that surfaces as "Module threw an exception" before the loop below is
// established. Normalising it to a rejection keeps one error path.
let parsed: Promise<unknown>;
try {
    parsed = parse();
} catch (error) {
    parsed = Promise.reject(error);
}

// The same probe the gjsify examples use, inlined so no module graph is pulled in ahead of the
// loop.
const runningOnGjs = typeof (globalThis as { imports?: unknown }).imports !== 'undefined';

if (runningOnGjs) {
    // GJS HAS NO ALWAYS-ON EVENT LOOP, and without one this binary printed NOTHING on a valid
    // message while exiting 0: `verify`'s handler ran, reached its first `await`, and the process
    // ended with the verification still in flight. A GLib main loop keeps the handler alive and
    // pumps its I/O.
    //
    // Quitting when `parsed` settles is safe HERE and would not be in a program with
    // fire-and-forget handlers: yargs awaits an async handler's promise, and every stamped
    // command is one, so a settled `parsed` means the report has been printed.
    //
    // Always leave through `process.exit()` — gjsify idle-schedules `GLib.MainLoop.quit()` with
    // it, while a bare `imports.system.exit()` from an async continuation sets GJS's exit flag
    // without quitting the loop, and hangs.
    const GLib = (
        globalThis as unknown as {
            imports: {
                gi: { GLib: { MainLoop: new (ctx: unknown, running: boolean) => { run(): void } } };
            };
        }
    ).imports.gi.GLib;
    const loop = new GLib.MainLoop(null, false);
    parsed.then(
        () => process.exit(0),
        (error: unknown) => {
            reportError(error);
            process.exit(2);
        },
    );
    loop.run();
} else {
    parsed.catch((error: unknown) => {
        reportError(error);
        process.exitCode = 2;
    });
}
