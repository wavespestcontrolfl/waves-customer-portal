# Inactive plan-total pricing findings

`inspectEmailReplyPlanTotal({ text = '', commercialProposal = false,
legacyMonthlyPlan = false } = {})` consumes the shared period-relations
recognizer once. It returns only `{ disposition: 'needs_review',
violations }`. It has no approval flag: absence of a violation is not
permission to send, including for empty or unrecognized text. No runtime
caller or customer communication is added.

A clause containing a `plan_total` period relation produces
`customer_copy_compliance`, unless `commercialProposal === true` exempts the
whole result, or `legacyMonthlyPlan === true` exempts only month-period
relations (`relation.period.period === 'month'`) — a year-period relation
still violates under the trusted legacy flag. Only these strict literal
`true` flags exempt; text claiming either status cannot exempt itself, and
the exemption never bypasses normalization limits or the review disposition.
Scanner failures return their original reason in `violations`.

Positive evidence first (owner ruling 2026-09-19): a money amount in the
same claim as a month/year period is a finding, including account notices
and cadence prose, because every result is reviewed by a person and a
missed plan total costs more than an extra flag on a payment notice. The
shared recognizer owns all vocabulary, amount/period pairing, claim
boundaries, and the only exclusion evidence there is (a bare measurement, an
amount tied to a visit/application unit, a bare number with no price cue);
activity cadence and account events are NOT exclusions — a money amount
beside a period in such prose is a finding. This consumer has no parser of
its own — it only asks whether any relation is a `plan_total` and applies the two
trusted exemption flags. It does not check company names, regulatory
language, presentation, account facts, or every possible English pricing
construction. The inherited finite grammar, amount, period, and newline
limits remain. Every result still needs review, so unknown phrasing cannot
become a compliant/sendable result here.

Review standard: this consumer and its evidence chain are inactive modules
with no runtime caller, merged on green CI with no P0 under the AGENTS.md
"Inactive evidence modules" rule; unsupported phrasings are tracked in the
period-relations doc's known-limitations list.

The test suite keeps every frozen plan-total case: 195 retain their original
`{ok,violations}` expectations, and the 60 that the owner ruling flips from
allowed to a finding live verbatim in an `owner ruling 2026-09-19` block; no
rejected expectation was weakened. All are projected onto the `needs_review`
disposition with no `ok` field on any actual result. `server/services/comms-lint.js`
remains the live raw-text `no-plan-total` policy; it is unaffected, and no
runtime migration is authorized here.
