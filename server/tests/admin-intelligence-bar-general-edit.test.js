/**
 * The general admin edit (owner ruling 2026-10-12) through the REAL /query and
 * /confirm-action routes. The route wires four things for it: the card's
 * display params, the request's own Authorization on the action context at the
 * preview AND at the commit, the approved pin stored on the pending action, and
 * the owner-only guard. Only the pending-action store and the model are
 * stand-ins; the edit endpoint is the loopback fetch, mocked.
 *
 * Harness mirrors admin-intelligence-bar-general-read.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GATE_IB_PLATFORM = 'true';
process.env.GATE_IB_GENERAL_EDIT = 'true';

const mockMessagesCreate = jest.fn();
const mockInsert = jest.fn(async () => undefined);
const mockToolEvent = jest.fn();
const mockCreatePending = jest.fn();
const mockClaimForConfirm = jest.fn();
const mockRecordResult = jest.fn(async () => true);

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
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  paramsHash: jest.requireActual('../services/intelligence-bar/pending-actions').paramsHash,
  createPendingAction: (...args) => mockCreatePending(...args),
  approvedCardParams: jest.fn(async ({ params }) => params),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  recordResult: (...args) => mockRecordResult(...args),
  getActionReceipt: jest.fn(async () => null),
  stepKey: jest.fn(() => 'step-1'),
}));
jest.mock('../services/intelligence-bar/tasks', () => ({
  begin: jest.fn(async () => ({ created: true, task: { id: 'task-1', runner_token: 'runner-1', state: 'running', session_id: 'session-1' } })),
  checkpoint: jest.fn(async () => undefined),
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
const { ADMIN_READ_HEADER, adminReadMarkerValue } = require('../utils/redact-request-url');
const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const OWNER = 'Bearer owner-token-abcdef';
const OTHER_ADMIN = 'Bearer other-admin-token-abcdef';
const LOOPBACK = `http://127.0.0.1:${Number(config.port)}/api/`;
const ID = '10000000-0000-4000-8000-00000000000a';
const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0020';
const INPUT = { method: 'PUT', endpoint: '/admin/sms-templates/:id', params: { id: ID }, body: { name: 'Reminder 24h', body: 'Hi {first_name}, see you tomorrow.' } };
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

async function post(baseUrl, route, authorization, body) {
  const res = await realFetch(`${baseUrl}/admin/intelligence-bar/${route}`, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let loopbackCalls;
let loopbackResponder;
beforeEach(() => {
  jest.clearAllMocks();
  loopbackCalls = [];
  loopbackResponder = () => ({ status: 200, body: { success: true, template: { api_key: 'sk_live_NOT_FOR_THE_MODEL' } } });
  mockCreatePending.mockImplementation(async ({ summary }) => ({ id: PENDING_ID, summary, status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() }));
  global.fetch = jest.fn(async (url, options) => {
    if (String(url).startsWith(LOOPBACK)) {
      loopbackCalls.push({ url: String(url), method: options.method, body: options.body, headers: { ...options.headers } });
      const { status, body } = loopbackResponder();
      return { status, headers: { get: key => ({ 'content-type': 'application/json' }[String(key).toLowerCase()] ?? null) }, text: async () => JSON.stringify(body) };
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

async function proposeThroughQuery(authorization = OWNER) {
  const seen = [];
  scriptModel([
    toolUse('t1', 'discover_capabilities', { query: 'reviewed admin edit confirm card' }),
    (request) => { seen.push(request.tools.map(t => t.name)); return toolUse('t2', 'propose_admin_edit', INPUT); },
    { content: [{ type: 'text', text: 'Please confirm the card.' }] },
  ]);
  const answer = await withServer(baseUrl => post(baseUrl, 'query', authorization, { prompt: 'change the reminder text wording', context: 'dashboard', session_id: 'session-1' }));
  return { answer, seen };
}

describe('the /query proposal', () => {
  test('mints ONE card with the carded fields, the approved pin and the preview fingerprint, and sends nothing', async () => {
    const { answer, seen } = await proposeThroughQuery();
    expect(answer.status).toBe(200);
    expect(seen[0]).toEqual(expect.arrayContaining(['find_admin_edits', 'propose_admin_edit']));
    expect(mockCreatePending).toHaveBeenCalledTimes(1);
    const stored = mockCreatePending.mock.calls[0][0];
    expect(stored.toolName).toBe('propose_admin_edit');
    expect(stored.params).toMatchObject({ method: 'PUT', endpoint: '/admin/sms-templates/:id', params: { id: ID }, body: INPUT.body });
    expect(stored.params._approved_edit_pin).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.params._two_step_preview_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The card: the edit, both fields, what it does not do, and the same-endpoint line.
    const labels = stored.contract.effects.map(effect => effect.label).join('\n');
    expect(labels).toContain('Edit: Text message template: name and wording');
    expect(labels).toContain('name: (current value not shown) → Reminder 24h');
    expect(labels).toMatch(/No text is sent or queued now/);
    expect(stored.contract).toMatchObject({ tool: 'propose_admin_edit', tier: 'yellow', action_label: 'Edit an admin record', notifies_customer: false });
    // The model is told to wait for the operator, and sees the pin-free preview.
    const toolResult = JSON.stringify(mockMessagesCreate.mock.calls.slice(-1)[0][0].messages.slice(-1)[0]);
    expect(toolResult).toContain('pending_confirmation');
    expect(toolResult).toContain('Reminder 24h');
    expect(loopbackCalls).toHaveLength(0);
  });

  test('an admin login without full access never gets the tools, and a forced call mints no card', async () => {
    const { answer, seen } = await proposeThroughQuery(OTHER_ADMIN);
    expect(answer.status).toBe(200);
    for (const list of seen) {
      expect(list).not.toContain('propose_admin_edit');
      expect(list).not.toContain('find_admin_edits');
    }
    expect(mockCreatePending).not.toHaveBeenCalled();
    expect(loopbackCalls).toHaveLength(0);
  });

  test('with the gate off the owner login does not get the tools, and a forced call mints no card', async () => {
    process.env.GATE_IB_GENERAL_EDIT = 'false';
    try {
      const { answer, seen } = await proposeThroughQuery();
      expect(answer.status).toBe(200);
      for (const list of seen) {
        expect(list).not.toContain('propose_admin_edit');
        expect(list).not.toContain('find_admin_edits');
      }
      expect(mockCreatePending).not.toHaveBeenCalled();
      expect(loopbackCalls).toHaveLength(0);
    } finally {
      process.env.GATE_IB_GENERAL_EDIT = 'true';
    }
  });

  test('the legacy tool list never offers them, whatever the login', () => {
    for (const context of ['customers', 'dashboard', 'ops', 'revenue', 'tech', 'agent_estimate']) {
      for (const [isAdmin, fullAccess] of [[true, true], [true, false], [false, false]]) {
        const names = intelligenceRouter.getToolsForContext(context, isAdmin, fullAccess).map(t => t.name);
        expect(names).not.toContain('propose_admin_edit');
        expect(names).not.toContain('find_admin_edits');
      }
    }
  });

  test('the query words of the finder, the bodies and the token are in no stored row, event or log line', async () => {
    const NOTE = 'Zelda Syntheticname 941-555-0100';
    scriptModel([
      toolUse('t1', 'discover_capabilities', { query: 'reviewed admin edit confirm card' }),
      toolUse('t2', 'find_admin_edits', { query: `${NOTE} template` }),
      toolUse('t3', 'propose_admin_edit', { ...INPUT, body: { name: NOTE } }),
      { content: [{ type: 'text', text: 'Please confirm the card.' }] },
    ]);
    await withServer(baseUrl => post(baseUrl, 'query', OWNER, { prompt: `edit the template for ${NOTE}`, context: 'dashboard', session_id: 'session-1' }));
    const kept = JSON.stringify({ inserts: mockInsert.mock.calls, events: mockToolEvent.mock.calls, logs: Object.values(logger).flatMap(fn => fn.mock.calls) });
    expect(kept).not.toContain('Zelda');
    expect(kept).not.toContain('941-555-0100');
    expect(kept).not.toContain('owner-token-abcdef');
    expect(mockToolEvent.mock.calls.some(([event]) => event.toolName === 'find_admin_edits')).toBe(true);
  });
});

// The card as /query stores it, then the real /confirm-action.
async function storedCard(extra = {}) {
  await proposeThroughQuery();
  const stored = mockCreatePending.mock.calls[0][0];
  const params = { ...stored.params, ...extra };
  mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'propose_admin_edit', params, contract: stored.contract } });
  return params;
}

async function confirm(authorization = OWNER) {
  return withServer(baseUrl => post(baseUrl, 'confirm-action', authorization, { pending_action_id: PENDING_ID }));
}

describe('the /confirm-action commit', () => {
  test('sends exactly the carded body once, with the confirming request\'s own token, and returns a receipt only', async () => {
    await storedCard();
    jest.clearAllMocks();
    const { status, body } = await confirm();
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, outcome: 'completed', tool: 'propose_admin_edit' });
    expect(loopbackCalls).toHaveLength(1);
    const call = loopbackCalls[0];
    expect(call.method).toBe('PUT');
    expect(new URL(call.url).pathname).toBe(`/api/admin/sms-templates/${ID}`);
    expect(JSON.parse(call.body)).toEqual(INPUT.body);
    expect(call.headers.Authorization).toBe(OWNER);
    expect(call.headers[ADMIN_READ_HEADER]).toBe(adminReadMarkerValue([2]));
    expect(body.result).toMatchObject({ success: true, fields_changed: ['body', 'name'], record: { id: ID } });
    expect(JSON.stringify(body)).not.toContain('sk_live_NOT_FOR_THE_MODEL');
    expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, expect.objectContaining({ success: true }));
    expect(JSON.stringify(mockRecordResult.mock.calls)).not.toContain('owner-token-abcdef');
  });

  test('a body changed in the stored card after it was shown sends nothing', async () => {
    await storedCard({ body: { ...INPUT.body, name: 'Sneaky name' } });
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(loopbackCalls).toHaveLength(0);
  });

  test('a field added to the stored card sends nothing', async () => {
    await storedCard({ body: { ...INPUT.body, is_active: false } });
    const { status, body } = await confirm();
    expect([400, 409]).toContain(status);
    expect(JSON.stringify(body)).toMatch(/not allowed|changed after the card/);
    expect(loopbackCalls).toHaveLength(0);
  });

  test('a stored pin from another card, or none, sends nothing', async () => {
    await storedCard({ _approved_edit_pin: 'f'.repeat(32) });
    expect((await confirm()).status).toBe(409);
    await storedCard({ _approved_edit_pin: undefined });
    expect((await confirm()).status).toBe(409);
    expect(loopbackCalls).toHaveLength(0);
  });

  test('a card the preview fingerprint no longer matches sends nothing', async () => {
    await storedCard({ _two_step_preview_fingerprint: previewFingerprint({ preview: true, other: 1 }) });
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(loopbackCalls).toHaveLength(0);
  });

  test('another admin login cannot confirm: the owner-only guard answers 403 before any edit', async () => {
    await storedCard();
    const { status, body } = await confirm(OTHER_ADMIN);
    expect(status).toBe(403);
    expect(body.error).toMatch(/limited to the owner account/);
    expect(loopbackCalls).toHaveLength(0);
  });

  test('with the gate off by the time of Confirm, nothing is sent', async () => {
    await storedCard();
    process.env.GATE_IB_GENERAL_EDIT = 'false';
    try {
      const { status, body } = await confirm();
      expect(status).toBe(409);
      expect(body.preview_changed).toBe(true);
      expect(loopbackCalls).toHaveLength(0);
    } finally {
      process.env.GATE_IB_GENERAL_EDIT = 'true';
    }
  });

  test('a refusal from the screen\'s own endpoint is shown as a refusal, with its message', async () => {
    await storedCard();
    loopbackResponder = () => ({ status: 400, body: { error: 'This template must keep {first_name}' } });
    const { body } = await confirm();
    expect(body.success).toBe(false);
    expect(body.result).toMatchObject({ success: false, code: 'endpoint_rejected', error: 'This template must keep {first_name}' });
    expect(loopbackCalls).toHaveLength(1);
  });
});

describe('source contract: the route carries the token and the pin and nothing else', () => {
  const fs = require('fs');
  const path = require('path');
  const route = fs.readFileSync(path.join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');

  test('the preview, the commit preflight and the commit pass the request\'s Authorization header', () => {
    expect(route).toMatch(/executeToolByName\(toolUse\.name, \{ \.\.\.params \}, null, \{ fullAccess: ibFullAccess\(req\), staffAuthorization: req\.headers\.authorization \}\)/);
    expect(route.match(/fullAccess: ibFullAccess\(req\), staffAuthorization: req\.headers\.authorization,\n\s+confirmed: (false|true),/g)).toHaveLength(2);
  });

  test('the approved pin is stored from the card\'s own preview, never from model input', () => {
    expect(route).toContain("if (toolUse.name === 'propose_admin_edit' && preview?._version) params._approved_edit_pin = preview._version;");
  });
});
