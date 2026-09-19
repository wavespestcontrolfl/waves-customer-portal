# Inactive email period-relation candidates

`recognizeEmailReplyPeriodRelations(text = '')` calls
`recognizeEmailReplyPricingContext` exactly once and adds a `periodRelations`
array to each clause. It has no runtime caller and does not authorize a
reply, send a message, invoke a provider, or access a database.

## Result contract

Failures pass through by identity. Every successful result is
`{ ok: true, disposition: 'needs_review', clauses }`; each clause retains
every upstream field by identity (`tokens`, `phrases`, `contextPhrases`,
`amountRelations`, `unitRelations`, `priceEvidence`, `periodPhrases`) plus the
new `periodRelations` array.

For each adjacent amount/period anchor pair inside one claim — a bounded
region of a clause's tokens, not the whole clause — the module adds one
record:

```
{ amount, period, relation, connector, claim: { start, end },
  context: { roles }, evidence: { reason } }
```

`amount` and `period` are the exact upstream objects from `amountRelations`
and `periodPhrases` (identity, not a copy). `relation` is `'plan_total'` or
`'excluded'`; `evidence.reason` names which rule decided it (`money_period_claim`,
`bare_number_price_cue`, `no_price_cue`, `bare_measurement`, or `visit_tied`).
`connector` is `null` when the amount and
period are directly adjacent, else `{ start, end, text }` over the gap
tokens between them. `claim` bounds the anchor's own claim segment; `context`
lists the context-phrase roles visible to that pair. Every field is
clause-local token indexes, never source character offsets. A record is
evidence describing why a pair does or does not read as a plan-total price
claim; the module never returns a verdict, an exemption, or an `ok`/violation
field of its own.

Anchors are amount tokens (`amountRelations`) and period tokens
(`periodPhrases`) in clause order. Only two adjacent, differing-type anchors
inside the same claim are ever compared, so each token is inspected a
constant number of times regardless of clause length.

## Boundaries and uncertainty

Positive evidence first (owner ruling 2026-09-19). A money amount in the
same claim as a month/year period is a plan-total claim
(`money_period_claim`); account notices such as `Your $98 monthly payment
posted` and cadence prose such as `Monthly reminders mention the $98 price`
are findings for a reviewer, not silent allowances. The only exclusions are:

- **Bare measurement** (`bare_measurement`): a bare number immediately
  followed by a `measurement` context role or `%`.
- **Visit/application-tied amounts** (`visit_tied`): an amount already
  connected to a visit or application unit in `unitRelations` — a unit before
  the amount, or a genuine pricing unit after it (`per`/`each`/`every`/
  `for`/`a`/`-` prefixed, or `unit`/`forVisit` kind), never across a comma.
  A visit token whose embedded period modifies a following plan word
  (`The monthly visit plan costs $98`) is a period anchor instead.
- **Bare numbers without a price cue** (`no_price_cue`): a bare number pairs
  only when a `billing_head` noun (price or payment alike) or a `priceCue`
  predicate is in the pair's bounded context (`bare_number_price_cue`).

Claim boundaries: a barrier token, a visit/application unit, or a comma /
`and` / `or` / `but` ends a claim, with three bounded continuations: a
fronted period comma at the start of its claim (`Annually, we charge
$1176`), a fronted plan phrase whose comma leads into a pricing copula (`For
the monthly plan, the price is $98`), and a comma and/or `and` before an
optional pronoun, optional copula, billing predicate and period (`The plan
is $98, and it is billed monthly`). Independent facts still break the claim
(`The initial price is $98, service occurs monthly`).

The module carries no price vocabulary of its own; word lists come from the
pricing-phrases heads, `priceCue` predicates and pricing-context roles. It
never attaches an amount to a unit or resolves a general English sentence,
and it does not know about `commercialProposal` or `legacyMonthlyPlan` —
those are consumer policy. The inherited normalization limits (8,192 UTF-8
bytes, 512 whitespace tokens) apply through the upstream chain.

## Ownership and verification

`email-reply-pricing-context.js` and everything under it (period phrases,
price evidence, unit/amount relations, pricing phrases and clauses, the unit
and amount lexers) are unowned by this module — it only adds relation
evidence over their output. The three upstream corrections that shipped
alongside it (extended temporal `ago` phrases, context roles inside composite
unit tokens, punctuation-prefixed embedded periods) are documented in the
period-phrase and pricing-context docs. `server/services/comms-lint.js` remains
the live raw-text `no-plan-total` policy; it is unaffected.

Run `npx jest server/tests/email-reply-period-relations.test.js --runInBand`
for upstream call/identity checks, failure forwarding, the pair/no-pair
evidence table, clause-local claim/context bounds, and the absence of any
verdict field. Run ESLint on the new source and test files.
