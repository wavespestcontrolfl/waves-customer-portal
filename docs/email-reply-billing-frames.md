# Inactive billing frames

`recognizeEmailReplyBillingFrames(text = '')` extends the shared price-evidence
chain. It calls that recognizer once, forwards failures unchanged, and retains
all upstream clause fields and object references. Success always carries
`disposition: 'needs_review'`; neither a frame nor its absence approves copy.
There is no runtime caller, provider/DB operation, exemption, or policy verdict.

Each clause adds `nominalFrames` and `predicateFrames`:

- A nominal frame holds `{start, end, head, modifiers, frequency}`. `head` is an original
  noun-role billing phrase. Up to six following word tokens can extend a compound
  to a later nominal head, stopping at syntax, coordination, negation, or an
  intervening recognized action/participant. Thus `payment receipt fee` retains
  the terminal fee, while `payment receipt` stops at payment and leaves receipt
  unresolved. A bill head followed immediately by `frequency` retains that
  bounded suffix and its original token in `frequency`; other heads do not
  consume it. This is a lexical candidate, not a completed assertion.
- A predicate frame holds `{start, end, predicate, recipient, separate, object}`.
  The predicate and optional recipient reference original phrases. Separate
  adverbs may flank the recipient; `on its/their own` is retained too.
- An object records `{start, end, visit, amount, nominal, separate}`. It supports
  a bounded determiner/separation prefix, an optional visit and object prefix, optional amount,
  optional nominal, and an amount after the nominal (directly or via `of`/`at`).
  Visit and amount references are the original unit/amount records. This retains
  `pay a visit fee` distinctly from `pay a visit`, without judging either.
  Another modifier prefix requires an intervening visit or amount; repeated
  determiners or separation modifiers do not supply an object.

Ranges, currency, unit modifiers, normalization and predicate negation stay
owned by the existing recognizers. Unknown object words remain outside frames;
no arbitrary skip or operational-noun allowlist supplies a missing object.
These records do not attach billing to units, resolve nominal/action ambiguity,
recognize coordinated complements, or decide whether an application complement
is complete and affirmative. Those relationships are required before billing
policy replacement. All frozen billing tests and known review findings remain
preserved for that later consumer; this prerequisite does not claim their full
coverage. The scanner's documented size, amount and newline limits remain.

```sh
npx jest server/tests/email-reply-billing-frames.test.js --runInBand
```
