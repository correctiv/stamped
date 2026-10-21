# Stamped

**Check email signatures.** Stamped tells a journalist whether a message is the message that was
signed — offline, on their own machine.

German name: **Poststempel**.

## Why

A leaked mailbox arrives and the first question is always the same: is this real? Email carries
an answer to part of that question already. Most mail is signed by the sending domain with
[DKIM](https://www.rfc-editor.org/rfc/rfc6376), and that signature covers the body and a list of
header fields — so if the signature still verifies, the message is byte-for-byte what left the
domain's servers, and if the body hash no longer matches, somebody changed it afterwards.

Verifying it by hand is possible and nobody does it under deadline. The web services that do it
for you want the message uploaded, which is not a thing one does with a leak.

So Stamped is **local and offline by default**. Public keys come from a store you fill
(`stamped keys add`), because a DNS lookup would tell the signing domain which of its mail is
being examined. `stamped keys fetch` can ask archive.prove.email or DNS for missing keys, but only
after it has listed the exact domains and selectors and you have confirmed (`--yes` skips the
question). Nothing else touches the network.

## The six answers

"Valid or invalid" is the wrong vocabulary, and collapsing into it is how a true story gets
spiked. Stamped says one of:

| Verdict | Means |
|---|---|
| **confirmed** | A signature verified. The message is what was signed. |
| **confirmed with caveats** | It verified, but covers less than it appears to — see below. |
| **body altered** | The body hash does not match: the body was changed after signing. |
| **headers altered** | The body is intact but a signed header field is not what was signed. |
| **unverifiable** | A signature is present and nothing here can check it (usually: no key). |
| **unsigned** | No DKIM signature. Says nothing about the message either way. |

**`unverifiable` is not `invalid`.** It is the absence of a finding, and reporting it as forgery
would be a false accusation — which is why it is its own word.

A confirmation gets caveats when it is real but narrower than the word suggests: `rsa-sha1`
(SHA-1 collisions are practical), an RSA key under 1024 bits, an `l=` tag that signs only the
start of the body, `Subject`/`To`/`Date` missing from the signed headers, or a public key that
came from the archive under examination rather than from the DNS or from you — which proves
internal consistency, not authenticity.

Every signature is evaluated **on its own**. A message whose author domain's signature broke
while a mailing list's still verifies is a finding, not an average.

Alongside the verdict, Stamped prints the evidence it came from: domain, selector, algorithm, key
size and provenance, which headers are signed, and both body hashes when they differ. A claim a
journalist cannot defend to an editor is not worth making.

## Importing an archive

```
stamped import <case> <source…>            # an mbox, a Maildir, a .eml, a folder of those
stamped import --case <case> <folder>      # a folder of mailboxes — a leak, as it is handed over
```

A leaked archive is not a file. It is a **folder**: one folder per account, each holding its
mailbox in pieces (`part-01.mbox`, `part-02.mbox`, …), with a README and a licence next to them.
Stamped reads that tree as it lies:

- **A folder is a mailbox**, named after the folder it came from. The layout is the only naming
  there is — nobody writes a manifest, and a manifest written by the leaker is a manifest we
  would have to trust.
- **Only mail is mail.** `.mbox` and `.eml` files are read; everything else — a README, a
  licence — is left alone and counted. A file that is not mail never becomes a message.
- **Each part is read on its own**, streamed, so the size of the archive is not a limit and the
  largest single message is.
- **A link out of the tree is not followed.** The archive is evidence; evidence that reaches into
  the operator's own disk reads files that were never part of the leak.
- **One damaged file does not cost the tree.** A part that cannot be read is reported by name,
  the rest of the archive is imported, and the run ends with exit code 2 — a partial import must
  not look like a clean one to a script.

`--progress=jsonl` prints one JSON object per indexed batch, each naming the mailbox it belongs
to, so a long import can be watched and a stalled one can be located.

## Status

**Early.** The verification core, a CLI, and a libadwaita window that imports an archive and
searches it (SQLite FTS5).

```
stamped verify <file.eml> [--key <selector>._domainkey.<domain>=<record or .pem>] [--json]
```

Exit code 0 means a report was produced, whatever it says; 2 means Stamped could not produce one.
A broken signature is a result, not a program failure.

## Build and run

The toolchain is [gjsify](https://github.com/gjsify/gjsify): a TypeScript monorepo that runs on
GJS. Use `gjsify install`, never `npm install`.

```bash
gjsify install
gjsify foreach -A check                   # type-check app + every package
gjsify workspace stamped-cli test         # the suite, on gjs AND node
gjsify workspace stamped-cli build        # → app/dist/stamped.gjs.mjs
gjsify run app/dist/stamped.gjs.mjs verify app/tests/fixtures/confirmed.eml \
  --key t2048._domainkey.example.com=app/tests/fixtures/keys/t2048._domainkey.example.com.pub.pem
```

Stamped is multilingual from the first string: English msgids, `po/de.po`, `dev/i18n.sh extract`
and `compile`.

## Test fixtures are synthetic, always

Every `.eml` under `app/tests/fixtures/` is generated by `tools/make-fixtures.mjs` — messages in
reserved example domains, signed by keys made on the spot, one per verdict and caveat. **No real
message may ever be committed here.** A committed mail can burn a source, and this is a tool for
leaks.

The generator implements RFC 6376 canonicalization **independently of the verifier**, so the
suite is two implementations agreeing rather than one agreeing with itself. Regenerate with
`node tools/make-fixtures.mjs` from the repo root; it makes new keys too, so every fixture
changes together.

The archive fixtures come from `tools/make-archive-fixtures.mjs` — a second generator, because
those files carry no signature and must stay byte-stable across runs. It writes the mbox and
Maildir quirks and `archives/leak/`, the tree of mailboxes a leaked archive arrives in: one
folder per account, each holding its mailbox in pieces, with the files that are not mail next to
them. Synthetic like everything else: reserved example domains, invented bodies.

## Documentation

- [docs/spikes/dkim-and-fts5.md](docs/spikes/dkim-and-fts5.md) — what was measured before it was decided: why mailauth and
  not an own verifier, how it is configured and why, FTS5 under gjsify.
- [AGENTS.md](AGENTS.md) — conventions, for humans and AI agents both.

## Licence

AGPL-3.0-or-later. © CORRECTIV.
