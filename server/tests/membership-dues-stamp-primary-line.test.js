/**
 * B08: the membership-dues stamp goes only on the line the builder marks as the
 * visit's PRIMARY service line (client_id scheduled_<visit>_primary), never on
 * the first positive line by position. With no such line the mint is UNSTAMPED
 * (returned untouched, before any lock or read), so an add-on can never become
 * "the month's dues". The Postgres suite covers the full mint.
 */
jest.mock('../models/db', () => jest.fn());
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

const mockChain = jest.fn();
jest.mock('../services/scheduled-invoice-mint', () => ({
  ...jest.requireActual('../services/scheduled-invoice-mint'),
  acquireScheduledMintLockChain: (...args) => mockChain(...args),
}));

const InvoiceService = require('../services/invoice');

describe('stampMembershipDuesUnderLock — no primary line, no stamp', () => {
  const stamp = (lineItems) => InvoiceService.stampMembershipDuesUnderLock(null, {
    customerId: 'cust-1', scheduledServiceId: 'visit-1', month: '2026-09', lineItems, derivedAmount: 49,
  });

  test('add-on lines plus a price adjustment (no primary line) come back untouched: never stamped, no lock or query taken', async () => {
    const lines = [
      { client_id: 'scheduled_visit-1_addon_a', description: 'Big Add-on', quantity: 1, unit_price: 60, amount: 60 },
      { client_id: 'discount_scheduled_price_visit-1', _kind: 'discount', description: 'Scheduled price adjustment', quantity: 1, unit_price: -11, amount: -11 },
    ];
    const out = await stamp(lines);
    expect(out).toBe(lines);
    expect(out.some((li) => li.membership_dues_month)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('no primary service line'));
  });

  test('a positive line that is some OTHER visit\'s primary is not this visit\'s primary either', async () => {
    const lines = [{ client_id: 'scheduled_other_primary', description: 'Lawn', quantity: 1, unit_price: 49, amount: 49 }];
    expect(await stamp(lines)).toBe(lines);
  });

  test('no positive line at all returns the lines as they are', async () => {
    const lines = [{ client_id: 'scheduled_visit-1_primary', quantity: 1, unit_price: 0, amount: 0 }];
    expect(await stamp(lines)).toBe(lines);
  });
});

// The locked visit's OWNER is re-read: a customer merge that repointed the visit
// after the caller read the service record must not be stamped (or month-locked)
// under the merged-away customer.
describe('stampMembershipDuesUnderLock — the locked visit must still belong to the caller\'s customer', () => {
  const primary = { client_id: 'scheduled_visit-1_primary', description: 'Lawn', quantity: 1, unit_price: 49, amount: 49 };
  const stamp = (customerId = 'cust-1') => InvoiceService.stampMembershipDuesUnderLock({}, {
    customerId, scheduledServiceId: 'visit-1', month: '2026-09', lineItems: [primary], derivedAmount: 49,
  });

  test('a visit now owned by another customer is refused retryably before any month lock or coverage read', async () => {
    mockChain.mockResolvedValueOnce({ id: 'visit-1', customer_id: 'cust-survivor', estimated_price: null, is_callback: false, scheduled_date: '2026-09-15' });
    await expect(stamp('cust-merged-away')).rejects.toMatchObject({ code: 'SCHEDULED_BILLING_SOURCE_MOVED', status: 409 });
    // the chain was asked to select the owner
    expect(mockChain.mock.calls.at(-1)[1].visitColumns).toContain('customer_id');
  });
});
