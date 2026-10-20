#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues.
#
#   dev/i18n.sh extract    refresh po/stamped.pot and merge it into every po/*.po
#   dev/i18n.sh compile    build app/dist/locale/<lang>/LC_MESSAGES/stamped.mo
#
# ONE domain for the whole repo: the app sources and every packages/*/src. A package is not a
# separate product here — it is a layer of the same binary — and a second domain would mean a
# second catalogue to bind, for strings a user cannot tell apart.
set -euo pipefail

cd "$(dirname "$0")/.."
DOMAIN='stamped'
POT="po/$DOMAIN.pot"

case "${1:-}" in
extract)
    # `--from-code` matters: without it xgettext refuses any non-ASCII msgid, and an English
    # source string with a typographic dash in it is already non-ASCII.
    find app/src packages/*/src -type f -name '*.ts' \
        -not -name '*.spec.ts' -not -name '*.test.ts' | sort > po/POTFILES.in
    xgettext \
        --files-from=po/POTFILES.in \
        --output="$POT" \
        --from-code=UTF-8 \
        --language=JavaScript \
        --keyword=_ \
        --keyword=_n:1,2 \
        --keyword=_p:1c,2 \
        --add-comments=TRANSLATORS \
        --package-name="$DOMAIN" \
        --msgid-bugs-address='https://github.com/correctiv/stamped/issues'
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
