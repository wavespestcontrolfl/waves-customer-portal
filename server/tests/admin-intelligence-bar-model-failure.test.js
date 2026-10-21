/**
 * POST /admin/intelligence-bar/query when the MODEL call fails
 * (GATE_IB_MODEL_FAILURE_NOTICE). 2026-10-19: the Anthropic monthly limit
 * (anthropic_400) ended every ask with a thrown error, "Error: <message>" in
 * the palette, no gap row and no alert. With the gate on the route answers 200
 * with a plain reply, records one quiet `ib-model` gap row and rings one admin
 * bell an hour; with it off the error path is unchanged. A saved change is
 * read from the task's receipts and never reported as "nothing was changed".
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-empty-reply-ledger.test.js.
 * The rolling-hour dedupe itself runs against PostgreSQL in
 * ib-model-failure-db.test.js; here the fake notifyAdmin honours the same
 * dedupeKey + dedupeWindowMs contract and the test pins what the route sends.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockWriteGapRows = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockMarkAdminDone = jest.fn();
const mockForTask = jest.fn();
const mockTaskCheckpoint = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: jest.fn(async () => undefined) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false),
    fastFailResult: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], UPDATABLE_FIELDS: {}, executeTool: jest.fn(), resolveTechnicianByName: jest.fn(), resolveActiveTechnicianById: jest.fn() }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false), loadReviewRecipient: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(), resolveCustomer: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(), previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500 }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
// actionReceipt stays the real projection so the outcomes read as production's.
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  ...jest.requireActual('../services/intelligence-bar/pending-actions'),
  forTask: (...args) => mockForTask(...args),
}));
// The saved task: begin hands back a running task, checkpoint remembers the last
// state + response, snapshot projects them as the real store does.
jest.mock('../services/intelligence-bar/tasks', () => {
  const task = { id: 'task-1', session_id: 'session-1', runner_token: 'runner-1', state: 'running', response: null };
  return {
    requestStartedAt: () => Date.now(),
    begin: jest.fn(async () => ({ task, created: true })),
    get: jest.fn(async () => task),
    checkpoint: jest.fn(async (id, actor, update) => {
      mockTaskCheckpoint(update);
      if (update.state) task.state = update.state;
      if (update.response) task.response = update.response;
    }),
    snapshot: jest.fn(async (saved) => ({ ...(saved.response || {}), taskId: saved.id, taskState: saved.state, pendingActions: [], receipts: [] })),
    _task: task,
  };
});
jest.mock('../services/intelligence-bar/task-context', () => ({
  ...jest.requireActual('../services/intelligence-bar/task-context'),
  resolve: jest.fn(async () => ({ target: null, targets: [], ambiguous: false })),
}));
jest.mock('../services/agent-gap-reports', () => ({
  ...jest.requireActual('../services/agent-gap-reports'),
  writeGapRows: (...args) => mockWriteGapRows(...args),
}));
jest.mock('../services/notification-service', () => ({
  ...jest.requireActual('../services/notification-service'),
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
  markAdminDone: (...args) => mockMarkAdminDone(...args),
}));
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Staff access required' })),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const IbTasks = require('../services/intelligence-bar/tasks');

const SESSION = '7e1c2f7a-1111-2222-3333-deadbeef0001';

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
  try { return await fn(baseUrl); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function postQuery(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const limitError = () => Object.assign(
  new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}'),
  { status: 400 },
);

// A fake notifyAdmin that honours dedupeKey + dedupeWindowMs the way the real one does.
function rollingDedupeNotify() {
  const rows = [];
  mockNotifyAdmin.mockImplementation(async (category, title, body, opts) => {
    const standing = rows.find((r) => r.dedupeKey === opts.dedupeKey && Date.now() - r.at < opts.dedupeWindowMs);
    if (standing) return { notification: standing, deduped: true };
    const row = { category, title, body, dedupeKey: opts.dedupeKey, at: Date.now(), opts };
    rows.push(row);
    return row;
  });
  return rows;
}

const PLATFORM_BODY = { prompt: 'what is on the schedule', context: 'customers', session_id: SESSION, request_key: 'request-key-0001' };
const savedRow = (overrides = {}) => ({
  id: 'act-1', tool_name: 'update_customer', summary: 'Update the customer phone number', status: 'confirmed',
  result: JSON.stringify({ success: true }), expires_at: new Date(Date.now() + 600000).toISOString(),
  consumed_at: new Date(), updated_at: new Date(), ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_IB_PLATFORM;
  process.env.GATE_IB_MODEL_FAILURE_NOTICE = 'true';
  mockWriteGapRows.mockResolvedValue([{ id: 7, occurrences: 1 }]);
  mockNotifyAdmin.mockResolvedValue({ id: 1 });
  mockForTask.mockResolvedValue([]);
  IbTasks._task.state = 'running';
  IbTasks._task.response = null;
});

afterAll(() => {
  delete process.env.GATE_IB_MODEL_FAILURE_NOTICE;
  delete process.env.GATE_IB_PLATFORM;
});

describe('gate on, platform off', () => {
  test('a monthly-limit failure answers 200 in plain words, records one quiet gap and rings one bell', async () => {
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'who is on the schedule today', context: 'customers', conversationHistory: [] });
      expect(status).toBe(200);
      expect(body.response).toMatch(/^The AI model did not answer this request \(error anthropic_400\)\./);
      expect(body.response).toContain('Nothing was changed.');
      expect(body.response).toMatch(/Try again in a few minutes\.$/);
      expect(body.response).not.toMatch(/specified API usage limits/);
      expect(body.modelFailure).toEqual({ code: 'anthropic_400' });
      expect(body.pendingActions).toEqual([]);
    });
    expect(mockWriteGapRows).toHaveBeenCalledTimes(1);
    const [signals, , options] = mockWriteGapRows.mock.calls[0];
    expect(signals).toEqual([expect.objectContaining({ source: 'ib-model', kind: 'blocked', code: 'anthropic_400' })]);
    expect(options).toEqual({ quiet: true });
    // The prompt text is never kept on the gap row.
    expect(JSON.stringify(signals)).not.toMatch(/schedule today/);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('agents');
    expect(title).toBe('System — check why the AI model is not answering');
    expect(why).toMatch(/1 failure recorded/);
    expect(opts).toEqual(expect.objectContaining({ dedupeKey: 'ib:model-failure:admin', dedupeWindowMs: 3600000, dedupeOpenOnly: true, link: '/admin/agents' }));
    expect(opts.detail).toContain('anthropic_400');
    expect(opts.metadata).toEqual(expect.objectContaining({ code: 'anthropic_400', severity: 'needs-you', who: 'person' }));
  });

  test('a second failure inside the hour leaves one bell', async () => {
    const rows = rollingDedupeNotify();
    mockMessagesCreate.mockRejectedValue(limitError());
    await withServer(async (baseUrl) => {
      expect((await postQuery(baseUrl, { prompt: 'first ask', context: 'customers' })).status).toBe(200);
      expect((await postQuery(baseUrl, { prompt: 'second ask', context: 'customers' })).status).toBe(200);
    });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(2);
    expect(mockNotifyAdmin.mock.calls[1][3]).toEqual(expect.objectContaining({ dedupeKey: mockNotifyAdmin.mock.calls[0][3].dedupeKey, dedupeWindowMs: 3600000 }));
    expect(rows).toHaveLength(1);
    expect(mockWriteGapRows).toHaveBeenCalledTimes(2); // the gap row counts every failure
  });

  test('a timeout is told as too slow, with its own code', async () => {
    mockMessagesCreate.mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toMatch(/^The AI model took too long to answer \(error anthropic_timeout\)\./);
    });
    expect(mockWriteGapRows.mock.calls[0][0][0].code).toBe('anthropic_timeout');
  });

  test('an overloaded provider (529) is told as busy', async () => {
    mockMessagesCreate.mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529 }));
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(body.response).toMatch(/^The AI model is too busy to answer right now \(error anthropic_529\)\./);
    });
  });

  test('a gap or bell write that throws still leaves the plain answer', async () => {
    mockWriteGapRows.mockRejectedValue(new Error('db down'));
    mockNotifyAdmin.mockRejectedValue(new Error('db down'));
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toContain('Try again in a few minutes.');
    });
  });

  test('an error that is not the model call (a bad reply shape) is not turned into a notice', async () => {
    mockMessagesCreate.mockResolvedValueOnce({}); // no content: the route throws after the call
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(status).toBe(500);
      expect(body.response).toBeUndefined();
    });
    expect(mockWriteGapRows).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('gate off', () => {
  test.each([[undefined], ['false'], ['1']])('GATE_IB_MODEL_FAILURE_NOTICE=%s keeps today\'s error, with no gap and no bell', async (value) => {
    if (value === undefined) delete process.env.GATE_IB_MODEL_FAILURE_NOTICE; else process.env.GATE_IB_MODEL_FAILURE_NOTICE = value;
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(status).toBe(400); // the provider's own status reaches the error handler, as before
      expect(body.error).toMatch(/usage limits/);
      expect(body.response).toBeUndefined();
    });
    expect(mockWriteGapRows).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('gate off with a saved task still marks it outcome_unknown', async () => {
    delete process.env.GATE_IB_MODEL_FAILURE_NOTICE;
    process.env.GATE_IB_PLATFORM = 'true';
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(status).toBe(400);
    });
    expect(mockTaskCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'outcome_unknown' }));
    expect(mockForTask).not.toHaveBeenCalled();
  });
});

describe('gate on, saved task (GATE_IB_PLATFORM)', () => {
  beforeEach(() => { process.env.GATE_IB_PLATFORM = 'true'; });

  test('nothing ran: the task ends failed (resumable) and the reply says nothing was changed', async () => {
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(status).toBe(200);
      expect(body.taskState).toBe('failed');
      expect(body.response).toContain('Nothing was changed.');
    });
    expect(mockTaskCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }));
  });

  test('a change saved earlier in the request is named, never reported as "nothing was changed"', async () => {
    mockForTask.mockResolvedValue([savedRow()]);
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(status).toBe(200);
      expect(body.response).toContain('Before the error, this was already saved: Update the customer phone number.');
      expect(body.response).toContain('Do not repeat what was saved.');
      expect(body.response).not.toMatch(/Nothing was changed/);
      expect(body.taskState).toBe('outcome_unknown');
    });
  });

  test('a change whose outcome is unknown is called unknown, and the task stays outcome_unknown', async () => {
    mockForTask.mockResolvedValue([savedRow({ summary: 'Reschedule the visit', result: JSON.stringify({ outcome: 'outcome_unknown' }) })]);
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(body.response).toContain('I cannot confirm whether this ran: Reschedule the visit.');
      expect(body.response).not.toMatch(/Nothing was changed/);
      expect(body.taskState).toBe('outcome_unknown');
    });
  });

  test('a confirmation card still waiting is said to be waiting, and the task stays awaiting_approval', async () => {
    mockForTask.mockResolvedValue([savedRow({ status: 'pending', result: null })]);
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(body.response).toContain('Nothing was changed. A confirmation card is still waiting for you');
      expect(body.taskState).toBe('awaiting_approval');
    });
  });

  test('receipts that cannot be read are never answered as "nothing was changed"', async () => {
    mockForTask.mockRejectedValue(new Error('db down'));
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, PLATFORM_BODY);
      expect(status).toBe(200);
      expect(body.response).toContain('I could not check whether any change was saved.');
      expect(body.response).not.toMatch(/Nothing was changed/);
      expect(body.taskState).toBe('outcome_unknown');
    });
  });
});

describe('review round 1 fixes (#6368)', () => {
  beforeEach(() => { process.env.GATE_IB_PLATFORM = 'true'; });

  test('a snapshot that throws after the checkpoint still answers the plain payload', async () => {
    IbTasks.snapshot.mockRejectedValueOnce(new Error('malformed receipt json'));
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { ...PLATFORM_BODY, request_key: 'request-key-0101' });
      expect(status).toBe(200);
      expect(body.response).toMatch(/^The AI model did not answer this request/);
      expect(body.taskId).toBe('task-1');
      expect(body.taskState).toBe('failed');
    });
  });

  test('unreadable receipts answer the cautious payload without a second receipt read', async () => {
    mockForTask.mockRejectedValue(new Error('db down'));
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { ...PLATFORM_BODY, request_key: 'request-key-0102' });
      expect(status).toBe(200);
      expect(body.response).toContain('I could not check whether any change was saved.');
      expect(body.taskState).toBe('outcome_unknown');
    });
    expect(IbTasks.snapshot).not.toHaveBeenCalled();
  });
});

describe('the standing bell closes when the model answers again', () => {
  test('closeFailureBellOnRecovery marks open ib:model-failure rows done once, then is a no-op', async () => {
    const db = require('../models/db');
    const select = jest.fn(async () => [{ id: 11 }, { id: 12 }]);
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain), select };
    db.mockImplementation(() => chain);
    mockMarkAdminDone.mockImplementation(async (ids) => ids.length);
    const ModelFailure = require('../services/intelligence-bar/model-failure');
    try {
      await expect(ModelFailure.closeFailureBellOnRecovery()).resolves.toBe(2);
      expect(chain.whereRaw).toHaveBeenCalledWith("metadata->>'dedupeKey' = ?", ['ib:model-failure:admin']);
      expect(mockMarkAdminDone).toHaveBeenCalledWith([11, 12], expect.objectContaining({ by: 'ib-model-recovered' }));
      // Inside a minute this process does not ask again; after a minute it does
      // (another replica may have rung), and it finds the row with no rows left.
      await expect(ModelFailure.closeFailureBellOnRecovery({ now: Date.now() + 1000 })).resolves.toBe(0);
      expect(select).toHaveBeenCalledTimes(1);
      select.mockResolvedValueOnce([]);
      await expect(ModelFailure.closeFailureBellOnRecovery({ now: Date.now() + 61000 })).resolves.toBe(0);
      expect(select).toHaveBeenCalledTimes(2);
    } finally {
      db.mockImplementation(() => ({ insert: jest.fn(async () => undefined) }));
    }
  });
});

describe('gap reader classifies ib-model rows as system faults', () => {
  test('an ib-model row is system_fault, never quoted_words', () => {
    const tools = jest.requireActual('../services/intelligence-bar/gap-report-tools');
    const { toGap } = tools._private;
    const gap = toGap({ id: 1, source: 'ib-model', kind: 'blocked', domain: null, summary: 's', attempted: 'a', closest_tool: null, occurrences: 2, status: 'open', first_seen_at: new Date(), last_seen_at: new Date() });
    expect(gap.system_fault).toBe(true);
    expect(gap.quoted_words).toBeUndefined();
  });
});

describe('round 2 fixes (#6368)', () => {
  test('the failed ask and the failure answer join the returned history', async () => {
    mockMessagesCreate.mockRejectedValueOnce(limitError());
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, {
        prompt: 'move the Tuesday visit to Friday', context: 'customers',
        conversationHistory: [{ role: 'user', content: 'earlier ask' }, { role: 'assistant', content: 'earlier answer' }],
      });
      const history = body.conversationHistory;
      expect(history.slice(0, 2).map((t) => t.content)).toEqual(['earlier ask', 'earlier answer']);
      expect(history[2].role).toBe('user');
      expect(history[2].content).toContain('move the Tuesday visit to Friday');
      expect(history[3].role).toBe('assistant');
      expect(history[3].content).toContain('The AI model did not answer this request');
      // The client drops its thread: the failed exchange is not in it.
      // No thread id (the palette drops its thread); availability is reported as it is.
      expect(body.threadId).toBeUndefined();
      expect(typeof body.threadsEnabled).toBe('boolean');
    });
  });

  test('a middle round that succeeds does not close the bell; only a finished answer does', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');
    const callSite = src.indexOf('.catch(err => { throw ModelFailure.tagModelCallError(err); });');
    const close = src.indexOf('ModelFailure.closeFailureBellOnRecovery({ lane:');
    expect(callSite).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(callSite);
    // The close sits after the loop, beside the final send, not next to the model call.
    expect(src.slice(callSite, close)).toMatch(/const payload = \{/);
  });
});

describe('round 3 fixes (#6368)', () => {
  test('lanes are separate: a technician recovery does not close the admin bell', async () => {
    const db = require('../models/db');
    const select = jest.fn(async () => []);
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain), select };
    db.mockImplementation(() => chain);
    const ModelFailure = require('../services/intelligence-bar/model-failure');
    try {
      await ModelFailure.closeFailureBellOnRecovery({ lane: 'tech', now: Date.now() + 10 * 60000 });
      expect(chain.whereRaw).toHaveBeenLastCalledWith("metadata->>'dedupeKey' = ?", ['ib:model-failure:tech']);
    } finally {
      db.mockImplementation(() => ({ insert: jest.fn(async () => undefined) }));
    }
  });
});
