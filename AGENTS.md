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
| `@stamped/verify` | DKIM verification on **mailauth**: the offline resolver, the evidence extraction, `verifyMessage` | `core`, `mailauth`, `node:*` |
| `stamped-cli` (`app/`) | yargs CLI, the report rendering, the key-flag parsing, fixtures and every test | both of the above |

**`@stamped/core` stays dependency-free and runtime-free** — no `gi://`, no `node:*`, no mailauth.
It holds the part a reader must be able to audit without a toolchain: what each verdict means and
which evidence produces it. The classifier takes already-extracted evidence as data, so it is
testable without a crypto library and reviewable without one.

**mailauth is quarantined in `@stamped/verify`.** Nothing else imports it. If mailauth has to be
replaced, `verifyMessage` is the only surface that changes.

## Why mailauth and not our own verifier

Measured, not assumed (see [docs/spikes.md](docs/spikes.md)). RFC 6376 canonicalization —
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
- All `@gjsify/*` packages are pinned to the **same exact version** (0.64.2). gjsify ships as one
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
- Ed25519: `p=` is the RAW 32-byte key (RFC 8463 § 3), not SPKI. The SPKI base64 prefix
  `MCowBQYDK2VwAyEA` is exactly 12 bytes, which is why no DER parser is needed. The
  `recordFromPem` test is anchored to **RFC 8463 § A.2's published key**, not a locally generated
  one, so the expectation comes from the standard.

`.gitignore` excludes `*.eml` and `*.pem` repo-wide with narrow negations for
`app/tests/fixtures/**`. That is the second line of defence; not putting a real message there is
the first.

## Conventions

- **User-facing strings go through gettext** — `_`, `_n`, `fmt` from `@stamped/core`, English
  msgids, German in `po/de.po`. Two traps: a `_()` at MODULE level resolves before `initI18n()`
  and freezes English into the module, and a plural built from an `n === 1` check at the call site
  takes the rule away from the language.
- **Commands are functions, not module-level objects.** `verifyCommand()` is called from
  `main()` after `initI18n()`; an exported const would be constructed at import time by ESM
  hoisting and freeze English into its `describe` and help text.
- **The GJS entry point needs a `GLib.MainLoop`** (curlew's pattern, `app/src/index.ts`). Without
  it `verify` printed nothing and exited 0, because the process ended at the handler's first
  `await`. yargs runs with `.fail(false)` and `.exitProcess(false)`, a sync throw is normalised to
  a rejection, and the exit goes through `process.exit()` — **never** `imports.system.exit()`,
  which skips the loop teardown. Quitting the loop when `parsed` settles is only safe because
  every command handler is async and yargs awaits it; a sync handler would need a different shape.
- **Exit codes:** `0` = a report was produced, whatever the verdict (`body-altered` is a result,
  not an error); `2` = Stamped could not produce one (unreadable file, bad `--key`). Never map a
  verdict to an exit code — a script that treats `body-altered` as a crash loses the finding.
- **`@gjsify/unit`'s `toEqual` compares with `==`, not deeply.** Use `toStrictEqual` for every
  array and object assertion (or `toEqualArray`). An array compared with `toEqual` passes by
  stringification and will happily accept the wrong contents.
- **No TypeScript parameter properties** (`constructor(private x: T)`). Node's
  `--experimental-strip-types` rejects them, which silently breaks the Node test run.
- SQLite runs on **libgda** through gjsify's `node:sqlite` wrapper, not sqlite3. FTS5 is available
  on both runtimes (measured, [docs/spikes.md](docs/spikes.md)).
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
