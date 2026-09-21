# Inactive billing relationships

`recognizeEmailReplyBillingRelations(text = '')` calls the shared billing-frame
recognizer once and adds `billingRelations` to each clause. Upstream fields,
frames, unit references and failures retain identity. Every success remains
`needs_review`. There is no runtime consumer or compliance/exemption verdict.

Each record holds an original `unit` and `candidates`. Each candidate contains
`relation`, `frameType`, original `frame`, `start`, `end`, `position`, `connector`
and `via`. Token spans remain clause-local and end-exclusive.

- `frame_unit` links an immediately preceding nominal/predicate frame through
  a bounded copular label, existing apply/occur/due/required/payable predicate,
  or up to three separators. A crossed opening parenthesis requires a closing
  parenthesis immediately after the unit. Original nominal amount relations
  supply alternative endings for `fee is $98 per visit` and are retained in
  `amountRelation`. Their connector negation carries through to coordinated
  units; comparative qualifiers such as `not more than` are not negation.
  A modal connector requires a copula (`will be`, not bare `will`).
- `unit_frame` retains immediate, comma-fronted, and possessive relationships.
  Fronted subjects use recognized participants; nominal determiners and the
  finite existential `there is` form are supported, with an optional comma
  before the existential. Ordinary fronted subjects require the comma.
  Unknown words stop a link.
- `frame_object` retains a visit embedded in an original predicate object,
  including both `pay a visit` and `pay a visit fee`. Interpretation is deferred.
- Immediately adjacent `and`/`or` plus an explicit unit can inherit a trailing
  link. `via` references the preceding unit; the frame identity is unchanged.
  Chained links retain connector negation, including `for a visit` units. A bare later visit/application
  subject does not qualify as an explicit coordinated unit.

The connector stores `{start, end, negated}`; predicate negation also remains
on the original frame. Candidates can overlap. A fronted noun followed by an
unknown word retains a lexical edge, not a completed billing assertion:
`per visit, payment receipt is available` stops its frame before `receipt`.
Application links alone do not grant an exemption: polarity, completion and
competing units still need interpretation. Amount-free policy and all318
frozen billing assertions remain later acceptance work. Scanner normalization,
amount grammar and newline limitations remain inherited.

Known limitations (review round 3, recorded under the inactive-module
standard — no runtime caller, every result is `needs_review`):

- `There is no fee per visit`: a direct nominal link that begins at `fee`
  records `negated: false`; a bounded `no` determiner is not carried as
  polarity, so an amount-free negative billing sentence produces the same
  relation as `There is a fee per visit`. A later interpreter must read the
  preceding determiner before treating a direct nominal link as affirmative.
- Malformed pre-copular negation (`The fee not is per visit`, `The fee never
  was per visit`) is accepted like `The fee is not per visit`: the connector
  slot order permits negation before the copula without a modal.
- Recognition is cubic on punctuation-dense clauses: `endings()` rescans the
  amount relations for every unit/frame pair. The scanner's 8,192-byte cap
  bounds it, but a pathological ~5.5 KB run of repeated `fee,$1,/mo,` segments
  takes on the order of ten seconds. Precomputing endings per frame is the
  follow-up before any runtime caller exists.

```sh
npx jest server/tests/email-reply-billing-relations.test.js --runInBand
```
