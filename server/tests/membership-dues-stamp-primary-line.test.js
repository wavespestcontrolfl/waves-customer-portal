/**
 * B08: the membership-dues stamp goes only on the line the builder marks as the
 * visit's PRIMARY service line (client_id scheduled_<visit>_primary), never on
 * the first positive line by position. With no such line the mint is UNSTAMPED
 * (returned untouched, before any lock or read), so an add-on can never become
 * "the month's dues". The Postgres suite covers the full mint.
 */
jest.mock('../models/db', () => jest.fn());
const mockRaise = jest.fn(async () => ({ id: 1 }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...args) => mockRaise(...args),
}));
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

// A manual prepaid marker on another plan visit of the month, written BEFORE the
// dues invoice was minted, needs a person to apply the cash to that invoice.
// The pure selection rule and the alert copy (rules of docs/admin-notifications.md).
describe('prepaid marker vs a newly minted dues invoice — selection and copy', () => {
  const { prepaidVisitsToApplyToDuesInvoice, composePrepaidDuesAlertSpec } = InvoiceService._prepaidDuesAlert;
  const visit = (over = {}) => ({ id: 'v1', status: 'confirmed', prepaid_amount: 49, prepaid_method: 'cash', annual_prepay_term_id: null, ...over });

  test('a positive manual prepayment on a live or completed plan visit is selected', () => {
    expect(prepaidVisitsToApplyToDuesInvoice([visit(), visit({ id: 'v2', status: 'completed', prepaid_method: 'zelle' })]).map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  test('amount 0 or missing, annual coverage (term link or annual method), cancelled / skipped visits and the dues invoice\'s own visit are not', () => {
    const out = prepaidVisitsToApplyToDuesInvoice([
      visit({ id: 'zero', prepaid_amount: 0 }),
      visit({ id: 'none', prepaid_amount: null }),
      visit({ id: 'annual-term', annual_prepay_term_id: 'term-1' }),
      visit({ id: 'annual-method', prepaid_method: 'annual_prepay_invoice' }),
      visit({ id: 'cancelled', status: 'cancelled' }),
      visit({ id: 'skipped', status: 'skipped' }),
      visit({ id: 'own' }),
      visit({ id: 'ok' }),
    ], { ownVisitId: 'own' });
    expect(out.map((v) => v.id)).toEqual(['ok']);
  });

  test('the alert copy satisfies the notification rules for the longest month and a large amount; the amount rides the why, the invoice is the subject', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    const spec = composePrepaidDuesAlertSpec({ customerName: 'Fixture DuesMember', monthName: 'September', amount: 1234.5, invoiceId: 'inv-1', customerId: 'cust-1' });
    const composed = composeAdminAlert(spec);
    expect(composed.why).toContain('$1234.50');
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.metadata.subject).toEqual({ type: 'invoice', id: 'inv-1' });
    expect(composed.metadata.severity).toBe('needs-you');
  });
});

// A refunded dues invoice restored by a bounced refund beside a replacement
// dues invoice (or a collected month): the unpaid replacement is voided through
// the canonical void; anything else is ONE needs-you alert, never an automatic refund.
describe('reconcileMembershipDuesRestore', () => {
  const db = require('../models/db');
  const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');
  const ctx = (over = {}) => ({ invoiceId: 'inv-orig', invoiceNumber: 'WPC-1', customerId: 'cust-1', month: '2026-09',
    replacement: { id: 'inv-repl', status: 'sent', invoice_number: 'WPC-2' }, collectedPaymentId: null, ...over });
  let voidSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ first_name: 'Fixture', last_name: 'DuesMember' }) }) }));
    voidSpy = jest.spyOn(InvoiceService, 'voidInvoice').mockResolvedValue({});
  });
  afterEach(() => voidSpy.mockRestore());

  test('nothing beside the restored original: no void, no alert', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(null);
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: null }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('an UNPAID replacement is voided through the canonical void, with no alert', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx());
    expect(voidSpy).toHaveBeenCalledWith('inv-repl');
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a refused void raises ONE alert to void it by hand', async () => {
    voidSpy.mockRejectedValueOnce(new Error('payment in flight'));
    await InvoiceService.reconcileMembershipDuesRestore(ctx());
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('billing');
    expect(spec.action).toMatch(/void/);
    expect(opts.dedupeKey).toBe('dues_restore_conflict:inv-orig:inv-repl');
    expect(composeAdminAlert(spec).headline.length).toBeLessThanOrEqual(60);
  });

  test.each([['paid'], ['prepaid'], ['processing']])('a %s replacement is never voided: ONE "paid twice" alert, no automatic refund', async (status) => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: { id: 'inv-repl', status, invoice_number: 'WPC-2' } }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [, spec] = mockRaise.mock.calls[0];
    expect(spec.action).toMatch(/refund/);
    expect(spec.why).toMatch(/paid twice/);
    expect(() => composeAdminAlert(spec)).not.toThrow();
  });

  test('a month already collected by a payment (no replacement invoice) alerts once, keyed on the payment', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: null, collectedPaymentId: 'pay-9' }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(mockRaise.mock.calls[0][2].dedupeKey).toBe('dues_restore_conflict:inv-orig:pay-9');
  });
});
