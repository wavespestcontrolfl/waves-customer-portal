jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test' }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn(() => ({ technicianId: 'tech-1' })), sign: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(),
  auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
}));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn() }));
jest.mock('stripe', () => jest.fn(() => ({ paymentIntents: { retrieve: jest.fn(), update: jest.fn() } })));

const express = require('express');
const Stripe = require('stripe');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');
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

test.each([true, false])('Terminal surcharge gate=%s refuses a late deposit before progressing its PI', async (enabled) => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(enabled);
  const invoice = {
    id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '100.00',
    credit_applied: '0.00', stripe_payment_intent_id: 'pi-terminal',
  };
  const queryFor = (row) => {
    const query = {};
    query.where = () => query;
    query.forUpdate = () => query;
    query.first = async () => row;
    return query;
  };
  db.mockImplementation((table) => {
    if (table === 'technicians') return queryFor({ id: 'tech-1', active: true, role: 'technician' });
    if (table === 'terminal_handoff_tokens') return queryFor({
      jti: 'handoff-1', used_at: new Date(), tech_user_id: 'tech-1',
      invoice_id: 'inv-1', amount_cents: 10000, stripe_payment_intent_id: 'pi-terminal',
    });
    if (table === 'invoices') return queryFor(invoice);
    throw new Error(`unexpected table ${table}`);
  });
  db.transaction = jest.fn(async (callback) => callback(db));
  assertInvoiceDepositSettlementReady.mockRejectedValue(Object.assign(
    new Error('A received deposit is awaiting invoice reconciliation'),
    { code: 'DEPOSIT_RECONCILIATION_REQUIRED', statusCode: 409 },
  ));

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stripe/terminal/apply-surcharge`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jti: 'handoff-1' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED' });
  });
  expect(assertInvoiceDepositSettlementReady).toHaveBeenCalledWith(db, invoice);
  expect(Stripe).not.toHaveBeenCalled();
});
