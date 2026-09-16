# Email reply plan-total verification

`server/services/email/email-reply-plan-total-verifier.js` exports
`verifyEmailReplyPlanTotal({ text = '', commercialProposal = false,
legacyMonthlyPlan = false } = {})`. It returns `{ ok, violations }`. The
module is inactive: no send path or runtime caller uses it.

The verifier first calls `recognizeEmailReplyPricingClauses`, including its
bounded copy normalization. A normalization failure returns its reason as the
sole violation even when an exemption flag is true. Only literal boolean
`true` in trusted `commercialProposal` or `legacyMonthlyPlan` metadata
exempts a valid draft. Text claiming either status cannot exempt itself;
the caller owns provenance for both flags. This email helper has no
invoice or prepay preview surface.

For ordinary copy, `customer_copy_compliance` rejects a month/year period
joined to a monetary amount (`$98/mo`, `$1176/yr`, `$98 per month`) or a
bounded monthly/yearly/annual pricing predicate in either order (`monthly
price is $98`, `$98 is the yearly fee`). Bare numbers need an explicit
pricing word, such as `price`, `cost`, `fee`, `rate`, `charge`, or `total`.
Only canonical scanner tokens in the same clause are considered. A barrier,
conjunction, sentence boundary, or visit/application unit breaks the
relationship; account payments and schedule prose without a price claim
are left alone. This is a finite policy, not a general English parser.
A unit attached to one amount does not shield a later amount across a comma,
and a later price statement after a conjunction or comma does not turn an
earlier account payment into a plan-total claim.

Focused check from the repository root:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-plan-total-verifier.test.js`.
