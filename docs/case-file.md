# The case file

`stamped case pack` seals a case folder into one `.stamped` file. `stamped case verify` checks
it, `stamped case unpack` turns it back into a folder. This page is the format and what it does
and does not promise.

## What it promises: integrity, not authenticity

A case file proves that it is the file that was written: every member matches the SHA-256 in
the manifest, and the manifest matches the hash stored in the ZIP comment. It does NOT prove who
wrote it. Anyone can build a consistent file. A signature is a separate piece of work
(issue #214).

A file that does not match is **refused**: `unpack` writes nothing under the real folder name.

## The container

A ZIP, so `unzip -t` and `python3 -m zipfile -t` read it. Stored only (no compression: the
messages are already text the index has seen, and a stored member cannot be larger than the file
that holds it, so there is no decompression bomb). ZIP64 per entry where a size or offset does
not fit the classic fields. Extension `.stamped`, MIME type `application/vnd.stamped.case+zip`.
The reader refuses compressed or encrypted members, anything that is not a regular file, and a
local header that disagrees with the central directory.

Members are sorted by name, so the same case makes the same bytes. The last member is
`manifest.jsonl`; the ZIP comment is its SHA-256.

## The members

A closed list, in `FIXED_MEMBERS` (`packages/store/src/case-file.ts`):

| Member | What it is |
|---|---|
| `case.json` | the marker; required |
| `import-log.jsonl` | where each message was read from |
| `index.db` | a `VACUUM INTO` snapshot of the index |
| `keys.json` | the key vault |
| `marks.json` | tags and bookmarks |
| `perimeter.json` | the sender perimeter |
| `semantic.json` | the semantic-search setting |
| `raw/<2 hex>/<64 hex>.eml` | the messages; the folder is the first two hex digits of the hash |

`index.db` goes in because nothing rebuilds it from `raw/`: it keeps history (`first_verdict`)
that only the importer, reading the source archives, produces. See #211 for a rebuild.

**Left out, and reported by `pack`:** `vectors.db` (derived, hours to compute, tied to a model
the recipient may not have), the `*-status.json` files (they describe a process on this
machine), `*.tmp`, `*.part`, SQLite's `-wal` and `-shm`, and any file not on the list.

**The import log carries the paths of the source files on the machine that imported them.** It
is not stripped: it is the chain of custody. Treat the file like the case.

## The manifest

JSON lines. The first line is a header, `{format, version, caseVersion, schemaVersion}`, with
no timestamp (so the bytes stay reproducible). Every other line is `{path, size, sha256}` for
one member, in the order of the central directory. A file from a newer `version`, `caseVersion`
or `schemaVersion` is refused.

## What a check does

It walks the central directory and the manifest side by side, so memory does not grow with the
number of messages. Names must be on the closed list, strictly increasing, and safe (relative,
no `..`, no backslash, no drive letter, no control character). A raw member's content must also
match the hash in its own name, which holds even against a consistent but forged manifest.
`verify` lists every problem and exits non-zero; `unpack` stops at the first.

## Pack and unpack safety

- `pack` is an export: the folder stays the live case. It writes `<target>.part` and renames it
  at the end, and refuses an existing target without `--force`, a target inside the case, and a
  case with a running import, key run, activity or semantic run.
- `pack` refuses a raw message whose content does not match its name: sealing a damaged case
  would hide the damage.
- Both check free space first (`statfs`): a pack needs the members plus twice the index, an
  unpack the members once.
- `unpack` extracts into `<folder>.unpacking` and renames it into place only after every check
  passed. A leftover staging folder is refused, with its path named. A target that exists and is
  not empty is refused.

## In the window, and as a file type

**Open Case File…** and **Save Case File…** are in the main menu. Both run `stamped case unpack`
or `case pack` with `--progress=jsonl` as a separate process, behind a progress dialog with a
Cancel button, so the window keeps repainting while a large case is read. The progress lines are
numbers only (`{"phase":"working","done":…,"total":…}`, then `{"phase":"done","path":…,"members":…,"bytes":…}`).

- Opening asks for the parent folder and unpacks into `<parent>/<file name without .stamped>`.
  A folder that exists is refused up front. Cancelling removes `<folder>.unpacking`, and nothing
  else.
- Saving asks for a file name and appends `.stamped` when it is missing. `--force` is passed only
  for a name the person chose themselves (the file dialog already asked about replacing it); a
  name with the extension appended is never forced. Cancelling removes the `.part` files.
- `stamped <file>.stamped` (a double click in the file manager) opens the unpack dialog once the
  window is on screen.

On Linux the package registers the type `application/vnd.stamped.case+zip` (`*.stamped`, a
subclass of `application/zip`) through `gjsify.ship.mimeTypes` in `app/package.json`: a
shared-mime-info definition plus `MimeType=` in the desktop entry. macOS (a UTI) and Windows
(registry keys) have no support in `gjsify ship` yet.

## Rebuilding the index of a case

`stamped case reindex [folder]` puts the index back from `raw/`, for a case whose index is lost,
damaged or from a build that cannot read it and whose source archives are gone. The messages are
the evidence and the index only what was derived from them, so this needs nothing but the folder.

- Every message under `raw/` is verified again with the keys in the case's vault, and the new
  index is built beside the old one in `index.db.rebuild`, then renamed over it at the end. A
  run that fails or is killed leaves the old index as it was.
- `first_verdict` (the "before" of the report's before/now table) is history, not cache: it is
  read out of the old index and carried over. A message the old index did not have gets the
  verdict it has now; with no readable old index there is nothing to carry.
- Where a message came from (archive, mailbox) is in `import-log.jsonl`, not in the index, and
  the log is not touched. Neither is `raw/`.
- A file under `raw/` whose SHA-256 is not its name is reported and not indexed. The old index is
  then kept; `--accept-failures` replaces it without those messages.
- Not brought back: the ledger of finished import files (a later import reads its files again and
  finds every message known), the attachment metadata (opt-in, its own command) and `vectors.db`.
- Close the window on the case first: its open handle points at the old file.
