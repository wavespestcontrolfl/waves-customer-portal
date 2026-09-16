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
It may also start after a comma, as in `$98,$120`; bare digits after a
malformed comma grouping remain blocked.
An opening straight or curly quote may precede an amount; apostrophes inside
words or malformed numbers do not create a new amount boundary.
Boundary checks inspect complete Unicode code points and combining marks.
Joined dollar signs (`$98$120`) are invalid, while whitespace or a comma
keeps separate amounts distinct. Hyphenated prose after a minimum phrase
leaves the base amount intact (`$98 and up-front` → `$98`). Calls at an
interior endpoint of a complete numeric, currency, or measurement range return
`null` only when the enclosing range has a valid start;
bare `between 90 and 120` without a measurement unit still exposes its two
historical number tokens because it has no full range token.
The same enclosure rule checks at most four earlier written-number words,
including hyphen joins, so the `twenty` inside `one hundred and twenty
dollars` is not a second amount. A later unrelated `twenty dollars` still
matches independently.

The finite currency scope is dollar signs, USD, dollars, bucks, cents, and
the cent sign (`98¢`). It recognizes numeric and bounded written amounts,
currency ranges and minimum suffixes, hyphenated currency adjectives,
leading-decimal money (`$.98`, `USD .98`), and bounded duration/count
measurements (`30-45 minutes`, `between 90 and 120 minutes`, `98mins`).
It does not parse arbitrary natural-language money descriptions.

Focused check from the repository root:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-amount-lexer.test.js`.
