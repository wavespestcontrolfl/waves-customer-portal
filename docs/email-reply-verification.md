# Email reply verification

`server/services/email/email-reply-verifier.js` checks recognized claims in
shared email generation. It has no runtime caller in this slice and never
calls a model, writes records, or creates/sends email. It returns
`{ok, violations}`.

The caller supplies assembled context and a word budget for the complete
visible reply. Only present authoritative fields support amounts, dates,
windows and status claims. Observation timestamps and free-text history are
not evidence. Payment amount/date and appointment date/window claims must
match one record, and matching records must agree on the claimed status.
Independent fact categories and multiple amounts require separate sentences.

Supported arrival windows retain both endpoints in order. The `and` separator
requires `between`; a window never supports an exact-time promise at either
endpoint. Bare hours, clocks without AM/PM, and noon/midnight require review.
Dotted AM/PM abbreviations stay intact during sentence checks; use a newline
when an abbreviation ends a sentence to avoid ambiguous fact grouping.

Amounts preserve their field meaning: invoice amount is not account balance,
and billing base dues, surcharge and collected total are distinct. Withheld
dues quotes cannot establish a surcharge or total. Signed or written-out
amounts, magnitude suffixes, malformed comma grouping and excess decimal
precision require review. Positive balance-presence wording requires a present
positive balance.
Dates use cardinal calendar forms; ordinal dates and dotted month abbreviations
require review. Invoice dates
support due-date wording only. Estimate dates support sent/emailed wording
only; viewed estimates retain sent evidence. Keep other lifecycle claims out
of those date sentences. Original payment dates do not establish refund,
reversal or other subsequent lifecycle-event timestamps.

The verifier also checks plain-text structure, greeting, unsupported signatures,
boilerplate, links (including numeric tel:/sms: URIs), access codes,
customer-copy compliance, copied example
facts, canonical company/per-application wording, and placeholders. A
placeholder requires explicit absence in its sentence's fact family;
unavailable data is not evidence of absence.

These checks cover recognized forms; pattern matching does not prove the truth
or completeness of arbitrary prose. The later generator must retain
instructions to use authoritative facts, bounded regeneration and operator
review. Live activation requires separate evaluation and approval.

Run from `server/`: `node ../node_modules/jest/bin/jest.js --runInBand
--no-coverage tests/email-reply-verifier.test.js` with Node 20 and `TZ=UTC`.
Tests use synthetic context objects and no database/provider credentials.
