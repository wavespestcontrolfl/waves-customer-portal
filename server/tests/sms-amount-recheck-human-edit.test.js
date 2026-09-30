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
