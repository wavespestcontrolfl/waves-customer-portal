/**
 * /api/public/a2a route — the anonymous informational A2A endpoint. Pins:
 *
 *  - the dark-ship gate (404 on POST and GET while GATE_A2A_PUBLIC is off);
 *  - message/send returns a single conforming A2A Message (kind/role/
 *    messageId/parts) whose static text carries the key pointers (MCP
 *    server, pricing surfaces, quote path, consent) and NO banned copy;
 *  - protocol edges: id required (no notifications), defined-but-
 *    unsupported A2A methods → -32004, unknown → -32601, batch arrays and
 *    malformed envelopes → -32600, GET → 405 when live;
 *  - the 64kb body cap (413 with a JSON-RPC error shape);
 *  - determinism: the reply text is identical across calls (no LLM, no
 *    per-request variance beyond messageId).
 *
 * feature-gates and the logger are stubbed; the real handler runs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'a2aPublic' ? mockGateOn : false)),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const publicA2aRouter = require('../routes/public-a2a');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/public/a2a', ...publicA2aRouter.publicA2aPreParsers);
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/public/a2a', publicA2aRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => { mockGateOn = true; });

async function rpc(payload) {
  const res = await fetch(`${baseUrl}/api/public/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('dark-ship gate', () => {
  test('gate off → POST and GET both 404', async () => {
    mockGateOn = false;
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'message/send' })).status).toBe(404);
    const res = await fetch(`${baseUrl}/api/public/a2a`);
    expect(res.status).toBe(404);
  });

  test('gate on → GET 405 (no streaming transport)', async () => {
    const res = await fetch(`${baseUrl}/api/public/a2a`);
    expect(res.status).toBe(405);
  });
});

describe('message/send', () => {
  test('returns a conforming A2A Message with the informational pointers', async () => {
    const { status, body } = await rpc({
      jsonrpc: '2.0', id: 7, method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'Do you treat termites in Sarasota?' }] } },
    });
    expect(status).toBe(200);
    expect(body.id).toBe(7);
    const m = body.result;
    expect(m.kind).toBe('message');
    expect(m.role).toBe('agent');
    expect(typeof m.messageId).toBe('string');
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0].kind).toBe('text');
    const text = m.parts[0].text;
    expect(text).toMatch(/Waves Pest Control/);
    expect(text).toMatch(/api\/public\/mcp/);
    expect(text).toMatch(/pricing\.md/);
    expect(text).toMatch(/consent/i);
    // Compliance: the static reply must never carry safety/re-entry claims
    expect(text).not.toMatch(/\bsafe\b/i);
    expect(text).not.toMatch(/EPA-registered/i);
  });

  test('reply text is deterministic across calls (messageId varies, copy does not)', async () => {
    const params = { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } };
    const a = (await rpc({ jsonrpc: '2.0', id: 1, method: 'message/send', params })).body.result;
    const b = (await rpc({ jsonrpc: '2.0', id: 2, method: 'message/send', params })).body.result;
    expect(a.parts[0].text).toBe(b.parts[0].text);
    expect(a.messageId).not.toBe(b.messageId);
  });

  test('missing or malformed MessageSendParams → -32602', async () => {
    for (const params of [undefined, {}, { message: 'hello' }, { message: { role: 'user' } }, { message: { role: 'user', parts: [] } }]) {
      const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'message/send', ...(params !== undefined ? { params } : {}) });
      expect(body.error.code).toBe(-32602);
    }
  });
});

describe('protocol edges', () => {
  test('id is required — A2A has no notifications', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', method: 'message/send' });
    expect(body.error.code).toBe(-32600);
  });

  test('defined-but-unsupported A2A methods → -32004, including the full push-config family', async () => {
    for (const method of ['message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe',
      'tasks/pushNotificationConfig/set', 'tasks/pushNotificationConfig/get',
      'tasks/pushNotificationConfig/list', 'tasks/pushNotificationConfig/delete']) {
      const { body } = await rpc({ jsonrpc: '2.0', id: 1, method });
      expect(body.error.code).toBe(-32004);
    }
  });

  test('non-string/non-integer ids → -32600 and are never echoed back', async () => {
    for (const id of [true, 1.5, { a: 1 }, [1]]) {
      const { body } = await rpc({ jsonrpc: '2.0', id, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: 'x' }] } } });
      expect(body.error.code).toBe(-32600);
      expect(body.id).toBeNull();
    }
  });

  test('unknown method → -32601; malformed envelope and batch array → -32600', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'agent/authenticatedExtendedCard' })).body.error.code).toBe(-32601);
    expect((await rpc({ id: 1, method: 'message/send' })).body.error.code).toBe(-32600);
    expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'message/send' }])).body.error.code).toBe(-32600);
  });

  test('oversized body → 413 with JSON-RPC error shape', async () => {
    const { status, body } = await rpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { pad: 'x'.repeat(70 * 1024) } }));
    expect(status).toBe(413);
    expect(body.error.code).toBe(-32600);
  });
});
