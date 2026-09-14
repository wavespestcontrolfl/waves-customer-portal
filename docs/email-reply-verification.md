# Email reply presentation checks

`server/services/email/email-reply-verifier.js` exports
`verifyEmailReplyStructure({text, customer, wordBudget})` and `wordCount`.
It returns `{ok, violations}` for the complete reply.

This inactive helper checks the word budget, exact supplied first-name greeting,
recognized signatures, HTML and lists, boilerplate, links, access credentials,
and recognized prompt-control language. It makes no model request, database
write, Gmail call, or draft/send decision. No runtime caller is added.

Whitespace and word-separating dashes count toward the budget; true hyphenated
compounds remain one word, and a standalone dash is not a word. Name comparison accepts Unicode and punctuation
equivalents inside the expected name, while preserving the difference between
an em-dash greeting separator and a hyphen continuing a longer name. An
unsupplied second name after the expected name fails the greeting delimiter.

The plain-output screen rejects plus bullets, HTML comments (including an
unterminated opener), relative/fragment/reference Markdown links, and common
closing/name structures. Boilerplate screening folds whitespace and smart
apostrophes. Bullet glyphs count at the start of a line even without a space.
Bare hostname checks use the repository's public-suffix-list dependency, so
common attachment filenames such as `invoice.pdf` do not count as domains;
`.zip` is treated as a filename only in explicit attachment/file prose.
An ambiguous bare `logs.zip` and explicit URLs remain links. The canonical
report access-code helper receives compatibility
letters/digits with mixed fractions preserved, so a gate width does not become
a credential. Explicitly labeled payment, postal, and service code/value
phrases are excluded from that screen unless nearby text identifies a physical
access point in the same sentence; gate and lockbox codes elsewhere remain
subject to it. Alphanumeric error identifiers such as `ERR42` and `3DS2`
are recognized as non-access codes only when labeled that way.
Output-specific prompt-control checks permit ordinary customer
preparation corrections and operational colon labels.

These are recognized lexical and structural checks, not a comprehensive
natural-language or HTML parser. Success does not establish customer-copy
compliance, financial or scheduling truth, or permission to create/send a
reply. Customer-copy policy is a separately reviewed sibling slice; account
fact verification and runtime integration remain later work.

This presentation recut preserves the complete combined implementation and
regression suite on PR #4511, `feat/email-reply-structure` at `c620a389d9`.
No runtime activation is included in the recut.

Run from `server/` using Node 20 and `TZ=UTC`:
`node ../node_modules/jest/bin/jest.js --runInBand --no-coverage tests/email-reply-verifier.test.js`.
Tests use synthetic inputs and need no provider/database credentials.
