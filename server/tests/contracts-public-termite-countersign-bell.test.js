/**
 * POST /api/contracts/:token/sign — the countersign-needed admin bell for
 * the termite annual protection agreement (owner ruling 2026-09-25, A-14).
 * Fires ONLY for the annual template key, is fire-and-forget, deduped per
 * contract, and never blocks or fails the customer's sign response.
 *
 * Full mocked-db behavioral test (not just a source-pattern check) — the
 * mock builder pattern here follows admin-contracts-share-link.test.js /
 * admin-contracts-countersign.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'countersign-bell-test-secret';

const { hashContractToken } = require('../services/contracts');

const ANNUAL_KEY = 'service_agreement.termite_annual_protection';
const OTHER_DOC_KEY = 'service_agreement.termite_bait_program_purchase';

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
jest.mock('../services/termite-program-agreement', () => ({ ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }) }));

const express = require('express');
const db = require('../models/db');
const contractsPublic = require('../routes/contracts-public');
const { sendSignedContractCopy } = require('../services/contract-signed-email');
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
    document_template_key: ANNUAL_KEY,
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
});

const signBody = { signedName: 'Sam Customer', initials: 'SC', agreeElectronic: true, agreeDocumentTerms: true };

describe('countersign-needed bell', () => {
  test('fires for the termite annual protection template, with a per-contract dedupe key and no block on the sign response', async () => {
    wireCustomerContracts(preSignRow());
    let status; let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/contracts/${TOKEN}/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBody),
      });
      status = res.status; body = await res.json();
    });
    expect(status).toBe(200);
    expect(body.signed).toBe(true);
    expect(sendSignedContractCopy).toHaveBeenCalledWith(CONTRACT_ID);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, msg, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('document');
    expect(title).toMatch(/countersign needed/i);
    expect(msg).toMatch(/Sam Customer/);
    expect(opts.dedupeKey).toBe(`termite-annual-countersign:${CONTRACT_ID}`);
    expect(opts.link).toBe('/admin/contracts?tab=requests&status=signed');
    expect(opts.metadata).toEqual({ customerId: 'cust-1', contractId: CONTRACT_ID });
  });

  test('does not fire for a different document template (e.g. the quarterly purchase agreement) — the email copy still sends', async () => {
    wireCustomerContracts(preSignRow({ document_template_key: OTHER_DOC_KEY }));
    let status;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/contracts/${TOKEN}/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBody),
      });
      status = res.status;
    });
    expect(status).toBe(200);
    expect(sendSignedContractCopy).toHaveBeenCalledWith(CONTRACT_ID);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a notifyAdmin rejection is swallowed — never surfaces as a sign failure', async () => {
    NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('boom'));
    wireCustomerContracts(preSignRow());
    let status; let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/contracts/${TOKEN}/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBody),
      });
      status = res.status; body = await res.json();
    });
    expect(status).toBe(200);
    expect(body.signed).toBe(true);
  });
});
