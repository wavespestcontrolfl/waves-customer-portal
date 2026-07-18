/**
 * /api/mcp route — the machine-auth MCP knowledge server (lane C). Pins:
 *
 *  - the three-layer fail-closed auth ORDER (403 gate-off before 503
 *    unconfigured before 401 mismatch) — the endpoint must be unusable in any
 *    environment until deliberately armed, and must not leak whether a token
 *    is configured while the gate is off;
 *  - the JSON-RPC surface (initialize / ping / tools/list / tools/call,
 *    notifications → 202, unknown method → -32601, batch cap);
 *  - tool behavior: read-only registry only, unknown tool → isError, tool
 *    crash → generic failure (no internals in the response), search degrades
 *    to FTS-only when the embedder is unavailable, snippets truncate.
 *
 * The real safeEqual and JSON-RPC plumbing run; feature-gates, db, the
 * embedder, and the logger are stubbed.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'mcpReadTools' ? mockGateOn : false)),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEmbedQuery = jest.fn();
jest.mock('../services/llm/embed', () => ({
  embedQuery: (...args) => mockEmbedQuery(...args),
  embedTexts: jest.fn(),
  OPENAI_EMBEDDINGS_API: 'stub',
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
const mcpRouter = require('../routes/mcp');

const TOKEN = 'test-mcp-service-token';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  mockGateOn = true;
  process.env.MCP_SERVICE_TOKEN = TOKEN;
  mockRows = [];
  mockFirstRow = null;
  mockRejectWith = null;
  builders.length = 0;
  mockEmbedQuery.mockReset().mockResolvedValue({ ok: false, reason: 'unconfigured' });
});

async function rpc(payload, { token = TOKEN, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const callTool = (name, args) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const toolResult = (body) => JSON.parse(body.result.content[0].text);

describe('auth — fail-closed order', () => {
  test('gate off → 403 even with a valid token (no config leak)', async () => {
    mockGateOn = false;
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(status).toBe(403);
  });

  test('gate on but MCP_SERVICE_TOKEN unset → 503', async () => {
    delete process.env.MCP_SERVICE_TOKEN;
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(status).toBe(503);
  });

  test('wrong or missing credential → 401', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'wrong' })).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: null })).status).toBe(401);
  });

  test('X-MCP-Token header is accepted as an alternative to Bearer', async () => {
    const { status, body } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { token: null, headers: { 'x-mcp-token': TOKEN } },
    );
    expect(status).toBe(200);
    expect(body.result).toEqual({});
  });

  test('GET is authenticated then 405 (stateless server, no SSE)', async () => {
    const withAuth = await fetch(`${baseUrl}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(withAuth.status).toBe(405);
    mockGateOn = false;
    const gateOff = await fetch(`${baseUrl}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(gateOff.status).toBe(403);
  });
});

describe('JSON-RPC plumbing', () => {
  test('initialize returns protocol version, capabilities, server info', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
    expect(status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe('waves-knowledge');
  });

  test('tools/list exposes exactly the read-only registry', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_protocol', 'get_service', 'list_sources', 'search_knowledge', 'search_resolutions']);
    body.result.tools.forEach((t) => {
      expect(t.inputSchema).toBeDefined();
      expect(t.execute).toBeUndefined(); // implementation never serializes out
    });
  });

  test('malformed message → -32600; unknown method → -32601', async () => {
    expect((await rpc({ id: 1, method: 'ping' })).body.error.code).toBe(-32600);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).body.error.code).toBe(-32601);
  });

  test('notifications (no id) are accepted silently with 202', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  test('batches answer per-message and reject over the cap', async () => {
    const { body } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'nope' },
    ]);
    expect(body).toHaveLength(2); // notification contributes no response
    expect(body[0].result).toEqual({});
    expect(body[1].error.code).toBe(-32601);

    const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const capped = await rpc(big);
    expect(capped.body.error.code).toBe(-32600);
    expect(capped.body.error.message).toMatch(/batch too large/);
  });
});

describe('tools', () => {
  test('unknown tool → isError with no crash', async () => {
    const { body } = await callTool('drop_tables', {});
    expect(body.result.isError).toBe(true);
    expect(toolResult(body).error).toMatch(/unknown tool/);
  });

  test('get_protocol resolves dotted keys from the static config; bogus key → error', async () => {
    const { body } = await callTool('get_protocol', { protocol_key: 'pest' });
    expect(body.result.isError).toBe(false);
    expect(Array.isArray(toolResult(body).visits)).toBe(true);

    const nested = await callTool('get_protocol', { protocol_key: 'lawn.st_augustine' });
    expect(Array.isArray(toolResult(nested.body).visits)).toBe(true);

    const bogus = await callTool('get_protocol', { protocol_key: 'nuke_everything' });
    expect(bogus.body.result.isError).toBe(true);
    expect(toolResult(bogus.body).error).toMatch(/not found/);
  });

  test('get_service returns the row or a not-found error', async () => {
    mockFirstRow = { service_key: 'pest_general_quarterly', name: 'General Pest Control (Quarterly)' };
    const found = await callTool('get_service', { service_key: 'pest_general_quarterly' });
    expect(toolResult(found.body).name).toBe('General Pest Control (Quarterly)');

    mockFirstRow = null;
    const missing = await callTool('get_service', { service_key: 'nope' });
    expect(missing.body.result.isError).toBe(true);
  });

  test('list_sources maps counts per corpus', async () => {
    mockRows = [{ source: 'kb', chunks: '202', last_updated: '2026-07-18T00:00:00Z' }];
    const { body } = await callTool('list_sources', {});
    expect(toolResult(body).sources).toEqual([{ source: 'kb', chunks: 202, lastUpdated: '2026-07-18T00:00:00Z' }]);
  });

  test('search degrades to FTS-only when the embedder is unavailable', async () => {
    mockRows = [{ source: 'wiki', source_id: 'chinch-bugs', title: 'Chinch bugs', content: 'x'.repeat(600), rank: 0.9 }];
    const { body } = await callTool('search_knowledge', { query: 'chinch bug damage' });
    const result = toolResult(body);
    expect(result.usedVector).toBe(false);
    expect(result.results[0]).toMatchObject({ source: 'wiki', sourceId: 'chinch-bugs', title: 'Chinch bugs' });
    expect(result.results[0].snippet).toHaveLength(500);
    expect(typeof result.results[0].score).toBe('number');
  });

  test('search fuses vector + FTS when the embedder responds', async () => {
    mockEmbedQuery.mockResolvedValue({ ok: true, vector: [0.1, 0.2], model: 'stub' });
    mockRows = [{ source: 'kb', source_id: 'k1', title: 'T', content: 'c', rank: 0.5 }];
    const { body } = await callTool('search_knowledge', { query: 'anything' });
    const result = toolResult(body);
    expect(result.usedVector).toBe(true);
    expect(result.results).toHaveLength(1); // same doc in both lists fuses to one
  });

  test('a non-numeric limit falls back to the default instead of silently emptying results', async () => {
    mockRows = [{ source: 'kb', source_id: 'k1', title: 'T', content: 'c', rank: 0.5 }];
    const { body } = await callTool('search_knowledge', { query: 'anything', limit: 'abc' });
    expect(toolResult(body).results).toHaveLength(1);
  });

  test('empty query returns empty results without touching the db', async () => {
    const { body } = await callTool('search_knowledge', { query: '   ' });
    expect(toolResult(body).results).toEqual([]);
    expect(builders).toHaveLength(0);
  });

  test('search_resolutions pins the source filter to resolution', async () => {
    mockRows = [];
    await callTool('search_resolutions', { query: 'refund for missed visit' });
    const filtered = builders.filter((b) => b.whereIn.mock.calls.some(
      ([col, vals]) => col === 'source' && Array.isArray(vals) && vals.join() === 'resolution',
    ));
    expect(filtered.length).toBeGreaterThan(0);
  });

  test('a crashing tool returns a generic failure, not internals', async () => {
    mockRejectWith = new Error('connection refused to 10.0.0.7:5432');
    const { body } = await callTool('list_sources', {});
    expect(body.result.isError).toBe(true);
    expect(toolResult(body).error).toBe('tool execution failed');
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.0\.7/);
  });
});
