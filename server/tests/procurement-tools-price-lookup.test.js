/**
 * intelligence-bar/procurement-tools.js — run_price_lookup.
 *
 * Codex r8 on #4884: same shape bug as admin-inventory.js's /ai-price-lookup
 * route (the two share `isUsablePriceResult`, exported off the admin-inventory
 * router) — a `results` array with no usable entry (e.g. [{}]) passed the
 * "is it an array of plain objects" schema check and read as a successful
 * ledger call even though the approval loop skipped it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.adminUser = { id: 'admin-1', name: 'Owner' }; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
// runPriceLookup's `require('node-fetch') || global.fetch` line is dead code
// (the result is never used — the lookup runs the Claude call inline instead
// of an HTTP round trip) but node-fetch v3 is ESM-only and throws under
// Jest's CJS require, which would fail every test below before it reached
// the code under test. Stub it out; nothing in this file exercises it.
jest.mock('node-fetch', () => jest.fn());

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests) but spy
// on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const db = require('../models/db');
const { executeProcurementTool } = require('../services/intelligence-bar/procurement-tools');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const PRODUCT = { id: 'prod-1', name: 'Taurus SC', container_size: '20 oz' };
const VENDOR_ROW = { id: 'v-acme', name: 'Acme Supply', website: 'acme.example', active: true };

function makeChain(table, resolve) {
  const q = { _table: table, _calls: [] };
  ['where', 'whereIn', 'whereILike', 'whereNull', 'whereNotNull', 'select', 'orderBy', 'join', 'leftJoin', 'limit', 'offset', 'groupBy']
    .forEach((m) => { q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; }); });
  q.insert = jest.fn((...args) => { q._calls.push(['insert', args]); return q; });
  q.first = jest.fn(async () => { q._calls.push(['first', []]); return resolve(q); });
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(q)).then(onOk, onErr);
  return q;
}

function wireDb() {
  const inserts = [];
  const resolve = (q) => {
    if (q._table === 'products_catalog') return q.called('first') ? PRODUCT : [PRODUCT];
    if (q._table === 'vendors') return [VENDOR_ROW];
    if (q._table === 'price_approvals' && q.called('insert')) {
      inserts.push(q.args('insert')[0]);
      return [{ id: `approval-${inserts.length}` }];
    }
    return q.called('insert') ? 1 : [];
  };
  db.mockImplementation((table) => makeChain(table, resolve));
  return inserts;
}

function respondWith(results) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ product: 'Taurus SC', results, cheapest: results[0]?.vendor || null, summary: 'test' }) }],
  });
}

beforeEach(() => jest.clearAllMocks());

test('a results array with no usable entry ({}) is a ledger failure and creates zero approvals', async () => {
  wireDb();
  respondWith([{}]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(0);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('a usable result creates exactly one approval and is not flagged', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: 'Acme Supply', price: 55.25, quantity: '20 oz' }]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(1);
  expect(inserts).toHaveLength(1);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('a junk entry alongside a usable one is skipped, not flagged, and counts only the real insert', async () => {
  const inserts = wireDb();
  respondWith([{}, { vendor: 'Acme Supply', price: 55.25 }]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(1);
  expect(inserts).toHaveLength(1);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

test('an intentionally empty results array stays a success', async () => {
  wireDb();
  respondWith([]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(0);
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});

// Codex r14 on #4884: a positive price under an invented or misspelled vendor
// can never become an approval, so a batch of only those must not read as a
// successful call. Matching is on the requested vendor's name, trimmed and
// case-insensitive.
test('results only from vendors that were never requested are a ledger failure and create zero approvals', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: 'Acme Suply', price: 55.25 }, { vendor: 'Some Other Store', price: 49.99 }]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(0);
  expect(inserts).toHaveLength(0);
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

test('a requested vendor named with different case and spacing still matches; optional fields are cleaned', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: '  acme supply ', price: '55.25', quantity: { oz: 20 }, url: 'javascript:alert(1)' }]);
  const out = await executeProcurementTool('run_price_lookup', { product_name: 'Taurus SC' });
  expect(out.approvals_created).toBe(1);
  expect(inserts[0]).toMatchObject({ vendor_id: 'v-acme', new_price: 55.25, source_url: null });
  expect(ledgerCallRejected).not.toHaveBeenCalled();
});
