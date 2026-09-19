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

The shared recognizer owns all vocabulary, amount/period pairing, claim
boundaries, and exclusion evidence (bare measurements, visit/application
ties, activity cadence, account events); this consumer has no parser of its
own — it only asks whether any relation is a `plan_total` and applies the two
trusted exemption flags. It does not check company names, regulatory
language, presentation, account facts, or every possible English pricing
construction. The inherited finite grammar, amount, period, and newline
limits remain. Every result still needs review, so unknown phrasing cannot
become a compliant/sendable result here.

The test suite preserves all 235 frozen plan-total tests and their original
`{ok,violations}` expectations, projected onto the `needs_review` disposition
with no `ok` field on any actual result. `server/services/comms-lint.js`
remains the live raw-text `no-plan-total` policy; it is unaffected, and no
runtime migration is authorized here.
