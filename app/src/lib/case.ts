/**
 * Naming the path when a case folder is not one.
 *
 * `search` and `report` READ a case; only `import` creates one. That asymmetry is deliberate: a
 * mistyped path handed to `openCase` would silently create an empty case folder next to the real
 * one and then report it as holding nothing — which, in a tool whose answers are about whether a
 * message exists in a leak, is the worst possible way to be wrong. So the reading commands refuse
 * a path that holds no `case.json` and say which path that was.
 */

import { fmt, _ } from '@stamped/core';
import { casePaths, type CasePaths, isCase } from '@stamped/store';

/** The case at `root`, or an error naming it. */
export function caseOrThrow(root: string): CasePaths {
    if (!isCase(root)) {
        throw new Error(
            fmt(_('{path} is not a case folder. Run `stamped import {path} <source>` first.'), {
                path: root,
            }),
        );
    }
    return casePaths(root);
}

/**
 * Where the case folder is, whichever way the operator wrote it.
 *
 * Every command takes the case as its first positional argument OR as `--case <dir>`; the flag
 * wins and leaves all positionals to the command. `fallback` is for the commands that always had
 * a default folder (`keys`, `reverify`). Without one, a missing case is an error that says so,
 * rather than yargs reading the next positional as the case.
 */
export function caseRoot(
    command: string,
    flag: unknown,
    positional: readonly (string | number | undefined)[],
    fallback?: string,
): { root: string; rest: string[] } {
    const given = typeof flag === 'string' && flag !== '' ? flag : undefined;
    const list = positional.filter((value) => value !== undefined).map(String);
    if (given !== undefined) return { root: given, rest: list };
    const [first, ...rest] = list;
    if (first !== undefined) return { root: first, rest };
    if (fallback !== undefined) return { root: fallback, rest: [] };
    throw new Error(
        fmt(_('No case folder given. Use `stamped {command} <case> …` or `--case <dir>`.'), { command }),
    );
}
