/**
 * The second thread: the only place in the window's process that holds an index connection.
 *
 * A separate bundle entry, built beside `stamped.<target>.mjs` by `scripts/build-bundle.mjs` —
 * the gjsify bundler does not follow a `new Worker(new URL(…))` path, so the worker needs its own
 * build output rather than being pulled into the main one.
 *
 * Deliberately thin. Every question it can answer lives in `lib/queries.ts`, which knows nothing
 * about threads and is what the tests call; this file is the loop that turns a message into one
 * of those calls. Two ops are the protocol's own rather than a query: `open` (re-sent on every
 * spawn, so a restarted worker reopens the case by itself) and `ping` (is anybody there).
 */

// First, and for its side effect: binds the catalogue before any other module is evaluated, so
// the error messages this thread produces are translated. Same rule as `main.ts`, and the reason
// it is safe here is that `i18n-init.ts` pulls in no GTK — a worker has no display.
import './i18n-init.ts';

import { parentPort } from 'node:worker_threads';

import { _ } from '@stamped/core';
import { openIndex, type CasePaths } from '@stamped/store';

import { isQueryOp, runQuery, type QueryContext, type QueryRequests } from '../lib/queries.ts';
import { READY_ID, type QueryReply, type QueryRequest } from './query-client.ts';

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

function handle(request: QueryRequest): QueryReply['result'] {
    if (request.op === 'open') {
        open((request.params as { paths: CasePaths }).paths);
        return null;
    }
    if (request.op === 'ping') return 'pong';
    if (context === undefined) throw new Error(_('No case is open in the index reader.'));
    if (!isQueryOp(request.op)) throw new Error(`unknown query op ${request.op}`);
    return runQuery(context, request.op, request.params as QueryRequests[typeof request.op]);
}

const port = parentPort;
if (port !== null) {
    port.on('message', (request: QueryRequest) => {
        let reply: QueryReply;
        try {
            reply = { id: request.id, ok: true, result: handle(request) };
        } catch (error) {
            // The message only — a stack from a bundled worker names a line nobody can look up,
            // and this string reaches the person as a toast.
            reply = { id: request.id, ok: false, error: String((error as Error)?.message ?? error) };
        }
        port.postMessage(reply);
    });
    // LAST, and only after the handler is attached: on GJS anything the client posted before
    // this module finished evaluating was dropped, so this reply is what tells it to send.
    // See `READY_ID` in `query-client.ts` for the measurement.
    port.postMessage({ id: READY_ID, ok: true, result: 'ready' } satisfies QueryReply);
}
