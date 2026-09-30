/**
 * Codex round-13 P1 (PR #5331): REAL binder, pre-v12 human-edited reply —
 * trustOwedAmounts excuses an OWED figure only; a receipt claim is bound to a
 * paid row and rechecked at fire time.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  ...jest.requireActual('../services/context-aggregator'),
  getContextForCustomer: jest.fn(),
}));
const ContextAggregator = require('../services/context-aggregator');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');

const dbh = () => ({ where: () => ({ first: async () => ({ id: 'c1' }) }) });
const ctx = (payments, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: payments, ...extra } });
const run = (body, payments, extra) => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(payments, extra));
  return outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', dbh, trustOwedAmounts: true });
};
const paid = { amount: 500, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };

test('an owed figure the human reviewed is still trusted', async () => {
  await expect(run('Your balance is $9,999.00.', [], {})).resolves.toEqual({ stale: false });
});

test('a receipt claim is rechecked: no paid row / refunded after scheduling => stale; matching paid row => fine', async () => {
  const body = 'We received your $500 payment from Sep 12.';
  await expect(run(body, [], {})).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run(body, [{ ...paid, status: 'refunded' }], {})).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run(body, [paid], {})).resolves.toEqual({ stale: false });
});

test('an amount-free settlement claim is rechecked against current billing', async () => {
  await expect(run("You're paid up!", [], { outstandingBalance: 40 })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run("You're paid up!", [], {})).resolves.toEqual({ stale: false });
});

// Codex round-14 P1: an "unpaid" assertion binds to a CURRENT open obligation at send time
// too — an invoice voided/canceled after the draft (no paid row, nothing open) blocks the send.
describe('a queued "still unpaid" reply is rechecked against the invoice that is open NOW', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const check = (body, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  test.each(['This invoice is still unpaid.', 'Your invoice is unpaid.', "Your payment hasn't been paid."])('%s', async (body) => {
    await expect(check(body, { outstandingBalance: 95 })).resolves.toEqual({ stale: false }); // open at draft time
    await expect(check(body, { outstandingBalance: 0, openInvoice: null })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // voided after the draft
  });
  test('with a figure: the amount must still be owed AND something must be open (outgoingAmountsStale)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 95 }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your $95 invoice is unpaid.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0, openInvoice: null }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your $95 invoice is unpaid.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
  test('a multi-family reply is rechecked against every family at send time', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, status: 'refunded' }], {}));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your payment was refunded after it failed.', strict: true, dbh }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your payment was refunded.', strict: true, dbh }))
      .resolves.toEqual({ stale: false });
  });
});

// Codex round-15 P1: a queued amount-free DENIAL ("No payment received.") is false once a paid row lands.
describe('a queued denial of receipt is rechecked at send time (paid-after-draft)', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const check = (body, rows, extra = {}) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(rows, extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  test.each(['No payment received.', "We didn't get your payment.", "We don't have your payment.", "Payment has not posted."])('%s', async (body) => {
    await expect(check(body, [])).resolves.toEqual({ stale: false }); // true at draft time
    await expect(check(body, [paid])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // paid since
    await expect(check(body, [{ ...paid, status: 'refunded' }])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(check(body, [{ ...paid, status: null }])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // unknown-status row
  });
  test('unavailable billing blocks it', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { unavailable: true } });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'No payment received.', strict: true, dbh }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-16 P1: a queued ZERO-balance claim is rechecked at send time with the drafter's own detector.
describe('a queued zero-balance reply is rechecked when a balance posts after the draft', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const check = (body, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  test.each(['Your balance is zero.', 'You have a zero balance.', 'Your balance is $0.00.'])('%s', async (body) => {
    await expect(check(body, { outstandingBalance: 0 })).resolves.toEqual({ stale: false }); // zero at draft time
    await expect(check(body, { outstandingBalance: 40 })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // a balance posted
    await expect(check(body, { outstandingBalance: 0, openInvoice: { amountDue: 40 } })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
  test('"$0.99" is a real balance, not a settlement claim, at draft and send time', async () => {
    const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0.99 }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $0.99.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0 }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $0.99.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-17 P1: the send-time check validates the rest of a zero-balance clause too.
describe('a zero-balance clause with another claim is fully rechecked at send time', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const run = (body, rows, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(rows, extra));
    return outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh });
  };
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  test('receipt half: needs the matching paid row NOW (refunded since the draft => stale)', async () => {
    const r = 'Your balance is $0 after we received your $500 payment from Sep 12.';
    await expect(run(r, [paid])).resolves.toEqual({ stale: false });
    await expect(run(r, [])).resolves.toEqual(STALE);
    await expect(run(r, [{ ...paid, status: 'refunded' }])).resolves.toEqual(STALE);
  });
  test('an extra fee/price half is never shielded by the zero claim', async () => {
    await expect(run('Your balance is $0 plus a fee of fifty dollars.', [])).resolves.toEqual(STALE);
    await expect(run('Your balance is $0 plus a fee of $50.', [])).resolves.toEqual(STALE);
  });
});

// Codex round-18 P1: the send-time recheck runs the SAME claim enumerator — every claim in a clause is rechecked.
describe('multi-claim clauses are rechecked claim-by-claim at send time', () => {
  const { amountFreeStatusClaimStale, outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  const proc = { ...paid, amount: 120, status: 'processing' };
  test('"Your account is current while your payment is processing." (processing payment + $95 owed) is stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([proc], { outstandingBalance: 95 }));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your account is current while your payment is processing.', strict: true, dbh })).resolves.toEqual(STALE);
  });
  test('"We received your $120 payment from Sep 12 while it is processing." with no paid row is stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $120 payment from Sep 12 while it is processing.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE);
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, amount: 120 }]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $120 payment from Sep 12 while it is processing.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE); // paid, but "processing" has no row
  });
  test('the enumerator is what decides a clause needs billing: a multi-claim clause always does', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    expect(drafter.enumeratePaymentClaims('Your account is current while your payment is processing.', {}).claims.map((c) => c.kind).sort()).toEqual(['settlement', 'status']);
    expect(drafter.enumeratePaymentClaims('Thanks so much, see you Tuesday!', {}).claims).toEqual([]);
  });
});

// Codex round-19 P2: the send-time fresh context surfaces the payment the customer asked about, exactly as the
// draft did — a valid reply about an OLDER payment (outside the 3-row display window) is not blocked at send.
describe('a valid reply about an older referenced payment is not blocked at send time', () => {
  const { outgoingAmountsStale, amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const older = { id: 'p-old', amount: 120, status: 'paid', payment_date: '2026-06-12', payment_method_type: 'card' };
  const newest = [1, 2, 3].map((n) => ({ id: `p${n}`, amount: 60 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  const freshCtx = () => ({
    customer: { id: 'c1' },
    billing: { outstandingBalance: 0, recentPayments: [...newest], recentPaymentsTruncated: true, paymentHistory: { rows: [...newest, older], complete: true } },
  });
  const ASK = 'Did you get my $120 payment from June 12?';
  const REPLY = 'We received your $120 payment from June 12.';
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };

  test('with the inbound, the older row is surfaced before the binder runs => not stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    await expect(outgoingAmountsStale({ customerId: 'c1', body: REPLY, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh, inboundMessage: ASK })).resolves.toEqual({ stale: false });
  });
  test('the same reply without the referencing inbound has no such row in view => stale (the surfacing is what makes it valid)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    await expect(outgoingAmountsStale({ customerId: 'c1', body: REPLY, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh, inboundMessage: null })).resolves.toEqual(STALE);
  });
  test('the amount-free/absence path surfaces too; a genuinely missing payment is still a stale denial-of-nothing', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    // "we don't see it" is FALSE when the older paid row exists
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "We don't see a $120 payment from June 12.", strict: true, dbh, inboundMessage: ASK })).resolves.toEqual(STALE);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ ...freshCtx(), billing: { ...freshCtx().billing, paymentHistory: { rows: [...newest], complete: true } } });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "We don't see a $120 payment from June 12.", strict: true, dbh, inboundMessage: ASK })).resolves.toEqual({ stale: false });
  });
});
