/**
 * Is anything working on this case right now?
 *
 * A case file is read in several passes over files an import, a key run or the semantic indexer
 * may be changing: a log line appended between the size and the content, an index mid-transaction.
 * The pack refuses instead of sealing something that never existed in that state. Only status
 * files are READ here, never written: a refusal must not disturb the run it is describing.
 */

import { fmt, _ } from '@stamped/core';
import {
    ACTIVITY_KINDS,
    type CasePaths,
    liveActivity,
    orphanedImport,
    processAlive,
    readImportStatus,
    readSemanticRunStatus,
} from '@stamped/store';

import { liveSemanticRun } from './semantic-run.ts';

export function refuseBusyCase(
    paths: CasePaths,
    now: number = Date.now(),
    alive: (pid: number) => boolean = processAlive,
): void {
    const imported = readImportStatus(paths);
    const busy =
        (imported !== undefined && imported.state === 'running' && !orphanedImport(imported, now)) ||
        ACTIVITY_KINDS.some((kind) => liveActivity(paths, kind, now)) ||
        liveSemanticRun(readSemanticRunStatus(paths), now, alive);
    if (busy) {
        throw new Error(
            fmt(_('Something is still working on {path}: an import, a key run or the semantic index. Wait for it, or stop it, and try again.'), {
                path: paths.root,
            }),
        );
    }
}
