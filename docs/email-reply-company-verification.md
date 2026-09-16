# Email reply company-name policy

`server/services/email/email-reply-company-verifier.js` exports
`verifyEmailReplyCompanyName({ text })`, returning `{ ok, violations }`.
It rejects retired company names, suffixes on the canonical company name,
truncated lawn and pest names, and service-style aliases such as Waves Termite
Control, Waves Mosquito Services, and Waves Exterminating. Paired inline
Markdown emphasis is removed before screening so formatting cannot hide a
rendered company name, and Unicode dashes are folded for suffix matching. The
canonical Waves Pest Control name, prose referring to its lawn, termite, or
mosquito team, and ordinary uses of lowercase `waves` remain valid.

The shared retired-name and suffix patterns live in
`server/services/customer-company-name.js`. `previsit-brief.js` imports those
patterns unchanged, so this extraction does not expand its existing behavior.
The email-only service-alias check stays in the email verifier.

Passing this policy does not verify any customer, account, price, treatment,
or schedule fact. No runtime caller, model request, database write, Gmail call,
or draft/send authorization is included.

Run the synthetic regressions from the repository root with Node 20 and UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-company-verifier.test.js server/tests/previsit-brief.test.js`.
