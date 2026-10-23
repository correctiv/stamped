/**
 * `node:child_process` for a bundle — the one import node-llama-cpp needs that GJS cannot give.
 *
 * WHY THIS FILE EXISTS: node-llama-cpp's `getLlama()` reaches `utils/testBindingBinary.js`, which
 * imports `fork` AT MODULE LEVEL to run the binary self-test in a child process.
 * `@gjsify/child_process` has no `fork` — that needs an IPC channel to a second interpreter — so
 * a GJS bundle fails to LINK on the missing named export, long before anything runs. The code is
 * dead there anyway: the GJS embedder bypasses `getLlama` and calls `Llama._create` itself.
 *
 * WHY IT ASKS THE RUNTIME INSTEAD OF STUBBING: the alias that routes `node:child_process` here is
 * declared in `gjsify.aliases`, which applies to EVERY target — the gjs bundle, the node bundle
 * and both test bundles. A GJS-shaped stub would therefore take `child_process` away from the
 * node build as well, and there `getLlama` really does fork. So this module picks the
 * implementation at run time: Node's own builtin when there is one, the GJS polyfill otherwise,
 * and a named function that throws for whatever the chosen one does not have.
 *
 * `process.getBuiltinModule` is the one acquisition a bundler leaves alone — a method call, not
 * an import, so the alias above cannot catch it and route it back into this file.
 *
 * gjsify gap, unfixed: `fork` in `@gjsify/child_process` (no IPC channel between GJS processes).
 */

import * as gjsChildProcess from '@gjsify/child_process';

type AnyFn = (...args: never[]) => unknown;

function builtinChildProcess(): Record<string, unknown> | undefined {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    if (typeof proc?.getBuiltinModule !== 'function') return undefined;
    try {
        return proc.getBuiltinModule('node:child_process') as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

const impl: Record<string, unknown> =
    builtinChildProcess() ?? (gjsChildProcess as unknown as Record<string, unknown>);

/** A placeholder that names itself: a bundle must link, but a call must not silently do nothing. */
function unavailable(name: string): AnyFn {
    return (): never => {
        throw new Error(`child_process.${name}() is not available on this runtime`);
    };
}

function pick(name: string): AnyFn {
    const value = impl[name];
    return typeof value === 'function' ? (value as AnyFn) : unavailable(name);
}

export const exec = pick('exec');
export const execFile = pick('execFile');
export const execFileSync = pick('execFileSync');
export const execSync = pick('execSync');
export const fork = pick('fork');
export const spawn = pick('spawn');
export const spawnSync = pick('spawnSync');

export default impl;
