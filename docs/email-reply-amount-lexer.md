# Email reply amount lexer

`server/services/email/email-reply-amount-lexer.js` exports
`matchEmailReplyAmountAt(source, at = 0)`. It returns `null` or an anchored
`{ kind, text, start, end }` match. `kind` is `money`, `measurement`, or
`number`; offsets are JavaScript string offsets into the unchanged input.
The longest valid match wins, so `98 cents` is money and `98 minutes` is a
measurement. Bare `90-120` and `90 to 120` are single number spans.
Textual `to` ranges require whitespace on both sides; hyphen ranges allow
compact endpoints. Joined forms such as `90to120` are not range tokens.

The caller must normalize reply copy before scanning. This helper does no
normalization, unit recognition, clause splitting, or policy evaluation. It
rejects non-string input, invalid offsets, and sources above 8,192 UTF-8
bytes. It guards identifier and amount boundaries with the finite rules
below and rejects recognized malformed decimals, grouping, ordinals, and
attached words. Callers must advance to the returned `end` after a match
rather than rescanning its interior. An explicit
`$` may start immediately after a letter, preserving copy such as `is$98`.
It may also start after a comma, as in `$98,$120`; bare digits after a
malformed comma grouping remain blocked.
An opening straight or curly quote may precede an amount; apostrophes inside
words or malformed numbers do not create a new amount boundary.
Boundary checks inspect complete Unicode code points, combining marks, and
currency symbols. Euro, pound, and other currency signs cannot expose an
adjacent bare number, while the recognized dollar and cent forms remain money.
Joined dollar signs (`$98$120`) are invalid, while whitespace or a comma
keeps separate amounts distinct. Hyphenated prose after a minimum phrase
leaves the base amount intact (`$98 and up-front` and `$98 and up‑front` →
`$98`). A spaced plus belongs to the amount only when it ends the text or is
followed by punctuation; an addend of any wording leaves the base amount
intact (`$98 + mandatory state sales tax` → `$98`, `$98 + labor` → `$98`).
An attached minimum plus still belongs to the amount (`$98+ per visit`),
except before a supported numeric, written-money, tax, or fee addend.
Bounded backward checks reject interior starts when they find a supported
enclosing numeric, currency, or measurement range with a valid start;
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

Known deferred grammar boundaries: an ASCII joined hyphen (or folded
mathematical minus) before an amount, such as `Price-$98`, can remain
unrecognized. The normalizer now spaces U+2012–U+2015 punctuation dashes
separately. Currency-aware `between ... and ...`
phrases can remain separate amount tokens. The arbitrary interior-offset
call for digits after hyphenated USD endpoints (`$90-USD 120`, offset 8)
can still return a number; advancing to the complete range token’s `end`
avoids that duplicate in the composed scanner. Extending these cases requires
coordinated delimiter or enclosing-range handling. This module is inactive.
