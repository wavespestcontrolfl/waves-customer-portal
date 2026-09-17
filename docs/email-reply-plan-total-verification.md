# Email reply plan-total verification

`server/services/email/email-reply-plan-total-verifier.js` exports
`verifyEmailReplyPlanTotal({ text = '', commercialProposal = false,
legacyMonthlyPlan = false } = {})`. It returns `{ ok, violations }`. The
module is inactive: no send path or runtime caller uses it.

The verifier first calls `recognizeEmailReplyPricingClauses`, including its
bounded copy normalization. A normalization failure returns its reason as the
sole violation even when an exemption flag is true. Literal boolean `true`
in trusted `commercialProposal` metadata exempts valid copy. Trusted
`legacyMonthlyPlan === true` permits monthly dues only; yearly aggregates
still reject, including drafts containing both units. Text claiming either
status cannot exempt itself; the caller owns provenance for both flags.
This email helper has no invoice or prepay preview surface or annual-prepay
exemption.

For ordinary copy, `customer_copy_compliance` rejects a month/year period
joined to a monetary amount (`$98/mo`, `$1176/yr`, `$98 per month`, `$98 a
month`, `$98 each month`, `$1176 every year`) or a
bounded monthly/yearly/annual pricing predicate in either order (`monthly
price is $98`, `$98 is the yearly fee`). Bare numbers need an explicit
pricing word, such as `price`, `cost`, `fee`, `rate`, `charge`, or `total`.
The live rule's `dues` and `subscription` labels also count as pricing cues.
The adapter joins canonical `a/each/every` and `month/mo/year/yr` word tokens
locally; the prerequisite scanner is unchanged. `a month/year` (including
`mo/yr`) immediately followed by `ago` remains temporal wording rather than a
recurring period. Only tokens in the same clause are considered. A barrier,
conjunction, sentence boundary, or visit/application unit breaks the
relationship; account events and schedule prose without a price claim
are left alone. This is a finite policy, not a general English parser.
Explicit payment predicates (`The monthly payment is $98`) and account
price labels (`The monthly account fee is $98`) remain price claims.
Received/posted payment events do not become prices merely because later
descriptions mention a plan or fee; overriding an event requires a pricing
assertion joining the period and amount, or an explicit direct currency/unit
total such as `$98/mo`.
An asserted price label also permits up to three qualifiers from the monetary
adapter's finite vocabulary (`only`, `exactly`, `at least`, `as low as`, and
the other supported approximations); unknown descriptions do not join the
label to an account-event amount.
Price/plan nouns may precede the amount through a recognized copula and those
qualifiers, including when the period follows (`The plan is only $98 monthly`).
Explicit payment copulas also work in either period order; later copulas in
posted-event descriptions do not turn the notice into a price.
Payment assertions use a bounded noun/copula/qualifier grammar. A copula
describing `is posted` or `has been received` does not assert the amount.
Singular/plural activity nouns allow up to four ordinary modifiers (`Monthly
service reminders mention the $98 initial-service price`); an activity fee
or cost predicate still counts as pricing.
A unit attached to one amount does not shield a later amount across a comma,
and a later price statement after a conjunction or comma does not turn an
earlier account payment into a plan-total claim.
Commas also break the amount/period relationship and cannot attach a later
visit/application noun to an earlier amount. One comma immediately after a
fronted monthly/yearly/annually period at the beginning of its claim is
permitted (`Annually, we charge
$1176`); a second comma still breaks the claim.
Colons, dashes, and parentheses before unrelated application/visit nouns
cannot exempt an amount; an actual attached unit such as `: per application`
can. Pairing considers adjacent amount/period anchors up to a claim boundary,
with context bounded by neighboring anchors rather than a five-token cutoff.
The scanner's 512-token limit applies, and each token is inspected a constant
number of times across pair traversal.

The existing `server/services/comms-lint.js` `no-plan-total` rule owns the live
customer-copy policy. It cannot be reused as-is for this inactive adapter:
it is a raw-text advisory evaluator, skips an unknown billing lane, and does
not consume the bounded canonical scanner clauses or preserve this adapter's
tested application-price, account-event, and activity-cadence exceptions.
Its unit-specific legacy-monthly exception is preserved here. This is the
proposed justification for the separate inactive adapter, subject to review;
no runtime migration is authorized and the live lint remains unchanged.

Focused check from the repository root:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-plan-total-verifier.test.js`.
