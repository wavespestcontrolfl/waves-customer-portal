process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = 'technician';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => ({
  create: jest.fn(),
  sendViaSMS: jest.fn(),
  sendViaSMSAndEmail: jest.fn(),
  voidInvoice: jest.fn(),
  unvoidInvoice: jest.fn(),
}));
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  acceptedEstimateIdFromNotes: jest.requireActual('../services/setup-fee-alert-reconcile').acceptedEstimateIdFromNotes,
  reconcileSetupFeeAlert: jest.fn(async () => {}),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'i'),
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: jest.fn(() => 'https://portal.test'),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const SetupFeeAlerts = require('../services/setup-fee-alert-reconcile');
const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
const router = require('../routes/admin-invoices');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, path, body) => fetch(`${baseUrl}/admin/invoices${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

describe('POST / accepted-estimate billing lock', () => {
  const estimateId = 'e1000000-0000-0000-0000-000000000001';
  let mockTrxRaw;
  const createBody = (notes) => ({ customerId: 'cust-1', title: 'Setup fee',
    lineItems: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }], notes });

  beforeEach(() => {
    jest.clearAllMocks();
    InvoiceService.create.mockResolvedValue({ id: 'inv-1', customer_id: 'cust-1', token: 'token-1' });
    mockTrxRaw = jest.fn(async () => ({}));
    db.transaction = jest.fn(async (work) => work({ raw: mockTrxRaw }));
  });

  test('mixed-case stamp takes the normalized estimate lock and reconciles after creation', async () => {
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/', createBody(`ACCEPTED ESTIMATE #${estimateId.toUpperCase()}.`));
      expect(response.status).toBe(201);
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockTrxRaw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))',
      [`unminted_setup_fee_manual_billing:${estimateId}`]);
    expect(SetupFeeAlerts.reconcileSetupFeeAlert).toHaveBeenCalledWith(expect.objectContaining({ sourceEstimateId: estimateId }));
  });

  test('malformed freeform stamp does not take an estimate lock', async () => {
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/', createBody('accepted estimate #freeform.'));
      expect(response.status).toBe(201);
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(SetupFeeAlerts.reconcileSetupFeeAlert).not.toHaveBeenCalled();
  });
});

test('packet ownership refusal is an operator-visible 409 with a code', async () => {
  InvoiceService.create.mockRejectedValueOnce(Object.assign(new Error('Resume that closeout.'), {
    status: 409, statusCode: 409, isOperational: true, code: 'VISIT_PACKET_OWNS_BILLING',
  }));
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, '/', { customerId: 'cust-1', title: 'Setup fee',
      lineItems: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }],
      notes: 'Ordinary manual invoice' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Resume that closeout.', code: 'VISIT_PACKET_OWNS_BILLING' });
  });
});

// Chainable stub for the batch-dedupe lookup:
// db('invoices').where(...).whereNotIn(...).whereNull(...).where(...).first(...)
function makeDupChain(result, { updateResult = 1 } = {}) {
  const chain = {};
  for (const m of ['where', 'whereNotIn', 'whereNull']) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(async () => result);
  chain.update = jest.fn(async () => updateResult);
  return chain;
}

// The atomic batch-key registry (invoice_batch_keys): insert-or-ignore then
// read-back. `existing` scripts the fingerprint an EARLIER batch bound to
// the key (null = key unclaimed / claimed by this request).
function makeRegistryChain(existing = null) {
  const chain = {};
  chain.insert = jest.fn(() => ({ onConflict: () => ({ ignore: async () => {} }) }));
  chain.where = jest.fn(() => chain);
  chain.first = jest.fn(async () => existing);
  return chain;
}

describe('POST /:id/send error surface', () => {
  beforeEach(() => jest.clearAllMocks());

  test('both channels failing returns 400 with a TOP-LEVEL error (adminFetch toasts body.error; without it the operator sees a bare "HTTP 400")', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false,
      sms: { ok: false, error: 'No phone on file' },
      email: { ok: false, error: 'No email on file' },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/send');
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('No phone on file');
      // Per-channel detail must survive for callers that read it.
      expect(body.sms).toEqual({ ok: false, error: 'No phone on file' });
      expect(body.email).toEqual({ ok: false, error: 'No email on file' });
    });
  });

  test('falls back to the email error, then a generic message, when sms carries none', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false,
      sms: { ok: false },
      email: { ok: false, error: 'Mailbox rejected the message' },
    });
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/send');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'Mailbox rejected the message' });
    });

    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: false, sms: { ok: false }, email: { ok: false } });
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/send');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'Invoice send failed on both channels' });
    });
  });

  test('a single-channel success stays 200 with per-channel results (partial sends are reported, not errored)', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: true,
      sms: { ok: true },
      email: { ok: false, error: 'No email on file' },
    });
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/send');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sms.ok).toBe(true);
      expect(body.email.ok).toBe(false);
    });
  });

  test('an in-progress send throw still maps to 409', async () => {
    InvoiceService.sendViaSMSAndEmail.mockRejectedValue(new Error('Invoice send already in progress'));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/send');
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: 'Invoice send already in progress' });
    });
  });
});

// Every business refusal InvoiceService.voidInvoice throws must surface as an
// operator-actionable 409 toast, never fall through to the generic 500 handler
// (an unhandled 500 gave the admin no toast and left the row unrefreshed).
// Pinned VERBATIM to the service's messages, mirroring the PUT mapper suite.
describe('POST /:id/void refusal mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['paid invoice', 'Cannot void a paid invoice — issue a refund instead'],
    ['payment in flight (status)', 'Cannot void an invoice with a payment in flight — wait for it to settle, then refund if needed'],
    ['finalized payer statement', 'This invoice is on a finalized payer statement — adjust it with a credit on the next statement, not by voiding a billed line'],
    ['payment already applied', 'Cannot void an invoice with payment already applied (payment recorded) — issue a refund instead'],
    ['unverifiable payment session', 'Open payment session pi_abc could not be verified (boom); resolve it before voiding'],
    ['PI money in flight', 'A payment is already in flight (requires_capture); wait for it to settle or refund it before voiding'],
    ['PI cancel failed', "Couldn't cancel the open payment session pi_abc (boom); resolve it before voiding"],
    ['live send claim', 'Cannot void this invoice — a send is already in progress; wait a moment and retry'],
    ['status changed mid-void', 'Invoice status changed while voiding — re-check and retry'],
    ['new payment session mid-void', 'A new payment session started for this invoice — re-check and retry the void'],
    ['payment applied mid-void', 'A payment was applied to this invoice while voiding — issue a refund instead'],
  ])('surfaces the %s refusal as a 409 conflict', async (_label, message) => {
    InvoiceService.voidInvoice.mockRejectedValue(new Error(message));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/void');
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: message });
    });
  });

  test('a missing invoice maps to 404', async () => {
    InvoiceService.voidInvoice.mockRejectedValue(new Error('Invoice not found'));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/void');
      expect(response.status).toBe(404);
    });
  });

  test('a non-refusal failure still surfaces as a server error (mapper is not over-broad)', async () => {
    InvoiceService.voidInvoice.mockRejectedValue(new Error('connection refused'));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/void');
      expect(response.status).toBe(500);
    });
  });
});

// Same contract for the undo: every business refusal InvoiceService.unvoidInvoice
// throws must surface as an operator-actionable 409 toast, pinned VERBATIM.
describe('POST /:id/unvoid refusal mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['not void', 'Only a voided invoice can be unvoided (current status: sent)'],
    ['annual prepay term', 'Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead'],
    ['unverifiable term link', 'Could not verify the annual prepay term link — refusing to unvoid (boom)'],
    ['prepay-switch superseded', 'Cannot unvoid — this invoice was superseded by an annual prepay switch; reversing that prepay (Annual prepay) restores it with the coverage checks applied'],
    ['cancelled linked service', 'Cannot unvoid — the linked service visit is cancelled; restore or re-book the visit before restoring its invoice'],
    ['skipped linked service', 'Cannot unvoid — the linked service visit is skipped; restore or re-book the visit before restoring its invoice'],
    ['annual prepay coverage settlement', 'Cannot unvoid — this invoice was settled as annual prepay coverage before it was voided; manage it from Annual prepay instead'],
    ['annual-stamped linked visit', 'Cannot unvoid — this visit is stamped prepaid by an annual prepay term, so its base work is already paid; bill any extras on a new invoice instead'],
    ['free re-service conversion', 'Cannot unvoid — this visit was converted to a free re-service and its invoice was retired with it; re-price the visit before restoring a charge'],
    ['orphaned annual prepay charge', 'Cannot unvoid — this is an annual prepay charge; rebuild it through Annual prepay so coverage activates with the payment'],
    ['unverifiable linked service', 'Could not verify the linked service visit — refusing to unvoid (boom)'],
    ['deferred send mid-dispatch', 'Cannot unvoid — a deferred message for this invoice is dispatching right now; retry in a minute'],
    ['delivered send still finalizing', 'Cannot unvoid — a delivered message for this invoice is still finalizing; retry in a few minutes'],
    ['saved-card charge pending', 'Invoice already has a saved-card charge in progress or awaiting reconciliation'],
    ['ambiguous charge attempt', 'Invoice has an unresolved charge attempt with an ambiguous Stripe outcome'],
    ['orphan Stripe charge', 'Invoice has an unresolved Stripe charge pi_abc'],
    ['deposit credit returned', "Cannot unvoid — the deposit credit on this invoice was returned to the customer's deposit when it was voided; create a replacement invoice so the credit re-applies cleanly"],
    ['finalized payer statement', 'This invoice is on a finalized payer statement — bill it as a new line on the next statement instead of restoring a voided one'],
    ['unverifiable payment session', 'Open payment session pi_abc could not be verified (boom); resolve it before unvoiding'],
    ['live payment session', 'This invoice still has a live payment session (requires_capture); resolve it before unvoiding'],
    ['payment landed after void', 'Cannot unvoid an invoice with payment already applied (payment pay-9)'],
    ['status changed mid-unvoid', 'Invoice status changed while unvoiding — re-check and retry'],
  ])('surfaces the %s refusal as a 409 conflict', async (_label, message) => {
    InvoiceService.unvoidInvoice.mockRejectedValue(new Error(message));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/unvoid');
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: message });
    });
  });

  test('a missing invoice maps to 404', async () => {
    InvoiceService.unvoidInvoice.mockRejectedValue(new Error('Invoice not found'));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/unvoid');
      expect(response.status).toBe(404);
    });
  });

  test('a successful restore returns the draft invoice', async () => {
    InvoiceService.unvoidInvoice.mockResolvedValue({ id: 'inv-1', status: 'draft' });
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/unvoid');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ id: 'inv-1', status: 'draft' });
    });
  });

  test('a non-refusal failure still surfaces as a server error (mapper is not over-broad)', async () => {
    InvoiceService.unvoidInvoice.mockRejectedValue(new Error('connection refused'));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/inv-1/unvoid');
      expect(response.status).toBe(500);
    });
  });
});

describe('POST /batch idempotency (batchKey)', () => {
  beforeEach(() => jest.clearAllMocks());

  const lineItems = [{ description: 'Service', unit_price: 100, quantity: 1, amount: 100 }];

  test('a keyed retry skips customers that already have a live same-title invoice from the last 24h (no duplicate row, no duplicate text)', async () => {
    // cust-1 already has the invoice (created by the first, partially-failed
    // request); cust-2 does not.
    const dupResults = [
      { id: 'inv-existing', invoice_number: 'WPC-1', status: 'sent', payer_id: null },
      undefined,
    ];
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain(dupResults.shift()));
    InvoiceService.create.mockResolvedValue({
      id: 'inv-new', invoice_number: 'WPC-2', total: 100, token: 'tok-2', payer_id: null,
    });
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true, ok: true });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1', 'cust-2'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000001',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.created_count).toBe(1);
      expect(body.skipped_count).toBe(1);
      expect(body.failed_count).toBe(0);
      expect(body.skipped[0]).toMatchObject({
        customerId: 'cust-1',
        invoiceId: 'inv-existing',
        invoiceNumber: 'WPC-1',
      });
      // The skipped customer must not be re-created OR re-texted.
      expect(InvoiceService.create).toHaveBeenCalledTimes(1);
      expect(InvoiceService.create.mock.calls[0][0]).toMatchObject({
        customerId: 'cust-2',
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000001',
      });
      expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
      expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-new', { firstDeliveryOnly: true, operatorInitiated: true, actorTechnicianId: 'tech-1' });
    });
  });

  test('an unkeyed request keeps the old behavior — no dedupe lookup, every customer billed', async () => {
    InvoiceService.create.mockResolvedValue({
      id: 'inv-new', invoice_number: 'WPC-2', total: 100, token: 'tok-2', payer_id: null,
    });
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1', 'cust-2'],
        title: 'Quarterly Pest Control',
        lineItems,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.created_count).toBe(2);
      expect(body.skipped_count).toBe(0);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('a keyed retry COMPLETES an unfinished immediate send on the existing draft row instead of stranding it', async () => {
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
    }));
    InvoiceService.sendViaSMS.mockResolvedValue({ sent: true, ok: true });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000003',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.created_count).toBe(0);
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toMatchObject({ sent: true });
      // Completed on the EXISTING row — no new invoice minted.
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-existing', { firstDeliveryOnly: true, operatorInitiated: true, actorTechnicianId: 'tech-1' });
    });
  });

  test('a keyed retry leaves a STALE sending claim to the central recovery — no status write, no re-text', async () => {
    // The claim may have started from sent/viewed/overdue (a resend), and
    // the crashed worker may have delivered — no status is safe to restore
    // blindly here. processScheduledSends owns stale-claim recovery; this
    // route only reports.
    const chain = makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'sending', payer_id: null,
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : chain);

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000004',
      });
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].reason).toMatch(/crashed send claim.*automatic recovery/i);
      expect(chain.update).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test('P0: the batch-key registry refuses the WHOLE request when the key is bound to a different payload (409, nothing created)', async () => {
    // The atomic up-front claim: per-row checks alone would let customers
    // without an existing row still be invoiced with the changed terms.
    db.mockImplementation((table) => (table === 'invoice_batch_keys'
      ? makeRegistryChain({ fingerprint: 'bound-to-a-different-payload' })
      : makeDupChain(undefined)));

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1', 'cust-2'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000006',
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe('BATCH_KEY_PAYLOAD_MISMATCH');
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
    });
  });

  test('reusing a batch key with a CHANGED payload is refused for existing rows (fingerprint mismatch)', async () => {
    // The stored row carries the fingerprint of the ORIGINAL payload; this
    // request's differing terms must fail the entry instead of silently
    // keeping the old invoice while other customers get the new terms.
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
      batch_fingerprint: 'fingerprint-of-a-different-payload',
    }));

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000005',
      });
      const body = await response.json();
      expect(body.failed_count).toBe(1);
      expect(body.failed[0].error).toMatch(/different payload/i);
      expect(body.skipped_count).toBe(0);
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test('a keyed retry leaves a FRESH sending claim alone (live concurrent send)', async () => {
    const chain = makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'sending', payer_id: null,
      updated_at: new Date().toISOString(),
    });
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : chain);

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000004',
      });
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].reason).toMatch(/in progress/i);
      expect(chain.update).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
    });
  });

  test('a keyed retry never re-texts an already-delivered row', async () => {
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'sent', payer_id: null,
    }));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000003',
      });
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toBeUndefined();
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    });
  });

  // Round-1 Codex P1 (PR #4633): a keyed retry of create-and-send is a
  // first delivery BY DEFINITION — deriving the flag from the row's own
  // stamps let a provider-accept whose finalize crashed (sms_sent_at set,
  // status still draft) read as an ordinary resend and re-text the pay
  // link a second time.
  test('a keyed retry against a draft row with sms_sent_at (provider accepted, finalize crashed) is an already_delivered no-op — no second provider call', async () => {
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
      sms_sent_at: new Date().toISOString(),
    }));
    const alreadyDeliveredErr = new Error('Invoice was already delivered — not sent again');
    alreadyDeliveredErr.code = 'already_delivered';
    InvoiceService.sendViaSMS.mockRejectedValue(alreadyDeliveredErr);
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems,
        sendImmediately: true, batchKey: 'b7f9c2d4-0000-4000-8000-000000000005',
      });
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toMatchObject({ ok: true, already_delivered: true });
      expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
      expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-existing', { firstDeliveryOnly: true, operatorInitiated: true, actorTechnicianId: 'tech-1' });
    });
  });

  // Round-1 Codex P2 (PR #4633): a keyed retry whose row processScheduledSends
  // already parked sits at status 'scheduled' (the park clears
  // scheduled_send_at, not the status) — it must never fall through to the
  // draft-only branch (which it can't reach) and silently skip with the
  // generic "already created" reason; it must be reported held.
  test('a keyed retry against an already-parked row (status scheduled) is reported held, not silently skipped', async () => {
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'scheduled', payer_id: null,
      scheduled_send_at: null, scheduled_send_error: STALE_SEND_PARK_ERROR,
    }));
    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems,
        sendImmediately: true, batchKey: 'b7f9c2d4-0000-4000-8000-000000000006',
      });
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toMatchObject({ held: true, code: 'stale_claim_review_hold' });
      expect(body.skipped[0].reason).toMatch(/stale-claim review hold/i);
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
      expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    });
  });

  test('a concurrent keyed retry losing the unique-index race is reported skipped, not failed', async () => {
    // Pre-check SELECT sees nothing (both requests passed it), insert loses on
    // invoices_customer_batch_key_uniq, re-select finds the winner's row.
    const dupResults = [undefined, { id: 'inv-winner', invoice_number: 'WPC-9' }];
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain(dupResults.shift()));
    const uniqueErr = new Error('duplicate key value violates unique constraint "invoices_customer_batch_key_uniq"');
    uniqueErr.code = '23505';
    uniqueErr.constraint = 'invoices_customer_batch_key_uniq';
    InvoiceService.create.mockRejectedValue(uniqueErr);

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'],
        title: 'Quarterly Pest Control',
        lineItems,
        sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000002',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.failed_count).toBe(0);
      expect(body.created_count).toBe(0);
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0]).toMatchObject({
        customerId: 'cust-1',
        invoiceId: 'inv-winner',
        invoiceNumber: 'WPC-9',
      });
      // The loser must not text the customer.
      expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
    });
  });

  test('a malformed batchKey is rejected up front', async () => {
    await withServer(async (baseUrl) => {
      for (const batchKey of [123, '', '   ', 'x'.repeat(101)]) {
        const response = await post(baseUrl, '/batch', {
          customerIds: ['cust-1'], title: 'T', lineItems, batchKey,
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: 'batchKey must be a non-empty string (max 100 chars)',
        });
      }
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test('a RESOLVED deposit_settlement_pending from an immediate send is held, not a batch failure (Codex round-5 audit P1 #4131 slice 4)', async () => {
    // settleZeroDueBeforeSend's chokepoint resolves this refusal instead of
    // throwing it — the resolved form used to fall through this route's
    // generic failure handling straight into created[].sent with no
    // held marker, indistinguishable from a genuine send failure.
    InvoiceService.create.mockResolvedValue({
      id: 'inv-new', invoice_number: 'WPC-2', total: 100, token: 'tok-2', payer_id: null,
    });
    InvoiceService.sendViaSMS.mockResolvedValue({
      sent: false, ok: false, code: 'deposit_settlement_pending',
      reason: 'Nothing is due on this invoice, but it could not be settled yet (invoice_delivery_in_flight) — not sent.',
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems, sendImmediately: true,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.created_count).toBe(1);
      expect(body.failed_count).toBe(0);
      // Converged onto the SAME shape the thrown form already reports.
      expect(body.created[0].sent).toEqual({ sent: false, held: true, code: 'deposit_settlement_pending' });
    });
  });

  test('a RESOLVED COMPLETED terminal void (INVOICE_VISIT_TERMINAL) from an immediate send is reported a handled no-op success, never a batch failure (Codex round-9 audit P2 #4131 follow-up)', async () => {
    // The SAME shared classifier (resolvedSendOutcome/firstDeliveryOutcome)
    // /batch/send and /:id/send already converge on for this code — before
    // this fix, the fresh-create send path here had no noop handling of
    // its own, so a completed, correct void fell through the raw ok:false
    // result straight into created[].sent, reading as a failed send.
    InvoiceService.create.mockResolvedValue({
      id: 'inv-new', invoice_number: 'WPC-2', total: 100, token: 'tok-2', payer_id: null,
    });
    InvoiceService.sendViaSMS.mockResolvedValue({
      sent: false, ok: false, code: 'INVOICE_VISIT_TERMINAL',
      reason: 'Linked visit is terminal; delivery not attempted',
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems, sendImmediately: true,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.created_count).toBe(1);
      expect(body.failed_count).toBe(0);
      // Converged onto the SAME shared-classifier shape /batch/send and
      // /:id/send already report for this code.
      expect(body.created[0].sent).toEqual({
        sent: false, ok: true, code: 'INVOICE_VISIT_TERMINAL', voided: true,
      });
    });
  });

  test('a keyed retry\'s RESOLVED deposit_settlement_pending on an unfinished send is reported held, not skipped as an ordinary failure', async () => {
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
    }));
    InvoiceService.sendViaSMS.mockResolvedValue({
      sent: false, ok: false, code: 'deposit_settlement_pending', reason: 'not sent yet',
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems, sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-000000000009',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toEqual({ sent: false, held: true, code: 'deposit_settlement_pending' });
      expect(body.skipped[0].reason).toMatch(/not sent yet/);
    });
  });

  test('a keyed retry\'s RESOLVED COMPLETED terminal void (INVOICE_VISIT_TERMINAL) on an unfinished send is reported a handled no-op success, never skipped as an ordinary failure (Codex round-9 audit P2 #4131 follow-up)', async () => {
    // Same shared-classifier convergence as the fresh-create test above,
    // for the keyed-retry-finishing-an-unfinished-send branch.
    db.mockImplementation((table) => table === 'invoice_batch_keys' ? makeRegistryChain() : makeDupChain({
      id: 'inv-existing', invoice_number: 'WPC-1', status: 'draft', payer_id: null,
    }));
    InvoiceService.sendViaSMS.mockResolvedValue({
      sent: false, ok: false, code: 'INVOICE_VISIT_TERMINAL',
      reason: 'Linked visit is terminal; delivery not attempted',
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch', {
        customerIds: ['cust-1'], title: 'Quarterly Pest Control', lineItems, sendImmediately: true,
        batchKey: 'b7f9c2d4-0000-4000-8000-00000000000a',
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.skipped_count).toBe(1);
      expect(body.skipped[0].sent).toEqual({
        sent: false, ok: true, code: 'INVOICE_VISIT_TERMINAL', voided: true,
      });
    });
  });
});

describe('POST /batch/send held vs. failed classification', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a RESOLVED deposit_settlement_pending is reported held, never counted failed (Codex round-5 audit P1 #4131 slice 4)', async () => {
    db.mockImplementation(() => ({
      where: function where() { return this; },
      first: async () => ({ status: 'scheduled', sent_at: null, sms_sent_at: null, email_sent_at: null }),
    }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false, code: 'deposit_settlement_pending',
      error: 'Nothing is due on this invoice, but it could not be settled yet (invoice_delivery_in_flight) — not sent.',
      sms: { ok: false, code: 'deposit_settlement_pending' }, email: { ok: false, code: 'deposit_settlement_pending' },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch/send', { invoiceIds: ['inv-1'] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.failed_count).toBe(0);
      expect(body.held_count).toBe(1);
      expect(body.held[0]).toMatchObject({ invoiceId: 'inv-1', code: 'deposit_settlement_pending' });
    });
  });

  test('a safety-refused terminal void (INVOICE_VISIT_TERMINAL_UNVOIDED) is filed held, never counted failed (Codex round-6 audit P1 #4131)', async () => {
    db.mockImplementation(() => ({
      where: function where() { return this; },
      first: async () => ({ status: 'scheduled', sent_at: null, sms_sent_at: null, email_sent_at: null }),
    }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', voided: false,
      error: 'Linked visit is terminal; delivery not attempted, but the invoice could not be safely voided yet — held for review',
      sms: { ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED' }, email: { ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED' },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch/send', { invoiceIds: ['inv-1'] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.failed_count).toBe(0);
      expect(body.held_count).toBe(1);
      expect(body.held[0]).toMatchObject({ invoiceId: 'inv-1', code: 'INVOICE_VISIT_TERMINAL_UNVOIDED' });
    });
  });

  test('a COMPLETED terminal void (INVOICE_VISIT_TERMINAL — the sweep DID void it) is filed settled, never counted failed (Codex round-9 audit P2 #4131)', async () => {
    // Distinct from INVOICE_VISIT_TERMINAL_UNVOIDED above: the sweep
    // successfully voided the invoice, so nothing is left for an operator
    // to fix. Before this fix, resolvedSendOutcome recognized no branch
    // for this code (returned null), so it fell straight past the held
    // carve-out into the generic failed.push below — a completed, correct
    // cleanup counted as a batch failure.
    db.mockImplementation(() => ({
      where: function where() { return this; },
      first: async () => ({ status: 'scheduled', sent_at: null, sms_sent_at: null, email_sent_at: null }),
    }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false, code: 'INVOICE_VISIT_TERMINAL',
      error: 'Linked visit is terminal; delivery not attempted',
      sms: { ok: false, code: 'INVOICE_VISIT_TERMINAL' }, email: { ok: false, code: 'INVOICE_VISIT_TERMINAL' },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch/send', { invoiceIds: ['inv-1'] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.failed_count).toBe(0);
      expect(body.held_count).toBe(0);
      expect(body.settled_count).toBe(1);
      expect(body.settled[0]).toMatchObject({ invoiceId: 'inv-1', code: 'INVOICE_VISIT_TERMINAL' });
    });
  });

  test('a covered_by_credit resolved success is filed settled, never as sent with both channels false (round-8 audit P1 #4131 slice 4)', async () => {
    db.mockImplementation(() => ({
      where: function where() { return this; },
      first: async () => ({ status: 'scheduled', sent_at: null, sms_sent_at: null, email_sent_at: null }),
    }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: true, covered_by_credit: true, sms: { ok: false }, email: { ok: false },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch/send', { invoiceIds: ['inv-1'] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sent_count).toBe(0);
      expect(body.failed_count).toBe(0);
      expect(body.settled_count).toBe(1);
      expect(body.settled[0]).toMatchObject({ invoiceId: 'inv-1', code: 'covered_by_credit' });
    });
  });

  test('a genuine dual-channel failure (no recognized held code) still counts failed, unaffected by the held carve-out above', async () => {
    db.mockImplementation(() => ({
      where: function where() { return this; },
      first: async () => ({ status: 'scheduled', sent_at: null, sms_sent_at: null, email_sent_at: null }),
    }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({
      ok: false, sms: { ok: false, error: 'no phone on file' }, email: { ok: false, error: 'bounced' },
    });

    await withServer(async (baseUrl) => {
      const response = await post(baseUrl, '/batch/send', { invoiceIds: ['inv-1'] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.held_count).toBe(0);
      expect(body.failed_count).toBe(1);
      expect(body.failed[0]).toMatchObject({ invoiceId: 'inv-1', error: 'sms: no phone on file | email: bounced' });
    });
  });
});
