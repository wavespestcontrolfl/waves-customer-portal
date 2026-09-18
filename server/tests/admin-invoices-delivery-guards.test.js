/** Shared send and schedule guards for existing visit-linked invoices. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (work) => work(fn));
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => {
  const actual = jest.requireActual('../services/invoice');
  return { ...actual, create: jest.fn(async (args) => ({ id: 'inv-new', token: 'tok', customer_id: args.customerId, invoice_number: 'WPC-TEST-1', scheduled_service_id: args.scheduledServiceId || null })) };
});
jest.mock('../services/scheduled-invoice-mint', () => ({
  ...jest.requireActual('../services/scheduled-invoice-mint'),
  acquireScheduledInvoiceMintLock: jest.fn(async () => undefined),
  // The ONE scheduled-visit mint helper: lock chain, adopt-existing, deposit
  // roll-forward. Mocked here; its own contract is covered by its suites.
  mintScheduledServiceInvoiceWithDeposit: jest.fn(async ({ svc, buildCreateParams }) => {
    const params = buildCreateParams();
    return { invoice: { id: 'inv-new', token: 'tok', customer_id: params.customerId, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id }, reused: false };
  }),
}));
jest.mock('../services/completion-invoice-candidate', () => ({
  ...jest.requireActual('../services/completion-invoice-candidate'),
  completionTerminalInvoiceLookup: jest.fn(async () => null),
}));
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  ...jest.requireActual('../services/setup-fee-alert-reconcile'),
  reconcileSetupFeeAlert: jest.fn(async () => undefined),
  reconcileSetupFeeAlertForInvoice: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  annualPrepayCoversVisit: jest.fn(async () => false),
}));
jest.mock('../services/estimate-deposits', () => ({
  ...jest.requireActual('../services/estimate-deposits'),
  pendingDepositCredit: jest.fn(async (estimateId) => (estimateId === 'est-with-deposit' ? { amount: 50 } : null)),
}));
jest.mock('../services/payer', () => ({
  ...jest.requireActual('../services/payer'),
  resolveForInvoice: jest.fn(async ({ scheduledServiceId }) => (scheduledServiceId === '55555555-5555-4555-8555-555555555555' ? { payerId: 'payer-1' } : { payerId: null })),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u), invoiceShortCodePrefix: jest.fn(() => 'INV') }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.example.test') }));
// The completion-side-effects fence (GitHub P1 #4131 r3): defaults to "no
// attempt in flight" so schedule-send tests that don't care about it are
// unaffected; individual tests override the state to exercise the fence.
jest.mock('../services/completion-attempts', () => ({
  completionStatusForService: jest.fn(async () => ({ state: 'none' })),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { completionStatusForService } = require('../services/completion-attempts');
const router = require('../routes/admin-invoices');

const VISIT = '33333333-3333-4333-8333-333333333333';

function qb(overrides = {}) {
  const q = {};
  for (const m of ['where', 'whereRaw', 'whereIn', 'leftJoin', 'select', 'orderBy', 'offset', 'limit', 'whereNull', 'whereNot', 'whereNotExists', 'modify']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => null);
  q.then = undefined;
  Object.assign(q, overrides);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

describe('POST /admin/invoices/:id/schedule-send on a linked visit (GitHub P1 #4131 r2/r3)', () => {
  const INVOICE = '44444444-4444-4444-8444-444444444444';
  const scheduleSend = (baseUrl) => fetch(`${baseUrl}/admin/invoices/${INVOICE}/schedule-send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledFor: '2040-03-04T08:00' }),
  });
  let visitStatus;
  let update;
  beforeEach(() => {
    jest.clearAllMocks();
    completionStatusForService.mockResolvedValue({ state: 'none' });
    update = jest.fn(() => ({ returning: jest.fn(async () => [{ id: INVOICE, status: 'scheduled' }]) }));
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => ({ payer_statement_id: null, scheduled_service_id: VISIT })), update });
      if (table === 'scheduled_services') return qb({ first: jest.fn(async () => ({ id: VISIT, status: visitStatus })) });
      throw new Error(`unexpected table ${table}`);
    });
  });

  test.each([['confirmed'], ['rescheduled'], [null]])('refuses a future send while the linked visit is still open (status %s) — the completion would send it first', async (status) => {
    visitStatus = status;
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'LINKED_VISIT_OPEN', error: expect.stringContaining('open visit') });
      expect(update).not.toHaveBeenCalled();
      expect(completionStatusForService).not.toHaveBeenCalled();
    });
  });

  test('schedules normally once the linked visit is completed and its completion side effects have finished', async () => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state: 'succeeded_other_key' });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    });
  });

  // GitHub P1 #4131 r3 — a committed `completed` status alone does not prove
  // completion delivery finished: the closeout flips the attempt row to
  // side_effects_running/succeeded only as it runs. Fence on that signal.
  test.each([['running'], ['resumable']])('refuses while the completion side effects are still %s — nothing scheduled', async (state) => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'COMPLETION_IN_PROGRESS' });
      expect(update).not.toHaveBeenCalled();
    });
  });

  test('a legacy completion with no attempt row (state "none"/"completed_no_attempt") schedules normally', async () => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state: 'completed_no_attempt', serviceRecordId: 'sr-1' });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(200);
    });
  });
});

describe('POST /admin/invoices/:id/send on a pre-completion linked invoice (Codex P1 #4131 r4)', () => {
  const INVOICE = '44444444-4444-4444-8444-444444444444';
  const send = (baseUrl, body) => fetch(`${baseUrl}/admin/invoices/${INVOICE}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let linkage;
  let sendSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    sendSpy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: false, skipped: true }, payUrl: 'https://pay.example.test/x' });
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => linkage) });
      throw new Error(`unexpected table ${table}`);
    });
  });
  afterEach(() => sendSpy.mockRestore());

  test('drops the review ask when the invoice is linked to an open visit with no service record yet', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: false }));
    });
  });

  test('the create flow\'s immediate send is a FIRST delivery: the claim\'s already_delivered refusal is a no-op success, the operator\'s own send never passes the flag (GitHub r6 P1)', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    sendSpy.mockRejectedValueOnce(Object.assign(new Error('Invoice WPC-1 was already delivered (status: sent) — not sent again'), { code: 'already_delivered' }));
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { firstDelivery: true, requestReview: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, already_delivered: true, sms: { ok: false, code: 'already_delivered' } });
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ firstDeliveryOnly: true }));
    });
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: false });
      expect(sendSpy).toHaveBeenLastCalledWith(INVOICE, expect.objectContaining({ firstDeliveryOnly: false }));
    });
  });

  test('a FIRST delivery finding the completion\'s QUEUED text (queued_pay_link) is the same no-op success; the operator\'s own send still surfaces it (Codex P2 r8)', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    const queued = () => Object.assign(new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window; it delivers then'), { code: 'queued_pay_link' });
    sendSpy.mockRejectedValueOnce(queued());
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { firstDelivery: true, requestReview: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, queued_delivery: true, sms: { ok: false, code: 'queued_pay_link' }, email: { ok: false, code: 'queued_pay_link' } });
    });
    sendSpy.mockRejectedValueOnce(queued());
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: false });
      expect(res.status).toBe(409); // not a first delivery: the refusal surfaces to the operator as before
      expect(await res.json()).not.toMatchObject({ queued_delivery: true });
    });
  });

  test('a linkage lookup that FAILS fails closed on the review ask: refused (409 linkage_unverifiable) with an ask, proceeds without one (Codex P1 r8)', async () => {
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => { throw new Error('connection reset'); }) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'linkage_unverifiable' });
      expect(sendSpy).not.toHaveBeenCalled();
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: false });
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: false }));
    });
  });

  test('keeps the operator\'s review ask for a standalone or completion-linked invoice', async () => {
    linkage = { scheduled_service_id: null, service_record_id: null };
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: true }));
    });
    linkage = { scheduled_service_id: VISIT, service_record_id: 'sr-1' };
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(sendSpy).toHaveBeenLastCalledWith(INVOICE, expect.objectContaining({ requestReview: true }));
    });
  });
});
