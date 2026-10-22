/**
 * The invoice version an Intelligence Bar invoice card showed (services/invoice-bar-expected.js) and where the services
 * enforce it: InvoiceService.update(id, body, { expected }) and InvoiceService.unvoidInvoice(id, { expected }).
 * Absent (the Invoices page and every other caller): nothing about the edit or the restore changes. Present: a changed
 * invoice is refused on the row read first, again on the LOCKED row, and the write carries the version as extra
 * predicates so a change after that read loses. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({ stopSequence: jest.fn(async () => undefined), rescheduleForInvoiceEdit: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
  acquireTermiteGateAtEntry: jest.fn(async () => []),
}));
jest.mock('../services/estimate-deposits', () => ({ restoreDepositCreditForVoidedInvoice: jest.fn(async () => 0) }));
jest.mock('../services/pay-combined', () => ({ clearPaymentIntentStamps: jest.fn(async () => undefined) }));
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: jest.fn(), assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined) }));

const db = require('../models/db');
const { invoiceVersionChanged, assertInvoiceVersion, applyInvoiceVersion } = require('../services/invoice-bar-expected');
const InvoiceService = require('../services/invoice');

const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const row = (overrides = {}) => ({
  id: 'inv-1', status: 'sent', invoice_number: 'WPC-2099-0001', customer_id: 'cust-1', title: 'Quarterly', total: '129.00', credit_applied: '0.00',
  subtotal: '129.00', discount_amount: '0.00', tax_rate: '0.0000', tax_amount: '0.00', updated_at: UPDATED, stripe_payment_intent_id: null,
  payment_recorded_at: null, archived_at: null, payer_statement_id: null, annual_prepay_term_id: null,
  line_items: [{ client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 129, amount: 129 }],
  ...overrides,
});
const EXPECTED = { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null };

describe('invoiceVersionChanged / assertInvoiceVersion / applyInvoiceVersion', () => {
  test('no expected: nothing changed, nothing asserted, no predicate added', () => {
    expect(invoiceVersionChanged(row(), undefined)).toBe(false);
    expect(() => assertInvoiceVersion(row(), null, 'editing')).not.toThrow();
    const q = { where: jest.fn(), whereRaw: jest.fn(), whereNull: jest.fn(), whereNotNull: jest.fn() };
    expect(applyInvoiceVersion(q, undefined)).toBe(q);
    expect(q.where).not.toHaveBeenCalled();
    expect(q.whereRaw).not.toHaveBeenCalled();
  });

  test.each([
    ['the same invoice', {}, false],
    ['status', { status: 'viewed' }, true],
    ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }, true],
    ['no edit time', { updated_at: null }, true],
    ['total', { total: '130.00' }, true],
    ['credit', { credit_applied: '1.00' }, true],
    ['pay session', { stripe_payment_intent_id: 'pi_new' }, true],
  ])('%s', (_label, change, changed) => {
    expect(invoiceVersionChanged(row(change), EXPECTED)).toBe(changed);
  });

  test('only the keys the card named are compared; archive state when named', () => {
    expect(invoiceVersionChanged(row({ total: '999.00' }), { status: 'sent' })).toBe(false);
    expect(invoiceVersionChanged(row({ archived_at: new Date() }), { archived: false })).toBe(true);
    expect(invoiceVersionChanged(row(), { archived: false })).toBe(false);
    expect(invoiceVersionChanged(row({ archived_at: new Date() }), { archived: true })).toBe(false);
    // An undefined key is treated as not named.
    expect(invoiceVersionChanged(row(), { status: undefined, updatedAt: undefined })).toBe(false);
  });

  test('a payer stamped on the row after the card (updated_at unmoved) is drift; the write requires the same owner', () => {
    expect(invoiceVersionChanged(row({ payer_id: 'payer-1' }), { payerId: null })).toBe(true);
    expect(invoiceVersionChanged(row({ payer_id: null }), { payerId: null })).toBe(false);
    expect(invoiceVersionChanged(row({ payer_id: 'payer-1' }), { payerId: 'payer-1' })).toBe(false);
    const calls = [];
    const q = {};
    for (const name of ['where', 'whereRaw', 'whereNull', 'whereNotNull']) q[name] = jest.fn((...a) => { calls.push([name, ...a]); return q; });
    applyInvoiceVersion(q, { payerId: null });
    applyInvoiceVersion(q, { payerId: 'payer-1' });
    expect(calls).toEqual([['whereNull', 'payer_id'], ['where', 'payer_id', 'payer-1']]);
  });

  test('assertSelfPayLive re-asks the live owner on the locked row only when the card computed a self-pay retotal', async () => {
    const { assertSelfPayLive } = require('../services/invoice-bar-expected');
    const ownership = require('../services/invoice-payer-ownership');
    const spy = jest.spyOn(ownership, 'invoicePayerOwnership');
    const term = jest.spyOn(require('../services/invoice-prepay'), 'resolveInvoiceTermId').mockResolvedValue(null);
    const locks = [];
    const conn = (table) => { const q = { where: () => q, forShare: () => { locks.push(table); return q; }, first: async () => ({ id: 'x' }) }; return q; };
    try {
      // An annual term that appeared through the visit refuses, with the visit row held FOR SHARE first; unverifiable too.
      term.mockResolvedValueOnce('term-1');
      await expect(assertSelfPayLive(row({ scheduled_service_id: 'ss-1' }), { selfPayLive: true }, conn)).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      expect(locks).toEqual(['scheduled_services']);
      term.mockRejectedValueOnce(new Error('db down'));
      await expect(assertSelfPayLive(row(), { selfPayLive: true }, conn)).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      await expect(assertSelfPayLive(row(), { status: 'sent' }, {})).resolves.toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      spy.mockResolvedValueOnce(null);
      await expect(assertSelfPayLive(row(), { selfPayLive: true }, {})).resolves.toBeUndefined();
      spy.mockResolvedValueOnce('payer_owned');
      await expect(assertSelfPayLive(row(), { selfPayLive: true }, {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED', statusCode: 409 });
      spy.mockResolvedValueOnce('payer_unverifiable');
      await expect(assertSelfPayLive(row(), { selfPayLive: true }, {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      // A service-record-only link whose visit a payer owns is not self-pay.
      const visitPayer = jest.spyOn(require('../services/visit-linked-invoice-withdrawal'), 'liveVisitPayerOf').mockResolvedValueOnce('payer-1');
      spy.mockResolvedValueOnce(null);
      await expect(assertSelfPayLive(row({ scheduled_service_id: null, service_record_id: 'sr-1' }), { selfPayLive: true }, {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
      visitPayer.mockRestore();
    } finally {
      spy.mockRestore();
      term.mockRestore();
    }
  });

  test('the drift error is a 409 PREVIEW_CHANGED operational error naming what was being done', () => {
    let error;
    try { assertInvoiceVersion(row({ total: '130.00' }), EXPECTED, 'unvoiding'); } catch (err) { error = err; }
    expect(error).toMatchObject({ message: 'Invoice changed while unvoiding — re-check and retry', statusCode: 409, status: 409, isOperational: true, code: 'PREVIEW_CHANGED' });
  });

  test('the write predicates: status, edit time to the millisecond, total and credit in cents, pay session, archive state', () => {
    const calls = [];
    const q = {};
    for (const name of ['where', 'whereRaw', 'whereNull', 'whereNotNull']) q[name] = jest.fn((...a) => { calls.push([name, ...a]); return q; });
    applyInvoiceVersion(q, { ...EXPECTED, archived: false });
    expect(calls).toEqual([
      ['where', 'status', 'sent'],
      ['whereRaw', "date_trunc('milliseconds', updated_at) = ?::timestamptz", [UPDATED.toISOString()]],
      ['whereRaw', 'ROUND(COALESCE(total, 0) * 100) = ?', [12900]],
      ['whereRaw', 'ROUND(COALESCE(credit_applied, 0) * 100) = ?', [0]],
      ['whereNull', 'stripe_payment_intent_id'],
      ['whereNull', 'archived_at'],
    ]);
    calls.length = 0;
    applyInvoiceVersion(q, { updatedAt: null, paymentIntentId: 'pi_1', archived: true });
    expect(calls).toEqual([['whereNull', 'updated_at'], ['where', 'stripe_payment_intent_id', 'pi_1'], ['whereNotNull', 'archived_at']]);
  });
});

// A table-routing stand-in for knex: per-table queues for first() reads, a result for update().returning(), and a record of
// every where* call on each table's builders.
let cfg;
let calls;
function builder(table) {
  const q = { table, ops: [], isUpdate: false };
  calls.push(q);
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(q.isUpdate ? 1 : q.selected ? (cfg.selects?.[table] || []) : []).then(res, rej);
      if (prop === 'select') return (...args) => { q.selected = true; q.ops.push(['select', ...args]); return chain; };
      if (prop === 'first') return async () => {
        const reads = cfg.reads[table];
        if (!reads) return undefined;
        return reads.length > 1 ? reads.shift() : reads[0];
      };
      if (prop === 'update') return (...args) => { q.isUpdate = true; q.ops.push(['update', ...args]); return chain; };
      if (prop === 'returning') return async () => cfg.updateReturning[table] || [];
      if (prop === 'insert') return () => Promise.resolve(1);
      return (...args) => { q.ops.push([String(prop), ...args]); return chain; };
    },
  });
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  cfg = { reads: {}, updateReturning: {} };
  calls = [];
  db.mockReset();
  db.mockImplementation(builder);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: jest.fn(() => 'NOW()') };
});

const updateOps = () => calls.filter((c) => c.table === 'invoices' && c.isUpdate).flatMap((c) => c.ops);

describe('InvoiceService.update(id, body, { expected })', () => {
  test('without `expected` the edit’s UPDATE carries no version predicates (the page and other callers)', async () => {
    cfg.reads.invoices = [row(), row()];
    cfg.updateReturning.invoices = [row({ title: 'Renamed' })];
    await InvoiceService.update('inv-1', { title: 'Renamed' });
    const ops = updateOps();
    expect(ops.filter(([name, first]) => name === 'whereRaw' || (name === 'where' && typeof first === 'string'))).toEqual([]);
    expect(ops.find(([name]) => name === 'update')[1]).toMatchObject({ title: 'Renamed' });
  });

  test('with `expected` the same edit’s UPDATE also requires the status, edit time, total, credit and no pay session', async () => {
    cfg.reads.invoices = [row(), row()];
    cfg.updateReturning.invoices = [row({ title: 'Renamed' })];
    await InvoiceService.update('inv-1', { title: 'Renamed' }, { expected: EXPECTED });
    const editCall = calls.find((c) => c.table === 'invoices' && c.ops.some(([name]) => name === 'update'));
    const names = editCall.ops.map(([name, ...rest]) => [name, ...rest.filter((value) => typeof value === 'string')]);
    expect(names).toEqual(expect.arrayContaining([
      ['where', 'status', 'sent'],
      ['whereRaw', "date_trunc('milliseconds', updated_at) = ?::timestamptz"],
      ['whereRaw', 'ROUND(COALESCE(total, 0) * 100) = ?'],
      ['whereRaw', 'ROUND(COALESCE(credit_applied, 0) * 100) = ?'],
    ]));
    expect(editCall.ops.find(([name, text]) => name === 'whereRaw' && /date_trunc/.test(text))[2]).toEqual([UPDATED.toISOString()]);
  });

  test.each([
    ['status', { status: 'viewed' }],
    ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }],
    ['total', { total: '130.00' }],
    ['credit', { credit_applied: '5.00' }],
  ])('a changed %s refuses on the first read: no other read, no transaction, no write', async (_label, change) => {
    cfg.reads.invoices = [row(change)];
    await expect(InvoiceService.update('inv-1', { title: 'Renamed' }, { expected: EXPECTED })).rejects.toMatchObject({
      message: 'Invoice changed while editing — re-check and retry', code: 'PREVIEW_CHANGED', statusCode: 409,
    });
    expect(db).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('an edit between the first read and the row lock is caught on the LOCKED row: nothing is written', async () => {
    cfg.reads.invoices = [row(), row({ updated_at: new Date('2099-01-03T00:00:00Z') })];
    await expect(InvoiceService.update('inv-1', { title: 'Renamed' }, { expected: EXPECTED })).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' });
    expect(updateOps()).toEqual([]);
  });

  test('a write that matches no row (changed after the lock read) throws the page’s own editability message', async () => {
    cfg.reads.invoices = [row(), row()];
    cfg.updateReturning.invoices = [];
    await expect(InvoiceService.update('inv-1', { title: 'Renamed' }, { expected: EXPECTED })).rejects.toThrow(/Only unpaid invoices can be edited/);
  });

  test('the new total the card showed is enforced with the edit’s own arithmetic: a different figure refuses before the transaction', async () => {
    const lines = [{ client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 149, amount: 149 }];
    cfg.reads.invoices = [row()];
    cfg.reads.customers = [{ id: 'cust-1', property_type: 'residential' }];
    await expect(InvoiceService.update('inv-1', { line_items: lines }, { expected: { ...EXPECTED, newTotal: 150 } })).rejects.toMatchObject({
      message: expect.stringMatching(/new total is no longer what the card showed/), code: 'PREVIEW_CHANGED',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the same retotal with the right new total goes through to the write', async () => {
    const lines = [{ client_id: 'li_a', description: 'Quarterly Pest Control', quantity: 1, unit_price: 149, amount: 149 }];
    cfg.reads.invoices = [row(), row()];
    cfg.reads.customers = [{ id: 'cust-1', property_type: 'residential' }];
    cfg.updateReturning.invoices = [row({ total: '149.00' })];
    const saved = await InvoiceService.update('inv-1', { line_items: lines }, { expected: { ...EXPECTED, newTotal: 149 } });
    expect(saved.total).toBe('149.00');
    expect(updateOps().find(([name]) => name === 'update')[1]).toMatchObject({ total: 149, subtotal: 149 });
  });

  test('the exported arithmetic is the one the edit uses (a commercial customer, the card’s tax rate)', async () => {
    cfg.reads.customers = [{ id: 'cust-1', property_type: 'commercial' }];
    const fin = await InvoiceService._calculateUpdateFinancials({
      lineItems: [{ client_id: 'li_a', description: 'Service', quantity: 2, unit_price: 50 }], customer: { property_type: 'commercial' }, invoice: row(), taxRate: 0.07,
    });
    expect(fin).toMatchObject({ subtotal: 100, discount_amount: 0, tax_rate: 0.07, tax_amount: 7, total: 107 });
  });
});

describe('InvoiceService.unvoidInvoice(id, { expected })', () => {
  const VOID_EXPECTED = { status: 'void', updatedAt: UPDATED.getTime() };

  test.each([
    ['edit time', { updated_at: new Date('2099-01-02T00:00:00Z') }],
    ['status', { status: 'draft' }],
  ])('a changed %s refuses on the first read, before any other read or write', async (_label, change) => {
    cfg.reads.invoices = [row({ status: 'void', ...change })];
    await expect(InvoiceService.unvoidInvoice('inv-1', { expected: VOID_EXPECTED })).rejects.toMatchObject({
      message: 'Invoice changed while unvoiding — re-check and retry', code: 'PREVIEW_CHANGED', statusCode: 409,
    });
    expect(db).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('without `expected` a draft is still refused by the page’s own message (nothing about the page changed)', async () => {
    cfg.reads.invoices = [row({ status: 'draft' })];
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow('Only a voided invoice can be unvoided (current status: draft)');
  });

  test('the restore’s UPDATE carries the version as extra predicates only with `expected`', async () => {
    const voided = row({ status: 'void' });
    cfg.reads.invoices = [voided];
    cfg.updateReturning.invoices = []; // the restore matches no row: the page’s own drift message
    await expect(InvoiceService.unvoidInvoice('inv-1', { expected: VOID_EXPECTED })).rejects.toThrow(/Invoice status changed while unvoiding — re-check and retry/);
    const restore = calls.find((c) => c.table === 'invoices' && c.ops.some(([name]) => name === 'update'));
    expect(restore.ops.map(([name]) => name)).toEqual(expect.arrayContaining(['where', 'whereRaw']));
    expect(restore.ops.find(([name, text]) => name === 'whereRaw' && /date_trunc/.test(text))[2]).toEqual([UPDATED.toISOString()]);
    calls.length = 0;
    cfg.reads.invoices = [voided];
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/Invoice status changed while unvoiding/);
    const pageRestore = calls.find((c) => c.table === 'invoices' && c.ops.some(([name]) => name === 'update'));
    expect(pageRestore.ops.filter(([name]) => name === 'whereRaw')).toEqual([]);
  });
});

describe('unvoid: setup-fee and dues invoices are left to the Invoices page (InvoiceService._unvoidObligationReason)', () => {
  const reason = (invoice) => InvoiceService._unvoidObligationReason(db, invoice);
  const SETUP_LINE = { description: 'Bait Station Setup — one-time setup fee', amount: 99 };

  test('an ordinary invoice has no obligation: the four reads come back empty', async () => {
    await expect(reason(row({ status: 'void' }))).resolves.toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['sms_log', 'invoice_followup_sequences', 'setup_fee_claims', 'dispatch_alerts', 'invoices']);
  });

  test('a membership-dues month and the setup line are found from the lines, with no read', async () => {
    await expect(reason(row({ line_items: [{ description: 'Dues', amount: 50, membership_dues_month: '2099-01' }] }))).resolves.toBe('membership_dues');
    await expect(reason(row({ line_items: [SETUP_LINE] }))).resolves.toBe('setup_fee');
    expect(calls).toEqual([]);
  });

  test.each([
    ['the durable setup-fee claim (a renamed line hides the text)', 'setup_fee_claims'],
    ['an office handoff alert naming the invoice', 'dispatch_alerts'],
  ])('%s', async (_label, table) => {
    cfg.reads[table] = [{ id: 'x' }];
    await expect(reason(row({ status: 'void' }))).resolves.toBe('setup_fee');
  });

  test.each([
    ['a packet invoice', { visit_completion_packet_id: 'packet-1' }, 'packet_invoice'],
    ['a payer-billed invoice', { payer_id: 'payer-1' }, 'payer_billed'],
    ['a withdrawn stamp left after the payer was removed', { payer_id: null, scheduled_send_error: 'payer_billed:payer-1' }, 'payer_billed'],
    ['a withdrawn stamp with flags', { scheduled_send_error: 'payer_billed:payer-1:park:hold' }, 'payer_billed'],
  ])('%s is found from the row, with no read', async (_label, change, expectedReason) => {
    await expect(reason(row({ status: 'void', ...change }))).resolves.toBe(expectedReason);
    expect(calls).toEqual([]);
  });

  test('a send error that is not a withdrawal stamp does not refuse; other open invoices of the customer are not read (the customer-wide reconcile only runs for a packet invoice, which is refused)', async () => {
    await expect(reason(row({ status: 'void', scheduled_send_error: 'SUMMARY_TEXT_PLANNED' }))).resolves.toBeNull();
    expect(calls.every((c) => !c.ops.some(([name, col]) => name === 'where' && col && col.customer_id))).toBe(true);
  });

  test('a live replacement draft carrying the rebill marker for this invoice', async () => {
    cfg.reads.invoices = [{ id: 'inv-rebill' }];
    await expect(reason(row({ status: 'void' }))).resolves.toBe('setup_fee');
    const rebill = calls.find((c) => c.table === 'invoices');
    expect(rebill.ops).toEqual(expect.arrayContaining([
      ['where', 'notes', 'like', '%[rodent-setup-rebill:inv-1]%'],
      ['whereNotIn', 'status', ['void', 'cancelled', 'canceled', 'refunded']],
    ]));
  });

  test('the bar’s restore refuses on the row its UPDATE holds (an obligation that appeared after the card) and rolls back; the page’s does not use the fence', async () => {
    const voided = row({ status: 'void' });
    cfg.reads.invoices = [voided];
    cfg.updateReturning.invoices = [voided];
    cfg.reads.setup_fee_claims = [{ id: 'claim-1' }];
    await expect(InvoiceService.unvoidInvoice('inv-1', { expected: { status: 'void', updatedAt: UPDATED.getTime() } })).rejects.toThrow(/^Cannot unvoid from the bar/);
    // Nothing after the fence ran: no write to the text queue or the reminder sequences (the fence only READ them).
    expect(calls.filter((c) => ['sms_log', 'invoice_followup_sequences'].includes(c.table) && (c.isUpdate || c.ops.some(([name]) => name === 'update')))).toEqual([]);
    calls.length = 0;
    cfg.reads.invoices = [voided];
    // The page restores the same invoice (it has its own handling of those records): the bar-only fence is not applied.
    await expect(InvoiceService.unvoidInvoice('inv-1')).resolves.toMatchObject({ id: 'inv-1' });
  });
});

describe('unvoid: a packet / payer-billed invoice never reaches the customer-wide Bill-To reconcile from the bar', () => {
  test.each([
    ['a packet invoice', { visit_completion_packet_id: 'packet-1' }],
    ['a payer-billed invoice', { payer_id: 'payer-1' }],
    ['a withdrawn stamp whose payer was removed', { scheduled_send_error: 'payer_billed:payer-1' }],
  ])('%s: the restore’s UPDATE row is refused under the lock before any reconcile work, and nothing is queued', async (_label, change) => {
    const voided = row({ status: 'void', ...change });
    cfg.reads.invoices = [voided];
    cfg.updateReturning.invoices = [voided];
    await expect(InvoiceService.unvoidInvoice('inv-1', { expected: { status: 'void', updatedAt: UPDATED.getTime() } })).rejects.toThrow(/^Cannot unvoid from the bar/);
    // The only tables read are the restore's own pre-UPDATE ownership locks; none of the reconcile / withdrawal / queue work ran, and the
    // UPDATE row was the last statement.
    const touched = calls.map((c) => c.table);
    for (const table of ['sms_log', 'invoice_followup_sequences', 'payer_statements', 'payers', 'dispatch_alerts']) expect(touched).not.toContain(table);
    expect(touched[touched.length - 1]).toBe('invoices');
    expect(calls[calls.length - 1].isUpdate).toBe(true);
  });
});


describe('unvoid: the bar restores the row and nothing else (structural refusal reasons)', () => {
  const reason = (invoice) => InvoiceService._unvoidObligationReason(db, invoice);

  test('a payer statement is found from the row, with no read', async () => {
    await expect(reason(row({ status: 'void', payer_statement_id: 'stmt-1' }))).resolves.toBe('payer_statement');
    expect(calls).toEqual([]);
  });

  test('ANY scheduled / sending / finalize-pending message tied to the invoice refuses, whatever its entry point', async () => {
    cfg.reads.sms_log = [{ id: 'sms-1' }];
    await expect(reason(row({ status: 'void' }))).resolves.toBe('queued_message');
    const q = calls.find((c) => c.table === 'sms_log');
    expect(q.ops[0]).toEqual(['whereRaw', "metadata->>'invoice_id' = ?", ['inv-1']]);
    // No entry-point list anywhere in the query: a new kind of queued message cannot slip past.
    expect(JSON.stringify(q.ops.map(([name, arg]) => (typeof arg === 'string' ? arg : name)))).not.toMatch(/entry_point/);
  });

  test('an active or autopay-held reminder sequence refuses', async () => {
    cfg.reads.invoice_followup_sequences = [{ id: 'seq-1' }];
    await expect(reason(row({ status: 'void' }))).resolves.toBe('followup_sequence');
    const q = calls.find((c) => c.table === 'invoice_followup_sequences');
    expect(q.ops).toEqual(expect.arrayContaining([['whereIn', 'status', ['active', 'autopay_hold']]]));
  });

  // The REAL owner resolver (visit-linked-invoice-withdrawal.js liveVisitPayerOf) on the table-routing stand-in. The invoice is VOID,
  // as at preview: the restore would withdraw a draft from the customer when a payer owns its visit now, and ownerTransitions would not
  // even list a void invoice, so the card has to ask the live owner itself.
  describe('linked_payer_owner reads the live Bill-To owner of a VOID invoice', () => {
    const visitInvoice = () => row({ status: 'void', scheduled_service_id: 'visit-1' });
    const owner = ({ visitPayer = null, customerPayer = null, selfPay = false, active = true, visitCustomer = 'cust-1' } = {}) => {
      cfg.reads.scheduled_services = [{ id: 'visit-1', customer_id: visitCustomer, payer_id: visitPayer, self_pay_override: selfPay }];
      cfg.reads.customers = [{ payer_id: customerPayer }];
      cfg.selects = { payers: [{ id: visitPayer || customerPayer, active }] };
    };

    test.each([
      ['a payer assigned to the visit after the void', { visitPayer: 'payer-1' }, 'linked_payer_owner'],
      ['a payer on the customer', { customerPayer: 'payer-2' }, 'linked_payer_owner'],
      ['a payer who is not active', { visitPayer: 'payer-1', active: false }, null],
      ['a self-pay override on the visit', { customerPayer: 'payer-2', selfPay: true }, null],
      ['no payer at all', {}, null],
      ['a visit that belongs to another customer', { visitPayer: 'payer-1', visitCustomer: 'cust-9' }, null],
    ])('%s', async (_label, state, expected) => {
      owner(state);
      await expect(reason(visitInvoice())).resolves.toBe(expected);
    });

    test('a service-record-only invoice resolves its visit through the record; an invoice with no visit link is not asked', async () => {
      owner({ visitPayer: 'payer-1' });
      cfg.reads.service_records = [{ scheduled_service_id: 'visit-1' }];
      await expect(reason(row({ status: 'void', service_record_id: 'rec-1' }))).resolves.toBe('linked_payer_owner');
      calls.length = 0;
      await expect(reason(row({ status: 'void' }))).resolves.toBeNull();
      expect(calls.map((c) => c.table)).not.toContain('scheduled_services');
    });

    test('the bar’s restore also refuses on the draft row under the lock (a payer assigned after the card), before the withdrawal runs', async () => {
      owner({ visitPayer: 'payer-1' });
      // The restore's linked-visit guard asks the schema first.
      db.schema = { hasColumn: jest.fn(async () => false), hasTable: jest.fn(async () => false) };
      const voided = visitInvoice();
      cfg.reads.invoices = [voided];
      cfg.updateReturning.invoices = [voided];
      await expect(InvoiceService.unvoidInvoice('inv-1', { expected: { status: 'void', updatedAt: UPDATED.getTime() } })).rejects.toThrow(/^Cannot unvoid from the bar/);
    });
  });

  test('an autopay-decline deferred text (a terminal-hook entry point): the bar refuses under the lock and never cancels it or runs its hook; the page still does both', async () => {
    const registry = require('../services/messaging/deferred-replay-registry');
    const entry = 'autopay_completion_decline_deferred';
    // The real registry: this entry point DOES carry a terminal hook (handOverHeldInvoiceToSender), the path that re-queues an invoice text.
    expect(registry.requiresTerminalHook(entry)).toBe(true);
    const hook = jest.spyOn(registry, 'runTerminalHookDurably').mockResolvedValue({ ok: true });
    try {
      const voided = row({ status: 'void' });
      // Bar: the queued text is found by the fence (no entry-point list), the restore rolls back, the text is untouched, the hook is not run.
      cfg.reads.invoices = [voided];
      cfg.updateReturning.invoices = [voided];
      cfg.reads.sms_log = [{ id: 'sms-1' }];
      cfg.selects = { sms_log: [{ id: 'sms-1', metadata: { entry_point: entry, invoice_id: 'inv-1' } }] };
      await expect(InvoiceService.unvoidInvoice('inv-1', { expected: { status: 'void', updatedAt: UPDATED.getTime() } })).rejects.toThrow(/^Cannot unvoid from the bar/);
      expect(calls.filter((c) => c.table === 'sms_log' && (c.isUpdate || c.ops.some(([name]) => name === 'update')))).toEqual([]);
      expect(hook).not.toHaveBeenCalled();
      // Page (no `expected`): the same row is cancelled with its terminal_pending stamp and the hook runs after the commit - the work the bar must not do.
      calls.length = 0;
      cfg.reads.invoices = [voided];
      cfg.reads.sms_log = [undefined];
      await InvoiceService.unvoidInvoice('inv-1');
      const cancel = calls.find((c) => c.table === 'sms_log' && c.ops.some(([name]) => name === 'update'));
      expect(JSON.stringify(cancel.ops)).toMatch(/terminal_pending/);
      expect(hook).toHaveBeenCalledWith('sms-1', entry, expect.objectContaining({ entry_point: entry }), { alreadyClaimed: true });
    } finally {
      hook.mockRestore();
    }
  });
});
