# Inactive email pricing context candidates

`recognizeEmailReplyPricingContext(text = '')` extends
`recognizeEmailReplyPeriodPhrases` with typed context-word candidates. It has
no runtime caller and does not authorize a reply, send a message, invoke a
provider, or access a database.

## Result contract

Failures pass through by identity. Every successful result is
`{ ok: true, disposition: 'needs_review', clauses }`; each clause retains
every upstream field by identity plus a `contextPhrases` array of
`{ start, end, text, token, roles }` with clause-local token indexes and the
original token object.

Roles are finite and may overlap on one word:

- `plan`: `plan`, `program`, `package`.
- `account`: `account`, `balance`, `payment`, `refund`, `credit`, `deposit`,
  `receipt`, `received`, `pay`, `due`.
- `account_event`: `posted`, `cleared`, `received`, `refunded`, `credited`,
  `pay` (the scanner stems `paid` to `pay`, so `pay` carries both roles).
- `activity`: `reminder(s)`, `update(s)`, `schedule`/`scheduling`,
  `appointment(s)`, `service(s)`, `treatment(s)`.
- `adjustment`: reduce/save/discount/increase/decrease word forms.
- `measurement`: `percent`, `percentage`, distance nouns, and the `%` barrier.

## Boundaries and uncertainty

A role is lexical context only. It never establishes a price, an account
event, an exemption, or a violation, and it never attaches an amount, period
or unit. Independent typed evidence (predicates, price evidence, period
candidates) is untouched. Unknown words stay in `tokens`. Consumers must
establish complete relationships themselves and keep `needs_review` when
they cannot.

The inherited normalization limits apply.

## Ownership and verification

The shared scanner owns normalization and lexing; this module only tags
words. Frozen adapters are unchanged.

Run `npx jest server/tests/email-reply-pricing-context.test.js --runInBand`.
