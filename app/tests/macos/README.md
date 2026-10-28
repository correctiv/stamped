# macOS app check

`check-app.mjs` verifies a built `.app` (from `gjsify ship darwin --target macos-app`) on
a Mac without Homebrew. It runs:

1. a static scan of every Mach-O file for absolute host paths in `LC_LOAD_DYLIB` /
   `LC_ID_DYLIB` (FAIL) and absolute `LC_RPATH` entries (WARN — see below);
2. presence of the relocatable `gtk/etc/fonts/fonts.conf` and of the GTK/libadwaita catalogs;
3. a sandboxed launch (HOME and XDG_* pointed at an empty temp dir, so no real case is
   reopened) under a profile that denies reads below `/opt/homebrew`, `/usr/local` and
   `/opt/local`, asserting via `lsof` that none of those prefixes is touched, that
   `AdwaitaSans*.ttf` is mapped, and that stderr has no `Fontconfig error`.

Why the absolute `LC_RPATH` is a warning, not a failure: an `LC_RPATH` is a search path
dyld skips silently when it does not exist. gjsify keeps the build host's Homebrew prefix
there as a last-resort fallback for Homebrew-only hosts, and dropping it would strand them.
An absolute `LC_LOAD_DYLIB` is different — it is a hard dependency that aborts the load.

Run:

    node app/tests/macos/check-app.mjs app/ship/out/Stamped.app
    node app/tests/macos/check-app.mjs --no-launch app/ship/out/Stamped.app

Exit code is 0 only when every FAIL check passes (warnings are allowed).
Part of #46.

## Semantic search in the .app

`check-semantic.mjs` runs the .app's own launcher against a synthetic case — import, probe, index,
then a query that shares no word with the mail — with a scrubbed environment (no
`STAMPED_EMBED_MODEL`, a private HOME). It fails when the bundled model is not found, when the
runtime is mistaken for GJS, when the CPU fallback needs a compiler, or when the case window's
worker file is missing.

    node app/tests/macos/check-semantic.mjs app/ship/out/Stamped.app
