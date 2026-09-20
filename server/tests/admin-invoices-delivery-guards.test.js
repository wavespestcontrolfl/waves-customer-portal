/**
 * POST /admin/invoices/:id/send — the first-delivery / explicit-resend
 * request contract (slice 3, #4131), plus the two batch first-delivery send
 * paths (POST /batch's sendImmediately, POST /batch/send).
 *
 * Third audit P1: the review-hold override was INFERRED from
 * operatorInitiated + stamp/status-derived firstDeliveryOnly instead of a
 * caller stating it outright — a batch/automated caller carrying
 * operatorInitiated:true (unconditional on every admin route) could clear a
 * parked row it never asked to override. Fix: a new explicit claim option,
 * `overridesReviewHold` (default false). The hold gate is now
 * `isStaleClaimReviewHold(current) && !overridesReviewHold` — independent
 * of operatorInitiated (which keeps ONLY its original, unrelated meaning:
 * the quiet-hours send-window bypass) and of firstDeliveryOnly.
 *
 * Route contract for POST /:id/send: `{ firstDelivery: true }` ⇒
 * firstDeliveryOnly true, overridesReviewHold false (never the way off the
 * hold); `{ resend: true }` ⇒ firstDeliveryOnly false, overridesReviewHold
 * true (a deliberate operator Resend — the ONE way off); neither (legacy
 * callers) ⇒ both false (an ordinary send, hold still not overridable).
 * operatorInitiated: true on every admin route call, unconditionally, same
 * as main. The batch routes NEVER set overridesReviewHold — a parked row is
 * refused there regardless of stamps, reported held (code
 * stale_claim_review_hold), not sent and not a batch failure.
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
// and !overridesReviewHold — independent of operatorInitiated and of
// firstDeliveryOnly (third audit P1 #4131).
function staleClaimReviewHoldError() {
  const e = new Error('Invoice is not sendable — parked under a stale-claim review hold (delivery unverified); an operator must review and resend');
  e.code = 'stale_claim_review_hold';
  return e;
}

describe('POST /admin/invoices/:id/send — mutual exclusivity of intent (fourth audit gap #4131)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('{ firstDelivery: true, resend: true } is refused with 400 before ever calling the service', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true, resend: true });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('conflicting_send_intent');
      expect(body.error).toMatch(/cannot be both a first delivery and a deliberate Resend/i);
      expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    });
  });
});

describe('POST /admin/invoices/:id/send — request-contract flags (third audit P1 #4131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } });
  });

  test('{ firstDelivery: true } passes firstDeliveryOnly: true, overridesReviewHold: false', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(200);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(true);
      expect(opts.overridesReviewHold).toBe(false);
      // operatorInitiated keeps its own, unrelated meaning (the
      // quiet-hours bypass) and is unconditionally true on this route.
      expect(opts.operatorInitiated).toBe(true);
    });
  });

  test('{ resend: true } passes firstDeliveryOnly: false, overridesReviewHold: true', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { resend: true });
      expect(res.status).toBe(200);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(false);
      expect(opts.overridesReviewHold).toBe(true);
      expect(opts.operatorInitiated).toBe(true);
    });
  });

  test('neither flag (legacy caller) passes both false — an ordinary send, hold still not overridable', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      expect(res.status).toBe(200);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(false);
      expect(opts.overridesReviewHold).toBe(false);
      expect(opts.operatorInitiated).toBe(true);
    });
  });
});

describe('POST /admin/invoices/:id/send — first delivery vs. explicit Resend against a parked row (third audit P1 #4131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Models exactly one precondition: this invoice is currently parked
    // under a stale-claim review hold. Only overridesReviewHold — the ONE
    // explicit switch — may clear it; operatorInitiated (unconditionally
    // true on this route) must have no effect on the outcome.
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (_id, opts) => {
      if (!opts.overridesReviewHold) throw staleClaimReviewHoldError();
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
  });

  test('a first-delivery request (firstDelivery: true) does NOT bypass the hold', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/stale-claim review hold/i);
    });
  });

  test('a LEGACY send (neither flag) does NOT bypass the hold either', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/stale-claim review hold/i);
    });
  });

  test('an explicit Resend ({ resend: true }) clears the hold — the ONE way off it', async () => {
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { resend: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
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

  // #4131 slice 4, pre-push audit P1: this used to fall through to the
  // route's generic failure/conflict handling, reporting a SUCCESSFUL
  // zero-balance settlement (the invoice is now prepaid) as a failed send.
  // Unlike already_delivered/queued_pay_link, zero_due is never gated on
  // firstDeliveryOnly — an explicit Resend can hit this exact race too, and
  // it is never a conflict either way.
  test.each([
    ['a first delivery', { firstDelivery: true }],
    ['an explicit Resend', { resend: true }],
  ])('%s that settles a zero-due invoice is reported a 200 success, not a failure', async (_case, body) => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => {
      const e = new Error('Cannot send a prepaid invoice');
      e.code = 'zero_due';
      throw e;
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, body);
      expect(res.status).toBe(200);
      const responseBody = await res.json();
      expect(responseBody).toMatchObject({ ok: true, settled_zero_due: true });
    });
  });

  // Pre-push audit P1: zeroDueOpenVisitSendOutcome's pre-claim settle is
  // the COMMON zero-due path (checked before any claim is ever taken) —
  // its success is a RESOLVED result, not a thrown error, so it must carry
  // the SAME settled_zero_due field the throw-shaped under-claim path
  // (tested above) reports, not a stale field name only that rarer path
  // used to use.
  test('the pre-claim settle (the common zero-due path, no claim ever taken) also reports settled_zero_due: true', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: true, settled_zero_due: true,
      sms: { ok: false, code: 'settled_zero_due' }, email: { ok: false, code: 'settled_zero_due' }, payUrl: null,
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, settled_zero_due: true });
    });
  });

  // Pre-push audit P1: the claim-path race re-check (throwForZero
  // DueVisitInvoice / reverifyClaimedVisitInvoice) throws this exact code
  // for the SAME underlying condition zeroDueOpenVisitSendOutcome's
  // RESOLVED pre-claim path already reports as a friendly 409 above — the
  // thrown path used to fall through to the generic failure handling
  // (a bare 500), leaving the operator with two different responses for
  // one condition depending on which check happened to catch it.
  test('the thrown deposit_settlement_pending race path converges on the SAME 409 shape as the resolved pre-claim path', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => {
      const e = new Error('Nothing is due on this invoice, but it could not be settled yet (existing_payment_work) — not sent.');
      e.code = 'deposit_settlement_pending';
      throw e;
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, {});
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, code: 'deposit_settlement_pending' });
      expect(body.error).toMatch(/could not be settled yet/);
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

  // Pre-push audit P1 (PR #4633): a concurrent first-delivery claim already
  // won this exact race — the customer's pay link IS on its way, from the
  // OTHER request. A no-op success, never "Failed to send invoice".
  test('a first delivery that finds a concurrent claim already delivering is a no-op success, not a failure', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (_id, opts) => {
      if (opts.firstDeliveryOnly) {
        const e = new Error('Invoice is already being delivered by another request — not sent again');
        e.code = 'delivery_in_progress';
        throw e;
      }
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { firstDelivery: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, in_progress: true });
    });
  });

  // The SAME code on an explicit Resend is a real conflict — the operator
  // asked to clear a hold or re-send, and a live concurrent claim means
  // that request cannot proceed right now; it must NOT read as a no-op
  // success (resendConflictMessage's "blocked" wording, not the benign
  // first-delivery phrasing).
  test('an explicit Resend that finds a concurrent claim in progress is a real conflict, not a no-op success', async () => {
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async () => {
      const e = new Error('Invoice is already being delivered by another request — not sent again');
      e.code = 'delivery_in_progress';
      throw e;
    });
    await withServer(async (baseUrl) => {
      const res = await postSend(baseUrl, { resend: true });
      // Retryable — the concurrent claim may finish any moment.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('delivery_in_progress');
      expect(body.ok).toBeUndefined();
      expect(body.in_progress).toBeUndefined();
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

describe('POST /admin/invoices/batch — sendImmediately\'s keyed retry is UNCONDITIONALLY a first delivery (round-1 Codex P1, PR #4633)', () => {
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

  // Round-1 Codex P1 (PR #4633): a keyed retry of create-and-send is a
  // first delivery BY DEFINITION — this row has never been delivered
  // under any OTHER request. Deriving the flag from the row's own stamps
  // used to read a provider-accept-then-crashed row (sms_sent_at set,
  // still draft) as an ordinary resend and re-text the pay link a second
  // time; it is now unconditionally true regardless of stamps, and the
  // already-delivered guard (order-fixed ahead of the review hold) is what
  // catches a genuinely-delivered retry as a no-op instead.
  test('a keyed-retry row already carrying a delivery stamp is STILL passed as firstDeliveryOnly: true', async () => {
    mockExisting({
      id: 'inv-2', invoice_number: 'WPC-2', status: 'draft', payer_id: null,
      updated_at: new Date(), batch_fingerprint: null,
      sent_at: null, sms_sent_at: null, email_sent_at: new Date(),
    });
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true });
    await withServer(async (baseUrl) => {
      await postBatch(baseUrl, 'retry-key-delivered');
      const [, opts] = InvoiceService.sendViaSMS.mock.calls[0];
      expect(opts.firstDeliveryOnly).toBe(true);
    });
  });
});

describe('POST /admin/invoices/batch/send — derives firstDeliveryOnly per invoice from its own row (round-6 P1 #4131)', () => {
  const FIRST_DELIVERY_ID = 'dddddddd-1111-4111-8111-111111111111';
  const RESEND_ID = 'eeeeeeee-1111-4111-8111-111111111111';
  const PARKED_ID = 'ffffffff-1111-4111-8111-111111111111';

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
          if (this._id === PARKED_ID) {
            // The audit's exact scenario: a parked row that ALSO carries a
            // delivery stamp — isFirstDeliveryRow correctly derives false
            // (it's not a first delivery), but the row is still parked
            // under a stale-claim review hold, and this route never sets
            // overridesReviewHold. It must be held, never sent.
            return { status: 'scheduled', sent_at: null, sms_sent_at: new Date(), email_sent_at: null };
          }
          return { status: 'sent', sent_at: new Date(), sms_sent_at: new Date(), email_sent_at: null };
        }),
      };
    });
    InvoiceService.sendViaSMSAndEmail.mockImplementation(async (invoiceId) => {
      if (invoiceId === PARKED_ID) {
        const e = new Error('Invoice is not sendable — parked under a stale-claim review hold (delivery unverified); an operator must review and resend');
        e.code = 'stale_claim_review_hold';
        throw e;
      }
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    });
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
      // Neither invoice's claim is authorized to override the review hold —
      // this route never sets it (falsy by omission, same as the default).
      expect(firstDeliveryCall[1].overridesReviewHold).not.toBe(true);
      expect(resendCall[1].overridesReviewHold).not.toBe(true);
    });
  });

  // The audit's exact scenario: a parked row that ALSO carries sms_sent_at
  // used to slip through as an ordinary resend (operatorInitiated:true
  // alone used to clear the hold). It must now be reported held, not sent.
  test('a parked row that also carries sms_sent_at is reported held with stale_claim_review_hold — not sent', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/batch/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds: [PARKED_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sent_count).toBe(0);
      expect(body.failed_count).toBe(0);
      expect(body.held_count).toBe(1);
      expect(body.sent).toEqual([]);
      expect(body.failed).toEqual([]);
      expect(body.held).toMatchObject([{ invoiceId: PARKED_ID, code: 'stale_claim_review_hold' }]);
      const [, opts] = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
      // Derived correctly from the row's own stamps (not a first delivery)
      // — the hold refusal is independent of that value entirely.
      expect(opts.firstDeliveryOnly).toBe(false);
    });
  });
});
