# macOS window spike: findings

**Verdict: GO for macOS, with one open measurement (clean Mac without Homebrew).**

## What was built

`Adw.ApplicationWindow` with `Adw.OverlaySplitView` (mailboxes) around `Adw.NavigationSplitView`
(conversations + reader), declared in Blueprint, dummy data only, `_()` msgids in English.
Two `Adw.Breakpoint`s (`max-width: 1100px`, `max-width: 600px`) give three layouts.

## Linux (headless mutter via `scripts/headless-run`)

Screenshots in `screenshots/`: `w1200.png` (three panes), `w1000.png` and `w800.png`
(sidebar collapsed, toggle in header), `w420.png` (one pane, list only; activating a row
navigates to the reader). Breakpoints work.

## macOS (MacBook Air, arm64, macOS 27, Node 24)

| Step | Result |
|---|---|
| `gjsify build --app node` | works |
| `gjsify run dist/index.node.mjs --runtime node` (Homebrew GTK) | starts, stays alive, frames are drawn |
| `gjsify ship darwin --target macos-app --sign -` | produces a 210 MB `.app` with own Node + GTK closure |
| Launch the `.app` binary with `env -i PATH=/usr/bin:/bin` | starts, stays alive, frames are drawn |

Not verified: a screenshot of the Mac window (`screencapture` fails over SSH: "could not create
image from display"), so "window visible and correct" is inferred from the running process and the
Gdk frame-timing warning, not seen. Fonts on a Mac without Homebrew (open item in gjsify
`status/open-todos/macos.md`) remain unmeasured: this Mac has Homebrew, and `env -i` only clears PATH.

## Friction (not bugs)

`gjsify ship` refuses to stage until `package.json` carries: `gjsify.main`, `gjsify.ship.appId`,
`license`, a maintainer, an SVG icon, and a `LICENSE` file. For a darwin `.app` the node bundle needs
`gjsify.ship.bundle` + `gjsify.ship.app.darwin = "node"`, and `@gjsify/gtk-runtime-darwin-arm64` plus
`@gjsify/node-runtime-darwin-arm64` must be installed, or the `.app` is staged without them. Unsigned
output needs `--sign -` (ad hoc) to be sealed. `timeout` does not exist on macOS.

Also: Pango markup in `Adw.ActionRow` subtitles: `<addr>` text is parsed as markup (a GTK warning, no crash).
Spike data avoids it.

## Not done

No gjsify core bug found, so no gjsify PR or issue. Still open for Stage 0: a clean Mac / fresh VM
run, developer-ID signing and notarization (needs Apple Developer ID).
