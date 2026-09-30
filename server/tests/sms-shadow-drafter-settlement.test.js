// Codex round-6 pre-push audit P1 (PR #5331): a settlement claim ("you're paid
// up") is decided from authoritative OUTSTANDING obligations, never from the
// set of prices a reply may quote (published monthly dues). Own file so the
// REAL context-aggregator.authorizedDuesCents is in play (sms-shadow-drafter
// .test.js stubs it in an earlier doMock).
const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');

const monthly = (billing) => ({
  customer: { billingLane: { monthlyBilled: true, monthlyDues: { base: 98.5, surcharged: false } } },
  billing: { outstandingBalance: 0, recentPayments: [], ...billing },
});
const check = (reply, ctx) => replyQuotesUngroundedAmount(reply, ctx, { byMeaning: true });

test('the monthly dues stay quotable prices (proves the real dues set is populated)', () => {
  expect(check('Your monthly balance is $98.50.', monthly({}))).toBe(false);
});

test('a settled monthly member can be told "you\'re paid up" / "account is current"', () => {
  expect(check("You're paid up.", monthly({}))).toBe(false);
  expect(check('Your account is current.', monthly({}))).toBe(false);
});

test('real outstanding debt still rejects, from balance or from an open invoice with an amount due', () => {
  expect(check("You're paid up.", monthly({ outstandingBalance: 40 }))).toBe(true);
  expect(check("You're paid up.", monthly({ openInvoice: { amountDue: 40 } }))).toBe(true);
});

test('an open invoice with nothing due is not debt; unavailable billing still fails closed', () => {
  expect(check("You're paid up.", monthly({ openInvoice: { amountDue: 0 } }))).toBe(false);
  expect(check("You're paid up.", monthly({ unavailable: true }))).toBe(true);
});

test('missing billing context is unknowable, never an empty account: {}, no billing key, null all reject a settlement claim', () => {
  expect(check("You're paid up.", {})).toBe(true);
  expect(check('Your account is current.', {})).toBe(true);
  expect(check("You're paid up.", { customer: { billingLane: null } })).toBe(true);
  expect(check("You're paid up.", null)).toBe(true);
  expect(check("You're paid up.", { billing: null })).toBe(true);
  // a successfully loaded billing object with nothing owed still passes
  expect(check("You're paid up.", { billing: { outstandingBalance: 0, recentPayments: [] } })).toBe(false);
});

// Codex round-7 P1 (PR #5331): every payment-status phrase the prompt permits
// is validated against a CURRENT row with the status it requires.
describe('payment-status vocabulary: the prompt and the classifier share ONE table', () => {
  const { PAYMENT_STATUS_VOCABULARY, paymentStatusPromptLine } = require('../services/payment-receipt-vocabulary');
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const row = (status, extra = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...extra });

  test('the drafter system prompt carries the table-derived status line, phrase for phrase', () => {
    const line = paymentStatusPromptLine();
    for (const { phrases } of Object.values(PAYMENT_STATUS_VOCABULARY)) {
      for (const phrase of phrases) expect(line).toContain(`"${phrase}"`);
    }
  });

  test('"Your payment was applied." (amount-free) is rejected even with a paid row on file', () => {
    expect(check('Your payment was applied.', ctx([row('paid')]))).toBe(true);
  });

  test('an amount-bearing "applied" claim binds to a PAID row and date; a refunded row no longer backs it', () => {
    expect(check('Your $120.00 payment was applied on Sep 12.', ctx([row('paid')]))).toBe(false);
    expect(check('Your $120.00 payment was applied on Sep 12.', ctx([row('refunded')]))).toBe(true);
    expect(check('Your $120.00 payment was applied on Sep 12.', ctx([]))).toBe(true);
  });

  test('"still processing" needs a CURRENT pending/processing row — none, or a since-settled/failed row, rejects', () => {
    expect(check('Your payment is still processing.', ctx([]))).toBe(true);
    expect(check('Your payment is still processing.', ctx([row('processing')]))).toBe(false);
    expect(check('Your payment is still processing.', ctx([row('pending')]))).toBe(false);
    // send-time recheck: the same row has since settled / failed
    expect(check('Your payment is still processing.', ctx([row('paid')]))).toBe(true);
    expect(check('Your payment is still processing.', ctx([row('failed')]))).toBe(true);
    // amount form binds to that row's amount
    expect(check('Your $120.00 payment is still processing.', ctx([row('processing')]))).toBe(false);
    expect(check('Your $95.00 payment is still processing.', ctx([row('processing')]))).toBe(true);
  });

  test('"is being processed" is a PENDING claim, not a paid "processed" ack', () => {
    expect(check('Your $120.00 payment is being processed.', ctx([row('processing')]))).toBe(false);
    expect(check('Your $120.00 payment is being processed.', ctx([row('paid')]))).toBe(true);
  });

  test('"didn\'t go through" needs a failed/declined/refunded row', () => {
    expect(check("Your payment didn't go through.", ctx([]))).toBe(true);
    expect(check("Your payment didn't go through.", ctx([row('paid')]))).toBe(true);
    expect(check("Your payment didn't go through.", ctx([row('failed')]))).toBe(false);
  });

  test('every phrase in every family is recognized by the guard (no row ⇒ rejected)', () => {
    for (const [family, { phrases }] of Object.entries(PAYMENT_STATUS_VOCABULARY)) {
      for (const phrase of phrases) {
        // amount-bearing form so the paid family's ack rules apply too
        const reply = family === 'paid'
          ? `Your $120.00 payment ${phrase} on Sep 12.`
          : `Your $120.00 payment ${phrase.startsWith('is ') || phrase.startsWith('still ') || phrase.startsWith('currently ') || phrase.startsWith('being ') ? (phrase.startsWith('being') ? `is ${phrase}` : phrase) : `is ${phrase}`}.`;
        expect({ family, phrase, rejected: check(reply, ctx([])) }).toEqual({ family, phrase, rejected: true });
      }
    }
  });

  test('a non-payment "pending"/"processing" clause is not a payment claim', () => {
    expect(check("We're processing your request.", ctx([]))).toBe(false);
    expect(check('Your estimate is pending.', ctx([]))).toBe(false);
  });
});

// Codex round-7 P1 #2: the bare "bank" tender wording.
describe('bank payment inbound never binds to a card-only history', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const cardRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const bankRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'us_bank_account' };
  const generic = 'Yes, we received your $120.00 payment from Sep 12.';
  test('"Did you get my $120 bank payment?"', () => {
    const inboundMessage = 'Did you get my $120 bank payment?';
    expect(replyQuotesUngroundedAmount(generic, ctx([cardRow]), { byMeaning: true, inboundMessage })).toBe(true);
    expect(replyQuotesUngroundedAmount(generic, ctx([bankRow]), { byMeaning: true, inboundMessage })).toBe(false);
  });
});
