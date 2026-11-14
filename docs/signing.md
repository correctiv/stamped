# Signing: not yet, and why

**The macOS and Windows packages of Stamped are not signed, and macOS builds are not notarised.**
That is a decision, not an oversight. Who signs, and under which name, needs the approval of the
organisation Stamped is built for, and that approval does not exist yet. Tracked in
[#234](https://github.com/correctiv/stamped/issues/234).

Until it does, no personal signing key is used for Stamped. A signature names its signer, and a
key held in a repository secret is readable by whoever can change that repository's workflows.

## What you see

- **macOS:** Gatekeeper refuses to open the app on a double click. Open it once with a right click
  → Open, or allow it under System Settings → Privacy & Security.
- **Windows:** SmartScreen shows "Windows protected your PC". Choose More info → Run anyway.
- **Linux:** nothing. The `.deb`, `.rpm` and AppImage are not signed by a developer key either; a
  release's `*.gjsify-release.json` files carry the checksums.

Check a download against its checksum before you open it, if the source matters to you.

## When it changes

This page is rewritten the day the approval is there: the signing identity, what is signed, and how
to verify it. Nothing here is a promise about a date.
