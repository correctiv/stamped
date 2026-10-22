/**
 * The semantic layer's controller: it owns the lifecycle of the vector index.
 *
 * THE APP COMPOSES THE TWO PACKAGES, and this is where it happens. `@stamped/semantic` knows how
 * to embed and how to walk a document source; `@stamped/store` knows where a case folder keeps
 * its files. Neither knows about the other, and this controller is the only place where the two
 * meet — the same seam `document-source.ts` already draws on the store side.
 *
 * WHAT IT OWNS:
 *
 * - **Enable** → probe the machine if nothing has been measured yet → start the indexer.
 * - **Disable** → stop the indexer → keep `vectors.db` (the hours of embedding are not thrown
 *   away; switching the feature off is not the same as asking for the work to be redone).
 * - **Pause on battery, resume on mains** → the indexer's own `shouldPause` predicate does the
 *   waiting; the controller says WHICH reason a pause has, because "paused" without a reason is
 *   a state nobody can act on.
 * - **Resume after a restart** → the setting says the feature is on, and the indexer asks the
 *   vector table what is still missing. Nothing else has to be remembered.
 *
 * THE EMBEDDER IS INJECTED, as a FACTORY: a runtime without the model runtime answers
 * `undefined`, and that is shown as "not available here" rather than thrown. The whole layer is
 * therefore testable against a deterministic fake, with no model and no download.
 *
 * THE CLOCK IS INJECTED TOO, because the remaining time is measured against it and a test that
 * cannot move time cannot test an estimate.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
    countVectors,
    createIndexer,
    openVectorDb,
    probeEmbedder,
    sampleForProbe,
    type DocumentSource,
    type Embedder,
    type Indexer,
    type IndexerProgress,
} from '@stamped/semantic';
import {
    readSemanticRunStatus,
    readSemanticSetting,
    SEMANTIC_SETTING_VERSION,
    SEMANTIC_STATUS_VERSION,
    type CasePaths,
    type SemanticPauseReason,
    type SemanticRunState,
    type SemanticRunStatus,
    type SemanticSetting,
    writeSemanticRunStatus,
    writeSemanticSetting,
} from '@stamped/store';

import {
    probeRemainingSeconds,
    semanticState,
    throughputRate,
    type SemanticSnapshot,
    type SemanticState,
    type ThroughputSample,
} from './semantic-state.ts';

/** How often the run status is written while the work goes on. */
const WRITE_INTERVAL_MS = 1000;

export interface SemanticControllerOptions {
    /** The case folder: the setting and the run status live in it. */
    readonly paths: CasePaths;
    /**
     * The embedder, or `undefined` when this runtime cannot embed at all.
     *
     * A factory and not an embedder: loading a model takes seconds and a gigabyte, and the
     * controller must not pay for that before the person has asked for it.
     */
    readonly createEmbedder: () => Promise<Embedder | undefined>;
    /** The messages of the case, in the order the indexer walks them. */
    readonly source: DocumentSource;
    /** Is the machine running on its battery? Asked before every batch. */
    readonly onBattery?: () => boolean;
    /** The clock; injectable so the estimate and the timestamps are testable. */
    readonly now?: () => number;
    /** Documents per batch; the indexer's own default when absent. */
    readonly batchSize?: number;
    /** How often a held run asks again whether it may go on. */
    readonly pollMs?: number;
    /** Called whenever the state changes. */
    readonly onProgress?: (state: SemanticState) => void;
}

export interface SemanticController {
    /** The state right now. */
    state(): SemanticState;
    /** The setting of the case, for whoever wants to show the estimate. */
    setting(): SemanticSetting | undefined;
    /** Switch semantic search on: measure the machine if needed, then index. */
    enable(): Promise<SemanticState>;
    /** Switch it off: the run stops, the vectors stay. */
    disable(): Promise<SemanticState>;
    /** Start or continue the indexing — also what a restart does when the setting says on. */
    start(): Promise<SemanticState>;
    /** Hold the run at the next batch boundary. */
    pause(): void;
    /** Go on after a pause. */
    resume(): void;
    /** Resolves when the current run has come to an end. */
    settled(): Promise<void>;
}

export function createSemanticController(options: SemanticControllerOptions): SemanticController {
    const now = options.now ?? Date.now;
    const battery = options.onBattery ?? (() => false);

    let setting: SemanticSetting | undefined = readSemanticSetting(options.paths);
    let run: SemanticRunStatus | undefined = readSemanticRunStatus(options.paths);
    let indexer: Indexer | undefined;
    let vectors: DatabaseSync | undefined;
    let running: Promise<void> | undefined;
    /** Whether the PERSON paused the run; the battery is the other reason, and it is not this one. */
    let userPaused = false;
    let writtenAt = 0;
    /** The measurements of the running indexer, for the moving window. */
    const samples: ThroughputSample[] = [];

    const snapshot = (): SemanticSnapshot => ({ setting, run });

    const state = (): SemanticState => semanticState(snapshot(), now());

    const publish = (): void => {
        try {
            options.onProgress?.(state());
        } catch {
            // A listener's error is not the index's.
        }
    };

    /** Write the run status, at most about once a second. */
    const writeRun = (force: boolean): void => {
        if (run === undefined) return;
        const at = now();
        if (!force && at - writtenAt < WRITE_INTERVAL_MS) return;
        writtenAt = at;
        writeSemanticRunStatus(options.paths, run);
    };

    /** A new snapshot of the run, written out and announced. */
    const setRun = (
        next: { state: SemanticRunState } & Partial<Omit<SemanticRunStatus, 'state' | 'version'>>,
        force = false,
    ): void => {
        // A change of state is always written; only the numbers inside a state are throttled.
        // "The run paused" is a fact a reader in another terminal must not miss because the last
        // progress line was a second ago.
        const changed = run === undefined || run.state !== next.state;
        run = {
            version: SEMANTIC_STATUS_VERSION,
            done: 0,
            total: 0,
            updatedAt: new Date(now()).toISOString(),
            pid: typeof process.pid === 'number' ? process.pid : 0,
            ...next,
        };
        writeRun(force || changed);
        publish();
    };

    /**
     * The seconds left.
     *
     * The running indexer's own throughput, over a moving window — and the probe's estimate only
     * while there is not enough measured yet. The spike's three-second probe was off by 32 % in
     * one run out of six, which is good enough to decide whether to switch the feature on and
     * not good enough to promise an hour.
     */
    const estimateRemaining = (done: number, total: number): number | undefined => {
        const rate = throughputRate(samples, now());
        if (rate !== undefined && rate > 0) return Math.max(0, total - done) / rate;
        return probeRemainingSeconds(setting?.probe, done, total);
    };

    /** Why a pause is a pause. */
    const pauseReason = (): SemanticPauseReason => (userPaused ? 'user' : 'battery');

    /** The indexer's own progress, turned into the app's state. */
    const onIndexerProgress = (progress: IndexerProgress): void => {
        switch (progress.state) {
            case 'running':
                // Only work counts as a measurement: a run that waits says nothing about how
                // fast this machine is.
                samples.push({ at: now(), done: progress.done });
                setRun({
                    state: 'indexing',
                    done: progress.done,
                    total: progress.total,
                    remainingSeconds: estimateRemaining(progress.done, progress.total),
                });
                break;
            case 'paused':
                setRun({
                    state: 'paused',
                    done: progress.done,
                    total: progress.total,
                    pausedReason: pauseReason(),
                });
                break;
            default:
                // 'finished', 'stopped' and 'failed' are settled when the run itself ends.
                break;
        }
    };

    const start = async (): Promise<SemanticState> => {
        const current = setting;
        if (current === undefined || !current.enabled) return state();
        if (running !== undefined) return state();

        const embedder = await options.createEmbedder();
        if (embedder === undefined) {
            // No model runtime here. Said plainly, and the app carries on without it.
            setRun({ state: 'unavailable' }, true);
            return state();
        }

        try {
            vectors = openVectorDb(options.paths.vectors, {
                modelId: embedder.modelId,
                dimensions: embedder.dimensions,
            });
        } catch (error) {
            setRun({ state: 'failed', error: messageOf(error) }, true);
            return state();
        }

        const total = options.source.count();
        const done = countVectors(vectors);
        samples.length = 0;

        // The probe runs when there is no measurement, and when the last one was for another
        // model: a measurement of a different model says nothing about this one.
        const measured = current.probe !== undefined && current.probe.modelId === embedder.modelId;
        let next: SemanticSetting = {
            ...current,
            enabled: true,
            modelId: embedder.modelId,
            dimensions: embedder.dimensions,
        };
        if (!measured && total > done) {
            setRun({ state: 'probing', done, total }, true);
            try {
                const sample = sampleForProbe(options.source);
                const probe = await probeEmbedder(embedder, sample, total - done, { now });
                next = {
                    ...next,
                    probe: {
                        modelId: embedder.modelId,
                        tokensPerSecond: probe.tokensPerSecond,
                        estimatedHours: probe.estimatedSeconds / 3600,
                        recommendation: probe.recommendation,
                        measuredAt: new Date(now()).toISOString(),
                    },
                };
            } catch (error) {
                // The measurement itself broke: the embedder is not working, and that is the
                // answer the case gets.
                setRun({ state: 'failed', error: messageOf(error) }, true);
                vectors?.close();
                vectors = undefined;
                return state();
            }
        }
        if (!sameSetting(next, current)) {
            setting = next;
            writeSemanticSetting(options.paths, next);
        }

        indexer = createIndexer({
            embedder,
            source: options.source,
            vectors,
            now,
            ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
            ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
            shouldPause: () => battery(),
            onProgress: onIndexerProgress,
        });
        const started = indexer;
        // A pause the person asked for before the run started still counts.
        if (userPaused) started.pause();
        running = started
            .run()
            .then(
                (result) => {
                    if (result.state === 'finished') {
                        setRun({ state: 'ready', done: result.done, total: result.total }, true);
                    } else {
                        // Stopped on purpose: the vectors stay, and the run continues later.
                        setRun(
                            {
                                state: 'paused',
                                done: result.done,
                                total: result.total,
                                pausedReason: 'user',
                            },
                            true,
                        );
                    }
                },
                (error: unknown) => {
                    setRun({ state: 'failed', error: messageOf(error) }, true);
                },
            )
            .finally(() => {
                vectors?.close();
                vectors = undefined;
                if (indexer === started) indexer = undefined;
                running = undefined;
            });
        return state();
    };

    const enable = async (): Promise<SemanticState> => {
        const base: SemanticSetting = setting ?? {
            version: SEMANTIC_SETTING_VERSION,
            enabled: true,
        };
        setting = { ...base, enabled: true };
        writeSemanticSetting(options.paths, setting);
        return start();
    };

    const disable = async (): Promise<SemanticState> => {
        const base: SemanticSetting = setting ?? {
            version: SEMANTIC_SETTING_VERSION,
            enabled: false,
        };
        setting = { ...base, enabled: false };
        writeSemanticSetting(options.paths, setting);
        indexer?.stop();
        const pending = running;
        if (pending !== undefined) await pending;
        return state();
    };

    const pause = (): void => {
        userPaused = true;
        indexer?.pause();
        if (run !== undefined) {
            setRun({
                state: 'paused',
                done: run.done,
                total: run.total,
                pausedReason: 'user',
            });
        }
    };

    const resume = (): void => {
        userPaused = false;
        indexer?.resume();
    };

    const settled = async (): Promise<void> => {
        const pending = running;
        if (pending !== undefined) await pending;
    };

    return {
        state,
        setting: () => setting,
        enable,
        disable,
        start,
        pause,
        resume,
        settled,
    };
}

/** Did the setting change? A file that is rewritten for nothing is a file nobody can trust. */
function sameSetting(a: SemanticSetting, b: SemanticSetting): boolean {
    return (
        a.enabled === b.enabled &&
        a.modelId === b.modelId &&
        a.dimensions === b.dimensions &&
        a.probe?.modelId === b.probe?.modelId &&
        a.probe?.tokensPerSecond === b.probe?.tokensPerSecond &&
        a.probe?.estimatedHours === b.probe?.estimatedHours &&
        a.probe?.recommendation === b.probe?.recommendation &&
        a.probe?.measuredAt === b.probe?.measuredAt
    );
}

/** What to tell the user when something threw. */
function messageOf(error: unknown): string {
    if (error instanceof Error && error.message !== '') return error.message;
    return String(error);
}
