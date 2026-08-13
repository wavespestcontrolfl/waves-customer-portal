/**
 * InvoiceService.restoreSwitchSupersededInvoicesForPrepay — the durable leg
 * of the on-site prepay switch (Codex on-site-switch P0 r7).
 *
 * The switch stamps every retired per-application invoice with
 * [prepay-switch-superseded-by:<prepayInvoiceId>]. When that prepay later
 * dies through the ORDINARY flows (voided from Invoices, refunded), the
 * annual-prepay term-cancel sync calls this helper so the retired AR (setup
 * fee included) comes back — long after the switch sheet is gone. What must
 * hold: it restores from the voided row's own line items, it is idempotent
 * via the restore marker, and it never invents money.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({
  stopSequence: jest.fn(async () => undefined),
  resumeSequence: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
// The restore serializes on the SAME per-customer advisory lock every prepay
// mint takes (lazily required to dodge the admin-customers ⇄ invoice cycle).
const mockLockOverlap = jest.fn(async () => {});
jest.mock('../routes/admin-customers', () => ({
  _private: { lockAndAssertNoAnnualPrepayOverlap: (...args) => mockLockOverlap(...args) },
}));

const InvoiceService = require('../services/invoice');

const VOIDED_ROW = {
  id: 'inv-old',
  invoice_number: 'WPC-2026-0345',
  status: 'void',
  customer_id: 'cust-1',
  scheduled_service_id: 'svc-1',
  title: 'WaveGuard Membership Setup + First Application',
  notes: 'Auto-generated from accepted estimate #est-1.\n[prepay-switch-superseded-by:inv-prepay]',
  line_items: JSON.stringify([
    { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
    { description: 'First service application', quantity: 1, unit_price: 128, amount: 128 },
  ]),
};

// Conn stub shaped like a knex TRANSACTION (isTransaction) so the helper
// restores inside the caller's trx. Table-aware: invoices serve the
// candidate select / row lock / marker probe / live-AR probe / by-id prepay
// lookup; scheduled_services serve the assert-date derivation (visit date,
// then the accept series' dates).
function conn({
  rows = [VOIDED_ROW], replacement = undefined, liveOnVisit = undefined,
  byId = {}, visitDate = undefined, seriesDates = [],
} = {}) {
  const fn = jest.fn((table) => {
    const q = {};
    let notesLike = false;
    let whereId = null;
    let byVisit = false;
    q.where = jest.fn((...args) => {
      if (args[0] === 'notes') notesLike = true;
      if (args[0] && typeof args[0] === 'object') {
        if (args[0].id !== undefined) whereId = args[0].id;
        if (args[0].scheduled_service_id !== undefined) byVisit = true;
      }
      return q;
    });
    q.whereNot = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    if (table === 'scheduled_services') {
      q.first = jest.fn(async () => (visitDate ? { scheduled_date: visitDate } : undefined));
      q.select = jest.fn(async () => seriesDates.map((d) => ({ scheduled_date: d })));
    } else {
      q.select = jest.fn(async () => rows);
      q.first = jest.fn(async () => {
        if (notesLike) return replacement;
        if (byVisit) return liveOnVisit;
        if (whereId != null) return rows.find((r) => String(r.id) === String(whereId)) || byId[String(whereId)];
        return undefined;
      });
    }
    return q;
  });
  fn.isTransaction = true;
  return fn;
}

describe('restoreSwitchSupersededInvoicesForPrepay', () => {
  let createSpy;
  beforeEach(() => {
    mockLockOverlap.mockReset();
    mockLockOverlap.mockResolvedValue(undefined);
    createSpy = jest.spyOn(InvoiceService, 'create')
      .mockResolvedValue({ id: 'inv-new', invoice_number: 'WPC-2026-0402' });
  });
  afterEach(() => createSpy.mockRestore());

  test('re-mints the retired invoice from its own line items, restore-marker stamped', async () => {
    const c = conn();
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([{ replacedInvoiceId: 'inv-old', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0402' }]);
    const created = createSpy.mock.calls[0][0];
    expect(created.lineItems).toEqual([
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
      { description: 'First service application', quantity: 1, unit_price: 128 },
    ]);
    expect(created.customerId).toBe('cust-1');
    expect(created.scheduledServiceId).toBe('svc-1');
    expect(created.notes).toContain('[prepay-switch-restore:inv-old]');
    // The replacement must NOT inherit the superseded-by marker — a later
    // void of the replacement would otherwise re-trigger the old prepay's
    // restore and mint fresh AR (Codex P0 r11).
    expect(created.notes).not.toContain('[prepay-switch-superseded-by:');
    // Rides the caller's transaction so the restore commits (or rolls back)
    // with the term-cancel sync that triggered it.
    expect(created.database).toBe(c);
    // ET calendar for the due date, never a UTC slice.
    expect(created.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('idempotent: an existing restore-marker replacement means nothing is minted again', async () => {
    const c = conn({ replacement: { id: 'inv-new' } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('no marker matches ⇒ nothing restored, nothing invented', async () => {
    const c = conn({ rows: [] });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('a row with unreadable line items is skipped (warned), never minted at $0', async () => {
    const c = conn({ rows: [{ ...VOIDED_ROW, line_items: 'not-json' }] });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('NEVER restores beside live AR on the same visit — a completed visit already re-billed', async () => {
    const c = conn({ liveOnVisit: { id: 'inv-completion', invoice_number: 'WPC-2026-0410' } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('takes the shared prepay advisory lock, and SKIPS when a live term stands', async () => {
    const c = conn();
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', expect.any(String), false, expect.any(String));

    const overlapErr = new Error('live term');
    overlapErr.annualPrepayOverlap = { error: 'live term' };
    mockLockOverlap.mockRejectedValue(overlapErr);
    createSpy.mockClear();
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', conn());
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('the overlap assert runs against the RESTORED VISIT date, not today', async () => {
    const c = conn({ visitDate: '2027-02-10' });
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', '2027-02-10', false, expect.any(String));
  });

  test('an UNATTACHED setup-only row derives the date from the accept series (Codex P0 r13)', async () => {
    const c = conn({
      rows: [{ ...VOIDED_ROW, scheduled_service_id: null }],
      seriesDates: ['2020-01-01', '2099-05-12'],
    });
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    // First UPCOMING visit of the accept's own series — today would wrongly
    // block a future-start renewal restore while the current year runs.
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', '2099-05-12', false, expect.any(String));
  });

  test('a null prepayInvoiceId is a no-op', async () => {
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay(null, conn());
    expect(restored).toEqual([]);
  });
});

describe('sweepOrphanedPrepaySwitchRestores — the durable repair job', () => {
  let restoreSpy;
  beforeEach(() => {
    restoreSpy = jest.spyOn(InvoiceService, 'restoreSwitchSupersededInvoicesForPrepay')
      .mockResolvedValue([{ replacedInvoiceId: 'inv-old', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0402' }]);
  });
  afterEach(() => restoreSpy.mockRestore());

  test('re-runs the restore for every marker whose superseding prepay is DEAD', async () => {
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'void' } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(restoreSpy).toHaveBeenCalledWith('inv-prepay', c);
    expect(restored).toHaveLength(1);
  });

  test('a LIVE superseding prepay is left alone — nothing to repair yet', async () => {
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'paid' } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
  });

  test('an ABANDONED switch prepay (old unsent draft) is expired: voided, term cancelled, AR restored', async () => {
    const voidSpy = jest.spyOn(InvoiceService, 'voidInvoice').mockResolvedValue({ status: 'void' });
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': {
        id: 'inv-prepay', status: 'draft', sent_at: null, paid_at: null,
        stripe_payment_intent_id: null,
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(voidSpy).toHaveBeenCalledWith('inv-prepay');
    expect(restoreSpy).toHaveBeenCalledWith('inv-prepay', c);
    expect(restored).toHaveLength(1);
    voidSpy.mockRestore();
  });

  test('a RECENT unsent draft is left alone — a live tender must never be yanked', async () => {
    const voidSpy = jest.spyOn(InvoiceService, 'voidInvoice').mockResolvedValue({ status: 'void' });
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': {
        id: 'inv-prepay', status: 'draft', sent_at: null, paid_at: null,
        stripe_payment_intent_id: null, created_at: new Date().toISOString(),
      } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(voidSpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
    voidSpy.mockRestore();
  });

  test('a restore that fails is retried next sweep, never thrown to the cron', async () => {
    restoreSpy.mockRejectedValue(new Error('transient'));
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'void' } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(restored).toEqual([]);
  });
});
