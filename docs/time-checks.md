# Time checks (Zeit)

A second layer beside the six DKIM verdicts. It asks one question per message: do the time values
written into this message agree with each other? It **never changes a DKIM verdict**, and it makes
no claim about who wrote the message or whether it was altered. A wrong clock, a wrong timezone
label and a queued mail all read as `inconsistent`; that is all the word means.

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

## Checks (Stufe 1, one message only)

| Check | Compares | Inconsistent when |
|---|---|---|
| `date-vs-signature` | `Date` and `t=` of verified signatures | Date after `t=` by more than 1 h, or before `t=` by more than 7 d |
| `signature-lifetime` | `x=` and `t=` of verified signatures | `x=` before `t=` |
| `received-order` | consecutive `Received` timestamps | a lower hop is later than the one above by more than 15 min |
| `date-vs-received` | `Date` and the first (bottom) `Received` | Date after it by more than 1 h |

With several verified signatures the worst deviation is reported.

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

## Not in Stufe 1

Weekday vs date, timezone vs season, the mbox From-line and anything that needs other messages.

## Dates

`parseMailDate` is hand-written instead of `Date.parse`, so GJS and Node answer identically. A date
without a zone, with an unknown zone name or an impossible calendar day is unreadable, not guessed.

## Evidence input

`SignatureEvidence` gained `signedAt` and `expiresAt` (seconds since the epoch). `@stamped/verify`
does not fill them yet; until it does, the signature checks read `not-checkable`.
