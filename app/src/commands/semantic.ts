/**
 * `stamped semantic index <case>` — build or continue the semantic index of a case, in this process.
 *
 * What the window starts as a subprocess, and what can be run from a terminal as well: the
 * progress goes to `semantic-status.json`, so either one is visible from the other. The setting
 * decides — a case that is switched off indexes nothing — and a SIGTERM / SIGINT ends the run
 * cleanly, keeping `vectors.db`, so the next run continues where this one stopped. A second run
 * beside a live one is refused, as in the window (`liveSemanticRun`).
 */

import { createInterface } from 'node:readline';

import { fmt, _ } from '@stamped/core';
import { onBattery, ResidentVectors } from '@stamped/semantic';
import {
    indexDocumentSource,
    openIndex,
    readSemanticRunStatus,
    type CasePaths,
    type SemanticRunStatus,
} from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';
import { bufferedLines, serveEmbedder } from '../lib/embed-serve.ts';
import { createGuiEmbedder } from '../lib/semantic-embedder.ts';
import { liveSemanticRun, runSemanticIndex } from '../lib/semantic-run.ts';
import { createSemanticController } from '../lib/semantic.ts';

interface IndexArgs {
    case?: string;
    folder?: string;
}

/** Test seams for {@link refuseLiveRun}: the live-run test's clock and liveness check. */
export interface RefuseOptions {
    readonly now?: number;
    readonly alive?: (pid: number) => boolean;
}

/** Which process holds the case, so the operator can look at it instead of guessing. */
function refuseMessage(status: SemanticRunStatus): string {
    if (status.pid > 0) {
        return fmt(
            _(
                'A semantic index run is already going for this case (pid {pid}). Wait for it to end, or end that process first.',
            ),
            { pid: status.pid },
        );
    }
    // A pid of 0 means the writer did not say — the run is believed, but not named.
    return _(
        'A semantic index run is already going for this case. Wait for it to end, or end that process first.',
    );
}

/**
 * Refuse to start beside a live run, as the window does (`createSubprocessSemantic`).
 *
 * Two indexers on one case write the same vectors to `vectors.db` and leave `semantic-status.json`
 * naming whichever of them wrote last — the other one becomes invisible while it still runs. The
 * status file is only READ here: a refusal must not overwrite the run it is describing.
 */
export function refuseLiveRun(paths: CasePaths, options: RefuseOptions = {}): void {
    const status = readSemanticRunStatus(paths);
    if (status === undefined || !liveSemanticRun(status, options.now, options.alive)) return;
    throw new Error(refuseMessage(status));
}

function indexCommand(): CommandModule<unknown, IndexArgs> {
    return {
        command: 'index [folder]',
        describe: _('Build or continue the semantic index of a case (needs it switched on)'),
        builder: (yargs) =>
            yargs.positional('folder', { describe: _('The case folder'), type: 'string' }).option('case', {
                describe: _('The case folder'),
                type: 'string',
            }),
        handler: async (args) => {
            const startedAt = Date.now();
            const paths = caseOrThrow(caseRoot('semantic index', args.case, [args.folder]).root);
            refuseLiveRun(paths);
            const db = openIndex(paths);
            try {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: createGuiEmbedder,
                    source: indexDocumentSource(db, paths),
                    onBattery,
                });
                const state = await runSemanticIndex({
                    controller,
                    onSignal: (handler) => {
                        process.on('SIGTERM', handler);
                        process.on('SIGINT', handler);
                        return () => {
                            process.off('SIGTERM', handler);
                            process.off('SIGINT', handler);
                        };
                    },
                });
                console.log(fmt(_('Semantic index: {state}'), { state: state.kind }));
                console.log(durationLine(startedAt));
            } finally {
                db.close();
            }
        },
    };
}

function probeCommand(): CommandModule<unknown, IndexArgs> {
    return {
        command: 'probe [folder]',
        describe: _('Measure how fast this machine embeds, and keep the estimate in the case'),
        builder: (yargs) =>
            yargs.positional('folder', { describe: _('The case folder'), type: 'string' }).option('case', {
                describe: _('The case folder'),
                type: 'string',
            }),
        handler: async (args) => {
            const paths = caseOrThrow(caseRoot('semantic probe', args.case, [args.folder]).root);
            refuseLiveRun(paths);
            const db = openIndex(paths);
            try {
                const controller = createSemanticController({
                    paths,
                    createEmbedder: createGuiEmbedder,
                    source: indexDocumentSource(db, paths),
                    onBattery,
                });
                const probe = (await controller.probeOnly())?.probe;
                if (probe === undefined) {
                    console.log(_('No estimate: no model here, or nothing to embed'));
                    return;
                }
                console.log(
                    fmt(
                        _('{rate} tokens/s, about {hours} h for the case, recommendation: {recommendation}'),
                        {
                            rate: Math.round(probe.tokensPerSecond),
                            hours: probe.estimatedHours.toFixed(1),
                            recommendation: probe.recommendation,
                        },
                    ),
                );
            } finally {
                db.close();
            }
        },
    };
}

/**
 * The window's query helper: lines in, lines out, until the window closes the pipe. Not meant
 * for a person — the protocol is `lib/embed-protocol.ts`. Stdout is the wire, so anything else
 * the process says goes to stderr.
 */
function embedCommand(): CommandModule<unknown, IndexArgs> {
    return {
        command: 'embed [folder]',
        describe: _('Answer search queries with their meaning, for the window (not for typing)'),
        builder: (yargs) =>
            yargs.positional('folder', { describe: _('The case folder'), type: 'string' }).option('case', {
                describe: _('The case folder, whose vectors are then searched from memory'),
                type: 'string',
            }),
        handler: async (args) => {
            // Without a case the helper only embeds, as before.
            const root = args.case ?? args.folder;
            const vectorsPath = root === undefined || root === '' ? undefined : caseOrThrow(root).vectors;
            const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
            await serveEmbedder(
                createGuiEmbedder,
                {
                    lines: bufferedLines(rl),
                    write: (line) => {
                        process.stdout.write(`${line}\n`);
                    },
                },
                vectorsPath === undefined
                    ? {}
                    : {
                          resident: (model, onState) =>
                              new ResidentVectors({ path: vectorsPath, model, onState }),
                      },
            );
        },
    };
}

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function semanticCommand(): CommandModule<unknown, unknown> {
    return {
        command: 'semantic',
        describe: _('Semantic search: build the index of a case, or measure how long it takes'),
        builder: (yargs) =>
            yargs
                .command(indexCommand())
                .command(probeCommand())
                .command(embedCommand())
                .demandCommand(1, _('Pick a subcommand. Try `stamped semantic --help`.')),
        handler: () => undefined,
    };
}
