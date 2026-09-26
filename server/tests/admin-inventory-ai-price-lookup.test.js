/**
 * POST /ai-price-lookup — Claude + web-search agent that proposes vendor
 * prices for the approval queue.
 *
 * Codex r8 on #4884: the response schema check only verified "results is an
 * array of plain objects" — {"results":[{}]} passed it, the approval loop
 * then skipped the entry (no vendor/price), and the response still reported
 * `approvalsCreated: parsed.results.length` (1) even though nothing was
 * inserted. Fixed:
 *   - a nonempty `results` array with no USABLE entry (vendor + a real
 *     price) is recorded as a ledger failure, not a success
 *   - `approvalsCreated` counts actual `price_approvals` inserts, never the
 *     raw entry count
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

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const express = require('express');
const db = require('../models/db');
const inventoryRouter = require('../routes/admin-inventory');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VENDOR_ROW = { id: 'v-acme', name: 'Acme Supply', website: 'acme.example', type: 'distributor' };

function makeChain(table, resolve) {
  const q = { _table: table, _calls: [] };
  ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'join', 'leftJoin', 'limit', 'offset', 'forUpdate', 'returning', 'groupBy']
    .forEach((m) => { q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; }); });
  q.insert = jest.fn((...args) => { q._calls.push(['insert', args]); return q; });
  q.first = jest.fn(async () => { q._calls.push(['first', []]); return resolve(q); });
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(q)).then(onOk, onErr);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

// insertShouldFail: when true, a price_approvals insert throws (simulating
// a DB error) so approvalsCreated must still reflect what actually landed.
function wireDb({ insertShouldFail = false } = {}) {
  const inserts = [];
  const resolve = (q) => {
    if (q._table === 'vendors') return [VENDOR_ROW];
    if (q._table === 'vendor_pricing') return null; // no existing price on file
    if (q._table === 'price_approvals' && q.called('insert')) {
      if (insertShouldFail) throw new Error('duplicate key value violates unique constraint');
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

const lookup = (baseUrl, body) => fetch(`${baseUrl}/admin/inventory/ai-price-lookup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productName: 'Taurus SC', productId: PRODUCT, ...body }),
});

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'NOW()') };
});

test('a results array with no usable entry ({}) is a ledger failure and creates zero approvals', async () => {
  wireDb();
  respondWith([{}]);
  await withServer(async (baseUrl) => {
    const res = await lookup(baseUrl);
    const body = await res.json();
    expect(body.approvalsCreated).toBe(0);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

test('a usable result (matching vendor + real price) creates exactly one approval and is not flagged', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: 'Acme Supply', price: 42.5, quantity: '32 oz', url: 'https://acme.example/x' }]);
  await withServer(async (baseUrl) => {
    const res = await lookup(baseUrl);
    const body = await res.json();
    expect(body.approvalsCreated).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ product_id: PRODUCT, vendor_id: 'v-acme', new_price: 42.5 });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

test('a junk entry alongside a usable one is skipped, not flagged, and counts only the real insert', async () => {
  const inserts = wireDb();
  respondWith([{}, { vendor: 'Acme Supply', price: 42.5 }]);
  await withServer(async (baseUrl) => {
    const res = await lookup(baseUrl);
    const body = await res.json();
    expect(body.approvalsCreated).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

test('approvalsCreated reflects actual inserts, not the usable-entry count — an insert failure counts as zero', async () => {
  wireDb({ insertShouldFail: true });
  respondWith([{ vendor: 'Acme Supply', price: 42.5 }]);
  await withServer(async (baseUrl) => {
    const res = await lookup(baseUrl);
    const body = await res.json();
    expect(body.approvalsCreated).toBe(0);
    // The entry itself was well-shaped, so this is not a schema failure.
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

test('a strictly numeric price string is usable and inserted as a number (Codex r12 on #4884)', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: 'Acme Supply', price: ' 42.50 ' }]);
  await withServer(async (baseUrl) => {
    const body = await (await lookup(baseUrl)).json();
    expect(body.approvalsCreated).toBe(1);
    expect(inserts[0]).toMatchObject({ new_price: 42.5 });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

test('a non-numeric, zero or negative price is not usable', async () => {
  wireDb();
  respondWith([{ vendor: 'Acme Supply', price: 'about $40' }, { vendor: 'Acme Supply', price: 0 }, { vendor: 'Acme Supply', price: '-3' }, { vendor: 'Acme Supply', price: '0' }]);
  await withServer(async (baseUrl) => {
    const body = await (await lookup(baseUrl)).json();
    expect(body.approvalsCreated).toBe(0);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

test('an intentionally empty results array stays a success', async () => {
  wireDb();
  respondWith([]);
  await withServer(async (baseUrl) => {
    const res = await lookup(baseUrl);
    const body = await res.json();
    expect(body.approvalsCreated).toBe(0);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

// Codex r14 on #4884: a positive price under an invented or misspelled vendor
// can never become an approval, so a batch of only those must not read as a
// successful call. Matching is on the requested vendor's name, trimmed and
// case-insensitive; quantity/url/notes are cleaned so they cannot fail the insert.
test('results only from vendors that were never requested are a ledger failure and create zero approvals', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: 'Acme Suply', price: 42.5 }, { vendor: 'Some Other Store', price: 39.99 }]);
  await withServer(async (baseUrl) => {
    const body = await (await lookup(baseUrl)).json();
    expect(body.approvalsCreated).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

test('a requested vendor named with different case and spacing still matches; optional fields are cleaned', async () => {
  const inserts = wireDb();
  respondWith([{ vendor: ' ACME supply', price: 42.5, quantity: 32, url: 'not a url', notes: { n: 1 } }]);
  await withServer(async (baseUrl) => {
    const body = await (await lookup(baseUrl)).json();
    expect(body.approvalsCreated).toBe(1);
    expect(inserts[0]).toMatchObject({ vendor_id: 'v-acme', new_price: 42.5, new_quantity: '32', source_url: null, notes: 'AI agent lookup — ' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});
