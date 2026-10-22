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

import { importCommand } from './commands/import.ts';
import { keysCommand } from './commands/keys.ts';
import { peopleCommand } from './commands/people.ts';
import { reportCommand } from './commands/report.ts';
import { reverifyCommand } from './commands/reverify.ts';
import { searchCommand } from './commands/search.ts';
import { statusCommand } from './commands/status.ts';
import { timelineCommand } from './commands/timeline.ts';
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
            .command(keysCommand())
            .command(importCommand())
            .command(searchCommand())
            .command(reportCommand())
            .command(peopleCommand())
            .command(timelineCommand())
            .command(reverifyCommand())
            .command(statusCommand())
            .demandCommand(1, _('Pick a command. Try `stamped verify --help`.'))
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

/**
 * Run the CLI and return the process's exit code. Never throws.
 *
 * A FUNCTION, and this module runs nothing by itself, because `src/gui/main.ts` is the bundle's
 * entry: it decides from argv whether this is a command or a window, and a module body that
 * parsed argv on import would run the CLI during a GUI launch.
 *
 * NOTHING HERE PUMPS A MAIN LOOP, and that is a change from the version that did — read this
 * before putting one back. The incident the loop was added for is real: on GJS, `verify` printed
 * NOTHING and exited 0, because the process ended at the handler's first `await` with the
 * verification still in flight. What keeps the handler alive now is that the entry module
 * (`gui/main.ts`) uses TOP-LEVEL AWAIT — GJS pumps the main context until an entry module's
 * promise settles, which is the same pump by another owner. Measured against async `Gio` I/O
 * inside a dynamically imported module.
 *
 * A `GLib.MainLoop` here would now HANG instead of helping. `gui/main.ts` reaches this function
 * through `await import(...)`, so this code runs inside a promise job, and GJS does not dispatch
 * further promise jobs while it is draining the queue — `loop.run()` from in there blocks the
 * drain and the `.then` that would quit the loop never fires. Measured: a 2 MB bundle that
 * printed nothing and had to be killed.
 */
export async function runCli(): Promise<number> {
    // yargs can throw SYNCHRONOUSLY for some validation failures even with `.fail(false)`,
    // instead of rejecting. On GJS that surfaces as "Module threw an exception" rather than as a
    // message. Normalising it to a rejection keeps one error path.
    let parsed: Promise<unknown>;
    try {
        parsed = parse();
    } catch (error) {
        parsed = Promise.reject(error);
    }
    try {
        await parsed;
        return 0;
    } catch (error) {
        reportError(error);
        return 2;
    }
}
