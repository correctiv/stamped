# Spike: the message list on a large case

Question: why does the window feel heavy on a case of hundreds of thousands of messages, and what does each fix buy?

Everything here is measured on a synthetic case (no real mail): 400,000 index rows from `app/scripts/make-bench-case.mts`, the newest 6,000 with a stored copy. One workstation, headless mutter, one run each. Read the numbers as orders of magnitude.

## Method

```bash
node --experimental-strip-types app/scripts/make-bench-case.mts /tmp/stamped-bench 400000
gjsify workspace stamped-cli build
STAMPED_BENCH=/tmp/bench.jsonl ./scripts/headless-run -- gjsify run app/dist/stamped.gjs.mjs /tmp/stamped-bench
```

`STAMPED_BENCH=<file>` (`app/src/gui/bench.ts`) makes the window, once the first page is up, scroll 24 more pages (5,000 rows), select three rows near the end, idle, and append one JSON line. CPU is read from `/proc`, split into the main thread and all other threads (the query worker). It is off in every normal run.

## Baseline (`Gtk.ListBox` of `Adw.ActionRow`, never trimmed)

| Measure | Value |
|---|---|
| First list on screen | 2.5 s after start; main thread 700 ms CPU, other threads 40 ms |
| Scroll 24 pages (5,000 rows) | 30.2 s wall, **10.1 s main-thread CPU**, 60 ms other threads |
| RSS | 202 MB at first list, 313 MB after 5,000 rows |
| Select a row after scrolling | 727 ms main-thread CPU per selection |
| 1.5 s idle with 5,000 rows | 850 ms main-thread CPU |

The worker does almost nothing; the main thread is busy because every page adds 200 more `Adw.ActionRow` widget trees to a list that keeps all of them, and each addition re-measures the whole box.

## Step 2: `Gtk.ListView` over a `Gio.ListStore`

Rows are `MessageItem` objects in a `Gio.ListStore`; a `SignalListItemFactory` binds a small recycled `MessageRowView` to each visible one. Paging bookkeeping lives in `app/src/lib/paged-list.ts` (unit-tested).

| Measure | Baseline | ListView |
|---|---|---|
| First list on screen | 2.5 s; main 700 ms CPU | 2.2 s; main 630 ms CPU |
| Scroll 24 pages (5,000 rows) | 30.2 s wall, **10.1 s** main CPU | 29.5 s wall, **1.0 s** main CPU |
| RSS after scrolling | 313 MB | 207 MB |
| Select a row after scrolling | 727 ms main CPU | 73 ms main CPU |
| 1.5 s idle with 5,000 rows | 850 ms main CPU | 40 ms main CPU |

Wall time for the scroll barely moves: the bench waits for each page from the worker, so that figure is the query, not the widgets. The main thread is free during it.

## Step 3: merged reloads of only the stale panes

A run that ends (import, key lookup, re-verification) used to reload every pane at once, one after the other, and each ending did it again. Now a change names its panes (`app/src/lib/refresh-scheduler.ts`): a key lookup or re-verification touches the sidebar, list, keys and overview, never the people and timeline panes; the people backfill touches only those two; an import still reloads everything. Requests inside 250 ms merge, and one reload runs at a time.

Measured as three runs ending together (the bench calls `refresh()` three times without the backfill step, against three `refreshSoon` calls of the verdict panes):

| Measure | Before | After |
|---|---|---|
| Three runs end together, main-thread CPU | 1280 ms (3 full reloads) | 160 ms (one reload of 4 panes) |
| Wall time | 28.4 s | 2.5 s (the bench's own settle time; the reload ends sooner) |

The wall figure of the "before" row is dominated by the people and timeline queries over 400,000 rows, which the verdict panes do not need.

## Step 4: `verifyStored` on the query worker

A new `verify` op (`verifyOf` in `app/src/lib/queries.ts`) reads the stored bytes, loads the saved key vault and runs mailauth on the worker thread; the window only awaits the finding. The vault is read from disk per call, so the worker holds no copy that can go stale. The worker bundle now carries `@stamped/verify` (it loads standalone under `gjsify run`). Sync ops still reply synchronously: only `verify` goes through a promise.

Measured on the same case, selecting a row after scrolling (rows have stored copies, but they are tiny synthetic mails): main thread 23 ms (step 3 run) vs 50 ms (this run) — within run-to-run noise, so no gain is claimed here. What moves is the cost for a real message with a large attachment: its hashing no longer runs on the main thread. That is by construction, not measured, because the synthetic mails are small.
