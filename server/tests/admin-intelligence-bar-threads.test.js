/**
 * Server-persisted IB threads (GATE_IB_THREADS, owner-ratified 2026-08-31).
 *
 * Invariants:
 *  1. Gate off (default): /query persists nothing and returns no threadId;
 *     the /threads endpoints 404. Ephemeral behavior is byte-identical.
 *  2. Gate on: an admin /query appends the marker-tainted turn pair to the
 *     actor's thread (creating one when thread_id is absent) and returns the
 *     thread id; a technician /query never persists.
 *  3. /threads reads are admin-only and actor-bound (binding enforced inside
 *     the service; the route passes the derived actor id, never a client one).
 *  4. Persistence is best-effort: a thread write failure never fails /query.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockAppendExchange = jest.fn();
const mockLatestThread = jest.fn();
const mockGetThread = jest.fn();
const mockListThreads = jest.fn();
const mockIsThreadIdle = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: mockDbInsert })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
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

jest.mock('../services/intelligence-bar/tools', () => ({
  TOOLS: [],
  executeTool: (...args) => mockExecuteTool(...args),
  resolveTechnicianByName: jest.fn(),
  resolveActiveTechnicianById: jest.fn(),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(), resolveCustomer: jest.fn(),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({
  LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(),
  previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500,
}));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: jest.fn(),
  claimForConfirm: jest.fn(),
  cancelPendingAction: jest.fn(),
  recordResult: jest.fn(),
}));
jest.mock('../services/intelligence-bar/threads', () => ({
  threadsEnabled: () => process.env.GATE_IB_THREADS === 'true',
  isThreadIdle: (...args) => mockIsThreadIdle(...args),
  appendExchange: (...args) => mockAppendExchange(...args),
  latestThread: (...args) => mockLatestThread(...args),
  getThread: (...args) => mockGetThread(...args),
  listThreads: (...args) => mockListThreads(...args),
  purgeExpiredThreads: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const THREAD_ID = '5a1c2f7a-aaaa-bbbb-cccc-deadbeef0002';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message, stack: err.stack });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function scriptModelTurns(turns) {
  mockMessagesCreate.mockReset();
  for (const content of turns) {
    mockMessagesCreate.mockResolvedValueOnce({ content });
  }
}

async function postQuery(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getPath(baseUrl, path, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  delete process.env.GATE_IB_THREADS;
});

describe('threads gate OFF (default)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('/query persists nothing and returns no threadId', async () => {
    scriptModelTurns([[{ type: 'text', text: 'hello' }]]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'hi', context: 'customers' });
      expect(status).toBe(200);
      expect(mockAppendExchange).not.toHaveBeenCalled();
      expect(body.threadId).toBeUndefined();
      expect(body.threadsEnabled).toBe(false);
    });
  });

  test('/threads endpoints 404', async () => {
    await withServer(async (baseUrl) => {
      for (const p of ['/threads/latest', '/threads', `/threads/${THREAD_ID}`]) {
        const { status } = await getPath(baseUrl, p);
        expect(status).toBe(404);
      }
      expect(mockLatestThread).not.toHaveBeenCalled();
      expect(mockListThreads).not.toHaveBeenCalled();
    });
  });
});

describe('threads gate ON', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_THREADS = 'true';
  });

  test('admin /query appends the exchange and returns the thread id', async () => {
    mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 2 });
    scriptModelTurns([[{ type: 'text', text: 'the answer' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'remember this', context: 'customers' });
      expect(status).toBe(200);
      expect(body.threadId).toBe(THREAD_ID);
      expect(body.threadSeq).toBe(2);
      expect(body.threadsEnabled).toBe(true);

      expect(mockAppendExchange).toHaveBeenCalledTimes(1);
      const arg = mockAppendExchange.mock.calls[0][0];
      expect(arg.actorId).toBe('admin-1');
      expect(arg.threadId).toBeNull();
      expect(arg.userText).toContain('remember this');
      expect(arg.assistantText).toContain('the answer');
      expect(arg.seedTurns).toEqual([]);
    });
  });

  test('a new thread is seeded with the round-tripped history', async () => {
    mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 4 });
    scriptModelTurns([[{ type: 'text', text: 'continuing' }]]);
    const priorHistory = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];

    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'and now?', context: 'customers', conversationHistory: priorHistory });
      const arg = mockAppendExchange.mock.calls[0][0];
      expect(arg.threadId).toBeNull();
      expect(arg.seedTurns).toEqual(priorHistory);
    });
  });

  test('an existing thread_id and thread_seq are passed through to the service', async () => {
    mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 6 });
    scriptModelTurns([[{ type: 'text', text: 'ok' }]]);

    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, {
        prompt: 'follow-up', context: 'customers', thread_id: THREAD_ID, thread_seq: 4,
      });
      expect(mockAppendExchange.mock.calls[0][0].threadId).toBe(THREAD_ID);
      expect(mockAppendExchange.mock.calls[0][0].expectedSeq).toBe(4);
      expect(body.threadId).toBe(THREAD_ID);
      expect(body.threadSeq).toBe(6);
    });
  });

  test('a rejected append (stale seq / foreign thread) returns no threadId but threadsEnabled stays true', async () => {
    mockAppendExchange.mockResolvedValue(null);
    scriptModelTurns([[{ type: 'text', text: 'answered anyway' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, {
        prompt: 'follow-up', context: 'customers', thread_id: THREAD_ID, thread_seq: 4,
      });
      expect(status).toBe(200);
      expect(body.response).toBe('answered anyway');
      expect(body.threadId).toBeUndefined();
      expect(body.threadsEnabled).toBe(true);
    });
  });

  test('technician /query never persists', async () => {
    scriptModelTurns([[{ type: 'text', text: 'route info' }]]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'my route', context: 'tech' }, 'tech');
      expect(status).toBe(200);
      expect(mockAppendExchange).not.toHaveBeenCalled();
      expect(body.threadId).toBeUndefined();
      expect(body.threadsEnabled).toBe(false);
    });
  });

  test('a thread write failure never fails the answer (best-effort)', async () => {
    mockAppendExchange.mockRejectedValue(new Error('db down'));
    scriptModelTurns([[{ type: 'text', text: 'still answered' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'hi', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toBe('still answered');
      expect(body.threadId).toBeUndefined();
    });
  });

  test('/threads/latest returns the actor\'s thread; technician gets 403', async () => {
    mockLatestThread.mockResolvedValue({
      id: THREAD_ID, title: 'Test reschedule', context: 'schedule',
      conversationHistory: [{ role: 'user', content: 'move the test appointment' }],
    });
    await withServer(async (baseUrl) => {
      const { status, body } = await getPath(baseUrl, '/threads/latest');
      expect(status).toBe(200);
      expect(body.thread.id).toBe(THREAD_ID);
      expect(mockLatestThread).toHaveBeenCalledWith('admin-1');

      const techRes = await getPath(baseUrl, '/threads/latest', 'tech');
      expect(techRes.status).toBe(403);
    });
  });

  test('/threads/latest with an idle newest thread answers no thread (the server decides the auto-resume)', async () => {
    mockLatestThread.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const { status, body } = await getPath(baseUrl, '/threads/latest');
      expect(status).toBe(200);
      expect(body).toEqual({ thread: null });
    });
  });

  test('/query with no thread_id starts a new thread and never resumes the latest one', async () => {
    mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 2 });
    scriptModelTurns([[{ type: 'text', text: 'fresh' }]]);
    await withServer(async (baseUrl) => {
      // The latest thread is idle: the lookup would answer null, and /query
      // must not look for a thread at all.
      mockLatestThread.mockResolvedValue(null);
      await postQuery(baseUrl, { prompt: 'a new ask', context: 'customers' });
      expect(mockLatestThread).not.toHaveBeenCalled();
      expect(mockGetThread).not.toHaveBeenCalled();
      const arg = mockAppendExchange.mock.calls[0][0];
      expect(arg.threadId).toBeNull();
      expect(arg.expectedSeq).toBeNull();
    });
  });

  describe('explicit thread_id on an idle thread (server-side idle limit)', () => {
    afterEach(() => mockIsThreadIdle.mockReset());
    const run = async (extra) => {
      mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 2 });
      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      let sent;
      await withServer(async (baseUrl) => {
        await postQuery(baseUrl, {
          prompt: 'a later ask', context: 'customers', thread_id: THREAD_ID, thread_seq: 4,
          conversationHistory: [{ role: 'user', content: 'Synthetic old ask' }, { role: 'assistant', content: 'Synthetic old answer' }],
          ...extra,
        });
        sent = mockAppendExchange.mock.calls[0][0];
      });
      return sent;
    };

    test('idle and not reopened: a new thread, no old history', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      const sent = await run({});
      expect(mockIsThreadIdle).toHaveBeenCalledWith('admin-1', THREAD_ID);
      expect(sent.threadId).toBeNull();
      expect(sent.expectedSeq).toBeNull();
      expect(sent.seedTurns).toEqual([]);
      const modelInput = JSON.stringify(mockMessagesCreate.mock.calls[0][0].messages);
      expect(modelInput).not.toContain('Synthetic old answer');
    });

    test('idle but reopened from History: it keeps appending to that thread', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      const sent = await run({ thread_reopened: true });
      expect(mockIsThreadIdle).not.toHaveBeenCalled();
      expect(sent.threadId).toBe(THREAD_ID);
      expect(sent.expectedSeq).toBe(4);
      expect(JSON.stringify(mockMessagesCreate.mock.calls[0][0].messages)).toContain('Synthetic old answer');
    });

    test('inside the limit: unchanged', async () => {
      mockIsThreadIdle.mockResolvedValue(false);
      const sent = await run({});
      expect(sent.threadId).toBe(THREAD_ID);
      expect(sent.expectedSeq).toBe(4);
    });

    test('a failed idle lookup fails open and the request runs unchanged', async () => {
      mockIsThreadIdle.mockRejectedValue(new Error('db down'));
      const sent = await run({});
      expect(sent.threadId).toBe(THREAD_ID);
    });
  });

  describe('threadRolledOver: the server is the only authority', () => {
    const history = [{ role: 'user', content: 'Synthetic old ask' }, { role: 'assistant', content: 'Synthetic old answer' }];
    const postRollover = async (extra = {}) => {
      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      let result;
      await withServer(async (baseUrl) => {
        result = await postQuery(baseUrl, { prompt: 'a later ask', context: 'customers', thread_id: THREAD_ID, thread_seq: 4,
          conversationHistory: history, ...extra });
      });
      return result;
    };
    afterEach(() => mockIsThreadIdle.mockReset());

    test('a rolled-over reply with a new thread id carries the flag', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      mockAppendExchange.mockResolvedValue({ threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lastSeq: 2 });
      const { status, body } = await postRollover();
      expect(status).toBe(200);
      expect(body.threadRolledOver).toBe(true);
      expect(body.threadId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    });

    test('the flag is there even when the append fails and no thread id could be created', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      mockAppendExchange.mockResolvedValue(null);
      const { body } = await postRollover();
      expect(body.threadRolledOver).toBe(true);
      expect(body.threadId).toBeUndefined();
    });

    test('a normal reply never carries it', async () => {
      mockIsThreadIdle.mockResolvedValue(false);
      mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 6 });
      const { body } = await postRollover();
      expect(body).not.toHaveProperty('threadRolledOver');
    });

    test.each([['a string', 'x'], ['an object', { role: 'user', content: 'x' }], ['null', null], ['a bad turn', [{ role: 'system', content: 'x' }]]])(
      'an idle thread with a malformed history (%s) is left to runQuery: its 400, no rollover, no model call, no flag', async (_label, bad) => {
        mockIsThreadIdle.mockResolvedValue(true);
        mockMessagesCreate.mockClear();
        mockAppendExchange.mockClear();
        const { status, body } = await postRollover({ conversationHistory: bad });
        expect(status).toBe(400);
        expect(body.error).toBe('Conversation history must contain user and assistant text turns');
        expect(body).not.toHaveProperty('threadRolledOver');
        expect(mockMessagesCreate).not.toHaveBeenCalled();
        expect(mockAppendExchange).not.toHaveBeenCalled();
      });

    test('an idle thread with no history field still rolls over', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      mockAppendExchange.mockResolvedValue({ threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lastSeq: 2 });
      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      let result;
      await withServer(async (baseUrl) => {
        result = await postQuery(baseUrl, { prompt: 'a later ask', context: 'customers', thread_id: THREAD_ID, thread_seq: 4 });
      });
      expect(result.status).toBe(200);
      expect(result.body.threadRolledOver).toBe(true);
    });

    test('a reopened thread is never rolled over and its reply never carries it', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 6 });
      const { body } = await postRollover({ thread_reopened: true });
      expect(mockIsThreadIdle).not.toHaveBeenCalled();
      expect(body).not.toHaveProperty('threadRolledOver');
      expect(mockAppendExchange.mock.calls.at(-1)[0].threadId).toBe(THREAD_ID);
    });

    test('every JSON body of a rolled-over request is flagged, unless it already states the flag (a stored snapshot)', async () => {
      mockIsThreadIdle.mockResolvedValue(true);
      const sent = [];
      const res = { json: (body) => { sent.push(body); return res; } };
      await intelligenceRouter.startFreshWhenThreadIdle({ body: { thread_id: THREAD_ID, conversationHistory: history },
        techRole: 'admin', technician: { id: 'admin-1' }, technicianId: 'admin-1' }, res, jest.fn());
      res.json({ error: 'refused' });
      res.json({ taskId: 't', threadRolledOver: undefined });
      res.json({ taskId: 't', threadRolledOver: true });
      res.json([1]);
      expect(sent).toEqual([{ error: 'refused', threadRolledOver: true }, { taskId: 't', threadRolledOver: undefined },
        { taskId: 't', threadRolledOver: true }, [1]]);
    });

    describe('request identity', () => {
      const reqFor = (body) => ({ body: { ...body }, techRole: 'admin', technician: { id: 'admin-1' }, technicianId: 'admin-1' });
      const runGuard = async (req) => {
        const next = jest.fn();
        await intelligenceRouter.startFreshWhenThreadIdle(req, { json: jest.fn() }, next);
        expect(next).toHaveBeenCalledTimes(1);
      };
      const taskRequest = (body) => ({
        prompt: body.prompt, context: 'customers', pageData: {}, selectedTarget: null, images: [],
        conversationHistory: (body.conversationHistory || []).slice(-10),
        thread_id: body.thread_id || null, thread_seq: Number.isInteger(body.thread_seq) ? body.thread_seq : null,
      });
      const identityOf = (req) => {
        const { request, identityRequest } = intelligenceRouter.taskRequestsFor(req, taskRequest(req.body));
        return identityRequest || request;
      };
      const sent = { prompt: 'a later ask', thread_id: THREAD_ID, thread_seq: 4, conversationHistory: history };

      test('an idle rollover hashes what the client sent and stores the rolled-over request with the decision', async () => {
        mockIsThreadIdle.mockResolvedValue(true);
        const req = reqFor(sent);
        await runGuard(req);
        expect(req.body.thread_id).toBeUndefined();
        expect(req.body.conversationHistory).toEqual([]);
        const { request } = intelligenceRouter.taskRequestsFor(req, taskRequest(req.body));
        expect(identityOf(req)).toEqual(taskRequest(sent));
        expect(request).toMatchObject({ thread_id: null, thread_seq: null, conversationHistory: [], thread_rolled_over: true });
      });

      test('no rollover: the identity is the request itself and no decision is stored', async () => {
        mockIsThreadIdle.mockResolvedValue(false);
        const req = reqFor(sent);
        await runGuard(req);
        expect(req.ibThreadRollover).toBeUndefined();
        expect(intelligenceRouter.taskRequestsFor(req, taskRequest(req.body))).toEqual({ request: taskRequest(sent) });
      });

      test('a retry of the same request hashes the same whether or not the thread is still idle', async () => {
        const identities = [];
        for (const idle of [false, true, true, false]) {
          mockIsThreadIdle.mockResolvedValue(idle);
          const req = reqFor(sent);
          await runGuard(req);
          identities.push(JSON.stringify(identityOf(req)));
        }
        expect(new Set(identities).size).toBe(1);
      });
    });
  });

  test('a malformed thread_id starts a fresh seeded thread instead of a uuid cast error', async () => {
    mockAppendExchange.mockResolvedValue({ threadId: THREAD_ID, lastSeq: 2 });
    scriptModelTurns([[{ type: 'text', text: 'ok' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, {
        prompt: 'hello', context: 'customers', thread_id: 'not-a-uuid', thread_seq: 2,
      });
      expect(status).toBe(200);
      expect(mockAppendExchange.mock.calls[0][0].threadId).toBeNull();
      expect(body.threadId).toBe(THREAD_ID);
    });
  });

  test('/threads/:id 404s a malformed id without touching the service', async () => {
    await withServer(async (baseUrl) => {
      const { status } = await getPath(baseUrl, '/threads/not-a-uuid');
      expect(status).toBe(404);
      expect(mockGetThread).not.toHaveBeenCalled();
    });
  });

  test('/threads/:id is actor-bound through the service and 404s on a miss', async () => {
    mockGetThread.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const { status } = await getPath(baseUrl, `/threads/${THREAD_ID}`);
      expect(status).toBe(404);
      expect(mockGetThread).toHaveBeenCalledWith('admin-1', THREAD_ID);
    });
  });
});
