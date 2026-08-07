/**
 * /api/public/mcp route — the anonymous public MCP tool surface. Pins:
 *
 *  - the dark-ship gate (404 — not 403 — on POST and GET while
 *    GATE_MCP_PUBLIC is off, indistinguishable from a missing route);
 *  - the JSON-RPC surface via the shared plumbing (initialize identity,
 *    tools/list registry, batch caps, notifications → 202, unknown method);
 *  - tool behavior: read-only registry only; catalog tools filter to
 *    customer_visible active rows and NEVER select price columns; the
 *    pricing-ranges tool proxies the shared fail-closed producer (error →
 *    isError, payload passed through untouched); how_to_request_quote
 *    documents the real /calculate contract including the consent note and
 *    the exported service-key list;
 *  - the 64kb body cap (413 with a JSON-RPC error shape).
 *
 * feature-gates, db, the pricing-ranges producer, and public-quote (heavy
 * transitive imports) are stubbed; the real shared RPC plumbing runs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'mcpPublic' ? mockGateOn : false)),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockRangesResult = { ok: true, payload: { services: [], disclaimer: 'x' }, cacheable: true };
jest.mock('../routes/public-pricing-ranges', () => ({
  getPublicPricingRangesResult: jest.fn(() => Promise.resolve(mockRangesResult)),
}));

// public-quote pulls Twilio/newsletter/automation at require time — stub to
// just the export public-mcp consumes.
jest.mock('../routes/public-quote', () => ({
  PUBLIC_QUOTE_SERVICE_KEYS: ['pest', 'lawn', 'mosquito'],
}));

// db stub: chainable builder; every builder resolves to mockRows (thenable)
// or mockFirstRow (.first). Builders are captured so filter assertions can
// inspect recorded calls.
let mockRows = [];
let mockFirstRow = null;
let mockRejectWith = null;
const builders = [];
const CHAIN_METHODS = ['where', 'whereIn', 'whereRaw', 'whereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'groupBy', 'count', 'max'];
const makeBuilder = (table) => {
  const b = { table };
  CHAIN_METHODS.forEach((m) => { b[m] = jest.fn(() => b); });
  b.first = jest.fn(() => (mockRejectWith ? Promise.reject(mockRejectWith) : Promise.resolve(mockFirstRow)));
  b.then = (resolve, reject) => (mockRejectWith ? Promise.reject(mockRejectWith) : Promise.resolve(mockRows)).then(resolve, reject);
  builders.push(b);
  return b;
};
const mockDb = jest.fn((table) => makeBuilder(table));
mockDb.raw = jest.fn((sql) => ({ sql }));
jest.mock('../models/db', () => mockDb);

const express = require('express');
const publicMcpRouter = require('../routes/public-mcp');

let server;
let baseUrl;
beforeAll((done) => {
  // Mirror the prod mount order (server/index.js): gate + limiter + capped
  // parser BEFORE the 50 MB global parser, router after it.
  const app = express();
  app.use('/api/public/mcp', ...publicMcpRouter.publicMcpPreParsers);
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/public/mcp', publicMcpRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  mockGateOn = true;
  mockRows = [];
  mockFirstRow = null;
  mockRejectWith = null;
  builders.length = 0;
  mockRangesResult = { ok: true, payload: { services: [], disclaimer: 'x' }, cacheable: true };
});

async function rpc(payload, { headers = {} } = {}) {
  const res = await fetch(`${baseUrl}/api/public/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const callTool = (name, args) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const toolResult = (body) => JSON.parse(body.result.content[0].text);

describe('dark-ship gate', () => {
  test('gate off → POST 404 (indistinguishable from a missing route)', async () => {
    mockGateOn = false;
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(status).toBe(404);
  });

  test('gate off → GET 404 too', async () => {
    mockGateOn = false;
    const res = await fetch(`${baseUrl}/api/public/mcp`);
    expect(res.status).toBe(404);
  });

  test('gate on → GET 405 (stateless, no SSE)', async () => {
    const res = await fetch(`${baseUrl}/api/public/mcp`);
    expect(res.status).toBe(405);
  });
});

describe('JSON-RPC surface', () => {
  test('initialize returns the public server identity, no auth required', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(status).toBe(200);
    expect(body.result.serverInfo).toEqual({ name: 'waves-public', version: '1.0.0' });
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities).toEqual({ tools: {} });
  });

  test('tools/list exposes exactly the 5 public read-only tools', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(['list_services', 'get_service', 'get_pricing_ranges', 'get_service_areas', 'how_to_request_quote']);
    // Registry entries never leak execute fns over the wire
    body.result.tools.forEach((t) => expect(t.execute).toBeUndefined());
  });

  test('unknown method → -32601; malformed message → -32600', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).body.error.code).toBe(-32601);
    expect((await rpc({ id: 1, method: 'ping' })).body.error.code).toBe(-32600);
  });

  test('notification-only request → 202 no body', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  test('batch caps: >20 messages and >5 tools/call both rejected', async () => {
    const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    expect((await rpc(big)).body.error.message).toMatch(/batch too large/);
    const tools = Array.from({ length: 6 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'list_services', arguments: {} } }));
    expect((await rpc(tools)).body.error.message).toMatch(/too many tools\/call/);
  });

  test('oversized body → 413 with JSON-RPC error shape', async () => {
    const { status, body } = await rpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }));
    expect(status).toBe(413);
    expect(body.error.code).toBe(-32600);
  });
});

describe('catalog tools', () => {
  test('list_services filters to active, non-archived, customer-visible rows and selects no price columns', async () => {
    mockRows = [{ service_key: 'pest_control', name: 'Pest Control', category: 'pest_control' }];
    const { body } = await callTool('list_services', {});
    expect(toolResult(body).services).toHaveLength(1);
    const b = builders.find((x) => x.table === 'services');
    expect(b.where).toHaveBeenCalledWith({ is_active: true, is_archived: false, customer_visible: true });
    const selected = b.select.mock.calls[0][0];
    expect(selected).not.toEqual(expect.arrayContaining(['base_price']));
    expect(selected).not.toEqual(expect.arrayContaining(['price_range_min']));
    expect(selected).toEqual(expect.arrayContaining(['service_key', 'name', 'description', 'frequency']));
  });

  test('get_service returns the row; unknown key → isError', async () => {
    mockFirstRow = { service_key: 'pest_control', name: 'Pest Control' };
    const found = await callTool('get_service', { service_key: 'pest_control' });
    expect(toolResult(found.body).name).toBe('Pest Control');
    const b = builders.find((x) => x.table === 'services');
    expect(b.where).toHaveBeenCalledWith(expect.objectContaining({ customer_visible: true }));

    mockFirstRow = null;
    const missing = await callTool('get_service', { service_key: 'nope' });
    expect(missing.body.result.isError).toBe(true);
  });

  test('get_service_areas returns active rows ordered by display_order', async () => {
    mockRows = [{ city: 'Bradenton', county: 'Manatee', is_primary: true }];
    const { body } = await callTool('get_service_areas', {});
    expect(toolResult(body).serviceAreas[0].city).toBe('Bradenton');
    const b = builders.find((x) => x.table === 'service_areas');
    expect(b.where).toHaveBeenCalledWith({ active: true });
    expect(b.orderBy).toHaveBeenCalledWith('display_order', 'asc');
  });

  test('tool crash → generic failure, no internals leaked', async () => {
    mockRejectWith = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const { body } = await callTool('list_services', {});
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });
});

describe('get_pricing_ranges', () => {
  test('passes the shared producer payload through untouched', async () => {
    mockRangesResult = { ok: true, payload: { currency: 'USD', services: [{ key: 'pest', low: 45, high: 65 }] }, cacheable: true };
    const { body } = await callTool('get_pricing_ranges', {});
    expect(toolResult(body)).toEqual(mockRangesResult.payload);
  });

  test('producer failure → isError with the producer message (fail closed, no stale payload)', async () => {
    mockRangesResult = { ok: false, error: 'pricing configuration temporarily unavailable' };
    const { body } = await callTool('get_pricing_ranges', {});
    expect(body.result.isError).toBe(true);
    expect(toolResult(body).error).toMatch(/temporarily unavailable/);
  });
});

describe('how_to_request_quote', () => {
  test('documents the real /calculate contract: endpoint, contact gate, exported service keys, consent note', async () => {
    const { body } = await callTool('how_to_request_quote', {});
    const doc = toolResult(body);
    expect(doc.quoteApi.endpoint).toBe('https://portal.wavespestcontrol.com/api/public/quote/calculate');
    expect(doc.quoteApi.method).toBe('POST');
    expect(Object.keys(doc.quoteApi.requiredFields)).toEqual(
      expect.arrayContaining(['firstName', 'lastName', 'email', 'phone', 'address', 'services']),
    );
    // Service keys come from public-quote's export, not a divergent copy
    expect(doc.quoteApi.requiredFields.services).toContain('pest, lawn, mosquito');
    expect(doc.quoteApi.sideEffects).toMatch(/consent/i);
    expect(doc.webAlternatives.quotePage).toMatch(/wavespestcontrol\.com/);
  });
});
