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

// Codex round-8 P1 (PR #5331): paid, pending and failed claims share ONE binder
// with identical amount/date/tender/inbound/ambiguity rules.
describe('pending/failed claims bind to the SPECIFIC payment (one binder for every family)', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const augFailedCard = { amount: 120, status: 'failed', payment_date: '2026-08-05', payment_method_type: 'card' };
  const sepFailedZelle = { amount: 120, status: 'failed', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
  const sepPaidZelle = { amount: 120, status: 'paid', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
  const sepProcessingZelle = { amount: 120, status: 'processing', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
  const sepProcessingCard = { amount: 120, status: 'processing', payment_date: '2026-09-12', payment_method_type: 'card' };
  const inbound = (inboundMessage) => (reply, c) => replyQuotesUngroundedAmount(reply, c, { byMeaning: true, inboundMessage });

  test('an August failed CARD payment never authorizes "Your $120 Zelle payment from Sep 12 failed" (even when the Sep Zelle payment is paid)', () => {
    const reply = 'Your $120 Zelle payment from Sep 12 failed.';
    expect(check(reply, ctx([augFailedCard, sepPaidZelle]))).toBe(true);
    expect(check(reply, ctx([augFailedCard]))).toBe(true);
    expect(check(reply, ctx([augFailedCard, sepFailedZelle]))).toBe(false);
  });

  test('the same tender/date rules hold for "still processing"', () => {
    const reply = 'Your $120 Zelle payment from Sep 12 is still processing.';
    expect(check(reply, ctx([sepProcessingCard]))).toBe(true);
    expect(check(reply, ctx([{ ...sepProcessingZelle, payment_date: '2026-08-05' }]))).toBe(true);
    expect(check(reply, ctx([sepPaidZelle]))).toBe(true);
    expect(check(reply, ctx([sepProcessingZelle]))).toBe(false);
  });

  test('reverse cases: a date-less status report still binds by amount/tender; a stated date must match', () => {
    expect(check('Your $120 payment is still processing.', ctx([sepProcessingZelle]))).toBe(false);
    expect(check('Your $120 card payment is still processing.', ctx([sepProcessingZelle]))).toBe(true);
    expect(check('Your $120 card payment is still processing.', ctx([sepProcessingCard]))).toBe(false);
    expect(check('Your payment is still processing.', ctx([sepProcessingZelle]))).toBe(false);
    expect(check('Your Zelle payment is still processing.', ctx([sepProcessingCard]))).toBe(true);
  });

  test('inbound tender/date/ambiguity apply to status claims exactly as to receipts', () => {
    const reply = 'Your $120 payment from Sep 12 is still processing.';
    expect(inbound('Did my $120 Zelle payment go through?')(reply, ctx([sepProcessingCard]))).toBe(true);
    expect(inbound('Did my $120 Zelle payment go through?')(reply, ctx([sepProcessingZelle]))).toBe(false);
    // ambiguous inbound tender fails closed
    expect(inbound('I sent Zelle, not a check - did it arrive?')(reply, ctx([sepProcessingZelle]))).toBe(true);
    // payment-related inbound, no tender, several tenders for that amount/date
    expect(inbound('Did my $120 payment go through?')(reply, ctx([sepProcessingZelle, sepProcessingCard]))).toBe(true);
  });

  test('paid claims still bind identically (regression)', () => {
    expect(check('We received your $120.00 Zelle payment from Sep 12.', ctx([sepPaidZelle]))).toBe(false);
    expect(check('We received your $120.00 Zelle payment from Sep 12.', ctx([augFailedCard]))).toBe(true);
  });
});
