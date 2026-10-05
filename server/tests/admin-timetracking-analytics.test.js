// Time Tracking analytics: the /analytics and /analytics/comparison reads
// 500'd in prod because they selected scheduled_services.estimated_duration,
// a column that exists only on dispatch_jobs (the real one is
// estimated_duration_minutes). These tests pin the fix, the efficiency math
// and the load-ahead week window.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockCalls = [];
const mockTableRows = {};

jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = { _table: table, _selected: [], _where: [] };
    for (const m of ['leftJoin', 'orderBy', 'whereNotNull', 'whereRaw', 'whereNotIn', 'groupBy', 'groupByRaw']) {
      chain[m] = jest.fn((...args) => { chain._where.push([m, ...args]); return chain; });
    }
    chain.where = jest.fn((...args) => { chain._where.push(['where', ...args]); return chain; });
    chain.select = jest.fn((...args) => { chain._selected.push(...args); return chain; });
    const settle = () => { mockCalls.push(chain); return Promise.resolve(mockTableRows[table] || []); };
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  };
  const fn = jest.fn((table) => makeChain(table));
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW') };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (k, f) => f) }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; req.technician = { id: 'admin-1', role: 'admin' }; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const router = require('../routes/admin-timetracking');
const math = require('../services/time-tracking-analytics');

async function get(path) {
  const app = express();
  app.use('/admin/timetracking', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/admin/timetracking${path}`);
    return { status: r.status, body: await r.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

const entry = (over = {}) => ({
  tech_name: 'Tech A', technician_id: 't1', service_type: null, duration_minutes: 30,
  ss_id: 's1', ss_service_type: 'Pest Control', ss_is_recurring: false, ss_is_callback: false,
  ss_window_start: null, ss_window_end: null, ss_estimated_duration_minutes: 60, ...over,
});

beforeEach(() => {
  mockCalls.length = 0;
  for (const k of Object.keys(mockTableRows)) delete mockTableRows[k];
});

describe('analytics queries read the real planned-minutes column', () => {
  test('neither query selects scheduled_services.estimated_duration (without _minutes)', async () => {
    mockTableRows.time_entries = [entry()];
    for (const path of ['/analytics', '/analytics/comparison']) {
      mockCalls.length = 0;
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 200]);
      const sqlish = mockCalls.flatMap((c) => [...c._selected, ...c._where.flat()])
        .filter((x) => typeof x === 'string').join('\n');
      expect(sqlish).toContain('scheduled_services.estimated_duration_minutes as ss_estimated_duration_minutes');
      expect(sqlish).not.toMatch(/scheduled_services\.estimated_duration(?!_minutes)/);
    }
  });

  test('source-level guard: the route file never names the missing column', () => {
    // Last-resort check on top of the mocked-query one above: a future query
    // added to the route with the wrong column would not run in this mock.
    const src = require('fs').readFileSync(require.resolve('../routes/admin-timetracking'), 'utf8');
    expect(src).not.toMatch(/scheduled_services\.estimated_duration(?!_minutes)/);
  });

  test('response keeps the field names the Analytics tab reads', async () => {
    mockTableRows.time_entries = [entry({ duration_minutes: 40 }), entry({ duration_minutes: 20, ss_id: 's2' })];
    const { body } = await get('/analytics');
    expect(body.serviceTypeStats).toEqual([
      expect.objectContaining({ svc_type: 'Pest Control', avg_actual: 30, job_count: 2, avg_estimated: 60 }),
    ]);
    const cmp = (await get('/analytics/comparison')).body;
    expect(cmp[0]).toEqual(expect.objectContaining({
      tech_name: 'Tech A', technician_id: 't1', svc_type: 'Pest Control', avg_actual: 30, job_count: 2, avg_estimated: 60,
    }));
  });

  test('an entry with no linked scheduled row has a null estimate, not a guessed one', () => {
    const rows = [entry({ ss_id: null })];
    expect(math.buildServiceTypeStats(rows)[0]).toEqual(expect.objectContaining({ job_count: 1, avg_estimated: null }));
  });
});

describe('efficiency math', () => {
  test('budget 300 over shift 480 is 62.5', () => {
    expect(math.efficiencyPct(300, 480)).toBe(62.5);
  });
  test('shift 0 or budget 0 is null', () => {
    expect(math.efficiencyPct(300, 0)).toBeNull();
    expect(math.efficiencyPct(0, 480)).toBeNull();
  });
  test('bands: under 50 broken, 50-70 weak, 70-90 normal, 90+ elite', () => {
    expect(['49.9', 50, 69.9, 70, 89.9, 90].map((p) => math.efficiencyBand(Number(p))))
      .toEqual(['broken', 'weak', 'weak', 'normal', 'normal', 'elite']);
    expect(math.EFFICIENCY_BANDS.map((b) => [b.key, b.min])).toEqual([['broken', 0], ['weak', 50], ['normal', 70], ['elite', 90]]);
  });
  test('per tech: budget from linked entries only, shift from the daily summary', () => {
    const rows = [
      entry({ ss_estimated_duration_minutes: 90, duration_minutes: 50 }),
      entry({ ss_estimated_duration_minutes: 30, duration_minutes: 40, ss_id: 's2' }),
      entry({ ss_id: null, duration_minutes: 15 }),
    ];
    const [t] = math.buildEfficiencyByTech(rows, [{ technician_id: 't1', tech_name: 'Tech A', total_shift: '240' }]);
    expect(t).toEqual(expect.objectContaining({
      budget_minutes: 120, job_minutes: 90, shift_minutes: 240, efficiency_pct: 50, jobs: 3, jobs_with_budget: 2,
    }));
  });
  test('the route returns efficiencyByTech and the bands', async () => {
    mockTableRows.time_entries = [entry({ ss_estimated_duration_minutes: 90 })];
    mockTableRows.time_entry_daily_summary = [{ technician_id: 't1', tech_name: 'Tech A', total_shift: '180' }];
    const { body } = await get('/analytics');
    expect(body.efficiencyByTech[0]).toEqual(expect.objectContaining({ technician_id: 't1', budget_minutes: 90, shift_minutes: 180, efficiency_pct: 50 }));
    expect(body.efficiencyBands).toHaveLength(4);
  });
});

describe('loadAhead', () => {
  // Wed 2026-10-07 noon ET: the ET week starts Mon 2026-10-05.
  const now = new Date('2026-10-07T16:00:00Z');

  test('exactly 3 weeks, first on the current ET week Monday', () => {
    expect(math.loadAheadWeekStarts(now)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    // Sunday ET still belongs to the week that began the Monday before.
    expect(math.loadAheadWeekStarts(new Date('2026-10-11T20:00:00Z'))[0]).toBe('2026-10-05');
  });

  test('buckets stops by week and sums planned minutes; rows outside the window are ignored', () => {
    const row = (sched_day, est) => ({ sched_day, service_type: 'Pest Control', estimated_duration_minutes: est, window_start: null, window_end: null });
    const weeks = math.buildLoadAhead([
      row('2026-10-07', 60), row('2026-10-11', 90), row('2026-10-12', 30), row('2026-10-25', 60), row('2026-10-26', 60),
    ], now);
    expect(weeks).toEqual([
      { week_start: '2026-10-05', stops: 2, planned_minutes: 150 },
      { week_start: '2026-10-12', stops: 1, planned_minutes: 30 },
      { week_start: '2026-10-19', stops: 1, planned_minutes: 60 },
    ]);
  });

  test('the route returns 3 weeks plus the trailing average', async () => {
    mockTableRows.scheduled_services = [];
    mockTableRows.time_weekly_summary = [
      { week_start: '2026-09-14', total_job_minutes: '1000', total_shift_minutes: '2000' },
      { week_start: '2026-09-14', total_job_minutes: '500', total_shift_minutes: '1000' },
      { week_start: '2026-09-21', total_job_minutes: '1500', total_shift_minutes: '3000' },
    ];
    const { body } = await get('/analytics');
    expect(body.loadAhead.weeks).toHaveLength(3);
    expect(body.loadAhead.weeks[0].week_start).toBe(math.loadAheadWeekStarts(new Date())[0]);
    expect(body.loadAhead.trailing).toEqual(expect.objectContaining({ weeks: 4, avg_job_minutes_per_week: 1500, avg_shift_minutes_per_week: 3000 }));
  });
});
