# Bounded email copy normalization

`normalizeEmailReplyCopy(text)` is the inactive normalization prerequisite for
the monetary and amountless pricing-policy recut of #4546. Success returns
`{ ok: true, text }`; failure returns `{ ok: false, text: null, reason }`.
Callers must reject failures, including for trusted commercial proposals.
Never match a truncated prefix or treat failure as empty compliant copy.

The fixed resource limits are 8,192 UTF-8 bytes, 512 whitespace-delimited
tokens, and eight formatting passes (including the stabilizing pass).
Raw length is checked before decoding, Unicode normalization, or regex work.
Decoded/compatibility-normalized text is checked again because expansion can
introduce bytes and tokens. Every formatting pass removes characters; failure
to stabilize within the pass budget returns `copy_format_depth` without text.
Other reasons are `copy_type`, `copy_size`, and `copy_tokens`.

The helper extracts the lexical normalization from preserved pricing head
`4f944d3868`: entities, compatibility typography, dashes/apostrophes, Markdown
escapes/hard breaks, whitespace, and paired code/emphasis. Unmatched delimiters
remain. It is not a complete CommonMark/HTML renderer or a compliance verdict.
Punctuation dashes U+2012–U+2015 become spaced ASCII separators; lexical
hyphens U+2010/U+2011 and the mathematical minus retain joined ASCII folding.
The whitespace-token bound is checked again after punctuation spacing.
HTML rendering, presentation completeness, factual grounding, and authorization
to draft/send remain separate checks. The existing content/MDX normalizer has
a different rendering contract and is not used as an email parser.

No existing claims/company helper, live customer-copy guard, runtime caller,
provider, database, or sending path is changed by this prerequisite.

Run from the root with UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-copy-normalizer.test.js`.
