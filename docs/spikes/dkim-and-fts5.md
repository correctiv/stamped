# Spikes

What was measured before it was decided, and what the measurement said. Each entry is here
because the answer was not obvious from documentation — and because the next person to ask the
same question deserves the numbers rather than a conclusion.

## DKIM verification: mailauth, not an own verifier

**Decision: use [mailauth](https://github.com/postalsys/mailauth) 8.0.1 (MIT).**

The alternative was a verifier of our own on `@gjsify/crypto`. It was tempting — Stamped needs
only *verification*, the key store is ours, and mailauth drags in a dependency tree (joi among
others) for a tool that signs nothing.

It was rejected because **RFC 6376 canonicalization is the hard part, and getting it subtly wrong
still returns `true`.** `relaxed` header canonicalization alone folds whitespace, lowercases
field names, unfolds continuations and strips trailing space per field; `relaxed` body
canonicalization reduces runs of whitespace, strips trailing whitespace per line, normalises line
endings and collapses trailing empty lines — and every one of those rules has an edge where a
plausible implementation and the standard disagree. A verifier that is wrong in one of those
edges does not throw: it reports a valid signature as broken, or a broken one as valid. For a
tool whose entire output is a claim about authenticity, that failure mode is disqualifying.

What settled it is that mailauth also **exposes every intermediate fact** the six verdicts need,
rather than a boolean: the computed body hash next to the `bh=` the signer committed to, the
modulus length of the key it fetched, whether an `l=` tag limited the body and by how much, and
its own words for why something failed. Those facts *are* the evidence chain Stamped prints.

The seam is kept narrow anyway: `@stamped/verify` translates mailauth's vocabulary into
`SignatureEvidence` (`packages/core/src/verdict.ts`), and nothing downstream knows mailauth
exists. Swapping in an own verifier later means filling the same shape.

### mailauth is run LENIENT on purpose

```
strict: false, rejectRsaSha1: false, minBitLength: 1
```

A mail server wants a policy decision, so mailauth's defaults refuse rsa-sha1 and short keys
before checking them. Stamped wants the opposite: a 512-bit key from 2003 should get a **real
crypto verdict** plus a caveat saying the key can be factored. Refusing to look would throw away
the finding and report `policy` — which a reader cannot distinguish from "no key".

**`minBitLength: 1`, not `0`.** `getPublicKey` in mailauth's `tools.js` does
`minBitLength = minBitLength || 1024`, so `0` is falsy and silently restores the 1024 default.
Measured against the 512-bit fixture: `dkim=policy` with `0`, `dkim=pass` with `1`. A one-line
difference that would have made `caveat-weak-key` unverifiable while looking like a config that
disabled the check.

### Running it under gjsify needed one shim: `self`

`import('mailauth/lib/dkim/verify')` under `--app gjs` failed with
`ReferenceError: self is not defined`.

Traced: **joi** (a mailauth dependency) declares a `browser` field pointing at
`dist/joi-browser.min.js`, a UMD bundle whose factory reads `self`. gjsify's `--app gjs` sets
`conditionNames: ['browser']`, so that file is the one that gets resolved — and gjsify's GJS
globals model defines `window` and `globalThis` but not `self`.

The shim is in `packages/verify/src/mailauth.ts`: set `globalThis.self`, then **dynamically**
import the verifier (dynamic so the assignment happens before the module body runs — a static
import is hoisted above it), cached after the first call. The real fix belongs in gjsify's GJS
globals table and is a separate PR there; the shim carries a marker naming it, so the next
version bump removes it.

### Other mailauth readings the classifier depends on

Measured against our own fixtures (`tools/make-fixtures.mjs` signs them independently of
mailauth, so these are two implementations agreeing rather than one agreeing with itself):

| Situation | mailauth reports |
|---|---|
| Body changed after signing | `status.result = 'neutral'`, `comment: 'body hash did not verify'` |
| Signed header changed, body intact | `status.result = 'fail'`, `comment: 'bad signature'` |
| No DKIM header at all | ONE result with `status.result = 'none'`, `comment: 'message not signed'` |
| `l=` limit in force | `canonBodyLengthLimited: true`, `status.underSized: <bytes left unsigned>` |
| 512-bit key, `minBitLength: 1` | `pass`, `modulusLength: 512` |

Two consequences in the code:

- `verifyMessage` **filters out** the `'none'` result. It is mailauth's synthetic "nothing here"
  entry, not a signature, and passing it through would make an unsigned message look like one
  signature that failed. `classifyMessage([])` is what yields `unsigned`.
- `status.comment` initialises to `false`, not `''` or `undefined`. Type-check it before reading
  it as a string.

### Offline by default

mailauth takes a `resolver(name, type)` callback, which Stamped points at its own `KeyStore`
(`packages/verify/src/mailauth.ts`). **No DNS query is made** unless a resolver is configured to
make one, which the CLI does not do in PR 1 — examining a leaked message must not send a lookup
to the signing domain, because that lookup tells the domain which of its mail somebody is
checking.

A missing key throws `Object.assign(new Error(...), { code: 'ENOTFOUND' })`, because mailauth maps
a generic throw to `temperror` ("ask again later") while `ENOTFOUND` becomes a permanent "no key"
— which is the honest answer when a key store simply does not hold it.

`VerifyOptions.fallbackResolver` is the seam a future `--dns` flag plugs into. It is deliberately
unwired today.

## SQLite FTS5 under gjsify: available

**Result: PASS on GJS and on Node, Linux.** Kept as a test rather than a note:
`app/tests/unit/fts5.test.ts`.

Stamped's second half — exploring an archive of a few hundred thousand messages — rests on
full-text search, and the question was not "does SQLite have FTS5" but "does *this* SQLite".
gjsify's `node:sqlite` is a **libgda wrapper**, not a sqlite3 binding, so the usual answer is
about a different library.

Probed with `@gjsify/sqlite` 0.64.2 on libgda, `DatabaseSync(':memory:')`:

- `CREATE VIRTUAL TABLE … USING fts5(subject, body)` — works.
- `MATCH` finds a word mid-column and returns nothing for a word that is absent (both halves
  matter: a tokenizer matching everything passes the first check and is just as useless).
- Column-scoped `subject : term` — understood, which is how a `from:`/`subject:` filter will be
  expressed.
- `ORDER BY rank` — works, so the auxiliary functions are compiled in too, not only the virtual
  table.

The failure this guards against is quiet: without FTS5 a search answers "no results" to
everything, which reads as *this mail is not in the leak* rather than as a broken build. That is
a wrong conclusion in a story, so the capability is asserted on every run from PR 1 onward,
before any index design depends on it.

Not yet measured, and deliberately out of scope here: index size and query latency at archive
scale, external-content tables, and which tokenizer to use for German compounds.
