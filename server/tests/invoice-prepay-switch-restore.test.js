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
// restores inside the caller's trx: a candidate-id select, a row-locked
// re-read, and the restore-marker probe.
function conn({ rows = [VOIDED_ROW], replacement = undefined } = {}) {
  const fn = jest.fn(() => {
    const q = {};
    let notesLike = false;
    let whereId = null;
    q.where = jest.fn((...args) => {
      if (args[0] === 'notes') notesLike = true;
      if (args[0] && typeof args[0] === 'object' && args[0].id !== undefined) whereId = args[0].id;
      return q;
    });
    q.forUpdate = jest.fn(() => q);
    q.select = jest.fn(async () => rows.map((r) => ({ id: r.id })));
    q.first = jest.fn(async () => {
      if (notesLike) return replacement;
      if (whereId != null) return rows.find((r) => String(r.id) === String(whereId));
      return undefined;
    });
    return q;
  });
  fn.isTransaction = true;
  return fn;
}

describe('restoreSwitchSupersededInvoicesForPrepay', () => {
  let createSpy;
  beforeEach(() => {
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

  test('a null prepayInvoiceId is a no-op', async () => {
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay(null, conn());
    expect(restored).toEqual([]);
  });
});
