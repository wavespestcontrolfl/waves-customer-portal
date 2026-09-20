// claimInvoiceForSend's adoption (adoptsQueuedInvoiceSend) CONSUMES a
// pre-existing queued pay-link SMS (the invoice_send_deferred row a held
// send left on the scheduled rail) BEFORE the replacement delivery is even
// attempted, so the queue worker can never double-send while the live
// replacement is in flight. If that replacement delivery then fails, the
// cancellation must be undone (restoreConsumedQueuedSend) — otherwise the
// customer's already-scheduled text is silently lost; if it succeeds, the
// adopted row must be discharged (resolveConsumedQueuedSend), never
// restored — restoring a row a live send actually delivered would double-
// text the pay link. An uncertain provider outcome must do neither: the
// adopted row stays exactly as consumeQueuedInvoiceSend left it (cancelled,
// pending) until an operator resolves the ambiguous send.
//
// This suite models 'invoices' and 'sms_log' as small in-memory tables so
// assertions are about durable STATE rather than a hand-counted call order.

const QUEUE_ADOPTION_PENDING_KEY = 'invoice_send_adoption_pending';
const INVOICE_SEND_DEFERRED_ENTRY_POINT = 'invoice_send_deferred';

function makeInvoicesTable(row) {
  let state = { ...row };
  return {
    state: () => state,
    reset: (next) => { state = { ...next }; },
    query() {
      const filters = {};
      const q = {};
      const applyFilters = (rows) => rows.filter((r) => (
        Object.entries(filters).every(([k, v]) => r[k] === v)
      ));
      q.where = jest.fn((crit) => { Object.assign(filters, crit); return q; });
      q.whereIn = jest.fn(() => q);
      q.whereNull = jest.fn(() => q);
      q.whereRaw = jest.fn(() => q);
      q.forUpdate = jest.fn(() => q);
      q.update = jest.fn((payload) => {
        const matched = applyFilters([state]);
        for (const r of matched) {
          for (const [k, v] of Object.entries(payload)) {
            if (k === 'status' && ((typeof v === 'string' && v.startsWith('CASE WHEN'))
              || (v && v.__sqlRaw && v.__sqlRaw.startsWith('CASE WHEN')))) {
              r[k] = ['draft', 'scheduled', 'sending'].includes(r.status) ? 'sent' : r.status;
            } else if (k === 'scheduled_send_error' && v && v.__sqlRaw) {
              // preserveWithdrawalStamp raw CASE — irrelevant to this suite's
              // fixtures (no withdrawal stamp), so it always resolves null.
              r[k] = null;
            } else {
              r[k] = v;
            }
          }
        }
        q.__affected = matched.length;
        return q;
      });
      // Single-row table: RETURNING after an UPDATE reflects the WHERE
      // clause evaluated once (real knex/PostgreSQL semantics), never a
      // re-filter against the now-mutated state — a status-changing update
      // would otherwise filter itself out of its own RETURNING.
      q.returning = jest.fn(async () => (q.__affected ? [{ ...state }] : []));
      // Cloned — a real DB row is a value, never a live reference into the
      // server's mutable row; the caller's read must not observe a LATER
      // update through this object.
      q.first = jest.fn(async () => { const m = applyFilters([state])[0]; return m ? { ...m } : undefined; });
      q.then = (resolve) => Promise.resolve(q.__affected ?? applyFilters([state]).length).then(resolve);
      q.catch = () => Promise.resolve();
      return q;
    },
  };
}

function applyRawMetadataUpdate(row, rawValue) {
  const sql = rawValue.__sqlRaw;
  row.metadata = row.metadata || {};
  if (sql.includes("jsonb_build_object('cancelled_reason'")) {
    row.metadata = {
      ...row.metadata,
      cancelled_reason: 'superseded_by_live_send',
      cancelled_at: rawValue.__bindings[0],
      [QUEUE_ADOPTION_PENDING_KEY]: true,
    };
  } else if (sql.startsWith('((metadata -')) {
    const { cancelled_reason: _reason, cancelled_at: _at, [QUEUE_ADOPTION_PENDING_KEY]: _drop, ...rest } = row.metadata;
    row.metadata = rest;
  } else if (sql.includes('adoption_resolved_at')) {
    const { [QUEUE_ADOPTION_PENDING_KEY]: _drop, ...rest } = row.metadata;
    row.metadata = { ...rest, adoption_resolved_at: rawValue.__bindings[0] };
  }
}

function makeSmsLogTable(initialRows) {
  let rows = initialRows.map((r) => ({ ...r, metadata: { ...r.metadata } }));
  return {
    rows: () => rows,
    query() {
      const rawFilters = [];
      let idFilter = null;
      let simpleWhere = {};
      const q = {};
      q.where = jest.fn((crit) => { Object.assign(simpleWhere, crit); return q; });
      q.whereIn = jest.fn((field, values) => { if (field === 'id') idFilter = values; return q; });
      q.whereNull = jest.fn(() => q);
      q.forUpdate = jest.fn(() => q);
      q.whereRaw = jest.fn((sql, bindings) => {
        const eqMatch = /metadata->>'(\w+)' = \?$/.exec(sql);
        if (eqMatch && Array.isArray(bindings) && typeof bindings[0] !== 'object') {
          const key = eqMatch[1];
          rawFilters.push((row) => (row.metadata || {})[key] === bindings[0]);
        } else if (sql.includes("entry_point' = ANY")) {
          const list = bindings[0];
          rawFilters.push((row) => list.includes((row.metadata || {}).entry_point));
        } else if (sql.includes("status = 'scheduled' OR")) {
          rawFilters.push((row) => row.status === 'scheduled'
            || (row.status === 'cancelled' && !!(row.metadata || {})[QUEUE_ADOPTION_PENDING_KEY]));
        } else if (sql.includes("cancelled_reason' = 'superseded_by_live_send'")) {
          rawFilters.push((row) => (row.metadata || {}).cancelled_reason === 'superseded_by_live_send');
        } else if (sql.includes(QUEUE_ADOPTION_PENDING_KEY)) {
          rawFilters.push((row) => !!(row.metadata || {})[QUEUE_ADOPTION_PENDING_KEY]);
        } else if (sql.includes('finalize_pending')) {
          if (bindings) {
            const excludedEntryPoint = bindings[0];
            rawFilters.push((row) => row.status === 'sending'
              || (row.status === 'sent' && (row.metadata || {}).finalize_pending === true)
              || (row.status === 'scheduled' && (row.metadata || {}).entry_point !== excludedEntryPoint));
          } else {
            rawFilters.push((row) => row.status === 'scheduled' || row.status === 'sending'
              || (row.status === 'sent' && (row.metadata || {}).finalize_pending === true));
          }
        }
        return q;
      });
      const matched = () => {
        let candidates = idFilter ? rows.filter((r) => idFilter.includes(r.id)) : rows.slice();
        for (const [k, v] of Object.entries(simpleWhere)) candidates = candidates.filter((r) => r[k] === v);
        for (const f of rawFilters) candidates = candidates.filter(f);
        return candidates;
      };
      q.first = jest.fn(async () => matched()[0]);
      q.update = jest.fn((payload) => {
        const targets = matched();
        q.__matched = targets;
        for (const row of targets) {
          for (const [k, v] of Object.entries(payload)) {
            if (k === 'metadata' && v && v.__sqlRaw) applyRawMetadataUpdate(row, v);
            else if (k !== 'updated_at') row[k] = v;
          }
        }
        q.__affected = targets.length;
        return q;
      });
      // Reflects the WHERE clause evaluated once, before the update applied
      // (real knex/PostgreSQL RETURNING semantics) — never a re-filter
      // against the now-mutated rows.
      q.returning = jest.fn(async () => (q.__matched || matched()).map((r) => ({ ...r })));
      q.then = (resolve) => Promise.resolve(q.__affected ?? matched().length).then(resolve);
      q.catch = () => Promise.resolve();
      return q;
    },
  };
}

jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql, bindings) => ({ __sqlRaw: sql, __bindings: bindings }));
  database.transaction = jest.fn(async (callback) => callback(database));
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://waves.test' }));
jest.mock('../services/invoice-prepay', () => ({
  loadInvoiceAnnualPrepay: jest.fn(async () => null),
  buildPrepayCoverageSummary: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
  getTemplate: jest.fn(async () => 'Your invoice is ready: https://waves.test/pay/abc'),
}));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(async () => true) }));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'),
  assertInvoiceVoidable: jest.fn(),
  invoiceAmountDue: (invoice) => Number(invoice.total) - Number(invoice.credit_applied || 0),
  formatCardLine: jest.fn(),
  preserveWithdrawalStamp: jest.fn(() => null),
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => true),
  withInvoiceDepositSettlement: jest.fn(async (_id, callback) => callback(null, null)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => null),
  reverseAppliedCredit: jest.fn(async () => {}),
}));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: jest.fn(async () => null) }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));

const db = require('../models/db');
const { withInvoiceDepositSettlement } = require('../services/estimate-deposits');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceService = require('../services/invoice');

function customerQuery(customer) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => customer);
  return q;
}

function passthroughQuery() {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'update', 'insert']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => undefined);
  q.then = (resolve) => Promise.resolve(1).then(resolve);
  q.catch = () => Promise.resolve();
  return q;
}

describe('invoice send claim adoption of a queued pay-link SMS', () => {
  const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T12:00:00.000Z');
  let invoices;
  let smsLog;
  let customer;

  beforeEach(() => {
    jest.clearAllMocks();
    invoices = makeInvoicesTable({
      id: 'inv-1',
      invoice_number: 'WPC-2026-2001',
      status: 'draft',
      customer_id: 'cust-1',
      payer_id: null,
      token: 'tok-1',
      total: 100,
      credit_applied: 0,
      send_claim_token: null,
    });
    smsLog = makeSmsLogTable([{
      id: 'sms-queued-1',
      status: 'scheduled',
      scheduled_for: ORIGINAL_SCHEDULED_FOR,
      metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
    }]);
    customer = { id: 'cust-1', first_name: 'Pat', phone: '+19415550100' };
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices.query();
      if (table === 'sms_log') return smsLog.query();
      if (table === 'customers') return customerQuery(customer);
      if (table === 'activity_log') return passthroughQuery();
      throw new Error(`Unexpected table: ${table}`);
    });
    withInvoiceDepositSettlement.mockImplementation(async (_id, callback) => callback(db, invoices.state()));
  });

  test('a no-phone failure restores the adopted queued row — same id, same schedule — before releasing the invoice claim', async () => {
    customer.phone = null;

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('Customer has no phone number');

    // The invoice claim gave back to 'draft' and the token cleared.
    expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
    // The adopted row is restored to exactly its original schedule — not a
    // fresh one.
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toEqual(ORIGINAL_SCHEDULED_FOR);
    expect(row.metadata.cancelled_reason).toBeUndefined();
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
  });

  test('a fully delivered send resolves the adopted row — it stays cancelled, never restored', async () => {
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
      withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
    ));

    await expect(InvoiceService.sendViaSMS('inv-1')).resolves.toMatchObject({ sent: true });

    expect(invoices.state().status).toBe('sent');
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    // Consumed by the adoption and never given back — a live send actually
    // delivered the pay link it superseded.
    expect(row.status).toBe('cancelled');
    expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
    // The pending marker is cleared (durably resolved) so a later resend
    // can never mistake this historically superseded row for an owed leg.
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
    expect(row.metadata.adoption_resolved_at).toEqual(expect.any(String));
  });

  test('an uncertain provider outcome leaves the adopted row exactly as consumed — neither restored nor resolved', async () => {
    const uncertainErr = Object.assign(new Error('provider socket closed'), {
      providerOutcome: { deliveryOutcome: 'uncertain', code: 'PROVIDER_TIMEOUT' },
    });
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
      withProviderHandoff(async () => { throw uncertainErr; })
    ));

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ deliveryOutcome: 'uncertain' });

    // The claim is retained (parked for review), never restored to draft.
    expect(invoices.state()).toMatchObject({ status: 'sending' });
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    // Consumed but neither resolved nor restored — the durable "may have
    // sent" marker stays exactly as the adoption left it until an operator
    // resolves the ambiguous send.
    expect(row.status).toBe('cancelled');
    expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
  });

  test('a live queued row not owned by this send refuses the claim outright (no adoption)', async () => {
    // A completion-deferred text (not this invoice's own held SMS leg) is
    // never adoptable — it always refuses, whether or not the caller is
    // authorized to adopt its OWN leg.
    smsLog = makeSmsLogTable([{
      id: 'sms-completion-1',
      status: 'scheduled',
      scheduled_for: ORIGINAL_SCHEDULED_FOR,
      metadata: { entry_point: 'dispatch_completion_deferred', invoice_id: 'inv-1' },
    }]);
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices.query();
      if (table === 'sms_log') return smsLog.query();
      if (table === 'customers') return customerQuery(customer);
      if (table === 'activity_log') return passthroughQuery();
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ code: 'queued_pay_link' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Refused before ever claiming — the invoice never left 'draft'.
    expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
  });
});
