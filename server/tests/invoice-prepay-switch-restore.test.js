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
const mockTermSync = jest.fn(async () => undefined);
const mockReconAssert = jest.fn(async () => undefined);
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...args) => mockReconAssert(...args),
}));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: (...args) => mockTermSync(...args) }));
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
  byId = {}, visitDate = undefined, seriesDates = [], paymentRow = undefined,
  termRow = undefined,
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
    if (table === 'annual_prepay_terms') {
      q.first = jest.fn(async () => termRow);
    } else if (table === 'payments') {
      // The real lookup rides metadata->>'invoice_id' via whereRaw — a
      // column-shaped where({invoice_id}) would throw in prod (Codex P0
      // r16), so the stub only answers the raw form.
      q.whereRaw = jest.fn((sql) => {
        if (!/metadata/.test(String(sql))) throw new Error('payments has no invoice_id column');
        return q;
      });
      q.where = jest.fn((...args) => {
        if (args[0] && typeof args[0] === 'object' && args[0].invoice_id !== undefined) {
          throw new Error('payments has no invoice_id column');
        }
        return q;
      });
      q.first = jest.fn(async () => paymentRow);
      q.select = jest.fn(async () => (paymentRow ? [paymentRow] : []));
    } else if (table === 'scheduled_services') {
      q.first = jest.fn(async () => (visitDate ? { scheduled_date: visitDate } : undefined));
      q.select = jest.fn(async () => seriesDates.map((d) => ({ scheduled_date: d })));
    } else {
      q.select = jest.fn(async () => {
        // The live-AR probe is a SELECT scoped by scheduled_service_id and
        // classifies each row's line_items (Codex P0 r19).
        if (byVisit) return liveOnVisit ? [liveOnVisit] : [];
        return rows;
      });
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
  // The canonical scheduled-invoice mint lock rides trx.raw.
  fn.raw = jest.fn(async () => {});
  return fn;
}

describe('restoreSwitchSupersededInvoicesForPrepay', () => {
  let createSpy;
  beforeEach(() => {
    mockLockOverlap.mockReset();
    mockLockOverlap.mockResolvedValue(undefined);
    mockReconAssert.mockReset();
    mockReconAssert.mockResolvedValue(undefined);
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

  test('live AR on the visit ⇒ restore the SETUP FEE ONLY, never the application again', async () => {
    const c = conn({ liveOnVisit: {
      id: 'inv-completion', invoice_number: 'WPC-2026-0410',
      line_items: JSON.stringify([{ client_id: 'svc-1_primary', description: 'Quarterly Pest Control', amount: 128 }]),
    } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toHaveLength(1);
    expect(createSpy.mock.calls[0][0].lineItems).toEqual([
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
    ]);
  });

  test('an application-only row beside live AR skips benignly — nothing left to restore', async () => {
    const c = conn({
      rows: [{ ...VOIDED_ROW, line_items: JSON.stringify([{ description: 'First service application', amount: 128 }]) }],
      liveOnVisit: {
        id: 'inv-completion',
        line_items: JSON.stringify([{ client_id: 'svc-1_primary', description: 'Quarterly Pest Control', amount: 128 }]),
      },
    });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('takes the advisory lock LOCK-ONLY, and SKIPS only on a term CONTAINING the visit date', async () => {
    const c = conn();
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    // allowOverlap=true: the shared assert's start-agnostic overlap test
    // would read a FUTURE term as a conflict and park the restore forever
    // (Codex P0 r23) — the lock is taken, the containment check is ours.
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', expect.any(String), true);

    createSpy.mockClear();
    const covered = conn({ termRow: { id: 'term-live' } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', covered);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('a live invoice billing something UNRELATED keeps the FULL restore (Codex P0 r19)', async () => {
    const c = conn({ liveOnVisit: {
      id: 'inv-manual', invoice_number: 'WPC-2026-0420',
      line_items: JSON.stringify([{ description: 'Wasp nest removal', amount: 150 }]),
    } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toHaveLength(1);
    // Nothing bills the application, so BOTH lines come back.
    expect(createSpy.mock.calls[0][0].lineItems).toHaveLength(2);
  });

  test('an UNREADABLE live invoice defers to manual review — no guess in either direction', async () => {
    const c = conn({ liveOnVisit: { id: 'inv-mystery', line_items: 'not-json' } });
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('the overlap assert runs against the RESTORED VISIT date, not today', async () => {
    const c = conn({ visitDate: '2027-02-10' });
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', '2027-02-10', true);
  });

  test('an UNATTACHED setup-only row derives the date from the accept series (Codex P0 r13)', async () => {
    const c = conn({
      rows: [{ ...VOIDED_ROW, scheduled_service_id: null }],
      seriesDates: ['2020-01-01', '2099-05-12'],
    });
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', c);
    // First UPCOMING visit of the accept's own series — today would wrongly
    // block a future-start renewal restore while the current year runs.
    expect(mockLockOverlap).toHaveBeenCalledWith(c, 'cust-1', '2099-05-12', true);
  });

  test('an UNRESOLVED Stripe charge outcome on the prepay defers the restore (Codex P0 r29)', async () => {
    const orphanErr = new Error('Invoice has an unresolved Stripe charge pi_orphan');
    orphanErr.code = 'STRIPE_CHARGED_DB_FAILED';
    mockReconAssert.mockRejectedValue(orphanErr);
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay('inv-prepay', conn());
    expect(restored).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('a null prepayInvoiceId is a no-op', async () => {
    const restored = await InvoiceService.restoreSwitchSupersededInvoicesForPrepay(null, conn());
    expect(restored).toEqual([]);
  });
});

describe('sweepOrphanedPrepaySwitchRestores — the durable repair job', () => {
  let restoreSpy;
  beforeEach(() => {
    mockTermSync.mockClear();
    mockTermSync.mockResolvedValue(undefined);
    mockReconAssert.mockReset();
    mockReconAssert.mockResolvedValue(undefined);
    restoreSpy = jest.spyOn(InvoiceService, 'restoreSwitchSupersededInvoicesForPrepay')
      .mockResolvedValue([{ replacedInvoiceId: 'inv-old', invoiceId: 'inv-new', invoiceNumber: 'WPC-2026-0402' }]);
  });
  afterEach(() => restoreSpy.mockRestore());

  test('re-runs the TERM SYNC then the restore for every marker whose superseding prepay is DEAD', async () => {
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'void' } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    // A term the void-time sync failed to cancel is repaired here — without
    // it the overlap assert would skip the restore forever (Codex P0 r15).
    expect(mockTermSync).toHaveBeenCalledWith('inv-prepay', c);
    expect(restoreSpy).toHaveBeenCalledWith('inv-prepay', c);
    expect(restored).toHaveLength(1);
  });

  test('a failed term sync defers the restore to the next sweep', async () => {
    mockTermSync.mockRejectedValueOnce(new Error('db blip'));
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'void' } },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
  });

  test('a PI-bearing old draft expires only when the payments ledger shows nothing live', async () => {
    const voidSpy = jest.spyOn(InvoiceService, 'voidInvoice').mockResolvedValue({ status: 'void' });
    const oldDraft = {
      id: 'inv-prepay', status: 'draft', sent_at: null, paid_at: null,
      stripe_payment_intent_id: 'pi_abandoned',
      created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };
    // No live payment row → the failed tender's draft is expirable.
    await InvoiceService.sweepOrphanedPrepaySwitchRestores(conn({ rows: [VOIDED_ROW], byId: { 'inv-prepay': oldDraft } }));
    expect(voidSpy).toHaveBeenCalledWith('inv-prepay');
    voidSpy.mockClear();
    restoreSpy.mockClear();
    // A live (non-terminal) payment row → hands off, fail closed.
    await InvoiceService.sweepOrphanedPrepaySwitchRestores(conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': oldDraft },
      paymentRow: { id: 'pay-1', status: 'processing' },
    }));
    expect(voidSpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    voidSpy.mockRestore();
  });

  test('a REFUND-CANCELLED term makes a still-"paid" prepay dead — the refund case repairs (Codex P0 r22)', async () => {
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'paid' } },
      termRow: { status: 'cancelled', renewal_decision: null },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(mockTermSync).toHaveBeenCalledWith('inv-prepay', c);
    expect(restoreSpy).toHaveBeenCalledWith('inv-prepay', c);
    expect(restored).toHaveLength(1);
  });

  test('a DECIDED renewal lapse is NOT dead — its paid year still covers, restoring would double-bill', async () => {
    const c = conn({
      rows: [VOIDED_ROW],
      byId: { 'inv-prepay': { id: 'inv-prepay', status: 'paid' } },
      termRow: { status: 'cancelled', renewal_decision: 'cancel' },
    });
    const restored = await InvoiceService.sweepOrphanedPrepaySwitchRestores(c);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
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

  test('an old draft with an UNRESOLVED charge outcome is NEVER auto-expired (Codex P0 r29)', async () => {
    // STRIPE_CHARGED_DB_FAILED leaves no PI and no payments row locally —
    // only the durable orphan/attempt markers know money may be collected.
    const orphanErr = new Error('Invoice has an unresolved Stripe charge pi_orphan');
    orphanErr.code = 'STRIPE_CHARGED_DB_FAILED';
    mockReconAssert.mockRejectedValue(orphanErr);
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
    expect(voidSpy).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
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
