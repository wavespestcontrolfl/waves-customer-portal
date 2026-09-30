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

  test('"didn\'t go through" needs a FAILED row (a refunded row is a reversal, not a failure)', () => {
    expect(check("Your payment didn't go through.", ctx([]))).toBe(true);
    expect(check("Your payment didn't go through.", ctx([row('paid')]))).toBe(true);
    expect(check("Your payment didn't go through.", ctx([row('failed')]))).toBe(false);
  });

  test('every phrase in every family is recognized by the guard', () => {
    for (const [family, { phrases, rowStatuses }] of Object.entries(PAYMENT_STATUS_VOCABULARY)) {
      const absence = family === 'not_found' || family === 'not_received';
      for (const phrase of phrases) {
        const reply = absence
          ? `Note: ${phrase} for your $120.00 payment.`
          : family === 'paid'
            ? `Your $120.00 payment ${phrase} on Sep 12.`
            : `Your $120.00 payment ${/^(?:is|still|currently|being|was|has|refunded|disputed|charged|failed|declined|didn|did|bounced|unsuccessful|pending|processing|in )/.test(phrase) ? (phrase.startsWith('being') ? `is ${phrase}` : (/^(?:refunded|disputed|failed|declined|bounced|unsuccessful|pending|processing)/.test(phrase) ? `is ${phrase}` : phrase)) : `is ${phrase}`}.`;
        const backing = ctx([row(rowStatuses[0])]);
        const noRow = check(reply, ctx([]));
        const withRow = check(reply, backing);
        // an ordinary family needs a matching row; an ABSENCE family is contradicted by one
        expect({ family, phrase, noRow, withRow }).toEqual({ family, phrase, noRow: !absence, withRow: absence });
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

// Codex round-8 (PR #5331): reversed family, not-found family, ACH tender label, inbound identity.
describe('round-8: reversed rows, absence claims, tender label, inbound identity', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const today = new Date().toISOString().slice(0, 10);
  const paidZelleToday = { amount: 120, status: 'paid', payment_date: today, description: 'Invoice INV-9 — zelle' };
  const oldPaid = { amount: 120, status: 'paid', payment_date: '2026-01-05', payment_method_type: 'card' };
  const refunded = { amount: 120, status: 'refunded', payment_date: '2026-09-12', payment_method_type: 'card' };
  const disputed = { amount: 120, status: 'disputed', payment_date: '2026-09-12', payment_method_type: 'card' };
  const failedRow = { amount: 120, status: 'failed', payment_date: '2026-09-12', payment_method_type: 'card' };
  const { paymentTenderLabel, replyQuotesUngroundedAmount: rq } = require('../services/sms-shadow-drafter');

  test('#4 reversed is its own family: refunded/disputed rows back "was refunded"/"is disputed", never "failed"', () => {
    expect(check('Your $120.00 payment was refunded.', ctx([refunded]))).toBe(false);
    expect(check('Your $120.00 payment is disputed.', ctx([disputed]))).toBe(false);
    expect(check('Your $120.00 payment was refunded.', ctx([failedRow]))).toBe(true);
    expect(check('Your $120.00 payment was refunded.', ctx([]))).toBe(true);
    // failure phrases do not bind to reversed rows
    expect(check('Your $120.00 payment failed.', ctx([refunded]))).toBe(true);
    expect(check("Your $120.00 payment didn't go through.", ctx([disputed]))).toBe(true);
    expect(check('Your $120.00 payment failed.', ctx([failedRow]))).toBe(false);
  });

  test('#4 the prompt no longer says a refunded payment "did NOT go through" and states the reversal wording', () => {
    const { PAYMENT_STATUS_VOCABULARY, paymentStatusPromptLine } = require('../services/payment-receipt-vocabulary');
    expect(PAYMENT_STATUS_VOCABULARY.failed.rowStatuses).not.toContain('refunded');
    expect(PAYMENT_STATUS_VOCABULARY.failed.rowStatuses).not.toContain('disputed');
    expect(PAYMENT_STATUS_VOCABULARY.refunded.rowStatuses).toEqual(['refunded']);
    expect(PAYMENT_STATUS_VOCABULARY.disputed.rowStatuses).toEqual(['disputed']);
    expect(PAYMENT_STATUS_VOCABULARY.reversed.rowStatuses).toEqual(['refunded', 'disputed']);
    const line = paymentStatusPromptLine();
    expect(line).toMatch(/refunded or disputed payment WAS received and then reversed/);
  });

  test('#3 "isn\'t showing" is valid only when NO matching paid/pending row exists NOW', () => {
    const reply = "Your $120 payment isn't showing on our end yet.";
    expect(check(reply, ctx([]))).toBe(false);
    expect(check(reply, ctx([failedRow]))).toBe(false);
    expect(check(reply, ctx([{ ...paidZelleToday, payment_method_type: 'card' }]))).toBe(true);
    expect(check(reply, ctx([{ ...oldPaid, amount: 95 }]))).toBe(false); // different amount
    expect(check(reply, ctx([{ amount: 120, status: 'processing', payment_date: today, payment_method_type: 'card' }]))).toBe(true);
    expect(check('Your $120 Zelle payment isn\'t showing on our end yet.', ctx([oldPaid]))).toBe(false); // card row, not Zelle
  });

  test('#3 the prompt\'s own bare response ("Your payment isn\'t showing on our end yet") is contradicted by ANY paid/pending row in the facts', () => {
    const reply = "Your payment isn't showing on our end yet.";
    expect(check(reply, ctx([]))).toBe(false);
    // no time window: ANY paid/pending row in the facts contradicts an unnamed payment (a 10-day-old payment that landed must not read "isn't showing")
    expect(check(reply, ctx([oldPaid]))).toBe(true);
    expect(rq(reply, ctx([oldPaid]), { byMeaning: true, inboundMessage: 'Did my $95 payment arrive?' })).toBe(false);
    expect(check(reply, ctx([paidZelleToday]))).toBe(true);          // a payment landed today
    // identity named by the customer's own message
    expect(rq(reply, ctx([paidZelleToday]), { byMeaning: true, inboundMessage: 'Did my $95 Zelle payment arrive?' })).toBe(false);
    expect(rq(reply, ctx([paidZelleToday]), { byMeaning: true, inboundMessage: 'Did my $120 Zelle payment arrive?' })).toBe(true);
    // unavailable billing fails closed
    expect(check(reply, { billing: { unavailable: true } })).toBe(true);
  });

  test('#3 "haven\'t received" is contradicted only by a PAID row (a processing row is "not received yet")', () => {
    const reply = "We haven't received your $120 payment yet.";
    expect(check(reply, ctx([{ amount: 120, status: 'processing', payment_date: today, payment_method_type: 'card' }]))).toBe(false);
    expect(check(reply, ctx([{ ...paidZelleToday, payment_method_type: 'card' }]))).toBe(true);
    expect(check(reply, ctx([]))).toBe(false);
  });

  test('#1 card_last_four alone is NOT a card: ACH rows (bank last4, no method type) read from persisted metadata', () => {
    expect(paymentTenderLabel({ card_last_four: '6789' })).toBeNull();
    expect(paymentTenderLabel({ card_last_four: '6789', metadata: JSON.stringify({ payment_method: 'us_bank_account' }) })).toBe('bank/ACH');
    expect(paymentTenderLabel({ card_last_four: '6789', metadata: { payment_method: 'us_bank_account' } })).toBe('bank/ACH');
    expect(paymentTenderLabel({ card_last_four: '4242', metadata: { payment_method: 'card' } })).toBe('card');
    expect(paymentTenderLabel({ card_last_four: '4242', card_brand: 'visa' })).toBe('card');
    expect(paymentTenderLabel({ metadata: 'not json', card_last_four: '1' })).toBeNull();
    // an ACH row never satisfies a card confirmation, and vice versa
    const ach = { amount: 120, status: 'paid', payment_date: '2026-09-12', card_last_four: '6789', metadata: { payment_method: 'us_bank_account' } };
    expect(check('We received your $120.00 card payment from Sep 12.', ctx([ach]))).toBe(true);
    expect(check('We received your $120.00 ACH payment from Sep 12.', ctx([ach]))).toBe(false);
    // unknown method: a tender claim cannot bind
    expect(check('We received your $120.00 card payment from Sep 12.', ctx([{ amount: 120, status: 'paid', payment_date: '2026-09-12', card_last_four: '6789' }]))).toBe(true);
  });

  test('#2 pending/failed claims bind to the customer\'s inbound identity (unrelated card attempt pending)', () => {
    const cardPending = { amount: 120, status: 'processing', payment_date: '2026-09-12', payment_method_type: 'card' };
    const zellePending = { amount: 120, status: 'processing', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
    const reply = 'Your payment is still processing.';
    const inboundMessage = 'Did you get my Zelle payment?';
    expect(rq(reply, ctx([cardPending]), { byMeaning: true, inboundMessage })).toBe(true);
    expect(rq(reply, ctx([zellePending]), { byMeaning: true, inboundMessage })).toBe(false);
    expect(rq(reply, ctx([cardPending]), { byMeaning: true, inboundMessage: 'Did my check clear?' })).toBe(true);
  });
});

describe('round-9: refunded vs disputed are distinct reversals', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const row = (status) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card' });
  test('"refunded" phrases bind only to refunded rows; "disputed/charged back" only to disputed rows; "was reversed" to either', () => {
    expect(check('Your $120.00 payment was refunded.', ctx([row('refunded')]))).toBe(false);
    expect(check('Your $120.00 payment was refunded.', ctx([row('disputed')]))).toBe(true);
    expect(check('Your $120.00 payment is disputed.', ctx([row('disputed')]))).toBe(false);
    expect(check('Your $120.00 payment is disputed.', ctx([row('refunded')]))).toBe(true);
    expect(check('Your $120.00 payment was charged back.', ctx([row('disputed')]))).toBe(false);
    expect(check('Your $120.00 payment was charged back.', ctx([row('refunded')]))).toBe(true);
    expect(check('Your $120.00 payment was reversed.', ctx([row('refunded')]))).toBe(false);
    expect(check('Your $120.00 payment was reversed.', ctx([row('disputed')]))).toBe(false);
    expect(check('Your $120.00 payment was reversed.', ctx([row('paid')]))).toBe(true);
  });
  test('the prompt built from the table states each reversal on its own row status', () => {
    const { paymentStatusPromptLine } = require('../services/payment-receipt-vocabulary');
    const line = paymentStatusPromptLine();
    expect(line).toMatch(/"was refunded".*ONLY for a line marked refunded, "was disputed".*ONLY for a line marked disputed, and "was reversed" for either/);
  });
});
