/**
 * `stamped semantic index <case>` — build or continue the semantic index of a case, in this process.
 *
 * What the window starts as a subprocess, and what can be run from a terminal as well: the
 * progress goes to `semantic-status.json`, so either one is visible from the other. The setting
 * decides — a case that is switched off indexes nothing — and a SIGTERM / SIGINT ends the run
 * cleanly, keeping `vectors.db`, so the next run continues where this one stopped.
 */

import { fmt, _ } from '@stamped/core';
import { onBattery } from '@stamped/semantic';
import { indexDocumentSource, openIndex } from '@stamped/store';
import type { CommandModule } from 'yargs';

import { caseOrThrow, caseRoot } from '../lib/case.ts';
import { durationLine } from '../lib/duration.ts';
import { createGuiEmbedder } from '../lib/semantic-embedder.ts';
import { runSemanticIndex } from '../lib/semantic-run.ts';
import { createSemanticController } from '../lib/semantic.ts';

interface IndexArgs {
    case?: string;
    folder?: string;
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

/** Built on call, not as a literal — see `verifyCommand` on when the catalogue is installed. */
export function semanticCommand(): CommandModule<unknown, unknown> {
    return {
        command: 'semantic',
        describe: _('Semantic search: build the index of a case'),
        builder: (yargs) =>
            yargs
                .command(indexCommand())
                .demandCommand(1, _('Pick a subcommand. Try `stamped semantic --help`.')),
        handler: () => undefined,
    };
}
