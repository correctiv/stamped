#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues.
#
#   dev/i18n.sh extract    refresh po/stamped.pot and merge it into every po/*.po
#   dev/i18n.sh compile    build app/dist/locale/<lang>/LC_MESSAGES/stamped.mo
#
# ONE domain for the whole repo: the app sources, every packages/*/src, and the blueprint
# templates. A package is not a separate product here — it is a layer of the same binary — and a
# second domain would mean a second catalogue to bind, for strings a user cannot tell apart.
set -euo pipefail

cd "$(dirname "$0")/.."
DOMAIN='stamped'
POT="po/$DOMAIN.pot"
TS_LIST="$(mktemp)"
BLP_LIST="$(mktemp)"
trap 'rm -f "$TS_LIST" "$BLP_LIST"' EXIT

case "${1:-}" in
extract)
    # `--from-code` matters: without it xgettext refuses any non-ASCII msgid, and an English
    # source string with a typographic dash in it is already non-ASCII.
    {
        find app/src packages/*/src -type f -name '*.ts' \
            -not -name '*.spec.ts' -not -name '*.test.ts'
        find app/src -type f -name '*.blp'
    } | sort > po/POTFILES.in
    grep '\.ts$' po/POTFILES.in > "$TS_LIST"
    grep '\.blp$' po/POTFILES.in > "$BLP_LIST"

    xgettext \
        --files-from="$TS_LIST" \
        --output="$POT" \
        --from-code=UTF-8 \
        --language=JavaScript \
        --keyword=_ \
        --keyword=_n:1,2 \
        --keyword=_p:1c,2 \
        --add-comments=TRANSLATORS \
        --package-name="$DOMAIN" \
        --msgid-bugs-address='https://github.com/correctiv/stamped/issues'

    # Blueprint in a SECOND pass, as C. The templates carry a quarter of the window's text —
    # every label the markup places rather than the code — and xgettext has no blueprint mode, so
    # the choice is a second pass or leaving those strings untranslated in a translated window.
    # C mode is enough because blueprint's `_("…")` is spelled exactly like C's and its comments
    # are C's: the lexer finds the same literals the blueprint compiler marks `translatable`.
    # `--join-existing` appends to the catalogue the first pass wrote, so a string that appears in
    # both a template and a source file keeps both references instead of forking into two entries.
    xgettext \
        --files-from="$BLP_LIST" \
        --output="$POT" \
        --join-existing \
        --from-code=UTF-8 \
        --language=C \
        --keyword=_ \
        --keyword=C_:1c,2 \
        --add-comments=TRANSLATORS
    while read -r lang; do
        [ -n "$lang" ] || continue
        # `--previous` keeps the old msgid next to a fuzzy match, which is the only thing that
        # makes a reworded string reviewable instead of guesswork.
        msgmerge --update --previous --backup=none "po/$lang.po" "$POT"
    done < po/LINGUAS
    printf 'extracted %s msgids\n' "$(grep -c '^msgid "' "$POT")"
    ;;
compile)
    if ! command -v msgfmt > /dev/null 2>&1; then
        # Not fatal: a build without catalogues runs in English, which is the source language.
        printf 'dev/i18n.sh: msgfmt not found, skipping catalogues (the build stays English)\n' >&2
        exit 0
    fi
    while read -r lang; do
        [ -n "$lang" ] || continue
        out="app/dist/locale/$lang/LC_MESSAGES"
        mkdir -p "$out"
        # `--check` refuses a catalogue whose placeholders do not match its msgid: a `{name}`
        # dropped in translation surfaces as literal braces to the user, not as a crash, which is
        # exactly the sort of defect nobody reports.
        msgfmt --check --output-file="$out/$DOMAIN.mo" "po/$lang.po"
        printf 'compiled %-6s -> %s\n' "$lang" "$out/$DOMAIN.mo"
    done < po/LINGUAS
    ;;
*)
    printf 'usage: %s <extract|compile>\n' "$0" >&2
    exit 2
    ;;
esac
