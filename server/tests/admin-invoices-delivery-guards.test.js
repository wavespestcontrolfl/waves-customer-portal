/**
 * POST /admin/invoices/:id/send — the first-delivery / explicit-resend
 * request contract (slice 3, #4131), plus the two batch first-delivery send
 * paths (POST /batch's sendImmediately, POST /batch/send).
 *
 * Round-6 P1: the route hardcoded `operatorInitiated: true` for EVERY
 * /:id/send call, including a first delivery, and claimInvoiceForSend's
 * stale-claim review hold was gated on operatorInitiated alone — so a first
 * delivery could silently reclaim (and potentially duplicate) an
 * unknown-outcome parked send. The fix keeps operatorInitiated's ordinary
 * meaning (an authenticated admin action — every admin route call IS one,
 * so it stays unconditionally true everywhere, exactly like main) and moves
 * the hold's gate onto BOTH flags: claimInvoiceForSend refuses the hold
 * whenever `firstDeliveryOnly || !operatorInitiated` — so only a
 * DELIBERATE Resend (operatorInitiated AND not a first delivery) may
 * reclaim a parked row. Contract: `{ firstDelivery: true }` ⇒
 * `firstDeliveryOnly: true, operatorInitiated: true` (hold NOT
 * overridable, quiet-hours bypass KEPT); omitted ⇒ explicit Resend,
 * `firstDeliveryOnly: false, operatorInitiated: true` (hold overridable).
 *
 * These tests mock InvoiceService to model exactly one precondition — the
 * invoice is currently parked under a stale-claim review hold — and assert
 * on what each ROUTE does with the request shapes. This is deliberately
 * narrower than the open-visit-picker/pre-completion suite this file's name
 * once covered in the source lane: that flow (linked visits, the
 * completion fence, the review-ask drop) is excluded from this slice (a
 * later lane) and is not ported here.
 */
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
jest.mock('../services/invoice', () => ({
  sendViaSMSAndEmail: jest.fn(),
  sendViaSMS: jest.fn(),
  create: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const router = require('../routes/admin-invoices');

const INVOICE = '44444444-4444-4444-8444-444444444444';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const postSend = (baseUrl, body) => fetch(`${baseUrl}/admin/invoices/${INVOICE}/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

// The stale-claim review hold's exact refusal — same code/shape
// claimInvoiceForSend throws when isStaleClaimReviewHold(current) is true
// and (firstDeliveryOnly || !operatorInitiated).
function staleClaimReviewHoldError() {
  const e = new Error('Invoice is not sendable — parked under a stale-claim review hold (delivery unverified); an operator must review and resend');
  e.code = 'stale_claim_review_hold';
  return e;
}

describe('POST /admin/invoices/:id/send — first delivery vs. explicit Resend (round-6 P1 #4131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Models exactly one precondition: this invoice is currently parked
    // under a stale-claim review hold. Only a caller that is BOTH
    // operatorInitiated AND not a first delivery (a deliberate Resend) may
    // claim it — mirrors claimInvoiceForSend's own gate exactly.
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (_id, opts) => {
      if (opts.firstDeliveryOnly || !opts.operatorInitiated) throw staleClaimReviewHoldError();
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
  });

  test('a first-delivery request (firstDelivery: true) does NOT bypass the hold — refused even though operatorInitiated is true', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/stale-claim review hold/i);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(true);
      // operatorInitiated keeps its ordinary meaning (an authenticated
      // admin action) and is unconditionally true on this route — the
      // hold's refusal comes from firstDeliveryOnly alone.
      expect(opts.operatorInitiated).toBe(true);
    });
  });

  test('an explicit Resend (no firstDelivery flag) clears the hold — the intended way off it', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(false);
      expect(opts.operatorInitiated).toBe(true);
    });
  });

  // The round-6 fix must NOT reintroduce the quiet-hours side effect: a
  // first delivery on a row that is NOT parked still carries
  // operatorInitiated:true all the way to the messaging layer, same as
  // main today (checkSendWindow bypasses the window whenever
  // operatorInitiated===true — see tests/messaging-send-window.test.js
  // "explicit operatorInitiated marker passes shared entry points at
  // night", unchanged by this slice).
  test('a first delivery that is NOT parked still carries operatorInitiated: true (quiet-hours bypass preserved)', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => ({ ok: true, sms: { ok: true }, email: { ok: true } }));
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(200);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(true);
      expect(opts.operatorInitiated).toBe(true);
    });
  });

  test('a first delivery that finds the row already delivered is a no-op success, not a conflict', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (_id, opts) => {
      if (opts.firstDeliveryOnly) {
        const e = new Error('Invoice was already delivered (status: sent) — not sent again');
        e.code = 'already_delivered';
        throw e;
      }
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, already_delivered: true });
    });
  });

  test('a first delivery that finds a queued pay-link text owning delivery is a no-op success', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (_id, opts) => {
      if (opts.firstDeliveryOnly) {
        const e = new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window');
        e.code = 'queued_pay_link';
        throw e;
      }
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, queued_delivery: true });
    });
  });

  test('an explicit Resend that finds a queued pay-link text is a real conflict, not a no-op success', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => {
      const e = new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window');
      e.code = 'queued_pay_link';
      throw e;
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      // "already in progress" is the one message the route's fallback
      // regex maps to 409 (retryable conflict) rather than 400.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already in progress/i);
      expect(body.already_delivered).toBeUndefined();
      expect(body.queued_delivery).toBeUndefined();
    });
  });
});

// ── Batch first-delivery routes ─────────────────────────────────────────
// A minimal knex query-builder double: dispatches by table name and serves
// canned rows/updates for exactly the calls these two routes make.
function qb(overrides = {}) {
  const q = {};
  for (const m of ['where', 'insert', 'onConflict', 'ignore', 'select', 'first']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => overrides.first ?? null);
  q.then = (resolve) => Promise.resolve(overrides.thenValue ?? 1).then(resolve);
  return q;
}

describe('POST /admin/invoices/batch — sendImmediately derives firstDeliveryOnly from the keyed-retry row (round-6 P1 #4131)', () => {
  const CUSTOMER = 'cccccccc-1111-4111-8111-111111111111';

  beforeEach(() => jest.clearAllMocks());

  function mockExisting(existingRow) {
    db.mockImplementation((table) => {
      if (table === 'invoice_batch_keys') return qb({ first: undefined }); // no registered fingerprint yet
      if (table === 'invoices') return qb({ first: existingRow });
      return qb();
    });
  }

  const postBatch = (baseUrl, batchKey) => fetch(`${baseUrl}/admin/invoices/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerIds: [CUSTOMER], title: 't', lineItems: [{ description: 'x', amount: 10 }],
      sendImmediately: true, batchKey,
    }),
  });

  test('a keyed-retry row that was never delivered is passed as firstDeliveryOnly: true', async () => {
    mockExisting({
      id: 'inv-1', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
      updated_at: new Date(), batch_fingerprint: null,
      sent_at: null, sms_sent_at: null, email_sent_at: null,
    });
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true });
    await withServer(async (baseUrl) => {
      await postBatch(baseUrl, 'retry-key-undelivered');
      const [, opts] = InvoiceService.sendViaSMS.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(true);
    });
  });

  test('a keyed-retry row already carrying a delivery stamp is passed as firstDeliveryOnly: false', async () => {
    mockExisting({
      id: 'inv-2', invoice_number: 'WPC-2', status: 'draft', payer_id: null,
      updated_at: new Date(), batch_fingerprint: null,
      sent_at: null, sms_sent_at: null, email_sent_at: new Date(),
    });
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true });
    await withServer(async (baseUrl) => {
      await postBatch(baseUrl, 'retry-key-delivered');
      const [, opts] = InvoiceService.sendViaSMS.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(false);
    });
  });
});

describe('POST /admin/invoices/batch/send — derives firstDeliveryOnly per invoice from its own row (round-6 P1 #4131)', () => {
  const FIRST_DELIVERY_ID = 'dddddddd-1111-4111-8111-111111111111';
  const RESEND_ID = 'eeeeeeee-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table !== 'invoices') return qb();
      return {
        where: jest.fn(function (crit) { this._id = crit.id; return this; }),
        first: jest.fn(async function () {
          if (this._id === FIRST_DELIVERY_ID) {
            return { status: 'draft', sent_at: null, sms_sent_at: null, email_sent_at: null };
          }
          return { status: 'sent', sent_at: new Date(), sms_sent_at: new Date(), email_sent_at: null };
        }),
      };
    });
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } });
  });

  test('a never-delivered invoice in the batch is sent with firstDeliveryOnly: true; an already-sent one with false', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/batch/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds: [FIRST_DELIVERY_ID, RESEND_ID] }),
      });
      expect(res.status).toBe(200);
      const calls = InvoiceService.sendViaSMSAndEmail.mock.calls;
      const firstDeliveryCall = calls.find((c) => c[0] === FIRST_DELIVERY_ID);
      const resendCall = calls.find((c) => c[0] === RESEND_ID);
      expect(firstDeliveryCall[1].firstDeliveryOnly).toBe(true);
      expect(resendCall[1].firstDeliveryOnly).toBe(false);
      // operatorInitiated is unconditionally true on this admin route
      // regardless of which invoice it is — unchanged from main.
      expect(firstDeliveryCall[1].operatorInitiated).toBe(true);
      expect(resendCall[1].operatorInitiated).toBe(true);
    });
  });
});
