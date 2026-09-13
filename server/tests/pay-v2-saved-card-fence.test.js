jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => true),
  savedCardChargeNeedsReconciliation: jest.fn(),
  createInvoicePaymentIntent: jest.fn(),
  updateInvoicePaymentIntentMethod: jest.fn(),
  quoteInvoiceSurcharge: jest.fn(),
  finalizeInvoicePayment: jest.fn(),
  confirmInvoicePayment: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const router = require('../routes/pay-v2');

function invoiceQuery(invoice) {
  const query = {};
  query.where = jest.fn(() => query);
  query.first = jest.fn(async () => invoice);
  return query;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /api/pay/:token/setup saved-card reconciliation fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return invoiceQuery({
          id: 'inv-1',
          token: 'public-token-0123456789',
          customer_id: 'cust-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          payer_statement_id: null,
        });
      }
      if (table === 'customers') {
        return invoiceQuery({ billing_mode: null, monthly_rate: 0 });
      }
      throw new Error(`unexpected table ${table}`);
    });
  });

  test.each([
    ['active claim', 'STRIPE_CHARGE_IN_PROGRESS', false],
    ['ambiguous outcome', 'STRIPE_AMBIGUOUS_OUTCOME', true],
  ])('does not mint a second PaymentIntent during an %s', async (_label, code, reconciliationRequired) => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(reconciliationRequired);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired,
      }));
    });

    expect(StripeService.createInvoicePaymentIntent).not.toHaveBeenCalled();
    if (reconciliationRequired) {
      expect(StripeService.parkInvoiceForSavedCardReconciliation).toHaveBeenCalledWith(expect.objectContaining({
        invoiceId: 'inv-1',
      }));
    } else {
      expect(StripeService.parkInvoiceForSavedCardReconciliation).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['update-amount', { paymentIntentId: 'pi-old', methodCategory: 'card' }, 'updateInvoicePaymentIntentMethod'],
    ['quote', { paymentMethodId: 'pm-old' }, 'quoteInvoiceSurcharge'],
    ['finalize', { quoteToken: 'quote-old' }, 'finalizeInvoicePayment'],
    ['confirm', { paymentIntentId: 'pi-old' }, 'confirmInvoicePayment'],
  ])('fences an existing pay-page intent at /%s', async (route, body, serviceMethod) => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(false);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired: false,
      }));
    });

    expect(StripeService[serviceMethod]).not.toHaveBeenCalled();
  });

  test('returns the distinct saved-card state when the final serialized check loses', async () => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
    StripeService.finalizeInvoicePayment.mockRejectedValue(Object.assign(
      new Error('saved-card collection claimed before confirm'),
      {
        code: 'STRIPE_CHARGE_IN_PROGRESS',
        statusCode: 409,
        savedCardPending: true,
        reconciliationRequired: false,
      },
    ));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteToken: 'quote-token' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        inProgress: false,
        savedCardPending: true,
        reconciliationRequired: false,
      }));
    });
  });
});

describe('POST /api/pay/:token/setup stale-render (invoiceVersion) fence', () => {
  // Delivered invoices are editable (2026-07-17): a page opened before an
  // edit still renders the old line items while the invoice has no PI. The
  // client echoes the version its render came from; a mismatch must refuse
  // the mint so the customer never confirms a charge against details they
  // are not looking at.
  const UPDATED_AT = '2026-07-17T12:00:00.000Z';

  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return invoiceQuery({
          id: 'inv-1',
          token: 'public-token-0123456789',
          customer_id: 'cust-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          payer_statement_id: null,
          updated_at: UPDATED_AT,
        });
      }
      if (table === 'customers') {
        return invoiceQuery({ billing_mode: null, monthly_rate: 0 });
      }
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('refuses to mint a PaymentIntent when the page rendered an older invoice version', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceVersion: new Date(UPDATED_AT).getTime() - 5000 }),
      });
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.staleInvoice).toBe(true);
      expect(StripeService.createInvoicePaymentIntent).not.toHaveBeenCalled();
    });
  });

  test('a matching version passes the fence (request proceeds to the saved-card fence)', async () => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceVersion: new Date(UPDATED_AT).getTime() }),
      });
      const body = await response.json();
      expect(body.staleInvoice).toBeUndefined();
      expect(body.savedCardPending).toBe(true);
    });
  });

  test('a lock-window edit is caught by the in-txn recheck and maps to the reload 409', async () => {
    // The unlocked pre-check passes (the route read still matches the echoed
    // version) but an edit commits before the mint's FOR UPDATE lock — the
    // service recheck refuses and the route must surface the same
    // staleInvoice reload signal as the pre-check, not a generic conflict.
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
    StripeService.createInvoicePaymentIntent.mockRejectedValue(Object.assign(
      new Error('This invoice was just updated — refreshing to the latest version.'),
      { statusCode: 409, inProgress: false, staleInvoice: true },
    ));
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceVersion: new Date(UPDATED_AT).getTime() }),
      });
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.staleInvoice).toBe(true);
    });
    // The echoed version must ride into the mint so the service CAN recheck
    // it against the locked row.
    expect(StripeService.createInvoicePaymentIntent).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      expectedVersion: new Date(UPDATED_AT).getTime(),
    }));
  });

  test('clients that do not echo a version skip the check (backward compatible)', async () => {
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(
      Object.assign(new Error('saved-card collection is fenced'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }),
    );
    StripeService.savedCardChargeNeedsReconciliation.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      expect(body.staleInvoice).toBeUndefined();
      expect(body.savedCardPending).toBe(true);
    });
  });
});

// A packet invoice whose Bill-To moved to a third-party payer AFTER the
// homeowner already held a pay link keeps a collectible status and a NULL
// payer_id — the withdrawal lives only in the `payer_billed:` stamp. /confirm
// gated its collectibility assertion on the TERMINAL statuses, which is
// exactly the set these rows are not in, so an already-minted PaymentIntent
// could still settle customer funds against payer-owned debt (codex r25 P1).
describe('POST /api/pay/:token/confirm withdrawn-invoice fence', () => {
  const WITHDRAWN = {
    id: 'inv-1',
    token: 'public-token-0123456789',
    customer_id: 'cust-1',
    status: 'overdue',
    total: 100,
    credit_applied: 0,
    payer_statement_id: null,
    payer_id: null,
    scheduled_send_error: 'payer_billed:5:hold',
  };

  function mockInvoice(row) {
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoiceQuery(row);
      if (table === 'customers') return invoiceQuery({ billing_mode: null, monthly_rate: 0 });
      throw new Error(`unexpected table ${table}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    StripeService.assertNoInvoiceChargeReconciliationPending.mockResolvedValue(undefined);
  });

  test.each(['sent', 'viewed', 'overdue'])('refuses a withdrawn %s invoice', async (status) => {
    mockInvoice({ ...WITHDRAWN, status });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: 'pi-minted-before-the-payer' }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'This visit is now billed to a third-party payer and is no longer payable here',
      });
    });
    expect(StripeService.confirmInvoicePayment).not.toHaveBeenCalled();
  });

  test('a self-pay invoice still confirms', async () => {
    mockInvoice({ ...WITHDRAWN, scheduled_send_error: null });
    StripeService.confirmInvoicePayment.mockResolvedValue({ id: 'pay-1', status: 'paid', metadata: {} });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: 'pi-1' }),
      });
      // Past the fence is what this asserts — the downstream receipt work is
      // out of scope for this suite's mocks.
      await expect(response.json()).resolves.not.toEqual({
        error: 'This visit is now billed to a third-party payer and is no longer payable here',
      });
    });
    expect(StripeService.confirmInvoicePayment).toHaveBeenCalledWith('inv-1', 'pi-1');
  });

  // A retry delivery failure is not the same as a withdrawal: only the
  // `payer_billed:` prefix means the debt moved.
  test('an ordinary send error does not fence the confirm', async () => {
    mockInvoice({ ...WITHDRAWN, scheduled_send_error: 'smtp 550 mailbox unavailable' });
    StripeService.confirmInvoicePayment.mockResolvedValue({ id: 'pay-1', status: 'paid', metadata: {} });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/pay/public-token-0123456789/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: 'pi-1' }),
      });
      await expect(response.json()).resolves.not.toEqual({
        error: 'This visit is now billed to a third-party payer and is no longer payable here',
      });
    });
    expect(StripeService.confirmInvoicePayment).toHaveBeenCalled();
  });
});
