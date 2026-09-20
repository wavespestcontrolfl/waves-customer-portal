# Inactive email period phrase candidates

`recognizeEmailReplyPeriodPhrases(text = '')` extends the shared
`recognizeEmailReplyPriceEvidence` chain with typed month/year period
candidates. It has no runtime caller and does not authorize a reply, send a
message, invoke a provider, or access a database.

## Result contract

Scanner failures pass through by identity as `{ ok: false, reason }`. Every
successful result has `{ ok: true, disposition: 'needs_review', clauses }`,
and each clause retains every upstream field by identity plus a
`periodPhrases` array. Success means scanning succeeded; it never means the
text is compliant.

Each candidate has `start`, `end` (clause-token indexes, end exclusive),
`text`, `period` (`'month'` or `'year'`), `embedded`, `tokens` (the original
token objects) and `offsets`. Indexes are clause-local, never source offsets.

Two sources feed the candidates:

- The scanner's own `period` tokens (`monthly`, `yearly`, `annual`,
  `annually`, `per month`, `/mo`, and their plural/abbreviated forms).
- Supplemental word sequences the scanner leaves as plain words: `a`, `each`
  or `every` followed by `month`/`mo`/`year`/`yr`, `for the month`/`year`,
  and `annualized`. These come from `matchEmailReplyPeriodAt`, a separate
  period-only matcher in the unit lexer; `matchEmailReplyUnitAt` and the
  scanner's tokens are unchanged, so no existing consumer sees new kinds.
- A period embedded inside a longer visit token (`monthly visit plan`) is
  reported with `embedded: true` and `offsets` into that token's text. The
  visit token keeps its kind; the candidate is metadata, not a unit rewrite.

## Boundaries and uncertainty

`a month ago` (and `mo`/`yr` forms) stays temporal, not a period. Hyphenated
compounds (`monthly-related`), interrupted sequences (`a, month`) and unknown
words remain unresolved. A candidate does not pair a period with an amount,
decide plan versus account context, or produce a violation. Later
relationship recognition owns pairing and claim boundaries.

The inherited normalization limits apply: 8,192 UTF-8 bytes, 512 whitespace
tokens, eight formatting passes, and newline collapsing.

## Ownership and verification

The shared scanner owns normalization, amount/unit lexing and clause
boundaries; this module only adds period candidates over that evidence.
Frozen monetary, billing and plan-total adapters are unchanged.

Run `npx jest server/tests/email-reply-period-phrases.test.js --runInBand`.
