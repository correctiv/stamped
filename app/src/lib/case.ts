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
