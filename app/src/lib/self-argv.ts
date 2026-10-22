/**
 * The argv that starts a second copy of this program, on whichever runtime runs it.
 *
 * The window runs an import as a subprocess of itself. GJS needs `-m` to load the bundle as a
 * module; Node treats `-m` as an unknown option and exits 9, which is what the macOS build (Node
 * plus node-gi) did on every import from the window.
 */

export interface SelfHost {
    readonly execPath: string;
    readonly execArgv: readonly string[];
    readonly argv: readonly string[];
    readonly versions: Readonly<Record<string, string | undefined>>;
}

/** `[interpreter, …flags, entry]`, or null when the entry is not a script this host can run. */
export function selfArgv(host: SelfHost): string[] | null {
    const entry = host.argv[1];
    if (entry === undefined || !/\.[cm]?js$/.test(entry)) return null;
    if (host.execPath === '') return null;
    if (host.versions.gjs === undefined) return [host.execPath, ...host.execArgv, entry];
    // gjsify gap (unfixed, gjsify/gjsify#2348): process.execArgv is [] on GJS, not ['-m'].
    const flags = host.execArgv.includes('-m') ? host.execArgv : ['-m', ...host.execArgv];
    return [host.execPath, ...flags, entry];
}
