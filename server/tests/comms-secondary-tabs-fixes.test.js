/**
 * Regression guards for PR 6 (Secondary Comms Tabs, Templates, Coach & Push Diagnostics):
 *   - PUT /api/admin/csr/follow-up-tasks/:id returns 404 on missing task ID
 *   - CSRCoach.getLeaderboard computes over half-month period boundaries instead of rolling 15d
 *   - GET /api/admin/communications/stats uses Eastern Time month start instead of UTC rollover
 */
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    req.technician = { id: 'admin-1', role: 'admin', name: 'Admin' };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  staffTokenVersionMatches: () => true,
}));

const db = require('../models/db');
const adminCsrRouter = require('../routes/admin-csr');
const CSRCoach = require('../services/csr/csr-coach');
const adminCommsRouter = require('../routes/admin-communications');

function makeChain(result = []) {
  const calls = [];
  const q = { _calls: calls };
  for (const m of ['where', 'whereNot', 'whereRaw', 'orWhereNull', 'leftJoin', 'joinRaw', 'select', 'groupBy', 'orderBy', 'limit', 'update', 'count']) {
    q[m] = jest.fn((...args) => {
      calls.push([m, ...args]);
      return q;
    });
  }
  q.first = jest.fn(async () => (Array.isArray(result) ? result[0] : result));
  q.returning = jest.fn(async () => result);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

async function withApp(router, mountPath, fn) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PUT /api/admin/csr/follow-up-tasks/:id', () => {
  test('returns 404 when the follow-up task does not exist', async () => {
    db.mockImplementation(() => makeChain([]));
    await withApp(adminCsrRouter, '/api/admin/csr', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/csr/follow-up-tasks/missing-task`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json).toEqual({ error: 'Follow-up task not found' });
    });
  });

  test('returns 200 with updated task when found', async () => {
    db.mockImplementation(() => makeChain([{ id: 'task-1', status: 'completed' }]));
    await withApp(adminCsrRouter, '/api/admin/csr', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/csr/follow-up-tasks/task-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ task: { id: 'task-1', status: 'completed' } });
    });
  });
});

describe('CSRCoach.getLeaderboard half-month period boundaries', () => {
  test('queries exact half-month boundaries (16th..end) using linked call start and excludes late-15th calls scored on the 16th', async () => {
    const scoreChain = makeChain([
      // Started Nov 15 at 11:30 PM EST, scored Nov 16 after midnight -> belongs to Nov 1-15, NOT Nov 16-30.
      { csr_name: 'Late15th', call_date: '2026-11-16', call_started_at: new Date('2026-11-16T04:30:00Z'), call_outcome: 'booked', is_first_call_from_lead: true, total_score: 16 },
      // Started Nov 16 at 10:00 AM EST -> belongs to Nov 16-30.
      { csr_name: 'Alex', call_date: '2026-11-16', call_started_at: new Date('2026-11-16T15:00:00Z'), call_outcome: 'booked', is_first_call_from_lead: true, total_score: 10 },
      // Unlinked score falls back to call_date -> belongs to Nov 16-30.
      { csr_name: 'Unlinked', call_date: '2026-11-17', call_started_at: null, call_outcome: 'not_booked', is_first_call_from_lead: true, total_score: 8 },
    ]);
    const followUpChain = makeChain([
      { assigned_to: 'Alex', status: 'completed', job_booked_from_followup: false },
    ]);
    db.mockImplementation((table) => {
      if (table === 'csr_call_scores as s') return scoreChain;
      if (table === 'ai_follow_up_tasks') return followUpChain;
      return makeChain([]);
    });

    const board = await CSRCoach.getLeaderboard(new Date('2026-11-18T17:00:00Z'));
    expect(board.periodStart).toBe('2026-11-16');
    expect(board.periodEnd).toBe('2026-11-30');
    expect(scoreChain.joinRaw).toHaveBeenCalledTimes(1);
    expect(scoreChain.where).toHaveBeenCalledWith('s.call_date', '>=', '2026-11-16');
    expect(scoreChain.where).not.toHaveBeenCalledWith('call_date', '<=', expect.anything());
    expect(board.csrs.map((c) => c.name).sort()).toEqual(['Alex', 'Unlinked']);
    expect(followUpChain.where).toHaveBeenCalledWith('created_at', '>=', new Date('2026-11-16T05:00:00.000Z'));
    expect(followUpChain.where).toHaveBeenCalledWith('created_at', '<', new Date('2026-12-01T05:00:00.000Z'));
  });

  test('counts a late-15th call scored after midnight in the 1st..15th period and excludes calls started on the 16th', async () => {
    const scoreChain = makeChain([
      // Started Dec 15 at 11:45 PM EST, scored Dec 16 -> counts in Dec 1-15.
      { csr_name: 'Late15th', call_date: '2026-12-16', call_started_at: new Date('2026-12-16T04:45:00Z'), call_outcome: 'booked', is_first_call_from_lead: true, total_score: 14 },
      // Started Dec 16 at 12:10 AM EST -> belongs to Dec 16-31, excluded from Dec 1-15.
      { csr_name: 'Early16th', call_date: '2026-12-16', call_started_at: new Date('2026-12-16T05:10:00Z'), call_outcome: 'booked', is_first_call_from_lead: true, total_score: 16 },
    ]);
    const followUpChain = makeChain([]);
    db.mockImplementation((table) => {
      if (table === 'csr_call_scores as s') return scoreChain;
      if (table === 'ai_follow_up_tasks') return followUpChain;
      return makeChain([]);
    });

    const board = await CSRCoach.getLeaderboard(new Date('2026-12-02T17:00:00Z'));
    expect(board.periodStart).toBe('2026-12-01');
    expect(board.periodEnd).toBe('2026-12-15');
    expect(scoreChain.where).toHaveBeenCalledWith('s.call_date', '>=', '2026-12-01');
    expect(board.csrs.map((c) => c.name)).toEqual(['Late15th']);
  });
});

describe('GET /api/admin/communications/stats Eastern Time month start', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('uses Eastern Time month start at 9 PM ET on Nov 30 (already Dec 1 in UTC)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(new Date('2026-12-01T02:00:00.000Z')); // Nov 30, 2026 9:00 PM EST

    const createdAtFilters = [];
    db.mockImplementation(() => {
      const q = makeChain([{ count: '0', sent: '0' }]);
      const origWhere = q.where;
      q.where = jest.fn((...args) => {
        if (args[0] === 'messages.created_at' && args[1] === '>=') {
          createdAtFilters.push(args[2]);
        }
        return origWhere(...args);
      });
      return q;
    });

    await withApp(adminCommsRouter, '/api/admin/communications', async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/communications/stats`);
      expect(res.status).toBe(200);
      expect(createdAtFilters.length).toBeGreaterThan(0);
      // Nov 1, 2026 00:00 EDT = 2026-11-01T04:00:00.000Z (NOT Dec 1 UTC!)
      for (const som of createdAtFilters) {
        expect(som).toBe('2026-11-01T04:00:00.000Z');
      }
    });
  });
});
