# AGENTS.md — stamped

Operating guide for AI agents in the **Stamped** repo (German display name *Poststempel*).
Follows the [agents.md](https://agents.md/) convention; the human overview is
[README.md](README.md). This repo is a submodule of **werkstatt**, whose
[AGENTS.md](../../AGENTS.md) carries the broader workspace rules — this file is the
Stamped-specific layer and wins where they differ.

## What this is

A tool for journalists working on leaked email archives: it verifies the **DKIM** signatures of a
message and says what each signature actually covers. A TypeScript monorepo that **runs on GJS
via gjsify** (not Node), following the curlew pattern: pure-TS `packages/*` plus one `app`
workspace that carries the gjsify toolchain and the yargs entrypoint.

**Offline by default, and that is a privacy property, not a convenience.** Public keys come from a
key store the journalist fills; Stamped never looks a selector up in DNS on its own. A DNS query
for `<selector>._domainkey.<domain>` tells the signing domain's operator that someone is examining
a message from them — for a leak, that is the leak itself. The seam for an opt-in `--dns` flag is
`VerifyOptions.fallbackResolver`; it exists and is deliberately **not** wired into the CLI yet.

## The six verdicts are the product

Everything else is plumbing. A verdict is never "valid/invalid" — that collapses the distinction
the journalist needs:

| Verdict | Means |
|---|---|
| `confirmed` | signature verifies and covers what matters |
| `confirmed-with-caveats` | verifies, but something limits what that proves |
| `body-altered` | the signature is intact; the **body hash** does not match |
| `headers-altered` | the body hash matches; the **header signature** does not |
| `unverifiable` | no key, broken key, unsupported algorithm — no verdict possible |
| `unsigned` | no DKIM signature at all |

`body-altered` vs `headers-altered` is the whole point and must never be merged into one "fail".
The caveats (`packages/core/src/verdict.ts`) are: `rsa-sha1`, a key under 1024 bit, an `l=` body
length limit, `To`/`Date`/`Subject` not in `h=`, and a key that came only from the archive rather
than from a published record. **Each signature of a multi-signature message is classified on its
own** — a forwarder's passing signature says nothing about the originator's.

Never make a caveat into a failure, and never drop one because it is "probably fine". Adding a
verdict or a caveat means a fixture and a test for it.

## Package layout — and the one rule that holds it together

| Package | Contains | May import |
|---|---|---|
| `@stamped/core` | **Pure, no dependencies.** The verdict model, the classifier, the key store and its record parsing (`p=` / PEM / DNS TXT), the i18n re-exports | nothing |
| `@stamped/import` | **The reading.** The mbox splitter, the decoders, the header parser, and the two walkers over a filesystem: `source.ts` (a source as it is) and `folder.ts` (a tree of mailboxes) | `core`, `node:*` |
| `@stamped/verify` | DKIM verification on **mailauth**: the offline resolver, the evidence extraction, `verifyMessage` | `core`, `mailauth`, `node:*` |
| `@stamped/store` | The case folder: the raw store, the import log, the SQLite/FTS5 index, the importer that drives all of them | `core`, `import`, `verify`, `node:*` |
| `stamped-cli` (`app/`) | yargs CLI, the report rendering, the key-flag parsing, fixtures and every test | all of the above |

**`@stamped/core` stays dependency-free and runtime-free** — no `gi://`, no `node:*`, no mailauth.
It holds the part a reader must be able to audit without a toolchain: what each verdict means and
which evidence produces it. The classifier takes already-extracted evidence as data, so it is
testable without a crypto library and reviewable without one.

**mailauth is quarantined in `@stamped/verify`.** Nothing else imports it. If mailauth has to be
replaced, `verifyMessage` is the only surface that changes.

## A leaked archive is a folder, and how it is read

A leak is handed over as a TREE: one folder per account, each holding its mailbox in pieces
(`part-01.mbox`, `part-02.mbox`, …), with a README and a licence next to them. `stamped import`
reads that tree through `packages/import/src/folder.ts`, and the rules below are the contract —
change one only with a fixture and a test for it.

- **A folder is a mailbox, named after the folder.** The layout is the only naming there is:
  nobody writes a manifest, and a manifest written by the leaker is a manifest we would have to
  trust. Two folders with the same name get a number on the end — `ada@example.com` and
  `ada@example.com (2)` — so a name never means two things. The number follows the sorted order
  of the folders, so the same tree always yields the same names.
- **Only mail is mail.** `.mbox` and `.eml` files, and Maildirs, are read. Everything else is
  left alone and counted — a README imported as a message would be a message nobody ever sent.
- **A part is read as an mbox, whatever its first line looks like.** The general reader decides
  by content (`source.ts`); a folder of mbox PARTS is the case where that is wrong, and a part
  that yields no message is a damaged archive that must be reported, not turned into a mail.
- **A link out of the tree is not followed.** The archive is evidence, and evidence that reaches
  into the operator's own disk reads files that were never part of the leak. The test is on the
  RESOLVED path, so a link through a link cannot get out either.
- **A damaged file does not cost the tree.** In folder mode the failures are collected PER FILE,
  the rest of the archive is imported, and the run ends with exit code 2. In the plain mode a
  broken source still ends the import: a mistyped path is a typo, and half a case folder with no
  sign of where it stopped is worse than an error.

**An interrupted import resumes by FILE.** Once every message of a mailbox is indexed, its files
go into the index's `imported_files` table (`packages/store/src/imported-files.ts`; resolved path,
size, mtime), in the same transaction as the last index batch. The next run skips a file whose
three values all match and reports it as `resumed`. A changed file is read again, and so is a file
that held no message or one whose messages did not all get a verdict. The ledger sits in the
index, so a rebuilt index forgets it: that costs a re-read and never loses a message.

**The mode is the CLI's, not the window's.** `importSources` takes a `mode` (`sources` by
default, `folders`, `auto`); the window never passes one, so the folder mode is not reachable
from the GUI — the GUI imports what the person picked, and the person's file is the whole of its
provenance. The CLI passes `auto`: a folder that holds `.mbox` files is read as a tree of
mailboxes, everything else as it is, and `--folders` / `--no-folders` decide it outright.

**A mailbox name is provenance, and it goes in the log.** The import log entry carries an
optional `mailbox` field, absent for a plain import — a field that is always there and always
empty is worse than one that is only there when it says something. `--progress=jsonl` names the
mailbox in EVERY line, because a progress stream that does not say which mailbox it is talking
about cannot tell a journalist that the import has reached the interesting one: one line per
mailbox, also for a mailbox that held no message at all, and the closing line names the mailbox
the run ended in.

## People and the timeline — an additive table, never a schema bump

The Personen and Zeitleiste views read the `addresses` table (`hash, address, name, sent,
received`; one row per message and address). **Decision: it is NOT part of `createSchema` and
`SCHEMA_VERSION` did not move.** A bump drops the index, and an index over several hundred GB is
hours of re-import, or impossible once the archive is gone. Everything in the table derives from
header columns that are already in `messages`, so `ensureAddresses` creates it in place (best
effort, like `ensureIndexes`), `indexMessage` fills it for every new message, `removeMessage`
empties it, and `backfillAddresses` fills it for older cases in short transactions (a `meta`
rowid cursor, `addresses_done` at the end). The backfill is idempotent: delete, then write, per
message. Queries over an unfilled table are incomplete, never wrong; `addressesComplete` says
which, and the GUI and the CLI say so. The GUI backfills in low-priority idle batches, the CLI
`people` runs it to the end first.

- **One address is one person.** Addresses are lower-cased, display names are listed beside them,
  and nothing is merged by guesswork: whether two mailboxes are one human is the journalist's call.
- **Timeline buckets are the UTC calendar of `sent_at`** (day when the case spans 62 days or
  fewer, otherwise month); mail without a readable date is counted apart, never put at 1970.
- **Large scopes are filled inside SQLite** (`queryScope`), so a person with 100,000 mails never
  passes 100,000 hashes through JavaScript.

**A running import writes `<case>/import-status.json`** (`packages/store/src/import-status.ts`):
PID, times, sources, current mailbox, mails and BYTES done/total across ALL sources of the run
(the percentage is by bytes — the message total is the current mailbox's and would restart at
every mailbox), rate, ETA, errors, and a state of `running | finished | failed | cancelled`. Written
atomically (tmp + rename) at most once a second, and the final state STAYS. It holds numbers and
mailbox/file names only — never mail content. `readImportStatus` + `orphanedImport` tell a
`running` file whose PID is dead or whose last update is over 60 s old from a live run. The CLI
import and the window's in-process fallback write it; `stamped status [--json]` (exit 0 even with
no import) and the window's status button (polled once a second, no modal dialog) read it. Its popover's
Cancel button exists only for a subprocess the window started itself. Formatting lives in
`app/src/lib/status.ts`, `app/src/gui/view/import.ts` and `app/src/gui/view/activity.ts`, not in `window.ts`.
Background work (import, key lookup, reverify, backfill) reports into `ActivityRegistry` (`app/src/lib/activity.ts`).

**The semantic layer keeps TWO files per case, and they answer different questions.**
`<case>/semantic.json` (`packages/store/src/semantic-setting.ts`) is the SETTING: on or off, the
model id and its dimension count, and what the last probe measured (tokens/s, estimated hours,
recommendation, when). Its ABSENCE means "never decided" — not "off": the difference decides
whether the probe runs before the first indexing. `<case>/semantic-status.json`
(`packages/store/src/semantic-status.ts`) is the RUN STATUS — `probing | indexing | paused |
ready | failed | unavailable`, done/total, the seconds left, why a run is on hold. Written
atomically; a state change is always written, the numbers inside a state at most once a second. A
`probing`/`indexing` file whose last update is over 60 s old reads as interrupted: the file must
never claim that a run is going on when nothing is running.

**The state is DERIVED, and the estimate is RE-MEASURED.** `app/src/lib/semantic-state.ts` turns
the two files into one of `off · unavailable · probing · indexing (n/N, remaining) · paused
(battery|user) · ready · failed`; the same derivation serves the window and `stamped status`, so
there is no second answer depending on who asks. The remaining time comes from the running
indexer's own throughput over a moving window (`app/src/lib/semantic.ts`), and the probe's number
is only the stand-in for the first seconds: the spike's three-second probe was off by 32 % in one
run out of six — enough to decide whether to switch the feature on, not enough to promise a
journalist an hour.

**The CONTROLLER owns the indexer's life** (`app/src/lib/semantic.ts`): enable probes if nothing
has been measured and starts the indexer, disable stops it and KEEPS `vectors.db`, the battery
holds the run and mains lets it go, and a restart continues where the vectors left off. The
embedder is injected as a FACTORY (`() => Promise<Embedder | undefined>`) — a runtime without the
model answers `undefined`, which shows as "not available here" instead of a crash — and so is the
clock, because an estimate that cannot be tested with a fake clock is an estimate nobody can
check. `@stamped/semantic` and `@stamped/store` never import each other; the app composes them.

**The window indexes in a SUBPROCESS, like the import** (`app/src/lib/semantic-run.ts`). The
controller above runs inside `stamped semantic index <case>` (it obeys the setting, resumes from
`vectors.db`, ends cleanly on SIGTERM/SIGINT with the vectors kept and the status `paused`). The
window spawns that command (`semanticArgv`, same `selfArgv` route as the import) and only polls
`semantic-status.json`; `createSubprocessSemantic` keeps the `SemanticController` interface, so the
dialog and the activity row are unchanged. Rules: never a second run beside a live one (fresh
update AND living pid — `liveSemanticRun`; a `paused` file is never stale, so its pid decides),
and `stamped semantic index` itself refuses one, naming the pid (`refuseLiveRun`), before it
opens the index; the index yields to an import (SIGTERM, restart when the import ends); the
window ends only a process it started itself, a terminal's run is shown and left alone. No argv
(no binary) → the in-process controller as before. The GUI still embeds the QUERY itself (model loaded twice, ~310 MB
plus a context each). `vectors.db` is opened by two processes, so both openers set `busy_timeout`
and WAL like the index.

## Why mailauth and not our own verifier

Measured, not assumed (see [docs/spikes/dkim-and-fts5.md](docs/spikes/dkim-and-fts5.md)). RFC 6376 canonicalization —
`relaxed` header unfolding, whitespace collapsing, the body's trailing-CRLF rules, `l=`
truncation — is the hard part, and a from-scratch implementation is subtly wrong in a way that
still returns `true` for the easy cases. mailauth (MIT) gets it right and exposes every
intermediate fact the six verdicts need.

**mailauth runs lenient on purpose**: `strict: false`, `rejectRsaSha1: false`, `minBitLength: 1`.
A weak signature must still get a real crypto verdict so Stamped can report *verified, with this
caveat* instead of refusing to look. Stamped applies policy on top; mailauth applies none.

- **`minBitLength: 1`, never `0`.** mailauth's `getPublicKey` does `minBitLength = minBitLength ||
  1024`, so `0` silently restores the 1024-bit floor. Measured: the 512-bit fixture gives
  `dkim=policy` with `0` and `pass` with `1`.
- `verifyMessage` filters out results whose `status.result === 'none'`, so an unsigned message
  reaches the classifier as an empty array and `classifyMessage([])` is `unsigned`.
- A missing key throws `ENOTFOUND` so it classifies as *no key* rather than a transient
  `temperror`. Do not let a lookup miss become a soft failure.
- Readings the classifier depends on: body-hash mismatch → `'neutral'` + `'body hash did not
  verify'`; header-signature failure → `'fail'` + `'bad signature'`. `status.comment` initialises
  to `false`, so type-check it before using it as a string.

## Run / build / test

- Deps: **`gjsify install`** — NEVER `npm install`, it prunes gjsify deps.
- All `@gjsify/*` packages are pinned to the **same exact version** (0.64.5). gjsify ships as one
  release train; a CLI ↔ libs skew produces silently broken bundles. Bump them together.
- `typescript` is pinned `^6.0.3`, **not** 7: `gjsify tsc` runs a bundle with TypeScript 6.0.3
  baked in, so a local 7 would give a different diagnostic set than CI.
- Use gjsify's workspace feature, not npm's: `gjsify foreach -A <script>` (the `-A` includes
  `private: true` workspaces — without it the packages are silently skipped), `gjsify workspace
  <name> <script>` for one (no `run` keyword).

```bash
gjsify foreach -A check                      # type-check everything
gjsify workspace stamped-cli build           # → app/dist/stamped.gjs.mjs
gjsify workspace stamped-cli test            # @gjsify/unit, on gjs AND node
gjsify run app/dist/stamped.gjs.mjs verify app/tests/fixtures/confirmed.eml \
  --key t2048._domainkey.example.com=app/tests/fixtures/keys/t2048._domainkey.example.com.pub.pem
node tools/make-fixtures.mjs                 # regenerate fixtures (mints new keys!)
./dev/i18n.sh extract && ./dev/i18n.sh compile
```

Tests run on **both** runtimes. That dual run is the point of the pure/`verify` split — if a
change makes the Node run impossible, the change is in the wrong package.

`gjsify run <bundle>` prints a `$ GI_TYPELIB_PATH=… gjs -m …` line first. Strip it before parsing
output (`raw.replace(/^\$ [^\n]*\n/, '')`), as the CI smoke test does.

A long-running FOREGROUND GJS process is killed by the werkstatt sandbox (Exit 144) — launch via
`run_in_background` when driving one.

## Fixtures are synthetic, always

- **Never commit a real message, address, domain or key.** Not a redacted one either. Every
  fixture is generated by [`tools/make-fixtures.mjs`](tools/make-fixtures.mjs) from keys it mints
  on the spot, over `example.com` / `lists.example.org`.
- The generator implements RFC 6376 canonicalization **independently of mailauth**, on purpose: a
  fixture signed by the same code that verifies it proves only self-consistency. Keep it
  independent — do not "deduplicate" it against `@stamped/verify`.
- **Private keys are never written to disk.** Only `*.pub.pem`, named after the DNS name
  (`<selector>._domainkey.<domain>.pub.pem`), so the test key store is built from the directory
  listing and the `unverifiable-no-key` fixture works *by absence* — its selector `tmissing` has
  no file. Never add one.
- Regenerating mints new keys, so every fixture changes together. Commit them as one change.
- The archive fixtures come from a SECOND generator,
  [`tools/make-archive-fixtures.mjs`](tools/make-archive-fixtures.mjs): they carry no signature,
  they are byte-stable across runs, and they are the mbox and Maildir quirks plus `archives/leak/`
  — the tree of mailboxes a leaked archive arrives in. Keep them out of the signing generator:
  a fixture that changes whenever a key is regenerated is a fixture nobody reads the diff of.
- Ed25519: `p=` is the RAW 32-byte key (RFC 8463 § 3), not SPKI. The SPKI base64 prefix
  `MCowBQYDK2VwAyEA` is exactly 12 bytes, which is why no DER parser is needed. The
  `recordFromPem` test is anchored to **RFC 8463 § A.2's published key**, not a locally generated
  one, so the expectation comes from the standard.

`.gitignore` excludes `*.eml` and `*.pem` repo-wide with narrow negations for
`app/tests/fixtures/**`, and `*.mbox` with a narrow negation for `app/tests/fixtures/archives/**`
— that is where the leak tree lives. That is the second line of defence; not putting a real
message there is the first.

## Screenshots may show one real set — a narrow, explicit exception

Screenshots otherwise behave like fixtures: synthetic only. The one exception, decided by Pascal
(2026-10), covers site pages and PR screenshots that display the **publicly published**
Yahoo/Epstein archives — the app has to be shown doing a real DKIM verification:

- **Publicly published leaks only.** Anything unpublished — above all the AfD material — never
  appears in a screenshot, in any view, until it is public.
- **Two views only:** the case overview and the key store. One Yahoo-signed message is allowed
  (Yahoo being recognisable is the point); never a third-party sender name, subject or body text.
- **Nothing third-party in frame:** build the screenshot case under `~/Cases/` with exactly the
  Yahoo messages chosen for display, so no other name or domain can appear.
- **Headless only:** `./scripts/headless-run -- …` from the werkstatt root (never open a window
  on the real desktop), window ≤ 1000×700 logical, per the Flathub quality guidelines.
- **Paid models only** touch those images or that case data (screenshot or caption work) —
  free/hosted models never, even though the set is public.
- The exception authorises **display only**. It never authorises committing a real message,
  key or case file into this repo — the fixture rule above keeps applying.

## Conventions

- **User-facing strings go through gettext** — `_`, `_n`, `fmt` from `@stamped/core`, English
  msgids, German in `po/de.po`. Two traps: a `_()` at MODULE level resolves before `initI18n()`
  and freezes English into the module, and a plural built from an `n === 1` check at the call site
  takes the rule away from the language.
- **Commands are functions, not module-level objects.** `verifyCommand()` is called from
  `main()` after `initI18n()`; an exported const would be constructed at import time by ESM
  hoisting and freeze English into its `describe` and help text.
- **The GJS entry point must keep the process alive across an `await`** — the original symptom was
  `verify` printing nothing and exiting 0, because the process ended at the handler's first
  `await`. The fix used to be a `GLib.MainLoop` in `app/src/index.ts` (curlew's pattern). It is
  now the entry module's **top-level await**: GJS pumps the main context until that promise
  settles, so `await runCli()` in `app/src/gui/main.ts` is the pump. `index.ts` therefore owns no
  loop and runs nothing on import — it exports `runCli(): Promise<number>`.
  **Do not put a `MainLoop` back in a module the GUI entry imports**: measured, `loop.run()`
  inside a promise job blocks the microtask drain and the CLI hangs instead of exiting.
  Unchanged: yargs runs with `.fail(false)` and `.exitProcess(false)`, a sync throw is normalised
  to a rejection, and the exit goes through `process.exit()` — **never** `imports.system.exit()`.
- **One binary, two frontends.** `app/src/gui/main.ts` is the entry and dispatches on `argv`: a
  known subcommand, or anything starting with `-`, hands off to `runCli()`; anything else opens
  the window. The GTK imports sit behind a dynamic `import()` so `stamped verify` does not pay for
  libadwaita. It starts the app with `runApplication(app, [argv0])` and **strips the rest of
  argv** — a GApplication without `HANDLES_OPEN`/`HANDLES_COMMAND_LINE` rejects arguments, so
  `stamped <case-folder>` would otherwise exit 1 without a window.
- **Exit codes:** `0` = a report was produced, whatever the verdict (`body-altered` is a result,
  not an error); `2` = Stamped could not produce one (unreadable file, bad `--key`). Never map a
  verdict to an exit code — a script that treats `body-altered` as a crash loses the finding. A
  FOLDER import that could not read every file is `2` as well: the report it produced covers less
  than the archive, and a script must not read a partial import as a clean one.
- **`@gjsify/unit`'s `toEqual` compares with `==`, not deeply.** Use `toStrictEqual` for every
  array and object assertion (or `toEqualArray`). An array compared with `toEqual` passes by
  stringification and will happily accept the wrong contents.
- **No TypeScript parameter properties** (`constructor(private x: T)`). Node's
  `--experimental-strip-types` rejects them, which silently breaks the Node test run.
- SQLite runs on **libgda** through gjsify's `node:sqlite` wrapper, not sqlite3. FTS5 is available
  on both runtimes (measured, [docs/spikes/dkim-and-fts5.md](docs/spikes/dkim-and-fts5.md)).
- Conventional commits (`feat(verify): …`, `fix(core): …`), imperative, subject ≤ 50 chars. Run
  `gjsify foreach -A check`, `format:check`, `lint` and the tests before committing. No
  `--no-verify`.
- This repo is a **submodule of werkstatt**: commit here, push, *then* bump the pointer in the
  parent. NEVER stage across that boundary in one commit, and never commit a werkstatt file here.

## Fix gjsify gaps at the core

gjsify is a first-party dependency, not vendored third-party code. If a capability is missing or
broken there, fix it in the `gjsify/gjsify` submodule with a test and let Stamped pick it up via a
version bump — do not paper over it here.

A shim that is unavoidable meanwhile carries **one of two markers, and they mean opposite things
at bump time**:

- `// fixed upstream in gjsify: …` — the fix has LANDED. Delete the shim at the next bump.
- `// gjsify gap (unfixed, <PR>): …` — no upstream fix exists yet. The shim is **load-bearing**;
  leave it however redundant it looks.

Neither marker is a substitute for measuring: a bump re-measures the behaviour and believes the
result, not the note.

**The one shim today** is `globalThis.self` in `packages/verify/src/mailauth.ts`. mailauth pulls
in joi, whose `package.json` `browser` field selects a build that reads `self`; GJS has no `self`,
so the module throws at import. The shim sets it and then does a **dynamic**
`import('mailauth/lib/dkim/verify')` (cached) — a static import would be hoisted above the
assignment and the shim would do nothing.

## Licence

AGPL-3.0-or-later for the whole repo.
