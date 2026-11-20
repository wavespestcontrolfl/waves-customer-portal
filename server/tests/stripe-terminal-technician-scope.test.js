// Tap to Pay handoff scope (codex #5568 r1 P1): a technician mints a handoff
// only for an invoice whose customer is on their current/recent route; an
// admin is unscoped. /capture is admin-only (see the route).
process.env.TERMINAL_HANDOFF_SECRET = 'terminal-handoff-test-secret-32-characters';

const mockChargeFence = jest.fn();
const mockAutoApplyCredit = jest.fn();
const mockPostCoverage = jest.fn();
const mockJwtSign = jest.fn(() => 'signed-handoff');
let mockTechRole = 'technician';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'staff-jwt-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test_placeholder' }));
jest.mock('jsonwebtoken', () => ({ sign: (...args) => mockJwtSign(...args), verify: jest.fn() }));
jest.mock('stripe', () => jest.fn(() => ({ paymentIntents: {} })));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = mockTechRole;
    req.staffToken = { mfa: false, tokenVersion: 1 };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(), auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: (...args) => mockAutoApplyCredit(...args),
  runPostFullCoverageSideEffects: (...args) => mockPostCoverage(...args),
  reverseAppliedCredit: jest.fn(),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...args) => mockChargeFence(...args),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: (err) => [
    'STRIPE_CHARGE_IN_PROGRESS',
    'STRIPE_AMBIGUOUS_OUTCOME',
    'STRIPE_CHARGED_DB_FAILED',
  ].includes(err?.code),
}));
const mockServices = jest.fn(async () => false);
jest.mock('../services/technician-visit-scope', () => ({
  technicianServicesCustomer: (...args) => mockServices(...args),
  technicianCurrentVisitFilter: (_req, query) => query,
}));

const express = require('express');
const Stripe = require('stripe');
const db = require('../models/db');
const router = require('../routes/stripe-terminal');
const { _test } = router;

beforeEach(() => {
  jest.clearAllMocks();
  mockTechRole = 'technician';
  mockServices.mockResolvedValue(false);
  mockChargeFence.mockResolvedValue(undefined);
  mockAutoApplyCredit.mockResolvedValue({ applied: 0, fullyCovered: false });
  mockPostCoverage.mockResolvedValue(undefined);
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe/terminal', router);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function setupHandoffDb({
  assigned = true,
  transactionState = null,
  invoiceStatus = 'sent',
  invoicePatches = {},
  lockedInvoicePatches = [],
} = {}) {
  const invoice = {
    id: 'inv-1', customer_id: 'cust-1', status: invoiceStatus, total: '100.00',
    credit_applied: '0.00', stripe_payment_intent_id: null,
    ...invoicePatches,
  };
  const tableReads = [];
  const rowLocks = [];
  const tokenInserts = [];
  const operations = [];
  let lockedInvoiceRead = 0;
  const queryFor = (table, row) => {
    tableReads.push(table);
    const query = { locked: false };
    for (const method of ['where', 'whereNotIn', 'whereIn', 'whereNull']) {
      query[method] = (...args) => { operations.push({ table, method, args }); return query; };
    }
    query.forUpdate = () => { query.locked = true; rowLocks.push(table); return query; };
    query.first = async () => {
      if (table === 'invoices' && query.locked) {
        const patch = lockedInvoicePatches[lockedInvoiceRead++] || null;
        return patch ? { ...invoice, ...patch } : invoice;
      }
      return row;
    };
    query.update = async (patch) => { Object.assign(row, patch); return 1; };
    query.insert = async (value) => { tokenInserts.push(value); return 1; };
    return query;
  };
  db.mockImplementation((table) => {
    if (table === 'invoices') return queryFor(table, invoice);
    if (table === 'customers') return queryFor(table, { id: 'cust-1' });
    if (table === 'scheduled_services') return queryFor(table, assigned ? { id: 'visit-1' } : null);
    if (table === 'terminal_handoff_tokens') return queryFor(table, null);
    throw new Error(`unexpected table ${table}`);
  });
  db.fn = { now: () => new Date() };
  db.transaction = jest.fn(async (callback) => {
    const snapshot = transactionState ? { ...transactionState } : null;
    try {
      return await callback(db);
    } catch (err) {
      if (snapshot) Object.assign(transactionState, snapshot);
      throw err;
    }
  });
  return { invoice, tableReads, rowLocks, tokenInserts, operations };
}

async function postHandoff() {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stripe/terminal/handoff`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ invoice_id: 'inv-1' }),
    });
    return { status: response.status, body: await response.json() };
  });
}

describe('technicianMayCollectInvoice', () => {
  test('an admin collects any invoice without a scope lookup', async () => {
    await expect(_test.technicianMayCollectInvoice({ techRole: 'admin' }, { id: 'inv', customer_id: 'c1' })).resolves.toBe(true);
    expect(mockServices).not.toHaveBeenCalled();
  });
  test('a technician collects only for a customer on their route', async () => {
    mockServices.mockResolvedValueOnce(true);
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician', technicianId: 't1' }, { id: 'inv', customer_id: 'c1' })).resolves.toBe(true);
    expect(mockServices).toHaveBeenCalledWith(expect.objectContaining({ technicianId: 't1' }), 'c1');
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician', technicianId: 't1' }, { id: 'inv', customer_id: 'c2' })).resolves.toBe(false);
  });
  test('an invoice with no customer is never collectible by a technician', async () => {
    await expect(_test.technicianMayCollectInvoice({ techRole: 'technician' }, { id: 'inv', customer_id: null })).resolves.toBe(false);
    expect(mockServices).not.toHaveBeenCalled();
  });
});

describe('POST /handoff checkout reconciliation fence', () => {
  test('a statement-owned invoice is refused at preflight before credit or token work', async () => {
    const state = setupHandoffDb({ invoicePatches: { payer_statement_id: 'statement-1' } });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invoice is billed to a third-party payer — do not collect in person' });
    expect(mockChargeFence).not.toHaveBeenCalled();
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tokenInserts).toEqual([]);
  });

  test('a processing invoice parked by saved-card evidence returns that hold', async () => {
    const state = setupHandoffDb({ invoiceStatus: 'processing' });
    mockServices.mockResolvedValue(true);
    mockChargeFence.mockRejectedValueOnce(Object.assign(new Error('received payment has no local posting'), {
      code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true,
    }));

    const { status, body } = await postHandoff();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { readOnly: true, checkout: true });
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
  });

  test('an ordinary processing invoice keeps the generic bank-processing refusal', async () => {
    const state = setupHandoffDb({ invoiceStatus: 'processing' });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Bank payment is already processing' });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { readOnly: true, checkout: true });
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
  });

  test.each([
    ['active or authenticating claim', 'STRIPE_CHARGE_IN_PROGRESS', false, 'payment_charge_in_progress'],
    ['submitted or ambiguous claim', 'STRIPE_AMBIGUOUS_OUTCOME', true, 'payment_reconciliation_pending'],
    ['received funds', 'STRIPE_CHARGED_DB_FAILED', true, 'payment_reconciliation_pending'],
  ])('returns the established 409 for a locked %s before credit or token work', async (
    _label,
    errorCode,
    reconciliationRequired,
    responseCode,
  ) => {
    const state = setupHandoffDb();
    mockServices.mockResolvedValue(true);
    mockChargeFence.mockRejectedValue(Object.assign(new Error('collection held'), {
      code: errorCode,
      reconciliationRequired,
    }));

    const { status, body } = await postHandoff();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: responseCode, reconciliationRequired });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
    expect(Stripe).not.toHaveBeenCalled();
  });

  test('keeps the locked ownership miss as a 404 without running the fence or credit', async () => {
    const state = setupHandoffDb({ assigned: false });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Invoice not found' });
    expect(mockChargeFence).not.toHaveBeenCalled();
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
  });

  test('the credit transaction locks the current owner and refuses ownership drift before visit, fence, or credit', async () => {
    const state = setupHandoffDb({ lockedInvoicePatches: [{ customer_id: 'cust-2' }] });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Invoice not found' });
    expect(state.operations).toContainEqual({ table: 'customers', method: 'where', args: [{ id: 'cust-2' }] });
    expect(mockChargeFence).not.toHaveBeenCalled();
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tokenInserts).toEqual([]);
  });

  test.each([
    ['paid status', { status: 'paid' }, 400, { error: 'Invoice already paid' }],
    ['payer ownership', { payer_id: 'payer-2' }, 400, { error: 'Invoice is billed to a third-party payer — do not collect in person' }],
    ['statement ownership', { payer_statement_id: 'statement-2' }, 400, { error: 'Invoice is billed to a third-party payer — do not collect in person' }],
  ])('the credit transaction refuses locked %s before credit', async (_label, patch, expectedStatus, expectedBody) => {
    const state = setupHandoffDb({ lockedInvoicePatches: [patch] });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(expectedStatus);
    expect(body).toEqual(expectedBody);
    expect(mockChargeFence).not.toHaveBeenCalled();
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tokenInserts).toEqual([]);
  });

  test.each([
    ['owner drift', { customer_id: 'cust-2' }, 404, { error: 'Invoice not found' }],
    ['paid status', { status: 'paid' }, 400, { error: 'Invoice already paid' }],
    ['payer ownership', { payer_id: 'payer-2' }, 400, { error: 'Invoice is billed to a third-party payer — do not collect in person' }],
    ['statement ownership', { payer_statement_id: 'statement-2' }, 400, { error: 'Invoice is billed to a third-party payer — do not collect in person' }],
  ])('the mint transaction refuses locked %s before token work', async (_label, patch, expectedStatus, expectedBody) => {
    const state = setupHandoffDb({ lockedInvoicePatches: [{}, patch] });
    mockServices.mockResolvedValue(true);

    const { status, body } = await postHandoff();

    expect(status).toBe(expectedStatus);
    expect(body).toEqual(expectedBody);
    expect(mockAutoApplyCredit).toHaveBeenCalledTimes(1);
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
    if (patch.customer_id) {
      expect(state.operations).toContainEqual({ table: 'customers', method: 'where', args: [{ id: patch.customer_id }] });
    }
  });

  test('returns partial credit when the invoice moves to a payer statement before mint', async () => {
    const state = setupHandoffDb({ lockedInvoicePatches: [{}, { payer_statement_id: 'statement-2' }] });
    mockServices.mockResolvedValue(true);
    mockAutoApplyCredit.mockResolvedValueOnce({ applied: 25, fullyCovered: false });

    const { status, body } = await postHandoff();

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invoice is billed to a third-party payer — do not collect in person' });
    expect(require('../services/customer-credit').reverseAppliedCredit).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      amount: 25,
      createdBy: 'system:handoff_invoice_refused',
    });
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
  });

  test('keeps an unexpected fence failure on the ordinary 500 rollback path', async () => {
    const state = setupHandoffDb();
    mockServices.mockResolvedValue(true);
    mockChargeFence.mockRejectedValue(new Error('attempt lookup unavailable'));

    const { status, body } = await postHandoff();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Handoff mint failed' });
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
  });

  test('commits an eligible stale pre-submit release before automatic-credit handling', async () => {
    const transactionState = { attemptStatus: 'claimed' };
    const state = setupHandoffDb({ transactionState });
    mockServices.mockResolvedValue(true);
    mockChargeFence.mockImplementationOnce(async (_invoiceId, _trx, options) => {
      expect(options).toEqual({ checkout: true });
      transactionState.attemptStatus = 'failed';
    });
    mockAutoApplyCredit.mockImplementationOnce(async () => {
      state.invoice.status = 'prepaid';
      return { applied: 100, fullyCovered: true };
    });

    const { status, body } = await postHandoff();

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invoice is now covered by account credit — no in-person collection needed' });
    expect(transactionState.attemptStatus).toBe('failed');
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(mockAutoApplyCredit).toHaveBeenCalledWith('inv-1', { trx: db, deferFullCoverageSideEffects: true });
    expect(mockChargeFence.mock.invocationCallOrder[0]).toBeLessThan(mockAutoApplyCredit.mock.invocationCallOrder[0]);
    expect(mockPostCoverage).toHaveBeenCalledWith('inv-1');
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
  });

  test('commits stale submitted-claim promotion while refusing credit and token minting', async () => {
    const transactionState = { attemptStatus: 'claimed' };
    const state = setupHandoffDb({ transactionState });
    mockServices.mockResolvedValue(true);
    mockChargeFence.mockImplementationOnce(async () => {
      transactionState.attemptStatus = 'ambiguous';
      throw Object.assign(new Error('submitted outcome is unresolved'), {
        code: 'STRIPE_AMBIGUOUS_OUTCOME',
        reconciliationRequired: true,
      });
    });

    const { status, body } = await postHandoff();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(transactionState.attemptStatus).toBe('ambiguous');
    expect(state.invoice).toMatchObject({ status: 'processing', stripe_payment_intent_id: null });
    expect(mockAutoApplyCredit).not.toHaveBeenCalled();
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
    expect(Stripe).not.toHaveBeenCalled();
  });

  test('delegates a competing-card credit race to the settlement-safe reversal primitive', async () => {
    const state = setupHandoffDb();
    mockTechRole = 'admin';
    mockAutoApplyCredit.mockImplementationOnce(async () => {
      state.invoice.credit_applied = 25;
      return { applied: 25, fullyCovered: false };
    });
    mockChargeFence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(
      new Error('An earlier card payment is awaiting verification.'), { code: 'STRIPE_CHARGE_IN_PROGRESS' },
    ));

    const { status, body } = await postHandoff();
    expect(status).toBe(409);
    expect(body.code).toBe('payment_charge_in_progress');
    expect(state.invoice.credit_applied).toBe(25);
    expect(require('../services/customer-credit').reverseAppliedCredit).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      amount: 25,
      createdBy: 'system:handoff_charge_refused',
    });
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
  });

  test.each(['admin', 'technician'])('rechecks the locked fence in the %s token-insert transaction', async (role) => {
    const transactionState = { attemptStatus: 'claimed' };
    const state = setupHandoffDb({ transactionState });
    mockTechRole = role;
    mockServices.mockResolvedValue(true);
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        expect(state.rowLocks.filter((table) => table === 'invoices')).toHaveLength(2);
        transactionState.attemptStatus = 'ambiguous';
        throw Object.assign(new Error('submitted outcome became unresolved at mint'), {
          code: 'STRIPE_AMBIGUOUS_OUTCOME',
          reconciliationRequired: true,
        });
      });

    const { status, body } = await postHandoff();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(transactionState.attemptStatus).toBe('ambiguous');
    expect(state.invoice).toMatchObject({ status: 'processing', stripe_payment_intent_id: null });
    expect(mockChargeFence).toHaveBeenCalledTimes(2);
    expect(mockChargeFence.mock.calls).toEqual([
      ['inv-1', db, { checkout: true }],
      ['inv-1', db, { checkout: true }],
    ]);
    expect(state.tableReads).not.toContain('terminal_handoff_tokens');
    expect(state.tokenInserts).toEqual([]);
    expect(mockJwtSign).not.toHaveBeenCalled();
    expect(Stripe).not.toHaveBeenCalled();
  });
});
