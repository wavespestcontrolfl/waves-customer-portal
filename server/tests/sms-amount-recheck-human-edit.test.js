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
