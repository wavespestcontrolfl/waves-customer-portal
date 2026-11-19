// B07: a Tap to Pay collection must retire the customer's open /pay PaymentIntent
// (services/prepaid-pi-guard, the same helper every other settlement rail runs)
// before binding its card-present PI — otherwise the pointer overwrite leaves the
// pay-page client secret live, and a still-open tab (Apple Pay / ACH confirm) can
// charge the customer a second time.
const mockCreate = jest.fn();
const mockCancelCreated = jest.fn();
const mockRetrieve = jest.fn();
const mockCancelPi = jest.fn();
const mockChargeFence = jest.fn();
const mockDepositFence = jest.fn();
const mockLockCombinedCustomer = jest.fn();
const mockVerifyAllocation = jest.fn();
const mockReleaseCombined = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test' }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn(() => ({ technicianId: 'tech-1' })), sign: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(),
  auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: (...args) => mockDepositFence(...args),
}));
jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomerStable: (...args) => mockLockCombinedCustomer(...args),
  isCombinedPiMetadata: (metadata) => !!metadata?.combined_allocation,
  parseCombinedAllocation: (metadata) => String(metadata.combined_allocation).split(',').map((entry) => {
    const [invoiceId, cents] = entry.split(':');
    return { invoiceId, cents: Number(cents) };
  }),
  verifyAllocationLocked: (...args) => mockVerifyAllocation(...args),
  releaseCombinedSessionBeforeCollection: (...args) => mockReleaseCombined(...args),
  clearPaymentIntentStamps: jest.fn(async () => 0),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: (...args) => mockChargeFence(...args),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: (err) => [
    'STRIPE_CHARGE_IN_PROGRESS',
    'STRIPE_AMBIGUOUS_OUTCOME',
    'STRIPE_CHARGED_DB_FAILED',
    'DEPOSIT_RECONCILIATION_REQUIRED',
  ].includes(err?.code),
  retrievePaymentIntent: (...args) => mockRetrieve(...args),
  cancelPaymentIntent: (...args) => mockCancelPi(...args),
}));
jest.mock('stripe', () => jest.fn(() => ({
  paymentIntents: { create: (...args) => mockCreate(...args), cancel: (...args) => mockCancelCreated(...args) },
})));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/stripe-terminal');

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

const TERMINAL_PI = { id: 'pi_terminal_new', client_secret: 'pi_terminal_new_secret' };
let invoiceUpdates;
let handoffUpdates;

// Minimal knex-ish table router: reads return the row, writes are recorded.
function setup({ invoice, handoff, handoffRead = null }) {
  jest.clearAllMocks();
  invoiceUpdates = [];
  handoffUpdates = [];
  mockChargeFence.mockResolvedValue(undefined);
  mockDepositFence.mockResolvedValue(undefined);
  mockLockCombinedCustomer.mockResolvedValue('cust-1');
  mockVerifyAllocation.mockResolvedValue([invoice]);
  mockReleaseCombined.mockResolvedValue({ released: false });
  mockCreate.mockResolvedValue(TERMINAL_PI);
  mockCancelCreated.mockResolvedValue({});
  mockCancelPi.mockResolvedValue({});
  const allocationRows = [invoice, {
    ...invoice,
    id: 'inv-2',
    total: '50.00',
    stripe_payment_intent_id: invoice.stripe_payment_intent_id,
  }];
  const rowQuery = (row, updates, directRows = [row], readFirst = null) => {
    const q = {};
    q.where = () => q;
    q.whereIn = () => q;
    q.whereNull = () => q;
    q.whereNotIn = () => q;
    q.orderBy = () => q;
    q.forUpdate = () => q;
    q.first = async () => (readFirst ? readFirst() : row);
    q.update = async (patch) => { if (updates) updates.push(patch); return 1; };
    q.then = (resolve, reject) => Promise.resolve(directRows).then(resolve, reject);
    return q;
  };
  db.mockImplementation((table) => {
    if (table === 'technicians') return rowQuery({ id: 'tech-1', active: true, role: 'technician' });
    if (table === 'terminal_handoff_tokens') return rowQuery(handoff, handoffUpdates, [handoff], handoffRead);
    if (table === 'invoices') return rowQuery(invoice, invoiceUpdates, allocationRows);
    throw new Error(`unexpected table ${table}`);
  });
  db.fn = { now: () => 'now()' };
  db.transaction = jest.fn(async (callback) => callback(db));
}

function baseInvoice(extra = {}) {
  return {
    id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '100.00',
    credit_applied: '0.00', stripe_payment_intent_id: null, ...extra,
  };
}
function baseHandoff(extra = {}) {
  const used = new Date('2026-10-03T12:00:00Z');
  return {
    jti: 'jti-1', used_at: used, expires_at: new Date(used.getTime() + 600000), tech_user_id: 'tech-1',
    invoice_id: 'inv-1', amount_cents: 10000, stripe_payment_intent_id: null, ...extra,
  };
}

async function postPaymentIntent() {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stripe/terminal/payment-intent`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jti: 'jti-1' }),
    });
    return { status: response.status, body: await response.json() };
  });
}

const boundPointer = () => invoiceUpdates.find((u) => u.stripe_payment_intent_id === TERMINAL_PI.id);

describe('POST /payment-intent retires the open pay-page PaymentIntent (B07)', () => {
  test('checkout-aware preflight holds an earlier authentication attempt before minting a Terminal PI', async () => {
    setup({ invoice: baseInvoice(), handoff: baseHandoff() });
    mockChargeFence.mockRejectedValueOnce(Object.assign(new Error('awaiting authentication verification'), {
      code: 'STRIPE_CHARGE_IN_PROGRESS',
      savedCardPending: true,
      reconciliationRequired: false,
    }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'payment_charge_in_progress',
      reconciliationRequired: false,
    });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });

  test('a received card payment awaiting local posting returns the reconciliation hold before mint', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    const fence = Object.assign(new Error('received payment has no local posting'), {
      code: 'STRIPE_CHARGED_DB_FAILED',
      reconciliationRequired: true,
    });
    mockChargeFence.mockRejectedValue(fence);

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(mockChargeFence).toHaveBeenNthCalledWith(1, 'inv-1', db, { checkout: true });
    expect(mockChargeFence).toHaveBeenNthCalledWith(2, 'inv-1', db, { readOnly: true, checkout: true });
    expect(require('../services/stripe').parkInvoiceForSavedCardReconciliation).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(invoiceUpdates).toEqual([]);
    expect(handoffUpdates).toEqual([]);
  });

  test('an unstamped ambiguous charge is revalidated under the invoice lock and parked without adopting its PI', async () => {
    setup({ invoice: baseInvoice(), handoff: baseHandoff() });
    const fence = Object.assign(new Error('submitted charge outcome is unknown'), {
      code: 'STRIPE_AMBIGUOUS_OUTCOME',
      chargeAttemptId: 'attempt-ambiguous',
      stripePaymentIntentId: 'pi_ambiguous_other',
      reconciliationRequired: true,
    });
    mockChargeFence.mockRejectedValue(fence);

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(mockChargeFence).toHaveBeenNthCalledWith(1, 'inv-1', db, { checkout: true });
    expect(mockChargeFence).toHaveBeenNthCalledWith(2, 'inv-1', db, { readOnly: true, checkout: true });
    expect(invoiceUpdates).toContainEqual(expect.objectContaining({ status: 'processing' }));
    expect(invoiceUpdates.some((update) => Object.hasOwn(update, 'stripe_payment_intent_id'))).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(handoffUpdates).toEqual([]);
  });

  test('checkout-aware locked bind holds a racing attempt and retires only the new Terminal PI', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: 'requires_payment_method', metadata: {} });
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('awaiting authentication verification'), {
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        savedCardPending: true,
        reconciliationRequired: false,
      }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'payment_charge_in_progress',
      reconciliationRequired: false,
      newHandoffRequired: true,
    });
    expect(mockChargeFence).toHaveBeenNthCalledWith(1, 'inv-1', db, { checkout: true });
    expect(mockChargeFence).toHaveBeenNthCalledWith(2, 'inv-1', db, { checkout: true });
    expect(boundPointer()).toBeUndefined();
    expect(handoffUpdates.some((u) => u.stripe_payment_intent_id === TERMINAL_PI.id)).toBe(false);
    expect(handoffUpdates.some((u) => 'expires_at' in u)).toBe(true);
    expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockReleaseCombined).not.toHaveBeenCalled();
  });

  test('a racing orphan hold preserves the live standalone checkout pointer', async () => {
    setup({
      invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }),
      handoff: baseHandoff(),
    });
    mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: 'requires_confirmation', metadata: {} });
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('received payment has no local posting'), {
        code: 'STRIPE_CHARGED_DB_FAILED',
        stripePaymentIntentId: 'pi_orphan',
        reconciliationRequired: true,
      }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'payment_reconciliation_pending',
      reconciliationRequired: true,
      newHandoffRequired: true,
    });
    expect(mockReleaseCombined).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(invoiceUpdates).toEqual([]);
  });

  test('a final-bind orphan on an unstamped invoice parks processing without switching to the orphan PI', async () => {
    setup({ invoice: baseInvoice(), handoff: baseHandoff() });
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('received payment has no local posting'), {
        code: 'STRIPE_CHARGED_DB_FAILED',
        stripePaymentIntentId: 'pi_orphan_other',
        reconciliationRequired: true,
      }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'payment_reconciliation_pending',
      reconciliationRequired: true,
      newHandoffRequired: true,
    });
    expect(invoiceUpdates).toContainEqual(expect.objectContaining({ status: 'processing' }));
    expect(invoiceUpdates.some((update) => Object.hasOwn(update, 'stripe_payment_intent_id'))).toBe(false);
    expect(mockCancelCreated).toHaveBeenCalledTimes(1);
  });

  test('a bind that already committed never issues its secret to a second request', async () => {
    const handoff = baseHandoff();
    let reads = 0;
    setup({
      invoice: baseInvoice(), handoff,
      handoffRead: () => (++reads === 1 ? handoff : { ...handoff, stripe_payment_intent_id: TERMINAL_PI.id }),
    });
    const { status, body } = await postPaymentIntent();
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_intent_already_created', paymentIntentId: TERMINAL_PI.id });
    expect(body).not.toHaveProperty('clientSecret');
    expect(mockCancelCreated).not.toHaveBeenCalled();
    expect(invoiceUpdates).toEqual([]);
    expect(handoffUpdates).toEqual([]);
  });

  test.each(['canceled', 'cancelled'])('refuses a %s invoice before creating a Terminal intent', async (status) => {
    setup({ invoice: baseInvoice({ status }), handoff: baseHandoff() });
    const result = await postPaymentIntent();
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'invoice_status_changed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('cancellation between preflight and bind invalidates the handoff before returning its secret', async () => {
    const invoice = baseInvoice();
    setup({ invoice, handoff: baseHandoff() });
    mockCreate.mockImplementationOnce(async () => {
      invoice.status = 'cancelled';
      return TERMINAL_PI;
    });
    const { status, body } = await postPaymentIntent();
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'invoice_status_changed' });
    expect(body).not.toHaveProperty('clientSecret');
    expect(mockCancelCreated).toHaveBeenCalledTimes(1);
    expect(invoiceUpdates).toEqual([]);
  });

  test('a concurrent successful bind wins the handoff lock and its published PI is never canceled by refusal cleanup', async () => {
    const handoff = baseHandoff();
    let reads = 0;
    setup({
      invoice: baseInvoice(),
      handoff,
      // Unlocked preflight, then this request's bind lock, then cleanup after
      // the competing request has committed the same idempotent PI.
      handoffRead: () => (++reads >= 3
        ? { ...handoff, stripe_payment_intent_id: TERMINAL_PI.id }
        : handoff),
    });
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('transient competing payment'), {
        code: 'STRIPE_CHARGE_IN_PROGRESS', reconciliationRequired: false,
      }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'payment_intent_already_created',
      paymentIntentId: TERMINAL_PI.id,
    });
    expect(mockCancelCreated).not.toHaveBeenCalled();
    expect(handoffUpdates.some((update) => 'expires_at' in update)).toBe(false);
  });

  test('a retry that meets an already-invalidated per-attempt handoff neither binds nor cancels the PI again', async () => {
    const handoff = baseHandoff();
    let reads = 0;
    setup({
      invoice: baseInvoice(),
      handoff,
      handoffRead: () => (++reads >= 2
        ? { ...handoff, expires_at: handoff.used_at }
        : handoff),
    });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'handoff_reissue_required' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCancelCreated).not.toHaveBeenCalled();
    expect(boundPointer()).toBeUndefined();
  });

  test('an early invalidated handoff refuses before an idempotent create or cancel retry', async () => {
    const handoff = baseHandoff();
    setup({ invoice: baseInvoice(), handoff: { ...handoff, expires_at: handoff.used_at } });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'handoff_reissue_required' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });

  test('takes the combined reservation and allocation locks before a racing hold and preserves the shared checkout', async () => {
    const invoice = baseInvoice({ stripe_payment_intent_id: 'pi_combined' });
    setup({ invoice, handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({
      id: 'pi_combined',
      status: 'requires_confirmation',
      metadata: { combined_allocation: 'inv-1:10000,inv-2:5000' },
    });
    mockChargeFence
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('awaiting authentication verification'), {
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        reconciliationRequired: false,
      }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_charge_in_progress', newHandoffRequired: true });
    expect(mockLockCombinedCustomer).toHaveBeenCalledWith(db, 'inv-1', 'cust-1');
    expect(mockVerifyAllocation).not.toHaveBeenCalled();
    expect(mockDepositFence).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'inv-1' }));
    expect(mockReleaseCombined).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(invoiceUpdates).toEqual([]);
  });

  test('replaces a shared checkout with stale sibling cents after all holds pass', async () => {
    const invoice = baseInvoice({ stripe_payment_intent_id: 'pi_combined' });
    setup({ invoice, handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({
      id: 'pi_combined',
      status: 'requires_confirmation',
      metadata: { combined_allocation: 'inv-1:10000,inv-2:6000' },
    });
    mockReleaseCombined.mockImplementationOnce(async () => {
      invoice.stripe_payment_intent_id = null;
      return { released: true };
    });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockChargeFence).toHaveBeenCalledTimes(4);
    expect(mockVerifyAllocation).toHaveBeenCalledWith(db, [{ invoiceId: 'inv-1', cents: 10000 }], {
      anchorInvoiceId: 'inv-1', expectPaymentIntentId: 'pi_combined',
    });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-2', db, { checkout: true });
    expect(mockLockCombinedCustomer.mock.invocationCallOrder[0]).toBeLessThan(mockVerifyAllocation.mock.invocationCallOrder[0]);
    expect(mockVerifyAllocation.mock.invocationCallOrder[0]).toBeLessThan(mockReleaseCombined.mock.invocationCallOrder[0]);
    expect(mockChargeFence.mock.invocationCallOrder[2])
      .toBeLessThan(mockReleaseCombined.mock.invocationCallOrder[0]);
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(boundPointer()).toBeTruthy();
  });

  test('a combined allocation refusal retires only the new Terminal PI and requires a fresh handoff', async () => {
    const invoice = baseInvoice({ stripe_payment_intent_id: 'pi_combined' });
    setup({ invoice, handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({
      id: 'pi_combined',
      status: 'requires_confirmation',
      metadata: { combined_allocation: 'inv-1:10000,inv-2:5000' },
    });
    mockVerifyAllocation.mockRejectedValueOnce(Object.assign(
      new Error('The account balance changed since this page loaded — refreshing.'),
      { statusCode: 409, staleBalance: true },
    ));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'combined_session_release_failed', newHandoffRequired: true });
    expect(mockReleaseCombined).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
    expect(handoffUpdates.some((update) => 'expires_at' in update)).toBe(true);
    expect(invoiceUpdates).toEqual([]);
  });

  test('a canceled shared PI with stale allocation cents is cleared after every original member is held', async () => {
    const invoice = baseInvoice({ stripe_payment_intent_id: 'pi_combined' });
    setup({ invoice, handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({
      id: 'pi_combined',
      status: 'canceled',
      metadata: { combined_allocation: 'inv-1:12500,inv-2:5000' },
    });
    mockReleaseCombined.mockImplementationOnce(async () => {
      invoice.stripe_payment_intent_id = null;
      return { released: true };
    });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockVerifyAllocation).not.toHaveBeenCalled();
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { checkout: true });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-2', db, { checkout: true });
    expect(mockReleaseCombined).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'inv-1' }),
      { context: 'collecting at the terminal' },
    );
    expect(boundPointer()).toBeTruthy();
  });

  test('a final allocation deposit hold uses charge-fence cleanup and preserves reissue facts', async () => {
    const invoice = baseInvoice({ stripe_payment_intent_id: 'pi_combined' });
    setup({ invoice, handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({
      id: 'pi_combined',
      status: 'requires_confirmation',
      metadata: { combined_allocation: 'inv-1:10000,inv-2:5000' },
    });
    mockVerifyAllocation.mockRejectedValueOnce(Object.assign(
      new Error('A received deposit is awaiting invoice reconciliation'),
      { code: 'DEPOSIT_RECONCILIATION_REQUIRED', statusCode: 409 },
    ));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'DEPOSIT_RECONCILIATION_REQUIRED',
      reconciliationRequired: true,
      newHandoffRequired: true,
    });
    expect(mockReleaseCombined).not.toHaveBeenCalled();
    expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
    expect(handoffUpdates.some((update) => 'expires_at' in update)).toBe(true);
  });

  test('a processing invoice parked by saved-card evidence returns that hold before mint', async () => {
    setup({ invoice: baseInvoice({ status: 'processing' }), handoff: baseHandoff() });
    mockChargeFence.mockRejectedValueOnce(Object.assign(new Error('received payment has no local posting'), {
      code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true,
    }));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_reconciliation_pending', reconciliationRequired: true });
    expect(mockChargeFence).toHaveBeenCalledWith('inv-1', db, { readOnly: true, checkout: true });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('an ordinary processing invoice keeps the generic bank-processing refusal', async () => {
    setup({ invoice: baseInvoice({ status: 'processing' }), handoff: baseHandoff() });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Invoice is processing', code: 'invoice_status_changed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a pay-page PI preserved by saved-card failure recovery is inspected and canceled before the Terminal retry binds', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: 'requires_payment_method', metadata: {} });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body).toEqual({ clientSecret: TERMINAL_PI.client_secret, paymentIntentId: TERMINAL_PI.id, amount: 10000 });
    expect(mockRetrieve).toHaveBeenCalledWith('pi_pay_page');
    expect(mockCancelPi).toHaveBeenCalledTimes(1);
    expect(mockCancelPi).toHaveBeenCalledWith('pi_pay_page', { cancellation_reason: 'abandoned' });
    expect(boundPointer()).toBeTruthy();
    // Retire happens before the pointer is overwritten.
    expect(mockCancelPi.mock.invocationCallOrder[0]).toBeLessThan(db.mock.invocationCallOrder[db.mock.invocationCallOrder.length - 1]);
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });

  test.each(['processing', 'succeeded', 'requires_capture'])(
    'a pay-page PI already %s refuses the terminal collection and binds nothing',
    async (piStatus) => {
      setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
      mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: piStatus, metadata: {} });

      const { status, body } = await postPaymentIntent();

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'payment_in_flight', newHandoffRequired: true });
      expect(body.error).toMatch(/already in progress/);
      expect(mockCancelPi).not.toHaveBeenCalledWith('pi_pay_page', expect.anything());
      // Nothing bound: invoice pointer untouched, the freshly minted PI cancelled, handoff burned.
      expect(boundPointer()).toBeUndefined();
      expect(handoffUpdates.some((u) => u.stripe_payment_intent_id === TERMINAL_PI.id)).toBe(false);
      expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
      expect(handoffUpdates.some((u) => 'expires_at' in u)).toBe(true);
    },
  );

  test('an unverifiable pay-page PI fails closed with no bind', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    mockRetrieve.mockRejectedValue(new Error('stripe timeout'));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_session_unverifiable', newHandoffRequired: true });
    expect(boundPointer()).toBeUndefined();
    expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
  });

  test('no prior PI: unchanged, guard never touches Stripe', async () => {
    setup({ invoice: baseInvoice(), handoff: baseHandoff() });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(boundPointer()).toBeTruthy();
  });

  test('retry with the terminal\'s own PI already on the handoff: 409 as before, nothing cancelled', async () => {
    setup({
      invoice: baseInvoice({ stripe_payment_intent_id: TERMINAL_PI.id }),
      handoff: baseHandoff({ stripe_payment_intent_id: TERMINAL_PI.id }),
    });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_intent_already_created', paymentIntentId: TERMINAL_PI.id });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('Stripe idempotent replay: pointer already equals the replayed terminal PI, so it is not retired', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: TERMINAL_PI.id }), handoff: baseHandoff() });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });
});
