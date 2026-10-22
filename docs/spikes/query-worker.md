# Spike: all index.db queries in a worker

Question: can Stamped run every index.db query inside a `node:worker_threads` Worker, so the GTK main thread never freezes?

Short answer: yes on both targets, with five constraints that shape the design. The harness lives in `app/spike/` and builds separately per target. It uses synthetic data only. Numbers come from one workstation, one run each, so read them as orders of magnitude.

## 1. Starting a Worker from a built bundle

A Worker starts on gjs and node. `new Worker(new URL('./worker.mjs', import.meta.url))` works when `worker.mjs` is a separately built file next to the main bundle. In the gjs bundle `import.meta.url` stays the real file URL of the bundle.

The gjsify bundler does not follow the Worker path. A literal `./lit-worker.ts` fails at runtime with `Cannot find module .../lit-worker.ts`. The worker entry therefore needs its own build step as an additional output.

Packaging follows from that. `gjsify ship` stages everything beside the bundle entry, minus the other targets' entries and the locale directory. A second entry file in the same output directory travels with the bundle with no ship change. Three consequences:

- AppImage and Flatpak. The gjs Worker spawns `gjs -m <tmp bootstrap>` and finds `gjs` on the PATH. The bundle's own launcher resolves `gjs`, but the Worker does not use it. The launcher must put its `gjs` on the PATH, or the Worker must receive the path.
- macOS `.app` and Windows zip. These run `stamped.node.mjs` under Node, so the Worker is a real thread. The worker file must sit beside `stamped.node.mjs`.
- `eval: true` with `import(...)` code times out on gjs (works on node). Do not rely on inline workers.

Not verified here: the real `stamped.gjs.mjs` bundle starting a Worker. Only the standalone spike bundles did. The mechanism is the same, but the PR should add that check first.

## 2. node:sqlite inside the worker

Opening and querying the case `index.db` works in the worker on both targets. `SELECT count(*) FROM messages` and an FTS `MATCH` both return 4 rows on gjs and node.

One gjsify gap. On gjs a statement that starts with `WITH` fails with the message `not an error`.

- Repro: `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10) SELECT count(*) FROM c`.
- Workaround: wrap it as `SELECT count(*) FROM (WITH ...)`.
- Node is fine.
- Location: the statement handling in `gjsify/gjsify/packages/node/sqlite/src/` (`parseSql`, `executeStatement`).
- The wrong message hides the real SQLite error.

Stamped's own sources contain no `WITH` statement, so this does not block the design.

## 3. Structured clone cost

Round trip for synthetic rows (id, subject, sender with NULLs, float score, bucket, snippet):

| Rows | gjs | node |
|---|---|---|
| 1k | 18 to 21 ms | 2 ms |
| 10k | 181 to 190 ms | 32 to 34 ms |
| 20k | 336 to 350 ms | 57 to 60 ms |

Row shape survives (null, number, string).

On gjs the clone is JSON, so types degrade:

- `Uint8Array` arrives as a plain object `{"0":1,...}`. A 1 MB array took 338 ms.
- A SQLite BLOB arrives as a plain object too.
- `ArrayBuffer` and `Map` become plain objects. `Date` becomes a string.
- A `BigInt` in a message kills the reply. The parent sees no reply at all.

Node keeps all types. The protocol must therefore be JSON-safe by contract. Encode blobs as base64, dates as strings, and 64-bit integers as strings.

## 4. Main loop responsiveness

A 50 ms ticker ran on the main thread during an 8M-row recursive query (wrapped, see 2).

| Setup | Longest tick gap |
|---|---|
| gjs, query in worker (1163 ms) | 50 ms, 23 of 23 ticks |
| node, query in worker | 51 ms |
| gjs, same query on main thread | 1230 ms |
| node, same query on main thread | 1294 ms |

The worker removes the freeze completely. Receiving 10k and 20k rows on the main thread showed no visible stall (gjs 50 ms, node 1 to 18 ms). Queries on gjs run about twice as slow as on node (join 610 vs 305 ms, LIKE 1577 vs 741 ms).

A caveat on gjs. A main script without top-level `await` exits at once with code 0 while Worker pipes are pending. The GTK main loop keeps the real app alive, so this only bites CLI paths.

## 5. Lifecycle

| Case | gjs | node |
|---|---|---|
| Startup | 57 ms (restart 55 to 66 ms) | 31 ms (restart 21 ms) |
| Ping round trip | 0.24 ms | about 1 ms |
| `terminate()` during a query | 511 ms, exit code 1 (the 500 ms force-exit backstop) | 12 to 15 s, waits for the synchronous call, exit code 1 |
| Uncaught throw in timer or unhandled rejection | no `error`, no `exit` event | `error` plus `exit` 1 |

A synchronous throw caught by user code in the message handler works on both.

On gjs a crashed worker stays silent. The parent cannot learn about it from events. Node cannot interrupt a running SQLite call, so `terminate()` blocks until the query ends.

## Recommended design for the PR

- One query worker owns the single `DatabaseSync`. gjsify sqlite pools connections and never closes them, so one persistent connection fits.
- Request and response protocol with `{ id, op, params }` in and `{ id, ok, rows | error }` out. Rows are JSON-safe only.
- Every request has a timeout. On timeout, or on silence, the parent kills and restarts the worker. This replaces the missing `error` event on gjs.
- Treat `terminate()` as a hard kill on gjs (about 0.5 s) and as blocking on node. Cancel long queries by bounding them (`LIMIT`, page size), not by terminating.
- Build the worker as a second entry beside the bundle. Make sure the launcher puts `gjs` on the PATH.
- Avoid statements that start with `WITH` until the gjsify sqlite fix lands.
- Keep page sizes near 1k rows. At 10k rows the clone alone costs about 190 ms on gjs.

## Gaps for gjsify (not fixed here)

1. sqlite: `WITH` statements fail with `not an error` on gjs.
2. worker_threads: no `error` or `exit` event for an uncaught throw in a timer or an unhandled rejection in the worker.
3. worker_threads: the clone is JSON, so typed arrays, `ArrayBuffer`, `Date`, `Map` and `BigInt` do not round trip.
4. worker_threads: the bundler does not bundle a literal worker path, and `eval: true` with dynamic `import` times out.
5. Process lifetime: a main script without top-level `await` exits before pending Worker pipes deliver.
6. worker_threads: a message posted to a worker before that worker's module has finished
   evaluating is dropped silently — no reply, no `error`, no `exit`. Node buffers it. Found
   during the implementation, not the spike: a `ping` posted right after `new Worker(url)` was
   never answered, the same `ping` posted two seconds later answered in under a millisecond.
   Worked around with a readiness handshake (`READY_ID` in `app/src/gui/query-client.ts`).
