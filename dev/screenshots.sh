#!/usr/bin/env bash
# Retake the store screenshots the metainfo points at.
#
#   dev/screenshots.sh [outdir]          default outdir: docs/images
#
# Everything in them is synthetic: the case is built on the spot from `app/tests/fixtures/*.eml`
# and the minted public keys next to them, so the pictures can never leak a real message — the
# same rule as the fixtures themselves. Three of the fourteen fixtures deliberately have no key,
# which is why the shots show `unverifiable` rows and a non-empty key view.
#
# Flathub caps a store screenshot's window at 1000x700 logical (2000x1400 for HiDPI), so the shots
# run at the window's 1000x700 default under `--scale 2`, never resized and never upscaled. The
# monitor is bigger than the window on purpose: `--window-shot` mattes the window out of it WITH
# its shadow and rounded corners, which Flathub requires and a maximised window does not have.
#
# The German shots need GJSIFY_LOCALE_DIR set explicitly — `gjsify run` sets none, and without it
# the app falls back to English while still looking perfectly fine, which is easy to ship by
# accident.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="${1:-$ROOT/docs/images}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

HEADLESS="${HEADLESS_RUN:-$ROOT/../../scripts/headless-run}"
command -v headless-run >/dev/null 2>&1 && HEADLESS=headless-run
[ -x "$HEADLESS" ] || { echo "no headless-run at $HEADLESS -- set HEADLESS_RUN" >&2; exit 2; }

BUNDLE="$ROOT/app/dist/stamped.gjs.mjs"
(cd "$ROOT" && gjsify workspace stamped-cli build >/dev/null)

# The demo case, rebuilt every run so it always matches the current index schema.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
cp "$ROOT"/app/tests/fixtures/*.eml "$WORK/src/"
CASE="$WORK/case"
K="$ROOT/app/tests/fixtures/keys"

# Built the way a journalist builds one, and NOT with `import --key`: that flag verifies with a
# key store it throws away, so the case would end up with fourteen verdicts and an empty
# `keys.json` — the key view would report every pair as missing, and opening a message would
# re-verify without the key that had just confirmed it. Import offline, store the keys, reverify.
# `--no-lookup` so a screenshot run can never put a query on the wire.
(cd "$ROOT" && gjsify run "$BUNDLE" import "$CASE" "$WORK/src" --no-lookup --quiet >/dev/null)
for pem in "$K"/*.pub.pem; do
  name="$(basename "$pem" .pub.pem)"
  (cd "$ROOT" && gjsify run "$BUNDLE" keys add --case "$CASE" "$name" "$pem" >/dev/null)
done
(cd "$ROOT" && gjsify run "$BUNDLE" reverify --case "$CASE" >/dev/null)

export GJSIFY_LOCALE_DIR="$ROOT/app/dist/locale"

shot() { # <file> <view> <lang> [monitor WxH]
  local file="$1" view="$2" lang="$3" size="${4:-2400x1800}"
  local -a vars=(STAMPED_SHOT_VIEW="$view")
  if [ "$lang" = de ]; then
    vars+=(LANG=de_DE.UTF-8 LANGUAGE=de LC_ALL=de_DE.UTF-8)
  else
    vars+=(LANG=C.UTF-8 LANGUAGE= LC_ALL=C.UTF-8)
  fi
  "$HEADLESS" --scale 2 --size "$size" --window-shot "$OUT/$file" \
    -- env "${vars[@]}" gjsify run "$BUNDLE" "$CASE" 2>&1 | grep -E '^wrote' || true
  [ -s "$OUT/$file" ] || { echo "missing $file" >&2; exit 1; }
}

shot 01-message.png message en
shot 02-keys.png keys en
shot 03-overview.png overview en
shot 04-message-de.png message de

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o 4 --strip safe "$OUT"/0*.png; fi
ls -l "$OUT"/0*.png
