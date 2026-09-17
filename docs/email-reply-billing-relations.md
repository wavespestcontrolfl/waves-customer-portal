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
  supply alternative endings for `fee is $98 per visit`.
- `unit_frame` retains immediate, comma-fronted, and possessive relationships.
  Fronted subjects use recognized participants; nominal determiners and the
  finite existential `there is` form are supported. Unknown words stop a link.
- `frame_object` retains a visit embedded in an original predicate object,
  including both `pay a visit` and `pay a visit fee`. Interpretation is deferred.
- Immediately adjacent `and`/`or` plus an explicit unit can inherit a trailing
  link. `via` references the preceding unit; the frame identity is unchanged.
  Chained links retain connector negation. A bare later visit/application
  subject does not qualify as an explicit coordinated unit.

The connector stores `{start, end, negated}`; predicate negation also remains
on the original frame. Candidates can overlap. A fronted noun followed by an
unknown word retains a lexical edge, not a completed billing assertion:
`per visit, payment receipt is available` stops its frame before `receipt`.
Application links alone do not grant an exemption: polarity, completion and
competing units still need interpretation. Amount-free policy and all318
frozen billing assertions remain later acceptance work. Scanner normalization,
amount grammar and newline limitations remain inherited.

```sh
npx jest server/tests/email-reply-billing-relations.test.js --runInBand
```
