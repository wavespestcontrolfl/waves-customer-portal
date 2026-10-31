/**
 * GET /api/contracts/:token — the response is built from a second read made
 * after the view is recorded. A signature or a link rotation that commits
 * between the two reads burns or replaces the token, so the re-read can find
 * no row, or a signed or cancelled one. It must answer like any spent link
 * (404 / 410), for the JSON payload and the ?format=pdf review copy, and
 * never reach the renderer with a missing row (contracts audit F7).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contracts-get-reread-test-secret';

const { hashContractToken } = require('../services/contracts');

let mockContractReads = [];
const mockWrites = [];

function mockBuilder(rawTable) {
  const table = String(rawTable).replace(/ as \w+$/i, '');
  const b = { table };
  for (const m of ['leftJoin', 'select', 'where', 'whereIn', 'whereNull', 'forUpdate']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => (table === 'customer_contracts' ? mockContractReads.shift() ?? null : { first_name: 'Sam' }));
  b.update = jest.fn(async (payload) => { mockWrites.push({ table, op: 'update', payload }); return 1; });
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
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayEnabled: jest.fn() }));
jest.mock('../services/termite-annual-activation', () => ({ ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection' }));
jest.mock('../services/commercial-proposal-agreement', () => ({ SNAPSHOT_SOURCE: 'commercial_proposal_sign' }));
jest.mock('../services/pdf/contract-pdf', () => ({
  generateContractPDF: jest.fn(async (_contract, _customer, res) => res.status(200).type('application/pdf').send('%PDF-fake')),
}));

const express = require('express');
const contractsPublic = require('../routes/contracts-public');
const { generateContractPDF } = require('../services/pdf/contract-pdf');

const TOKEN = 'a'.repeat(43);
const SENT = {
  id: 'contract-1',
  customer_id: 'cust-1',
  status: 'sent',
  share_token_hash: hashContractToken(TOKEN),
  share_token_expires_at: null,
  contract_type: 'document_template',
  requires_signature_snapshot: true,
  title: 'Service agreement',
};

async function get(query = '') {
  const app = express();
  app.use('/api/contracts', contractsPublic);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts/${TOKEN}${query}`);
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
});

test.each([['JSON', ''], ['PDF', '?format=pdf']])('%s: a token burned by a signature between the two reads answers 404, not a server error', async (_kind, query) => {
  mockContractReads = [SENT, null];
  expect(await get(query)).toEqual({ status: 404, body: { error: 'Contract not found' } });
  expect(generateContractPDF).not.toHaveBeenCalled();
  // The view itself was still recorded on the first read's row.
  expect(mockWrites.map((w) => `${w.table}:${w.op}`)).toEqual(['customer_contracts:update', 'customer_contract_events:insert']);
});

test.each([
  ['signed', { status: 410, body: { error: 'Contract has already been signed', status: 'signed' } }],
  ['cancelled', { status: 410, body: { error: 'Contract is no longer available', status: 'cancelled' } }],
])('a re-read that finds the contract %s answers like that spent link, for JSON and PDF', async (status, expected) => {
  mockContractReads = [SENT, { ...SENT, status }];
  expect(await get()).toEqual(expected);
  mockContractReads = [SENT, { ...SENT, status }];
  expect(await get('?format=pdf')).toEqual(expected);
  expect(generateContractPDF).not.toHaveBeenCalled();
});

test('a link still live on the re-read renders as before', async () => {
  mockContractReads = [SENT, { ...SENT, status: 'viewed' }];
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body.contract).toMatchObject({ id: 'contract-1', status: 'viewed' });
  mockContractReads = [SENT, { ...SENT, status: 'viewed' }];
  expect(await get('?format=pdf')).toEqual({ status: 200, body: '%PDF-fake' });
  expect(generateContractPDF).toHaveBeenCalledTimes(1);
});
