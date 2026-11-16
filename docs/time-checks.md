# Time checks (Zeit)

A second layer beside the six DKIM verdicts. It asks one question: do the time values written into
a message agree with each other, and with the message it says it answers? It **never changes a
DKIM verdict**, and it makes no claim about who wrote the message or whether it was altered. A
wrong clock, a wrong timezone label and a queued mail all read as `inconsistent`; that is all the
word means.

Code: `packages/core/src/timecheck.ts`. Pure and deterministic, no clock is read.

## Results

| Result | German | Means |
|---|---|---|
| `consistent` | stimmig | every check that could be made is within its tolerance |
| `inconsistent` | unstimmig | at least one check is beyond its tolerance |
| `not-checkable` | nicht prüfbar | no check had the values it needs |

A check that cannot be made (missing or unreadable value) is `not-checkable` and never counts
against the message.

## Protected values

A value is *protected* when a verified signature covers it: the `t=` / `x=` of a signature whose
body hash and header signature both verified, and a `Date` listed in that signature's `h=`. The
`t=` of an unverified signature is not evidence and is ignored. `Received` headers are never
protected. Each check and the overall finding carry `protectedBySignature`.

## Checks (Stufe 1)

| Check | Compares | Inconsistent when |
|---|---|---|
| `date-vs-signature` | `Date` and `t=` of verified signatures | Date after `t=` by more than 1 h, or before `t=` by more than 7 d |
| `signature-lifetime` | `x=` and `t=` of verified signatures | `x=` before `t=` |
| `received-order` | consecutive `Received` timestamps | a lower hop is later than the one above by more than 15 min |
| `date-vs-received` | `Date` and the first (bottom) `Received` | Date after it by more than 1 h |
| `date-vs-parent` | `Date` and the `Date` of the message this one answers | this message is dated before it by more than 2 h |

The first four read one message. With several verified signatures the worst deviation is reported.

### `date-vs-parent`: the one check that reads two messages

A reply is linked to what it answers by `In-Reply-To` (or, with none, the last id of
`References`). When the archive holds that message, the two `Date` headers can be put in order:
an answer written before the thing it answers did not happen.

**One check, not two.** The scope draft named two cases — a reply dated before its parent, and a
reply naming a message that only exists later. They are one statement with the comparison the
other way round: "the named message is later than the reply" *is* "the reply is earlier than the
named message", and both are decided by the sign of one subtraction. Two checks would report the
same inversion twice, each with its own badge, and a reader counting badges would count one fact
as two.

**Never protected**, whatever the signatures say. Both `Date` headers can sit in the `h=` of
verified signatures and the result still rests on the reply's `In-Reply-To` — a header the sender
wrote, which a forged message can point wherever it likes. So `protectedBySignature` is always
`false` here and the sentence is worded as an indication, not a proof.

**Only one direction is a finding.** A reply dated *later* than what it answers is the ordinary
case at any distance; people answer a mail a month on. Only the inversion is reported.

**A gap in the archive is not a finding.** The reasons below separate "nothing to compare" from
"compared and inverted", and only the second is ever a finding:

| Reason | When |
|---|---|
| `no-parent` | no `In-Reply-To` and no `References`, the ids name mails nobody holds, or the caller looked up no conversation at all (`stamped verify` on one file) |
| `no-parent-date` | the named message is held but carries no `Date` |
| `bad-parent-date` | its `Date` does not parse — no zone, unknown zone name, impossible day |
| `ambiguous-parent` | several messages could be the one answered and they are not dated alike |

`ambiguous-parent` is where the ambiguous cases land, and it is deliberately broad: it covers an
`In-Reply-To` naming two ids, two messages in the archive carrying one id, and a mix of ids of
which only some are held or datable. The comparison is only made when EVERY candidate yields a
readable instant and all of them are the same instant. One candidate the archive cannot date is
one message this reply might be answering whose time nobody knows, and the missing one could be
the later — comparing against the rest would be a guess about which was answered, and a guess
here produces a finding.

A message is never its own parent: a self-referencing `In-Reply-To` reads `no-parent` rather than
comparing a `Date` with itself and coming out `consistent` by arithmetic. A conversation that
loops back on itself cannot loop here, because the seam reads ids and never walks the tree
(`buildThread` has already dropped the loop-closing link anyway).

## Tolerances

Fixed constants (`TIME_TOLERANCES`), not per case, sized so that clock noise across thousands of
mails does not flood `inconsistent`.

| Constant | Value | Reasoning |
|---|---|---|
| `TOLERANCE_DATE_AFTER_SIGNATURE` | 3600 s | Sender and signer clocks drift by minutes, sometimes tens of minutes; beyond an hour the usual cause is a wrong timezone label |
| `TOLERANCE_DATE_BEFORE_SIGNATURE` | 7 d | Drafts, outboxes and MTA retry queues (4–5 days by default) delay signing legitimately |
| `TOLERANCE_EXPIRY_BEFORE_SIGNATURE` | 0 s | Both values come from one signer at one moment; no clock noise |
| `TOLERANCE_RECEIVED_STEP_BACK` | 900 s | Hops stamp their own clocks; 10–15 min drift occurs on badly kept servers |
| `TOLERANCE_DATE_AFTER_FIRST_RECEIVED` | 3600 s | Same reasoning as the signature case; a Date far *before* the first hop is ordinary delay and is not checked |
| `TOLERANCE_REPLY_BEFORE_PARENT` | 7200 s | Twice the signature case, because both sides are of the same bad kind: in the single-message checks one value comes from a server clock, here both `Date` headers come from mail clients on unmanaged devices, so that noise applies twice. Two hours also clears an hour of daylight-saving slip on each device, the common cause of a whole-hour inversion |

## Not in Stufe 1

Weekday vs date, timezone vs season, the mbox From-line, and everything about other messages
beyond the one pairwise comparison above — no ordering of a whole conversation, no comparison
against the archive's own timeline.

## Dates

`parseMailDate` is hand-written instead of `Date.parse`, so GJS and Node answer identically. A date
without a zone, with an unknown zone name or an impossible calendar day is unreadable, not guessed.

## Evidence input

`SignatureEvidence` gained `signedAt` and `expiresAt` (seconds since the epoch). `@stamped/verify`
fills them from `t=` and `x=` (`packages/verify/src/evidence.ts`); a signature without those tags
makes the signature checks read `not-checkable`.

## Where it shows

`stamped verify` prints the layer after the signature blocks and adds a `time` object to `--json`
(`app/src/lib/time.ts` reads the first `Date` and every `Received`, topmost first, and hands them
to `checkTime`). The layer never changes the verdict printed above it.

The same seam supplies the second message. `checkTime` reads no `In-Reply-To` — the rule for which
earlier message a reply names lives in `app/src/lib/time.ts`, which has the conversation
(`threadOf`) in hand. The reader pane passes the conversation it already loaded; `stamped verify`
has one file and no conversation, so `date-vs-parent` reads `not-checkable` there.
