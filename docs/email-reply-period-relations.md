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
`'excluded'`; `evidence.reason` names which rule decided it (for example
`direct_currency_period`, `payment_assertion`, `price_cue`, `plan_cue`,
`direct_gap`, `bare_measurement`, `visit_tied`, `activity_cadence`,
`account_event`, or `no_price_cue`). `connector` is `null` when the amount and
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

The module decides, using only typed evidence already on the clause:

- **Bare-measurement exclusion**: a bare number immediately followed by a
  `measurement` context role (or `%`) is never a price.
- **Visit/application-tied amounts**: an amount already connected to a
  visit/application unit (`unitRelations`) is excluded, unless the tie is a
  comma before an unrelated noun — a colon, dash, or bare adjacency still
  requires the unit itself to be a genuine pricing unit (`per`/`each`/
  `every`/`for`/`a`/`-` prefixed, or `unit`/`forVisit` kind).
- **Activity cadence**: an adjective-form period (`monthly`, `yearly`,
  `annual`, `annually`, `annualized`) followed within four ordinary words by
  an `activity` role noun, with no price predicate after it, describes a
  cadence rather than a price.
- **Account-event override**: an `account_event` role in the pair's context
  excludes the pair unless an asserted price label or payment predicate
  joins the amount — a bounded copula/qualifier/participant chain, chasing a
  chained run of qualifier phrases and one trailing separator, not a raw
  regex over the whole clause.
- **Explicit currency+period direct joins**: a money amount in a direct gap
  (separators and at most one copula) next to a period whose own text starts
  with `/`, `per`, `a`, `each`, or `every`, or whose gap contains a copula.
- **Bare numbers need a price cue**: a bare number only pairs when a
  `billing_head` noun or a `priceCue` predicate is in the pair's bounded
  context; a `plan` context role alone is not enough for a bare number.
- **Claim boundaries**: a barrier token, a visit/application unit, or a
  comma/`and`/`or`/`but` ends a claim, with the frozen adapter's bounded
  continuations preserved: a fronted period comma at the very start of its
  claim (`Annually, we charge $1176`), a bounded fronted plan phrase whose
  comma leads into a pricing copula (`For the monthly plan, the price is
  $98`), and `and`/comma immediately before the same billing predicate and
  period (`The plan is $98 and is billed monthly`).

The module never attaches an amount to a unit or resolves a general English
sentence; it consumes only the finite spans, roles, and candidates the
upstream recognizers already computed. It does not know about
`commercialProposal` or `legacyMonthlyPlan` — those are consumer policy, not
period-relation evidence. The inherited normalization limits (8,192 UTF-8
bytes, 512 whitespace tokens) apply through the upstream chain.

## Ownership and verification

`email-reply-pricing-context.js` and everything under it (period phrases,
price evidence, unit/amount relations, pricing phrases and clauses, the unit
and amount lexers) are unchanged and unowned by this module — it only adds
relation evidence over their output. `server/services/comms-lint.js` remains
the live raw-text `no-plan-total` policy; it is unaffected.

Run `npx jest server/tests/email-reply-period-relations.test.js --runInBand`
for upstream call/identity checks, failure forwarding, the pair/no-pair
evidence table, clause-local claim/context bounds, and the absence of any
verdict field. Run ESLint on the new source and test files.
