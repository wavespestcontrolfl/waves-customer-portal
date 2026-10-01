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
      const absence = family === 'not_found' || family === 'not_received' || family === 'unpaid';
      for (const phrase of phrases) {
        const reply = absence
          ? `Note: ${phrase} for your $120.00 payment.`
          : family === 'paid'
            ? `Your $120.00 payment ${phrase} on Sep 12.`
            : `Your $120.00 payment ${/^(?:is|still|currently|being|was|has|refunded|disputed|charged|failed|declined|didn|did|bounced|unsuccessful|pending|processing|in )/.test(phrase) ? (phrase.startsWith('being') ? `is ${phrase}` : (/^(?:refunded|disputed|failed|declined|bounced|unsuccessful|pending|processing)/.test(phrase) ? `is ${phrase}` : phrase)) : `is ${phrase}`}.`;
        const backing = ctx([row(rowStatuses[0] === '*' ? 'failed' : rowStatuses[0])]);
        const noRow = check(reply, ctx([]));
        const withRow = check(reply, backing);
        // an ordinary family needs a matching row; an ABSENCE family is contradicted by one
        // an ordinary family needs a matching row; an ABSENCE family is contradicted by one;
        // "unpaid" is owed-shaped too, so its $120 figure must itself be owed (rejected with no balance)
        expect({ family, phrase, noRow, withRow }).toEqual({ family, phrase, noRow: family === 'unpaid' ? true : !absence, withRow: absence });
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

  test('#3 "isn\'t showing" is valid only when NO matching row of ANY status exists NOW', () => {
    const reply = "Your $120 payment isn't showing on our end yet.";
    expect(check(reply, ctx([]))).toBe(false);
    // Codex round-9: a row of ANY status matching the identity contradicts "isn't showing" (failed, refunded, …)
    expect(check(reply, ctx([failedRow]))).toBe(true);
    expect(check(reply, ctx([refunded]))).toBe(true);
    expect(check(reply, ctx([{ ...failedRow, amount: 95 }]))).toBe(false); // a different amount does not
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

describe('round-9: negated status phrases fail closed; "isn\'t showing" is contradicted by ANY status', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const zelle = (status) => ({ amount: 120, status, payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' });
  const { paymentStatusPhraseClaim } = require('../services/payment-receipt-vocabulary');

  test('#1 a negated presence claim classifies as "negated" and is rejected even beside a matching row', () => {
    for (const c of ['Your payment is not pending', "Your payment wasn't refunded", "Your payment didn't fail", "Your payment wasn't declined",
      'Your payment is not being processed', 'Your payment has not yet been refunded', "Your payment isn't still processing"]) {
      expect({ c, kind: paymentStatusPhraseClaim(c) }).toEqual({ c, kind: 'negated' });
    }
    expect(check('Your $120.00 payment is not pending.', ctx([zelle('paid')]))).toBe(true);
    expect(check('Your $120.00 payment is not pending.', ctx([zelle('processing')]))).toBe(true);
    expect(check("Your $120.00 payment wasn't refunded.", ctx([zelle('refunded')]))).toBe(true);
    expect(check("Your $120.00 payment didn't fail.", ctx([zelle('paid')]))).toBe(true);
  });

  test('#1 the families\' own negative phrases keep their positive meaning ("didn\'t go through", "haven\'t received")', () => {
    expect(paymentStatusPhraseClaim("Your payment didn't go through")).toBe('failed');
    expect(paymentStatusPhraseClaim("We haven't received your payment")).toBe('not_received');
    expect(paymentStatusPhraseClaim('Your payment was not received')).toBe('not_received');
    expect(check("Your $120.00 payment didn't go through.", ctx([zelle('failed')]))).toBe(false);
    expect(check('We have not received your $120.00 payment yet.', ctx([zelle('processing')]))).toBe(false);
    expect(check('Your $120.00 payment was not received.', ctx([zelle('paid')]))).toBe(true);
    // an ordinary positive claim is unaffected, and distant negation elsewhere does not flip it
    expect(check("Don't worry, your $120.00 payment is pending.", ctx([zelle('pending')]))).toBe(false);
  });

  test('#2 "isn\'t showing" is contradicted by a FAILED or REFUNDED Zelle row for the named payment', () => {
    const reply = "Your $120 Zelle payment isn't showing on our end yet.";
    expect(check(reply, ctx([zelle('failed')]))).toBe(true);
    expect(check(reply, ctx([zelle('refunded')]))).toBe(true);
    expect(check(reply, ctx([zelle('canceled')]))).toBe(true);
    expect(check(reply, ctx([]))).toBe(false);
    expect(check(reply, ctx([{ ...zelle('failed'), payment_method_type: 'card', description: null }]))).toBe(false); // a card row is not the Zelle payment
    expect(paymentStatusPromptLineHas()).toBe(true);
  });
  function paymentStatusPromptLineHas() {
    return /NO line of ANY status \(paid, pending, failed, refunded, …\) matches/.test(require('../services/payment-receipt-vocabulary').paymentStatusPromptLine());
  }
});

// Codex round-10 P1: absence claims read the AUTHORITATIVE history, not the 3-row window.
describe('round-10: absence claims use the full payment history', () => {
  const shown = [1, 2, 3].map((n) => ({ amount: 50 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  const fourth = { amount: 120, status: 'paid', payment_date: '2026-08-20', description: 'Invoice INV-4 — zelle' };
  const ctx = (rows, complete = true, hist = { rows, complete }) => ({ billing: { outstandingBalance: 0, recentPayments: shown, paymentHistory: hist } });
  const rq = (reply, c, inboundMessage) => replyQuotesUngroundedAmount(reply, c, { byMeaning: true, inboundMessage });
  const reply = "Your $120 Zelle payment isn't showing on our end yet.";

  test('a real 4th payment (outside the 3-row window) contradicts "isn\'t showing"', () => {
    expect(check(reply, ctx([...shown, fourth]))).toBe(true);
    expect(check("We haven't received your $120 Zelle payment yet.", ctx([...shown, fourth]))).toBe(true);
  });

  test('no match anywhere in a COMPLETE history: the denial passes', () => {
    expect(check(reply, ctx(shown))).toBe(false);
    expect(check(reply, ctx([...shown, { ...fourth, amount: 95 }]))).toBe(false);
  });

  test('history read failed (null) ⇒ reject; bound hit with no match ⇒ reject; bound hit WITH a match ⇒ reject anyway', () => {
    expect(check(reply, ctx(shown, true, null))).toBe(true);
    expect(check(reply, ctx(shown, false))).toBe(true);
    expect(check(reply, ctx([...shown, fourth], false))).toBe(true);
  });

  test('bare "isn\'t showing" (no identity anywhere): more history than was shown ⇒ reject; same rows ⇒ unchanged', () => {
    const bare = "Your payment isn't showing on our end yet.";
    const failedOnly = { amount: 40, status: 'failed', payment_date: '2026-01-01', payment_method_type: 'card' };
    expect(check(bare, { billing: { outstandingBalance: 0, recentPayments: [], paymentHistory: { rows: [failedOnly], complete: true } } })).toBe(true);
    expect(check(bare, { billing: { outstandingBalance: 0, recentPayments: [], paymentHistory: { rows: [], complete: true } } })).toBe(false);
    // the customer's message names an identity ⇒ the history is queried by it instead
    expect(rq(bare, { billing: { outstandingBalance: 0, recentPayments: [], paymentHistory: { rows: [failedOnly], complete: true } } }, 'Did my $95 payment arrive?')).toBe(false);
    expect(rq(bare, ctx([...shown, fourth]), 'Did my $120 Zelle payment arrive?')).toBe(true);
  });

  test('a context without a history field reads the shown rows as the whole history (legacy shape)', () => {
    expect(check(reply, { billing: { outstandingBalance: 0, recentPayments: [fourth] } })).toBe(true);
    expect(check(reply, { billing: { outstandingBalance: 0, recentPayments: [] } })).toBe(false);
  });
});

// Codex round-10 (PR #5331): polarity on amount-bearing acks, Cash App, one classifier.
describe('round-10: negated amount-bearing acks, Cash App', () => {
  const ctx = (payments) => ({ billing: { outstandingBalance: 0, recentPayments: payments } });
  const paidCard = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const cashRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', description: 'Invoice INV-1 — cash' };
  const { replyClaimedTender, paymentAckPolarity, hasAffirmativePaymentAck } = require('../services/sms-shadow-drafter');

  test('a NEGATED ack with a figure never binds to a paid row', () => {
    for (const r of ['Your $120 payment was not received from Sep 12.', "Your $120 payment wasn't processed from Sep 12.",
      "We didn't get your $120 payment from Sep 12.", "Your $120 payment hasn't been applied from Sep 12."]) {
      expect({ r, ungrounded: check(r, ctx([paidCard])) }).toEqual({ r, ungrounded: true });
    }
    // the positive form still binds
    expect(check('We received your $120 payment from Sep 12.', ctx([paidCard]))).toBe(false);
  });

  test('amount-free truthful denials with a non-family verb are untouched (unchanged behavior)', () => {
    expect(check("We didn't get your payment yet.", ctx([]))).toBe(false);
  });

  test('polarity helper: positive / negated / null; hasAffirmativePaymentAck uses it', () => {
    expect(paymentAckPolarity('we received your payment')).toBe('positive');
    expect(paymentAckPolarity("we haven't received your payment")).toBe('negated');
    expect(paymentAckPolarity('see you Tuesday')).toBeNull();
    expect(hasAffirmativePaymentAck("we haven't received your payment")).toBe(false);
  });

  test('Cash App is its own tender, never physical Cash; "cash" alone still is Cash', () => {
    expect(replyClaimedTender('I paid with Cash App')).toBe('Cash App');
    expect(replyClaimedTender('my Cash  App payment')).toBe('Cash App');
    expect(replyClaimedTender('I paid cash')).toBe('Cash');
    // the quoted inbound against a manual CASH row is rejected; against nothing it can never bind
    const generic = 'Yes, we received your $120.00 payment from Sep 12.';
    expect(replyQuotesUngroundedAmount(generic, ctx([cashRow]), { byMeaning: true, inboundMessage: 'I sent $120 on Cash App on Sep 12, did you get it?' })).toBe(true);
    expect(replyQuotesUngroundedAmount(generic, ctx([cashRow]), { byMeaning: true, inboundMessage: 'I paid $120 cash on Sep 12, did you get it?' })).toBe(false);
  });

  test('no raw PAYMENT_ACK_RE decision remains outside the polarity helper (structural guard)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/sms-shadow-drafter'), 'utf8').split('\n');
    const uses = src.map((l, i) => [i + 1, l]).filter(([, l]) => /PAYMENT_ACK_RE\.test\(/.test(l) && !/^\s*\/\//.test(l));
    expect(uses).toHaveLength(1); // paymentAckPolarity itself
    const recheck = fs.readFileSync(require.resolve('../services/sms-amount-recheck'), 'utf8');
    expect(recheck).not.toMatch(/PAYMENT_ACK_RE\.test\(/);
  });
});

describe('round-11: an unloaded history under a possibly-truncated window is unknown', () => {
  const shown = [1, 2, 3].map((n) => ({ amount: 50 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  test('paymentHistory absent + recentPaymentsTruncated => the absence claim is rejected; not truncated => shown rows are the history', () => {
    const reply = "Your $120 Zelle payment isn't showing on our end yet.";
    expect(check(reply, { billing: { outstandingBalance: 0, recentPayments: shown, recentPaymentsTruncated: true } })).toBe(true);
    expect(check(reply, { billing: { outstandingBalance: 0, recentPayments: shown, recentPaymentsTruncated: false } })).toBe(false);
  });
});

describe('round-11: not_received contradicted by reversed rows; settlement needs nothing in flight', () => {
  const ctx = (payments, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: payments, ...extra } });
  const row = (status) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card' });
  test('"haven\'t received" is contradicted by paid, refunded AND disputed rows; pending/processing still are not', () => {
    const reply = "We haven't received your $120 payment yet.";
    for (const st of ['paid', 'refunded', 'disputed']) expect({ st, bad: check(reply, ctx([row(st)])) }).toEqual({ st, bad: true });
    for (const st of ['processing', 'pending', 'failed']) expect({ st, bad: check(reply, ctx([row(st)])) }).toEqual({ st, bad: false });
    const { PAYMENT_STATUS_VOCABULARY } = require('../services/payment-receipt-vocabulary');
    expect(PAYMENT_STATUS_VOCABULARY.not_received.rowStatuses).toEqual(['paid', 'refunded', 'disputed']);
  });

  test('settlement claims are rejected while a payment/invoice is processing or pending', () => {
    for (const reply of ["You're paid up.", 'Your account is current.']) {
      expect(check(reply, ctx([row('processing')]))).toBe(true);
      expect(check(reply, ctx([row('pending')]))).toBe(true);
      expect(check(reply, ctx([], { hasProcessingPayment: true }))).toBe(true); // e.g. a processing invoice the balance excludes
      expect(check(reply, ctx([row('paid')]))).toBe(false); // settled history is fine
      expect(check(reply, ctx([]))).toBe(false);
    }
  });
});

// Codex round-37 P1 (PR #5331): when billing ownership is UNAVAILABLE (e.g. the payer-linkage lookup failed) the rows still
// sitting on the context are not trustworthy, so EVERY payment-adjacent claim kind fails closed — refund claims included.
describe('round-37: billing unavailable fails closed for every claim kind', () => {
  const refundedRow = { amount: 120, status: 'refunded', refund_status: 'full', refund_amount: 120, payment_date: '2026-09-12', payment_method_type: 'card' };
  const invoice = { id: 'i1', invoiceNumber: 'WPC-2026-0101', status: 'paid', total: 120, amountDue: 0 };
  const ctx = (extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: [refundedRow], invoiceStatuses: [invoice], ...extra } });

  test.each([
    ['refund completed', 'Your $120 refund was issued.'],
    ['invoice status', 'Invoice #0101 is paid.'],
  ])('%s: grounded with available billing, rejected once billing is unavailable', (_n, reply) => {
    expect(check(reply, ctx())).toBe(false);
    expect(check(reply, ctx({ unavailable: true }))).toBe(true);
  });

  test('every refund state (pending / failed / "no refund") is rejected when billing is unavailable', () => {
    for (const reply of ['Your refund is pending.', 'No refund is showing.', 'Your $120 refund failed.']) {
      expect({ reply, bad: check(reply, ctx({ unavailable: true })) }).toEqual({ reply, bad: true });
    }
  });

  test('an anaphoric follow-up ("...but it was refunded") inherits no row when billing is unavailable', () => {
    const reply = 'We received your $120 payment from Sep 12, but it was refunded.';
    expect(check(reply, ctx({ unavailable: true, recentPayments: [{ ...refundedRow, status: 'paid' }] }))).toBe(true);
  });

  test('an owed figure and an invoice-tender claim are rejected when billing is unavailable', () => {
    expect(check('You owe $120.', ctx({ unavailable: true, outstandingBalance: 120 }))).toBe(true);
    expect(check('Invoice #0101 is paid with your card.', ctx({ unavailable: true }))).toBe(true);
  });

  test('gate OFF (byMeaning false) is the unchanged pooled allowlist: unavailable billing does not change the verdict', () => {
    const off = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: false });
    expect(off('Your $120 refund was issued.', ctx({ unavailable: true }))).toBe(off('Your $120 refund was issued.', ctx()));
  });
});

// Codex round-37 P2 class: the invoice-status list is CUT at 8, so a bare tail ("#0123") cannot be resolved against it.
describe('round-37: invoice status tail references against a truncated list', () => {
  const mk = (n, y) => ({ id: `i${y}${n}`, invoiceNumber: `WPC-${y}-${n}`, status: 'paid', total: 120, amountDue: 0 });
  const billing = (truncated) => ({ outstandingBalance: 0, recentPayments: [], invoiceStatuses: [mk('0123', 2026)], invoiceStatusesTruncated: truncated });
  test('a tail resolves against a complete list, not a truncated one; a FULL number still resolves', () => {
    expect(check('Invoice #0123 is paid.', { billing: billing(false) })).toBe(false);
    expect(check('Invoice #0123 is paid.', { billing: billing(true) })).toBe(true);
    expect(check('Invoice WPC-2026-0123 is paid.', { billing: billing(true) })).toBe(false);
  });
});

// Codex round-38 P1 class: a bare tail that matches MORE THAN ONE invoice the customer named in full is ambiguous - fail closed.
describe('round-38: ambiguous invoice tail across two named full invoices', () => {
  const inv = (y, status) => ({ id: `i${y}`, invoiceNumber: `WPC-${y}-0123`, status, total: 120, amountDue: status === 'paid' ? 0 : 120 });
  const billing = { outstandingBalance: 120, recentPayments: [], invoiceStatuses: [inv(2025, 'paid'), inv(2026, 'sent')] };
  const opts = { byMeaning: true, inboundMessage: 'Is WPC-2025-0123 or WPC-2026-0123 paid?' };
  test('"Invoice #0123 is paid" is rejected when the inbound names two full invoices sharing that tail', () => {
    expect(replyQuotesUngroundedAmount('Invoice #0123 is paid.', { billing }, opts)).toBe(true);
  });
  test('...even when only ONE of the two named invoices is in the account list (the tail alone would resolve uniquely)', () => {
    const oneListed = { outstandingBalance: 120, recentPayments: [], invoiceStatuses: [inv(2025, 'paid')] };
    expect(replyQuotesUngroundedAmount('Invoice #0123 is paid.', { billing: oneListed }, opts)).toBe(true);
  });
  test('a tail naming exactly one of the inbound full numbers still promotes to it', () => {
    const one = { byMeaning: true, inboundMessage: 'Is WPC-2025-0123 paid?' };
    expect(replyQuotesUngroundedAmount('Invoice #0123 is paid.', { billing }, one)).toBe(false);
  });
  test('the reply naming the full number explicitly is unaffected by the shared tail', () => {
    expect(replyQuotesUngroundedAmount('Invoice WPC-2025-0123 is paid.', { billing }, opts)).toBe(false);
    expect(replyQuotesUngroundedAmount('Invoice WPC-2026-0123 is paid.', { billing }, opts)).toBe(true);
  });
});
