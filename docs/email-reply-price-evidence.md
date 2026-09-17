# Inactive price evidence

`recognizeEmailReplyPriceEvidence(text = '')` calls the existing unit
recognizer once. Scanner failures pass through unchanged. Every successful
result retains `disposition: 'needs_review'`, even when no evidence is found.
There is no runtime caller or authority to approve customer copy.

Each clause preserves its original tokens, phrases, amount relationships,
and unit relationships and adds `priceEvidence`. Each record is
`{ family, unit, edge }`: `unit` and `edge` reference the original unit evidence
and one of its original amount candidates. Alternatives remain alternatives;
they are not deduplicated into a confirmed price or used for arithmetic.

Families preserve scanner distinctions: `unit`, `forVisit`, `visit`,
`visits`, and `eachVisit` map to `visit`; `application`, `timing`, and
`period` retain their names. This does not promote a timing phrase into a
recurring price, or establish that a period is a plan total.

## Finite evidence rules

- Literal scanner currency supplies amount evidence.
- An unmarked number needs an existing nominal billing anchor or a
  predicate whose shared `priceCue` is true. A nominal candidate for the
  same amount can supply that cue, as in `each visit generates a 98 fee`.
- The generic action `range` can use a nominal billing head immediately
  before its unit or predicate, as in `the cost per visit ranges from 90
  to 120`. A distant or previous-clause price word cannot supply the cue.
- An amount-first edge crossing a comma or dash to a bare visit subject
  (`visit`/`visits`/`eachVisit`) stays unresolved. For example, a refunded
  charge followed by `— each visit remains included` must not become a
  pricing claim. Explicit `per visit` units keep their existing edge.

Excluded candidates remain intact in `unitRelations`; missing evidence is
not a compliance result. A bare-number copula or generic `has`/`range`
without a price cue remains uncertain. Negation, competing units, account
events, and other text are retained for later interpretation, never used as
an automatic exemption here.

## Ownership and limits

The phrase recognizer owns action vocabulary and the `priceCue` flag. This
layer adds no raw-text parser or separate billing vocabulary. Normalization,
amount/unit lexing, local connectors, and all original span indexes remain
owned upstream. Inherited size, finite amount grammar, and newline limits
remain. No endpoint, provider, DB operation, customer send, or gate changes.

This prerequisite does not replace monetary/billing/plan policy. It does
not recognize amount-free billing, coordinated unit claims, complete
application complements, account-event scope, or compound plan subjects.
Any future consumer must keep the review-required contract. Trusted policy
exemptions and violation decisions belong in separately tested consumers.

Run `npx jest server/tests/email-reply-price-evidence.test.js --runInBand`
for candidate identity, supported cues, ambiguity, and failure propagation.
