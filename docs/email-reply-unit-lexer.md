# Inactive email pricing unit lexer

`matchEmailReplyUnitAt(source, at = 0)` returns the longest supported unit
starting exactly at a UTF-16 offset, or `null`. Matches contain
`{ kind, text, start, end }`; `text` preserves the source substring and `end`
is exclusive. A `period` match additionally identifies `month` or `year`.
Input is bounded to 8192 UTF-8 bytes and offsets must be in-range integers.

The caller must run the existing copy normalizer before scanning. This helper
does not search ahead, normalize markup, grant exemptions, or decide whether
wording complies. A null match means no supported unit starts at that offset;
it does not mean the copy is safe.

The extracted grammar distinguishes recurring visit units, singular `for`
visit phrases, one-off `on/at` timing, visit subjects, application phrases,
and explicit monthly/yearly periods. Visit modifiers are capped at eight;
application modifiers at four. Predicate and account words stop modifiers.
Numeric ordinals have one to three digits. Full and abbreviated numeric
duration modifiers, temporal possessives, and embedded `-per-visit` units
retain the predecessor's tested behavior. Hyphenated noun continuations
such as `application-related` do not become partial units.

The period forms `/mo`, `/month`, `/yr`, `/year`, `per month`, `per year`,
`monthly`, `yearly`, and `annually` are recognition evidence only. A separate
plan-total policy must relate a period to an amount and enforce trusted
exemptions. Currency/measurement parsing and clause boundaries belong to
separate modules. This is one prerequisite in the approved split of #4562;
it carries the slash-period finding forward without integrating runtime copy.

No live callers, database access, provider requests, drafts, sends, or gate
changes are included. Full natural-language understanding is outside this
finite lexical grammar.

Validation:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-unit-lexer.test.js`
