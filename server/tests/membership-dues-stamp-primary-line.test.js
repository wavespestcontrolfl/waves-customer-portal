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
    replacement: { id: 'inv-repl', status: 'sent', invoice_number: 'WPC-2', dueOnly: true }, collectedPaymentId: null, ...over });
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

  test('an UNPAID replacement that is provably dues-only is voided through the canonical void, with no alert', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx());
    expect(voidSpy).toHaveBeenCalledWith('inv-repl');
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('an unpaid replacement that is NOT provably dues-only (a fee line, credit, a payment, any doubt) is left untouched: no void, ONE adjust-by-hand alert', async () => {
    for (const dueOnly of [false, undefined]) {
      jest.clearAllMocks();
      await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: { id: 'inv-repl', status: 'sent', invoice_number: 'WPC-2', dueOnly } }));
      expect(voidSpy).not.toHaveBeenCalled();
      expect(mockRaise).toHaveBeenCalledTimes(1);
      const [, spec, opts] = mockRaise.mock.calls[0];
      expect(spec.action).toMatch(/adjust/);
      expect(spec.why).toMatch(/other charges/);
      expect(opts.dedupeKey).toBe('dues_restore_conflict:inv-orig:inv-repl');
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
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
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: { id: 'inv-repl', status, invoice_number: 'WPC-2', dueOnly: false } }));
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

// The "provably nothing but the duplicate dues" decision, made under the locks.
describe('replacementIsDuesOnly', () => {
  const dues = { client_id: 'scheduled_v2_primary', description: 'Pest', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: '2026-09' };
  const row = (over = {}) => ({ status: 'sent', credit_applied: 0, payment_recorded_at: null, stripe_payment_intent_id: null, paid_at: null, line_items: [dues], ...over });
  const decide = (over, opts) => InvoiceService.replacementIsDuesOnly(row(over), opts);

  test('only the stamped dues line, unpaid, nothing applied or in flight: dues-only (also its price-reconciliation lines, and a JSON string)', () => {
    expect(decide()).toBe(true);
    expect(decide({ line_items: JSON.stringify([dues]) })).toBe(true);
    expect(decide({ line_items: [dues, { client_id: 'scheduled_price_topup_v2', description: 'Scheduled price adjustment', quantity: 1, unit_price: 5, amount: 5 }] })).toBe(true);
  });

  test('dues plus a fee or service line is NOT dues-only', () => {
    expect(decide({ line_items: [dues, { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }] })).toBe(false);
    expect(decide({ line_items: [dues, { client_id: 'scheduled_v2_addon_1', description: 'Add-on', quantity: 1, unit_price: 20, amount: 20 }] })).toBe(false);
    expect(decide({ line_items: [dues, { description: 'Loyalty discount', quantity: 1, unit_price: -5, amount: -5, _kind: 'discount' }] })).toBe(false);
  });

  test('credit applied, a recorded payment, an intent in flight, a payment row, a paid status, or an unreadable / unstamped invoice is NOT dues-only', () => {
    expect(decide({ credit_applied: 10 })).toBe(false);
    expect(decide({ payment_recorded_at: new Date() })).toBe(false);
    expect(decide({ stripe_payment_intent_id: 'pi_1' })).toBe(false);
    expect(decide({ paid_at: new Date() })).toBe(false);
    expect(decide({}, { hasPayment: true })).toBe(false);
    for (const status of ['paid', 'prepaid', 'processing', 'void', 'refunded']) expect(decide({ status })).toBe(false);
    expect(decide({ line_items: 'not json' })).toBe(false);
    expect(decide({ line_items: [] })).toBe(false);
    expect(decide({ line_items: [{ ...dues, membership_dues_month: undefined }] })).toBe(false);
    expect(InvoiceService.replacementIsDuesOnly(null)).toBe(false);
  });
});

// The restore also fences the monthly collectors: month try-lock, then the
// customer collection claim, both tries; a busy claim refuses retryably before
// any coverage read.
describe('prepareMembershipDuesRestore — the customer collection claim', () => {
  function fakeTrx({ monthFree = true, claimFree = true } = {}) {
    const tables = [];
    const answers = [monthFree, claimFree];
    const trx = (table) => {
      tables.push(table);
      const q = { where: () => q, whereIn: () => q, whereRaw: () => q, first: async () => ({ id: 'inv-orig', invoice_number: 'WPC-1', customer_id: 'cust-1', line_items: [{ amount: 49, membership_dues_month: '2026-09' }] }) };
      return q;
    };
    trx.raw = jest.fn(async (sql) => ({ rows: [{ acquired: answers.shift() }], sql }));
    trx.tables = tables;
    return trx;
  }

  test('a collector holding the claim refuses the restore retryably (503) before any coverage or payment read', async () => {
    const trx = fakeTrx({ claimFree: false });
    await expect(InvoiceService.prepareMembershipDuesRestore(trx, 'inv-orig'))
      .rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_COLLECTION_BUSY', statusCode: 503, isOperational: true });
    expect(trx.raw).toHaveBeenCalledTimes(2); // month try, then claim try, in that order
    expect(trx.raw.mock.calls[0][1][0]).toBe('membership.dues_month');
    expect(String(trx.raw.mock.calls[1][1][0])).toMatch(/^cron:/);
    expect(trx.tables).toEqual(['invoices']); // only the invoice's own stamp read; no payments / coverage lookup
  });

  test('a busy month lock refuses first, without trying the claim', async () => {
    const trx = fakeTrx({ monthFree: false });
    await expect(InvoiceService.prepareMembershipDuesRestore(trx, 'inv-orig')).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_MONTH_BUSY' });
    expect(trx.raw).toHaveBeenCalledTimes(1);
  });
});
