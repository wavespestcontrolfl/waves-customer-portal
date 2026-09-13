# Email reply verification

`server/services/email/email-reply-verifier.js` is a deterministic check for
shared email generation. It has no runtime caller in this slice and never
calls a model, writes records, or creates/sends email.

The caller supplies the assembled context and a word budget for the complete
visible reply. Only present authoritative fact fields can support amounts,
dates, time windows and status claims; source observation timestamps and
free-text history are not evidence. Payment amount/date and appointment
date/window claims must match one record. Matching records must agree on
claimed status. Multiple amounts require separate sentences, and time-window
endpoints must match in order. Bare clock times without AM/PM require review.
Independent fact categories also use separate sentences: the verifier does
not infer subject relationships across coordinated billing/service clauses. Billing dues, surcharge and collected
total keep their separate meanings. Viewed estimates retain sent evidence.

The verifier also checks plain-text structure, greeting, unsupported signatures,
boilerplate, links, access codes, existing customer-copy compliance, copied
example facts, and placeholders. Placeholders require an explicitly absent
fact; an unavailable source is not absence. It returns `{ok, violations}`.

These checks cover recognized claim forms; deterministic pattern matching does
not prove the truth or completeness of arbitrary prose. The later generator
must keep authoritative-fact instructions, bounded regeneration and operator
review. Live activation still requires separate evaluation and approval.

Run from `server/`: `node ../node_modules/jest/bin/jest.js --runInBand
--no-coverage tests/email-reply-verifier.test.js` with Node 20 and `TZ=UTC`.
Tests use synthetic context objects and no database/provider credentials.
