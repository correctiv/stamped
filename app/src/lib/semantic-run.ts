/**
 * The semantic index as a SUBPROCESS: the argv that starts it, the test for "a run is already
 * going", the CLI's run-to-the-end, and the window's side of the arrangement.
 *
 * WHY A PROCESS: embedding runs for hours and holds a model of about 300 MB. In the window it
 * died with the window and shared its memory and its main loop; as `stamped semantic index` it
 * is the same shape as the import — started by the window or by a terminal, observed through
 * `semantic-status.json`, and finished or resumed regardless of who started it.
 *
 * THE WINDOW KEEPS THE `SemanticController` INTERFACE, so the settings dialog and the activity
 * row do not know the difference: {@link createSubprocessSemantic} answers from the case folder's
 * two files and turns enable / disable / pause / resume into starting and ending the process.
 * Only a process the window started itself is ever ended by it; a run from a terminal is shown
 * and left alone.
 */

import {
    processAlive,
    readSemanticRunStatus,
    readSemanticSetting,
    SEMANTIC_SETTING_VERSION,
    staleSemanticRun,
    writeSemanticSetting,
    type CasePaths,
    type SemanticRunStatus,
    type SemanticSetting,
} from '@stamped/store';

import type { SemanticController } from './semantic.ts';
import { semanticState, type SemanticState } from './semantic-state.ts';

/** `[…interpreter, 'semantic', 'index', '--case', root]`, or null when no binary can be found. */
export function semanticArgv(
    self: readonly string[] | null,
    found: string | null,
    root: string,
): string[] | null {
    const tail = ['semantic', 'index', '--case', root];
    if (self !== null) return [...self, ...tail];
    if (found !== null) return [found, ...tail];
    return null;
}

/**
 * Is a process working on this case's index right now?
 *
 * A `probing`/`indexing` file needs a fresh update AND a living pid; a `paused` file is never
 * stale (it waits on purpose), so only its pid says whether the process that holds it is there.
 * A pid of 0 means the writer did not say: a fresh working file is believed, a paused one is not.
 */
export function liveSemanticRun(
    status: SemanticRunStatus | undefined,
    now: number = Date.now(),
    alive: (pid: number) => boolean = processAlive,
): boolean {
    if (status === undefined) return false;
    if (status.state === 'probing' || status.state === 'indexing') {
        if (staleSemanticRun(status, now)) return false;
        return status.pid <= 0 || alive(status.pid);
    }
    if (status.state === 'paused') return status.pid > 0 && alive(status.pid);
    return false;
}

/** The two things `stamped semantic index` needs from the outside: a controller and a signal hook. */
export interface SemanticIndexRun {
    readonly controller: SemanticController;
    /** Call `handler` on SIGTERM / SIGINT; returns the function that removes the hook. */
    readonly onSignal: (handler: () => void) => () => void;
}

/**
 * Run the indexing to its end, or until a signal asks for the stop.
 *
 * The stop goes through the controller, so the indexer finishes its batch, `vectors.db` stays
 * as it is and the status says `paused`: the next run continues from the vectors. A case whose
 * setting is off indexes nothing — the command obeys the setting the window and the dialog write.
 */
export async function runSemanticIndex(run: SemanticIndexRun): Promise<SemanticState> {
    let stopping: Promise<void> | undefined;
    const release = run.onSignal(() => {
        stopping ??= run.controller.stop();
    });
    try {
        await run.controller.start();
        await run.controller.settled();
        await stopping;
    } finally {
        release();
    }
    return run.controller.state();
}

/** A process the window started: end it, and know when it is gone. */
export interface SemanticProcess {
    /** Ask it to stop (SIGTERM); it keeps `vectors.db`. */
    terminate(): void;
    /** Resolves when the process has exited. */
    readonly exited: Promise<void>;
}

export interface SubprocessSemanticOptions {
    readonly paths: CasePaths;
    /** Start `stamped semantic index` for this case. */
    readonly spawn: () => SemanticProcess;
    /** A fresh in-process controller, used only to measure the machine (`probeOnly`). */
    readonly probeController: () => SemanticController;
    /** Is an import running? The index waits for it. */
    readonly importRunning: () => boolean;
    /** Called with the derived state on every {@link SubprocessSemantic.poll}. */
    readonly onState?: (state: SemanticState) => void;
    readonly now?: () => number;
    readonly alive?: (pid: number) => boolean;
}

export interface SubprocessSemantic extends SemanticController {
    /** One tick: relaunch after an import, stop for one, report the state. */
    poll(): void;
}

export function createSubprocessSemantic(options: SubprocessSemanticOptions): SubprocessSemantic {
    const now = options.now ?? Date.now;
    const alive = options.alive ?? processAlive;

    let proc: SemanticProcess | undefined;
    /** The person paused it: nothing starts it again but them. */
    let held = false;
    /** Something wanted a start while an import ran; it happens when the import is over. */
    let deferred = false;
    let wasImporting = false;

    const setting = (): SemanticSetting | undefined => readSemanticSetting(options.paths);

    const live = (): boolean => liveSemanticRun(readSemanticRunStatus(options.paths), now(), alive);

    const state = (): SemanticState => {
        const current = setting();
        let run = readSemanticRunStatus(options.paths);
        // A working file whose process is gone is an interrupted run, not a running one.
        if (
            run !== undefined &&
            (run.state === 'probing' || run.state === 'indexing') &&
            run.pid > 0 &&
            !alive(run.pid)
        ) {
            run = { ...run, updatedAt: new Date(0).toISOString() };
        }
        return semanticState({ ...(current === undefined ? {} : { setting: current }), ...(run === undefined ? {} : { run }) }, now());
    };

    const launch = (): void => {
        const started = options.spawn();
        proc = started;
        deferred = false;
        const forget = (): void => {
            if (proc === started) proc = undefined;
        };
        started.exited.then(forget, forget);
    };

    const terminate = async (): Promise<void> => {
        const running = proc;
        if (running === undefined) return;
        running.terminate();
        await running.exited.catch(() => undefined);
    };

    const start = async (): Promise<SemanticState> => {
        const current = setting();
        if (current === undefined || !current.enabled) return state();
        if (proc !== undefined || live() || held) return state();
        if (options.importRunning()) {
            deferred = true;
            return state();
        }
        launch();
        return state();
    };

    const write = (enabled: boolean): void => {
        const base: SemanticSetting = setting() ?? { version: SEMANTIC_SETTING_VERSION, enabled };
        writeSemanticSetting(options.paths, { ...base, enabled });
    };

    return {
        state,
        setting,
        start,
        async enable() {
            write(true);
            held = false;
            return start();
        },
        async disable() {
            write(false);
            held = false;
            deferred = false;
            await terminate();
            return state();
        },
        async probeOnly() {
            // A run that is going has measured already, and a second model load would compete.
            if (proc !== undefined || live()) return setting();
            return options.probeController().probeOnly();
        },
        async stop() {
            deferred = false;
            await terminate();
        },
        pause() {
            held = true;
            void terminate();
        },
        resume() {
            held = false;
            void start();
        },
        async settled() {
            await proc?.exited.catch(() => undefined);
        },
        poll() {
            const importing = options.importRunning();
            // The import wins the machine: end our run, and go on when the import is over — which
            // is also when there is new mail to index.
            if (importing && proc !== undefined) {
                deferred = true;
                void terminate();
            }
            if (wasImporting && !importing) deferred = true;
            wasImporting = importing;
            if (deferred && !importing) void start();
            try {
                options.onState?.(state());
            } catch {
                // A listener's error is not the index's.
            }
        },
    };
}
