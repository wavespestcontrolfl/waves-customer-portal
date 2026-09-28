/**
 * sms-amount-recheck — the send-time amount revalidation shared by the
 * scheduler's fire-time path and the immediate Agent Review send (PR #5119
 * follow-up #2). Fresh context, current obligations only, payment history
 * only for an acknowledgement, fail closed on any error.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(),
  authorizedDuesCents: jest.fn(() => []),
}));
jest.mock('../services/sms-shadow-drafter', () => ({ replyQuotesUngroundedAmount: jest.fn(() => false) }));
jest.mock('../services/sms-followup-sla', () => ({ realAnswersGateOn: jest.fn(() => false) }));
const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
const { realAnswersGateOn } = require('../services/sms-followup-sla');
const ContextAggregator = require('../services/context-aggregator');
const { outgoingAmountsStale, bodyAmountCents } = require('../services/sms-amount-recheck');

function dbWithCustomer(row) {
  return () => ({ where: () => ({ first: async () => row }) });
}

beforeEach(() => {
  ContextAggregator.getContextForCustomer.mockReset();
  ContextAggregator.authorizedDuesCents.mockReset().mockReturnValue([]);
  replyQuotesUngroundedAmount.mockReset().mockReturnValue(false);
  realAnswersGateOn.mockReset().mockReturnValue(false);
});

test('gate ON: the drafter\'s clause-aware guard is the stricter authority (a reversed payment no longer backs an acknowledgement)', async () => {
  realAnswersGateOn.mockReturnValue(true);
  const ctx = { billing: { outstandingBalance: 95, recentPayments: [{ amount: 95, status: 'failed' }] } };
  ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
  replyQuotesUngroundedAmount.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('We received your $95 payment — thank you!', ctx);
  replyQuotesUngroundedAmount.mockReturnValue(false);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
});

test('gate OFF: the guard is not consulted', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 120.5, recentPayments: [] } });
  await outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) });
  expect(replyQuotesUngroundedAmount).not.toHaveBeenCalled();
});

test('bodyAmountCents extracts every priced form in cents', () => {
  expect(bodyAmountCents('You owe $120.50 and paid 95 dollars; USD 12 too.')).toEqual([12050, 9500, 1200]);
  expect(bodyAmountCents('No figures here, just Tuesday at 9.')).toEqual([]);
});

test('no amounts in the body → never stale, context never read', async () => {
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'See you Tuesday!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
});

test('an amount still owed passes; a paid-off balance no longer authorizes "your balance is $X"', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 120.5, recentPayments: [] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 120.5 }] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
});

test('payment history backs only an acknowledgement', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 95 }] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Thanks for reaching out — your balance is $95.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toMatchObject({ stale: true });
});

test('fails closed: no customer id, a missing customer row, or a lookup error', async () => {
  await expect(outgoingAmountsStale({ customerId: null, body: 'You owe $5.', dbh: dbWithCustomer(null) })).resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  ContextAggregator.getContextForCustomer.mockResolvedValue(null);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'You owe $5.', dbh: dbWithCustomer(null) })).resolves.toMatchObject({ stale: true });
  ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('boom'));
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'You owe $5.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
});
