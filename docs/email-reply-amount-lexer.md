# Email reply amount lexer

`server/services/email/email-reply-amount-lexer.js` exports
`matchEmailReplyAmountAt(source, at = 0)`. It returns `null` or an anchored
`{ kind, text, start, end }` match. `kind` is `money`, `measurement`, or
`number`; offsets are JavaScript string offsets into the unchanged input.
The longest valid match wins, so `98 cents` is money and `98 minutes` is a
measurement. Bare `90-120` and `90 to 120` are single number spans.

The caller must normalize reply copy before scanning. This helper does no
normalization, unit recognition, clause splitting, or policy evaluation. It
rejects non-string input, invalid offsets, and sources above 8,192 UTF-8
bytes. It will not start inside an identifier or amount, or return a prefix
of a malformed decimal, grouping, ordinal, or attached word. An explicit
`$` may start immediately after a letter, preserving copy such as `is$98`.

The finite currency scope is dollar signs, USD, dollars, bucks, cents, and
the cent sign (`98¢`). It recognizes numeric and bounded written amounts,
currency ranges and minimum suffixes, hyphenated currency adjectives,
leading-decimal money (`$.98`, `USD .98`), and bounded duration/count
measurements (`30-45 minutes`, `between 90 and 120 minutes`, `98mins`).
It does not parse arbitrary natural-language money descriptions.

Focused check from the repository root:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-amount-lexer.test.js`.
