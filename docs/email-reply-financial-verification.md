# Email reply amount and status checks

`email-reply-financial-verifier.js` exports
`verifyEmailReplyAmountsAndStatuses({text, context})`, returning
`{ok, violations}` for recognized financial amounts and status wording. It consumes present authoritative facts from the existing
email context assembler. It performs no queries, charge calculations, writes,
model requests or customer communications.

Amounts retain their meaning: customer balance, invoice amount, payment,
base dues, surcharge and collected total are not interchangeable. Monthly
dues require the assembled monthly-billed lane and a positive quoted base. Null is not
zero, and a withheld quote cannot support a fee or total. Currency spelling
must use supported unsigned numeric forms; malformed grouping/precision,
signed or written amounts, and magnitude suffixes require review.

Recognized invoice, payment and estimate states must match the authoritative
record. Negated monetary claims require review. Positive debt language needs
present positive evidence. Recognized requests to pay an invoice need an
unambiguous customer-owned open invoice; payer-billed invoice evidence cannot
authorize asking the customer to pay it.

The checker does not validate dates, scheduling, technician assignments,
reply structure, placeholders or facts copied from examples. Date-based
record selection and complete cross-category verification return in the later
composition slice. A successful partial check must not authorize a draft.
The full `verifyEmailReply` API and runtime wiring remain absent. Shared
`sentences`, `factLanguage`, and `financialFactKeys` helpers keep the later
composition on the same sentence and financial-category rules. The sentence
splitter preserves dotted AM/PM abbreviations; it does not validate times.

The source regression suite is preserved at `d47770a57e` on
`feat/email-reply-verifier`. This slice incorporates the financial review
findings from #4494; the day-part and technician findings belong to the
scheduling slice. Live activation remains separately approved.

Run from `server/` with Node 20 and `TZ=UTC`:
`node ../node_modules/jest/bin/jest.js --runInBand --no-coverage tests/email-reply-financial-verifier.test.js`.
Tests use synthetic context facts and require no provider/database credentials.
