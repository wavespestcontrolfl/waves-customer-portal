/**
 * GET /api/contracts/:token for the Florida consumer notice (GATE_ESTIMATE_CONSUMER_NOTICE): a notice issued from the
 * estimate page carries fromEstimate: true, so the signing page can offer "Back to your estimate". Every other
 * contract keeps its payload exactly (no new key), and the estimate id/token never appear in it.
 * Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

let mockRow;
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['leftJoin', 'select', 'where']) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(async () => mockRow);
  const fn = jest.fn(() => chain);
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayEnabled: jest.fn() }));
jest.mock('../services/termite-annual-activation', () => ({ ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection' }));

const express = require('express');
const contractsPublic = require('../routes/contracts-public');

const TOKEN = 'a'.repeat(48);
const row = (snapshot) => ({
  id: 'contract-1', customer_id: 'cust-1', contract_type: 'document_template', status: 'viewed', title: 'Consumer Notice Form (FDACS-13692)',
  recipient_name: 'Pat Owner', document_template_key: 'consumer_notice.fdacs_13692', contract_text_snapshot: 'form text',
  document_template_requires_signature: true, document_variables_snapshot: snapshot,
});

async function get() {
  const app = express();
  app.use('/api/contracts', contractsPublic);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts/${TOKEN}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('a notice issued from the estimate page is marked fromEstimate, with no estimate id in the payload', async () => {
  mockRow = row({ estimate: { id: 'est-1', source: 'estimate_consumer_notice' }, customer: { name: 'Pat Owner' } });
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body.contract).toMatchObject({ documentTemplateKey: 'consumer_notice.fdacs_13692', fromEstimate: true });
  expect(JSON.stringify(res.body)).not.toContain('est-1');
});

test.each([
  ['a notice staff issued by hand', { issuer: { name: 'Pat Office' } }],
  ['a commercial agreement that carries its own estimate marker', { estimate: { id: 'est-2', source: 'commercial_proposal_sign' } }],
  ['a contract with no snapshot', null],
])('%s has no fromEstimate key', async (_label, snapshot) => {
  mockRow = row(snapshot);
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body.contract).not.toHaveProperty('fromEstimate');
});
