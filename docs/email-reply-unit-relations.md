# Inactive unit relationship candidates

`recognizeEmailReplyUnitRelations(text = '')` extends the existing amount
relationship recognizer. It calls that recognizer once, forwards failures
unchanged, and always keeps `disposition: 'needs_review'` on success. No
runtime caller, provider call, database operation, or customer-copy approval
is introduced.

## Evidence contract

Each clause retains its complete upstream fields and adds `unitRelations`.
Every scanner token of kind `unit`, `application`, `timing`, `forVisit`,
`eachVisit`, `visits`, `visit`, or `period` gets one record:

```js
{
  unit: { start, end, kind, text },
  candidates: []
}
```

An empty candidate list means no supported local attachment was found.
The scanner's kind is retained exactly. A timing token never becomes a
recurring unit, and a visit noun never becomes a confirmed billing unit.
Period tokens use the same local lexical rules; interpreting a monthly
plan or a legacy monthly amount is outside this contract.

Each candidate contains `relation: 'amount_unit'`, `start`, `end`, `amount`,
`anchor`, and `connector`. The amount is the original upstream amount
record's evidence. The anchor is an original amount-relationship candidate,
or null for a direct relationship to the bare amount. The connector holds
intervening token indexes and normalized text, or is null for adjacency.
Distinct direct and anchored alternatives remain visible. No candidate is
preferred as the semantic meaning of the clause.

All indexes are clause-local scanner token indexes: inclusive start,
exclusive end. A candidate encloses its unit and the chosen amount or
amount-candidate span. Indexes are not source character offsets.

## Finite forms

A unit can immediately precede or follow either a bare amount or an existing
amount-candidate span. Exactly one colon or hyphen separator is also allowed.
Examples include `$98 per visit`, `each visit costs $98`,
`$98 is the price per visit`, `per visit: $98`, and `$98/mo`.

One additional fronted form is supported: unit, one comma, optionally one
existing participant phrase, then an existing amount-candidate span. For
example, `for each visit, we charge $98`. This comma form requires an
amount-candidate anchor when a participant is present. A bare amount can
also follow one comma, colon, or hyphen, optionally one qualifier and
`from`/`between`, as in `per visit: only $98`. A single trailing comma
is also a supported connector.

Additional finite connectors retain their full token evidence:

- A unit followed by a copula, optionally `not`/`never`, one qualifier, and
  `a`/`an`, then an amount span; reverse attachment accepts one copula.
  A separate modal plus one qualifier may precede the copula, as in
  `each visit will only be $98`.
- A possessive, or an existing `has` predicate with optional qualifier and `a`/`an`,
  between a unit and an existing nominal amount candidate.
- A fronted comma followed by `the`/`our`/`your`/`a`/`an` and a nominal
  amount candidate; or an optional comma then `there` and the same bounded
  copula form before an amount span.
- An existing `apply`/`occur`/`due`/`required`/`payable` predicate occupying
  the full gap between an amount span and a unit. Its original negation
  evidence remains in the clause; the edge does not imply an affirmative price.
- A single `pay` token before a scanner unit beginning `-per-`, as in
  `$98 pay-per-visit`. This does not skip a free-standing payment verb.
- `plus`/`before` followed by `tax`/`taxes`/`fee` between an amount span and
  a unit. This retains tax language without computing or validating it.
- One crossed parenthesis delimiter from a matched pair immediately around
  the unit or complete amount span. Unrelated parentheses do not erase
  an already-supported edge; no claim of globally balanced syntax is made.

Other words, conjunctions, separators, units, amounts, measurements, barriers,
and clause boundaries cannot be skipped. For example, `monthly plan costs
$98` keeps the period unlinked because `plan` is outside these finite forms.
`$98 per application and includes a visit` retains the application edge
and the later unlinked visit. Both facts remain available to later consumers.

## Limits and verification

This module provides lexical attachment evidence, not pricing claims,
coordination, unit precedence, exemptions, or compliance verdicts. It cannot
approve a reply, including when every unit has a candidate. Consumers must
retain uncertainty and assess the complete original evidence.
For example, `We refunded the $98 charge — each visit remains included`
has a lexical edge across the dash but needs account-event and clause
interpretation before any policy can call it recurring pricing.

Normalization, amount/unit vocabulary, phrase recognition, and amount
relationships remain owned by the existing upstream modules. Their finite
grammar and newline-normalization limitations remain. Existing live lint
and frozen monetary/billing/plan-total adapters are unchanged.

Run `npx jest server/tests/email-reply-unit-relations.test.js --runInBand`
and ESLint on the new source and tests. No policy replacement coverage is
claimed by this prerequisite.
