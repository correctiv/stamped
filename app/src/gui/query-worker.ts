/**
 * The second thread: the only place in the window's process that holds an index connection.
 *
 * Built by the gjsify bundler as its own file beside the main bundle, because `query-channel.ts`
 * names it in `new Worker(new URL(…, import.meta.url))`.
 *
 * Deliberately thin. Every question it can answer lives in `lib/queries.ts`, which knows nothing
 * about threads and is what the tests call; this file exposes it over Comlink. `open` (re-sent
 * on every spawn, so a restarted worker reopens the case by itself) and `ping` (is anybody
 * there) are the API's own rather than a query.
 */

// First, and for its side effect: binds the catalogue before any other module is evaluated, so
// the error messages this thread produces are translated. Same rule as `main.ts`, and the reason
// it is safe here is that `i18n-init.ts` pulls in no GTK — a worker has no display.
import './i18n-init.ts';

import * as Comlink from 'comlink';

import { _ } from '@stamped/core';
import { openIndex, type CasePaths } from '@stamped/store';

import {
    isQueryOp,
    runQuery,
    runQueryAsync,
    type QueryContext,
    type QueryRequests,
    type SyncQueryOp,
} from '../lib/queries.ts';

/**
 * How long a statement waits for a writer before it gives up.
 *
 * An import writes the same database from another process, and without this a query that meets
 * its transaction fails instantly with SQLITE_BUSY — a list that goes empty because somebody
 * imported at that moment. Waiting is right here and nowhere else: this thread painting nothing
 * is invisible, and the client's own timeout is the backstop.
 */
const BUSY_TIMEOUT_MS = 5000;

let context: QueryContext | undefined;

/** Open the case this worker serves. Sent by the client as part of every spawn. */
function open(paths: CasePaths): void {
    const db = openIndex(paths);
    try {
        db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    } catch {
        // Best effort, like the pragmas in `openIndex`: a backend that refuses it still queries.
    }
    context = { paths, db };
}

const api = {
    open,
    ping: (): string => 'pong',
    /**
     * An error crosses as a rejection carrying its message only — a stack from a bundled worker
     * names a line nobody can look up, and this string reaches the person as a toast.
     */
    run(op: string, params: unknown): unknown {
        if (context === undefined) throw new Error(_('No case is open in the index reader.'));
        if (!isQueryOp(op)) throw new Error(`unknown query op ${op}`);
        if (op === 'verify') return runQueryAsync(context, op, params as QueryRequests[typeof op]);
        return runQuery(context, op as SyncQueryOp, params as QueryRequests[SyncQueryOp]);
    },
};

/** What the window sees of this thread. Type only: importing it never loads this file. */
export type QueryWorkerApi = typeof api;

Comlink.expose(api, self as unknown as Comlink.Endpoint);
