/**
 * POST /api/contracts/:token/sign — the after-signature hook for the commercial proposal agreement
 * (GATE_COMMERCIAL_PROPOSAL_SIGN). It hands the signed contract to the service ONLY for the commercial
 * template key, after commit, and a failure there never fails the customer's sign response. What the
 * service then does (the deduped alert, the activity row) is commercial-proposal-agreement.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'countersign-bell-test-secret';

const { hashContractToken } = require('../services/contracts');

const COMMERCIAL_KEY = 'service_agreement.commercial_pest';
const OTHER_DOC_KEY = 'service_agreement.residential_pest';

function normalizeTable(table) {
  return String(table).replace(/ as \w+$/i, '');
}

let mockRows = {};
const mockWrites = [];

function mockBuilder(rawTable) {
  const table = normalizeTable(rawTable);
  const b = { table, filters: [] };
  const chain = () => b;
  for (const m of ['leftJoin', 'select', 'whereIn', 'whereNull', 'whereNotNull', 'forUpdate', 'orderBy', 'limit', 'where']) {
    if (m === 'where') continue;
    b[m] = jest.fn(chain);
  }
  b.where = jest.fn((...args) => { b.filters.push(args); return b; });
  b.first = jest.fn(async () => {
    const value = table in mockRows ? mockRows[table] : null;
    const resolved = typeof value === 'function' ? value(b) : value;
    return resolved ?? null;
  });
  b.update = jest.fn(async (payload) => {
    mockWrites.push({ table, op: 'update', payload, filters: b.filters.slice() });
    return mockRows.__updateResult ?? 1;
  });
  b.insert = jest.fn(async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; });
  return b;
}

jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockBuilder(table));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayEnabled: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/contract-signed-email', () => ({ sendSignedContractCopy: jest.fn().mockResolvedValue(undefined) }));
// The route keys both post-sign hooks (activation, then this bell) on the
// activation module's template key; activation itself is stubbed out here.
jest.mock('../services/termite-annual-activation', () => ({
  ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection',
  activateTermiteAnnualPlanForSignedContract: jest.fn().mockResolvedValue({ activated: true }),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }) }));
jest.mock('../services/commercial-proposal-agreement', () => ({
  handleAgreementSigned: jest.fn().mockResolvedValue({ alerted: true }),
  autopayNextStep: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const db = require('../models/db');
const contractsPublic = require('../routes/contracts-public');
const { sendSignedContractCopy } = require('../services/contract-signed-email');
const { handleAgreementSigned, autopayNextStep } = require('../services/commercial-proposal-agreement');
const NotificationService = require('../services/notification-service');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/contracts', contractsPublic);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const TOKEN = 'a'.repeat(43); // >=32 chars, passes publicTokenHash's length gate
const TOKEN_HASH = hashContractToken(TOKEN);
const CONTRACT_ID = 'contract-1';

function preSignRow(overrides = {}) {
  return {
    id: CONTRACT_ID,
    customer_id: 'cust-1',
    status: 'sent',
    share_token_hash: TOKEN_HASH,
    share_token_expires_at: null,
    contract_type: 'document_template',
    document_template_key: COMMERCIAL_KEY,
    payment_method_id: null,
    stripe_payment_method_id: null,
    requires_signature_snapshot: true,
    recipient_name: 'Sam Customer',
    ...overrides,
  };
}

// Call order for a document_template sign (see contracts-public.js /:token/sign):
//   1. contractPeek (id, customer_id)
//   2. locked (forUpdate)
//   3. contract (contractQuery, pre-sign)
//   4. updated (contractQuery, post-sign)
function wireCustomerContracts(base) {
  let call = 0;
  const responses = [
    { id: base.id, customer_id: base.customer_id },
    base,
    base,
    { ...base, status: 'signed', signed_at: new Date(), signed_name: 'Sam Customer' },
  ];
  mockRows.customer_contracts = () => responses[Math.min(call++, responses.length - 1)];
}

beforeEach(() => {
  mockWrites.length = 0;
  mockRows = { customers: { id: 'cust-1', active: true, deleted_at: null } };
  db.mockClear();
  sendSignedContractCopy.mockClear();
  NotificationService.notifyAdmin.mockClear();
  handleAgreementSigned.mockClear();
  autopayNextStep.mockClear();
});

const signBody = { signedName: 'Sam Customer', initials: 'SC', agreeElectronic: true, agreeDocumentTerms: true };

async function sign() {
  let status; let body;
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/contracts/${TOKEN}/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBody),
    });
    status = res.status; body = await res.json();
  });
  return { status, body };
}

describe('commercial proposal agreement sign hook', () => {
  test('a signed commercial agreement is handed to the service after commit; the customer copy still sends and no raw bell rings from the route', async () => {
    wireCustomerContracts(preSignRow());
    const { status, body } = await sign();
    expect(status).toBe(200);
    expect(body.signed).toBe(true);
    expect(handleAgreementSigned).toHaveBeenCalledTimes(1);
    expect(handleAgreementSigned).toHaveBeenCalledWith({ contractId: CONTRACT_ID });
    expect(sendSignedContractCopy).toHaveBeenCalledWith(CONTRACT_ID);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // No Auto Pay next step: the response is exactly the signed contract, no new key.
    expect(autopayNextStep).toHaveBeenCalledWith({ contractId: CONTRACT_ID });
    expect(body).not.toHaveProperty('autopaySetup');
  });

  test('an Auto Pay agreement answers with its next step, read BEFORE the office alert is raised (GATE_COMMERCIAL_AUTOPAY)', async () => {
    const order = [];
    autopayNextStep.mockImplementationOnce(async () => { order.push('next-step'); return { state: 'setup', url: 'https://portal.example/secure/tok' }; });
    handleAgreementSigned.mockImplementationOnce(async () => { order.push('alert'); return { alerted: true }; });
    wireCustomerContracts(preSignRow());
    const { status, body } = await sign();
    expect(status).toBe(200);
    expect(body.signed).toBe(true);
    expect(body.autopaySetup).toEqual({ state: 'setup', url: 'https://portal.example/secure/tok' });
    expect(order).toEqual(['next-step', 'alert']);
  });

  test('any other document template is untouched by the hook', async () => {
    wireCustomerContracts(preSignRow({ document_template_key: OTHER_DOC_KEY }));
    const { status } = await sign();
    expect(status).toBe(200);
    expect(handleAgreementSigned).not.toHaveBeenCalled();
    expect(autopayNextStep).not.toHaveBeenCalled();
    expect(sendSignedContractCopy).toHaveBeenCalledWith(CONTRACT_ID);
  });

  test('a service rejection is swallowed: the sign response is still the signed contract', async () => {
    handleAgreementSigned.mockRejectedValueOnce(new Error('boom'));
    wireCustomerContracts(preSignRow());
    const { status, body } = await sign();
    expect(status).toBe(200);
    expect(body.signed).toBe(true);
  });
});
