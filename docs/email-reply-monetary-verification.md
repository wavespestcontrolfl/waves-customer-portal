# Inactive monetary visit-pricing policy

`verifyEmailReplyMonetaryPricing({ text, commercialProposal })` consumes the
shared bounded pricing-clause recognizer. The recognizer owns input limits,
normalization, visit units, auxiliaries, explicit monetary amounts and measured
quantities. This adapter relates that evidence within a clause; it does not
parse raw currency, visit modifiers or grammatical tense again.

Currency amounts beside a visit price unit, visit-subject prices, price labels,
and explicit billing predicates produce `customer_copy_compliance`. Bare
numbers require a pricing predicate. Recognized measurements remain distinct
from numbers, including in `Each visit costs 98 minutes of technician time`.
One-off `on/at your next visit` payment timing remains distinct from recurring
visit units. Amountless billing belongs to the billing adapter.
Supported pricing orders include recognized `incur`/`generate` predicates,
bounded billing articles and `for` complements, qualified/modal has-price
clauses, possessive amount-first fees, and copular nominal charges. Explicit
pricing predicates accept introduced bare ranges; amount labels accept `apply`
and recurring `payment` nouns. Fronted monetary unit labels (`Per visit: $98`)
and amount-first copular nouns (`$98 is the price per visit`) remain supported.
Fronted labels require explicit money; measurements and application units remain
distinct in all these orders.
Perfect predicates, fronted existential fees, and `amount to` connectors are
supported, along with recurring amounts marked `due`, qualified modal copulas,
and `at most` prices. A separated amount-first claim requires an explicit visit unit,
preserving refund facts followed by an independent visit subject.

Normalization failures reject before the strict boolean
`commercialProposal === true` exemption. A future caller must derive that
exemption from trusted proposal data. This checks wording, not monetary facts.

This helper is inactive: no runtime caller, provider request, database access,
draft creation or send integration is included. It does not replace the live
comms lint, enforce presentation/company/regulatory rules, or authorize sends.
The two pricing adapters can overlap on the same prohibited clause; future
composition must deduplicate their shared violation. Full HTML rendering and
general natural-language understanding are outside this bounded lexical policy.

The test corpus carries the frozen monetary policy cases plus all three
unresolved round-five findings. Validate with:

```
TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-monetary-verifier.test.js
```
