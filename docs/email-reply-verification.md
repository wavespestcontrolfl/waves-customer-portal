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
unsupplied second name after the expected name fails the greeting delimiter;
a newline after the exact name is a valid separator.

The plain-output screen rejects plus bullets, HTML comments and tag openers
(including unterminated ones), relative/fragment/reference Markdown links,
and terminal closing/name structures including lowercase dashed names.
Standalone thanks followed by substantive reply prose remains valid.
An inline terminal `Regards, Alex` is a signature; `Thanks, I will check.`
and `Thanks, We will check soon.` are ordinary reply prose.
Mathematical comparisons such as `< 3` remain plain prose. Boilerplate
screening folds whitespace and smart
apostrophes and recognizes both `thank you` and `thanks` generic openers.
Bullet glyphs count at the start of a line even without a space.
Bare hostname checks use the repository's public-suffix-list dependency, so
common attachment filenames such as `invoice.pdf` do not count as domains;
`.zip` is treated as a filename only in explicit attachment/file prose.
An ambiguous bare `logs.zip` and explicit URLs remain links. An IPv4 address
followed by an optional numeric port and path also counts as a link; ordinary
version numbers and bare
addresses do not. The canonical report access-code helper receives compatibility
letters/digits with mixed fractions preserved, so a gate width does not become
a credential. Explicitly labeled payment, postal, and service code/value
phrases are excluded from that screen unless nearby text identifies a physical
access point in the same sentence; digital access alone
does not identify physical entry. Gate and lockbox codes elsewhere remain
subject to it. A code used to enter or unlock a property also remains
screened, including a home, house, or building. Alphanumeric error identifiers
such as `ERR42` and `3DS2`
are recognized as non-access codes only when labeled that way.
Output-specific prompt-control checks permit ordinary customer
preparation corrections, including an immediate `about preparing` or
`for preparing` qualifier after `instructions`, and operational colon labels;
generic directions not to follow previous instructions are rejected.

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
