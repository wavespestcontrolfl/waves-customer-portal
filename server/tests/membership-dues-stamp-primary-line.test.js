/**
 * B08: the membership-dues stamp goes only on the line the builder marks as the
 * visit's PRIMARY service line (client_id scheduled_<visit>_primary), never on
 * the first positive line by position. With no such line the mint is UNSTAMPED
 * (returned untouched, before any lock or read), so an add-on can never become
 * "the month's dues". The Postgres suite covers the full mint.
 */
jest.mock('../models/db', () => jest.fn());
const mockResolvePayer = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  ...jest.requireActual('../services/payer'),
  resolveForInvoice: (...args) => mockResolvePayer(...args),
}));
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

// A refunded dues invoice restored by a bounced refund beside another live dues
// invoice (or a collected month): NOTHING is voided, edited or refunded
// automatically; ONE needs-you alert asks a person to act.
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

  test('nothing beside the restored original: no alert', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(null);
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: null }));
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test.each([['sent'], ['draft'], ['overdue']])('a %s (still collectible) replacement is NEVER voided: ONE adjust-by-hand alert', async (status) => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: { id: 'inv-repl', status, invoice_number: 'WPC-2' } }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('billing');
    expect(spec.action).toMatch(/adjust/);
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

  test('the ORIGINAL came back UNPAID (combined path: its debit failed) and the replacement is paid: the month is paid ONCE, so no "paid twice" and no refund; the alert is about voiding or adjusting the reopened original', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ originalStatus: 'overdue', replacement: { id: 'inv-repl', status: 'paid', invoice_number: 'WPC-2' } }));
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [, spec, opts] = mockRaise.mock.calls[0];
    expect(spec.action).toMatch(/reopened/);
    expect(spec.why).not.toMatch(/paid twice/);
    expect(spec.subject).toEqual({ type: 'invoice', id: 'inv-orig' }); // the invoice to void is the original
    expect(opts.detail).not.toMatch(/refund the extra payment/);
    expect(opts.dedupeKey).toBe('dues_restore_conflict:inv-orig:inv-repl');
    expect(() => composeAdminAlert(spec)).not.toThrow();
  });

  test('original reopened unpaid beside an UNPAID replacement: two open invoices, one adjust-by-hand alert on the original', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ originalStatus: 'sent' }));
    const [, spec] = mockRaise.mock.calls[0];
    expect(spec.why).toMatch(/Two open invoices/);
    expect(spec.subject.id).toBe('inv-orig');
  });

  test('an original restored as processing beside a paid replacement is still "paid twice"; no originalStatus means paid', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ originalStatus: 'processing', replacement: { id: 'inv-repl', status: 'paid', invoice_number: 'WPC-2' } }));
    expect(mockRaise.mock.calls[0][1].why).toMatch(/paid twice/);
  });

  test('a month already collected by a payment (no replacement invoice) alerts once as paid twice, keyed on the payment', async () => {
    await InvoiceService.reconcileMembershipDuesRestore(ctx({ replacement: null, collectedPaymentId: 'pay-9' }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][1].why).toMatch(/paid twice/);
    expect(mockRaise.mock.calls[0][2].dedupeKey).toBe('dues_restore_conflict:inv-orig:pay-9');
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

// The one candidate filter both dues alerts share: only visits the month's dues
// COVER (the completion predicate), payer ownership resolved like completion.
describe('filterVisitsCoveredByDues', () => {
  const { filterVisitsCoveredByDues } = InvoiceService._prepaidDuesAlert;
  const member = { billing_mode: 'monthly_membership', monthly_rate: 49, waveguard_tier: 'Silver' };
  beforeEach(() => { jest.clearAllMocks(); mockResolvePayer.mockResolvedValue({ payerId: null }); });
  const ids = (rows) => rows.map((v) => v.id);

  test('an unpriced plan visit and a priced RECURRING one are covered; a priced NON-recurring visit (its cash belongs to its own service) is not', async () => {
    const out = await filterVisitsCoveredByDues([
      { id: 'unpriced', estimated_price: null, is_recurring: true },
      { id: 'priced-recurring', estimated_price: 85, is_recurring: true },
      { id: 'priced-one-off', estimated_price: 85, is_recurring: false },
    ], member, 'cust-1', 'test');
    expect(ids(out)).toEqual(['unpriced', 'priced-recurring']);
  });

  test('a payer-billed visit is not covered; an unreadable payer resolution counts as self-pay; a non-member lane covers nothing', async () => {
    mockResolvePayer.mockImplementation(async ({ scheduledServiceId }) => {
      if (scheduledServiceId === 'payer-billed') return { payerId: 7 };
      if (scheduledServiceId === 'unreadable') throw new Error('db down');
      return { payerId: null };
    });
    const rows = [
      { id: 'payer-billed', estimated_price: null, is_recurring: true },
      { id: 'unreadable', estimated_price: null, is_recurring: true },
      { id: 'self-pay', estimated_price: null, is_recurring: true },
    ];
    expect(ids(await filterVisitsCoveredByDues(rows, member, 'cust-1', 'test'))).toEqual(['unreadable', 'self-pay']);
    expect(await filterVisitsCoveredByDues(rows, { ...member, billing_mode: 'per_visit' }, 'cust-1', 'test')).toEqual([]);
  });
});

// Bill-To is final where create() resolves it for the row it inserts: a payer
// invoice never keeps the customer's self-pay dues stamp.
describe('payer-billed invoices never carry or count as the dues stamp', () => {
  const { stripPayerBilledDuesMarker } = InvoiceService._prepaidDuesAlert;
  const lines = [{ client_id: 'scheduled_v1_primary', amount: 49, membership_dues_month: '2026-09' }, { description: 'Fee', amount: 5 }];

  test('stripPayerBilledDuesMarker drops the marker (and only the marker) and warns; lines without a marker are returned untouched', () => {
    mockLogger.warn.mockClear();
    const out = stripPayerBilledDuesMarker(lines, 'cust-1');
    expect(out.some((li) => li.membership_dues_month)).toBe(false);
    expect(out[0]).toMatchObject({ client_id: 'scheduled_v1_primary', amount: 49 });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('membership-dues stamp was dropped'));
    const plain = [{ amount: 49 }];
    expect(stripPayerBilledDuesMarker(plain, 'cust-1')).toBe(plain);
  });

  test('the shared lookup ignores a payer-billed stamped invoice (payer_id IS NULL in its query)', async () => {
    const { findLiveStampedDuesInvoice } = require('../services/billing-lane');
    const raws = [];
    const q = { where: () => q, whereRaw: (sql) => { raws.push(sql); return q; }, whereNot: () => q, first: async () => null };
    const conn = () => q;
    await findLiveStampedDuesInvoice(conn, 'cust-1', '2026-09');
    expect(raws).toContain('payer_id IS NULL');
  });
});
