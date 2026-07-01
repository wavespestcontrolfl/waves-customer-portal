jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { first_name: 'Ava' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({
  calculateAllSourceROI: jest.fn(async () => []),
  logFirstResponse: jest.fn(),
  markConverted: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer(router = leadsRouter) {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// Chainable knex mock that distinguishes the three db('leads') chains the
// overview runs: the month cohort (awaited array), the open-backlog query
// (has where('status','new'), awaited array), and the rolling-7d responded
// query (terminated by .pluck).
function mockLeadsDb({ monthLeads, openLeads, recentMinutes }, captured = {}, dbFn = db) {
  dbFn.mockImplementation(() => {
    const calls = [];
    const builder = {
      where(...a) { calls.push(['where', a[0], a[1], a[2]]); return builder; },
      whereNull(...a) { calls.push(['whereNull', ...a]); return builder; },
      whereNotNull(...a) { calls.push(['whereNotNull', ...a]); return builder; },
      whereRaw(...a) { calls.push(['whereRaw', ...a]); return builder; },
      pluck() { return Promise.resolve(recentMinutes); },
      then(resolve, reject) {
        const isOpen = calls.some((c) => c[0] === 'where' && c[1] === 'status' && c[2] === 'new');
        if (isOpen) captured.openWheres = calls.slice(); // Speed-to-Lead backlog query
        return Promise.resolve(isOpen ? openLeads : monthLeads).then(resolve, reject);
      },
    };
    return builder;
  });
  return captured;
}

describe('GET /admin/leads/analytics/overview — response-time headline', () => {
  beforeEach(() => jest.clearAllMocks());

  test('headline is the MEDIAN (outlier-robust); mean kept as avgResponseTime; recent 7d median returned', async () => {
    mockLeadsDb({
      // responded minutes [10,20,30,40,5000]: median 30, mean 1020 — one late reply
      // must NOT define the headline. Unresponded lead is excluded from both.
      monthLeads: [
        { status: 'new', response_time_minutes: 10 },
        { status: 'won', response_time_minutes: 20 },
        { status: 'new', response_time_minutes: 30 },
        { status: 'contacted', response_time_minutes: 40 },
        { status: 'new', response_time_minutes: 5000 },
        { status: 'new', response_time_minutes: null },
      ],
      openLeads: [],
      recentMinutes: [5, 15], // 7-day median = 10
    });

    const { server, baseUrl } = appServer();
    try {
      const res = await fetch(`${baseUrl}/admin/leads/analytics/overview`);
      const body = await res.json();
      expect(body.medianResponseTime).toBe(30);
      expect(body.avgResponseTime).toBe(1020);
      expect(body.recentMedianResponseTime).toBe(10);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('null response-time metrics when no lead has been responded to', async () => {
    mockLeadsDb({
      monthLeads: [{ status: 'new', response_time_minutes: null }],
      openLeads: [{ status: 'new', first_contact_at: new Date().toISOString() }],
      recentMinutes: [],
    });

    const { server, baseUrl } = appServer();
    try {
      const res = await fetch(`${baseUrl}/admin/leads/analytics/overview`);
      const body = await res.json();
      expect(body.medianResponseTime).toBeNull();
      expect(body.avgResponseTime).toBeNull();
      expect(body.recentMedianResponseTime).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('Speed-to-Lead is floored at the fresh-start baseline (default 2026-07-01) and the date is exposed', async () => {
    const captured = mockLeadsDb({
      monthLeads: [{ status: 'new', response_time_minutes: null }],
      openLeads: [{ status: 'new', first_contact_at: new Date().toISOString() }],
      recentMinutes: [],
    }, {});

    const { server, baseUrl } = appServer();
    try {
      const res = await fetch(`${baseUrl}/admin/leads/analytics/overview`);
      const body = await res.json();
      // Baseline date is exposed for the UI (ET 2026-07-01).
      expect(body.speedToLeadSince).toContain('2026-07-01');
      // The open-backlog query applies a first_contact_at >= baseline floor,
      // matching the exposed date (so pre-reset leads are excluded).
      const floor = captured.openWheres.find(
        (c) => c[0] === 'where' && c[1] === 'first_contact_at' && c[2] === '>=',
      );
      expect(floor).toBeTruthy();
      expect(new Date(floor[3]).toISOString()).toBe(body.speedToLeadSince);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('a typoed / non-existent fresh-start env (Feb 30) fails open — no floor, null date', async () => {
    // Date.UTC rolls 2026-02-30 over to Mar 2; without the round-trip guard the
    // gauge would silently apply a wrong March cutoff. It must fail open instead.
    const prev = process.env.SPEED_TO_LEAD_FRESH_START;
    process.env.SPEED_TO_LEAD_FRESH_START = '2026-02-30';
    let freshDb;
    let freshRouter;
    jest.isolateModules(() => {
      freshDb = require('../models/db');
      freshRouter = require('../routes/admin-leads');
    });

    const captured = mockLeadsDb({
      monthLeads: [{ status: 'new', response_time_minutes: null }],
      openLeads: [{ status: 'new', first_contact_at: new Date().toISOString() }],
      recentMinutes: [],
    }, {}, freshDb);

    const { server, baseUrl } = appServer(freshRouter);
    try {
      const res = await fetch(`${baseUrl}/admin/leads/analytics/overview`);
      const body = await res.json();
      // Fails open: no baseline exposed and no first_contact_at floor applied.
      expect(body.speedToLeadSince).toBeNull();
      const floor = (captured.openWheres || []).find(
        (c) => c[0] === 'where' && c[1] === 'first_contact_at' && c[2] === '>=',
      );
      expect(floor).toBeFalsy();
    } finally {
      await new Promise((r) => server.close(r));
      if (prev === undefined) delete process.env.SPEED_TO_LEAD_FRESH_START;
      else process.env.SPEED_TO_LEAD_FRESH_START = prev;
    }
  });
});
