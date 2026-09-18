# Inactive email pricing phrase candidates

`recognizeEmailReplyPricingPhrases(text = '')` extends the shared bounded
`recognizeEmailReplyPricingClauses` scanner. It has no runtime caller and does
not authorize a reply, send a message, invoke a provider, or access a database.

## Result contract

Scanner failures pass through as `{ ok: false, reason }`. Every successful
result has `{ ok: true, disposition: 'needs_review', clauses }`, including
empty input, ordinary scheduling language, and unsupported pricing language.
Success means scanning succeeded; it never means the text is compliant.

Each clause contains its complete original scanner `tokens` and a `phrases`
array. Each candidate has `type`, `start`, `end`, and `text`. Indexes refer to
that clause's tokens: `start` is inclusive and `end` exclusive. They are not
source character offsets. Candidate text joins normalized token text with
spaces and is not a reconstruction of the original message.

The finite candidate families are:

- `qualifier`: longest supported qualifier at a position, including `only`,
  `about`, `up to`, `at least`, and comparative phrases such as `no more than`.
- `participant`: a pronoun or customer/client/account noun, optionally with
  a supported determiner (including `any`). This does not establish a subject, payer, or recipient.
- `billing_head`: a supported lexical head with `head` and `roles`. A word such
  as `charge` can retain both `noun` and `action` roles.
- `predicate`: a supported action head with a bounded auxiliary/qualifier
  prefix. Fields `headStart` and `headEnd` identify the head tokens; `prefix`
  retains the preceding token spans/text, and `negated` records explicit
  `not`/`never` prefix evidence outside a recognized comparative qualifier.
  `priceCue` identifies heads in the shared pricing-action vocabulary.
  Generic `generate`, `apply`, `occur`, `has`, `due`, `required`, `payable`,
  and `range` keep it false; they need separate currency or nominal evidence.
  A true cue is lexical context, not a confirmed price or compliance verdict.

Candidate families may overlap. Predicate candidates keep the longest
supported prefix found for a given head, with at most 12 prefix tokens.
An isolated action-shaped word can itself be a predicate candidate; this is
lexical evidence rather than a grammatical assertion. The source's finite
vocabulary and focused tests define coverage; no completeness is claimed.
The scanner stem `range` is also an action candidate for local range-introducer
relationships; it does not establish pricing context by itself.

## Boundaries and uncertainty

Predicates cannot consume amounts, units, separators, barriers, or another
clause. All those tokens remain available to later relationship recognition.
Money, bare numbers, measurements, applications, timing, and period tokens
retain the scanner's meanings. The scanner can collapse several words into
one `be` token, so the prefix bound counts scanner tokens rather than words.

The module does not attach amounts to predicates or units, infer coordination,
resolve noun/action ambiguity, or decide whether a visit is operational or
billable. For example, `pay you a visit` and `pay you per visit` retain distinct
scanner evidence but neither receives a policy verdict. Unknown words remain
in `tokens`; absence of a candidate cannot establish permission to send.
Future consumers must establish their own complete supported relationships
and preserve uncertainty when they cannot do so.

The inherited normalization limits apply: 8,192 UTF-8 bytes, 512 whitespace
tokens, and eight formatting passes. Existing finite amount grammar and
newline normalization limitations also apply. No raw newline boundary or
general English/HTML understanding is promised.

## Ownership and verification

The existing scanner owns normalization, amount/unit lexing, and clause
boundaries. This module only adds phrase candidates over that evidence.
`server/services/comms-lint.js` remains the existing advisory raw-text lint
mechanism; it does not provide this typed span contract. No runtime integration
or frozen monetary, billing, or plan-total adapter is changed here.

Run `npx jest server/tests/email-reply-pricing-phrases.test.js --runInBand`
for candidate spans, polarity, ambiguity, bounds, retained token evidence,
and failure propagation. Run ESLint on the new source and test files.
