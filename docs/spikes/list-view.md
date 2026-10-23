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
