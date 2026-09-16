# Email reply pricing clause recognition

`server/services/email/email-reply-pricing-clauses.js` exports
`recognizeEmailReplyPricingClauses(text = '')`. It calls the bounded
`normalizeEmailReplyCopy` prerequisite first and returns `{ ok: false, reason }`
on failure. Success returns `{ ok: true, clauses }`; each clause is an array of
`{ kind, text }` tokens. Sentence punctuation (`.`, `!`, `?`, `;`) ends a clause,
while comma, colon, dash, and parentheses remain `sep` tokens.
Whitespace is discarded. Unknown characters remain `barrier` tokens, so
unmatched markup cannot silently join a claim.

The finite recognizer uses longest anchored matches at each position. It
distinguishes explicit-currency `money`, bare `number`, duration/count
`measurement`, singular `visit`, plural `visits`, quantified `eachVisit`,
recurring `unit`, singular `forVisit`, one-off `timing`, per/for-application
`application`, possessives, auxiliaries (`be`), modals, and ordinary `word`
tokens. A visit noun phrase has at most eight modifiers; predicates,
prepositions, determiners, and account/payment/access terms stop it. Duration
modifiers may use one hyphen or space. `on a visit-by-visit basis` is one unit;
`30-45 minutes` is one measurement.
Bounded prose ranges such as `between 90 and 120 minutes` and `from 90 to
120 minutes` are also single measurements; explicit currency in the same
forms remains `money` evidence.
Currency words also stop visit modifiers, preserving `ninety-eight dollar` as
`money` before a `visit fee` phrase.
Hyphenated currency (`ninety-eight-dollar`, `98-dollar`) stays `money` as well.
The bounded written-number grammar also accepts fully hyphenated hundreds
(`one-hundred-and-twenty-eight-dollar`), while the same number followed by a
duration unit remains a `measurement`.
Compound predicates such as `pay-per-visit` emit `word pay` followed by
`unit -per-visit`; the same boundary preserves `-per-application` as an
`application` token. Application units accept the full visit determiner set.
That same finite determiner set follows `per` or `/` before application and
visit nouns. A hyphenated continuation such as `application-related` or
`visit-related` cannot be truncated into an application or visit token.
Bounded numeric ordinals (`1st`, `2nd`, and similar forms up to three digits)
may modify a visit or application noun.
One-off `on`/`at` timing also accepts possessive today, tomorrow, yesterday,
and weekday names (with optional this/next/last for weekdays).

Token text is lowercase normalized copy, except billing/pricing verb and noun
inflections are stemmed (`billed`/`billing` → `bill`, `prices` → `price`,
`rates` → `rate`, `ranges` → `range`). `payments` becomes `payment`, distinct
from the verb `pay`. The `+` operator before tax or fees becomes `word plus`;
otherwise it stays attached to a minimum-price `money` token. Neither this
module nor its tokens declare a pricing-policy violation; the monetary and
amountless adapters decide that from clause relationships.
Unknown words, including JavaScript object property names such as
`constructor`, keep string token text.

The same 8,192-byte, 512-token, eight-format-pass normalization limits apply.
This inactive helper has no runtime caller, database access, provider call, or
send path. The finite vocabulary is deliberately narrower than a general
English parser.

Run from the repository root with UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-pricing-clauses.test.js`.
