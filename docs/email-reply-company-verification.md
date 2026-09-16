# Email reply company-name policy

`server/services/email/email-reply-company-verifier.js` exports
`verifyEmailReplyCompanyName({ text })`, returning `{ ok, violations }`.
It rejects retired company names, suffixes on the canonical company name,
truncated lawn and pest names, and service-style aliases such as Waves Termite
Control, Waves Mosquito Services, Waves Rodent Control, and Waves Exterminating.
Paired inline Markdown emphasis and code spans are removed before screening so
formatting cannot hide a rendered company name; unmatched delimiters remain.
Rendered whitespace is folded before inline formatting is removed, including
line endings inside emphasis and code spans. HTML character references and
CommonMark punctuation escapes or hard breaks are rendered before screening,
and Unicode dashes are folded for suffix matching.
The canonical Waves Pest Control name, service descriptors followed by a team
role, and ordinary lowercase `waves` prose remain valid. A lowercase
name-shaped phrase is treated as a company alias only after a clear company
introduction such as `contacted`, `contacted the company`, or `the company name
is`; ordinary introductory punctuation and quotes are ignored when evaluating
that context. Title- and mixed-case aliases from the service taxonomy remain
name-shaped on their own. An introduced alias outside that taxonomy is screened
when one to three service words lead into a company noun. Prepositional
references such as `contacted Waves about ant control` remain valid. A title-
or mixed-case service
suffix directly on `Waves Pest Control` is rejected; an introduced lowercase
suffix is also rejected. Lowercase operational service prose and service
descriptors followed by a recognized team role remain valid, except when the
surrounding prose explicitly asserts that the entire phrase is the company or
business name.

The shared retired-name and suffix patterns live in
`server/services/customer-company-name.js`. `previsit-brief.js` imports those
patterns unchanged, so this extraction does not expand its existing behavior.
The email-only service-alias and canonical-team handling stay in the email
verifier.

Passing this policy does not verify any customer, account, price, treatment,
or schedule fact. No runtime caller, model request, database write, Gmail call,
or draft/send authorization is included.

Run the synthetic regressions from the repository root with Node 20 and UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-company-verifier.test.js server/tests/previsit-brief.test.js`.
