/**
 * Agent watchdog snapshot — the PII-free health read the external Hermes
 * watchdog polls. Verdict/reasons are derived from the shared classifiers;
 * ops-queue items never cross; a failing sub-read degrades, never throws.
 */
const dbTables = {};
const mockDb = jest.fn((table) => {
  const q = {
    where: jest.fn(() => q),
    whereNotNull: jest.fn(() => q),
    max: jest.fn(() => q),
    count: jest.fn(() => q),
    first: jest.fn(async () => {
      const h = dbTables[table];
      if (typeof h === 'function') return h(q);
      return h;
    }),
  };
  return q;
});
mockDb.raw = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../config', () => ({ nodeEnv: 'test' }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true) }));
jest.mock('../utils/db-health', () => ({ isDatabaseReady: jest.fn(async () => true) }));
jest.mock('../services/intelligence-bar/job-health-tools', () => ({ getScheduledJobHealth: jest.fn() }));
jest.mock('../services/ops-queue', () => ({ getOpsQueue: jest.fn() }));

const { gateEnvValue } = require('../config/feature-gates');
const logger = require('../services/logger');
const { isDatabaseReady } = require('../utils/db-health');
const { getScheduledJobHealth } = require('../services/intelligence-bar/job-health-tools');
const { getOpsQueue } = require('../services/ops-queue');
const { buildWatchdogSnapshot, _test, SCHEDULER_HEARTBEAT_JOB } = require('../services/agent-watchdog-snapshot');

const healthyJobs = () => ({
  total: 2, unhealthy: 0,
  jobs: [
    { job: 'a', state: 'healthy', last_success_age_minutes: 5, consecutive_failures: 0, last_error: null },
    { job: 'b', state: 'running', last_success_age_minutes: 60, consecutive_failures: 0, last_error: null },
  ],
});
const quietQueue = () => ({
  totals: { pending: 3, parked: 4, failed: 0 },
  lanes: [{ key: 'calls', label: 'Call processing', pending: 3, parked: 4, failed: 0, error: null, items: [{ title: 'Jane Customer — stuck call' }] }],
});

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  isDatabaseReady.mockResolvedValue(true);
  getScheduledJobHealth.mockResolvedValue(healthyJobs());
  getOpsQueue.mockResolvedValue(quietQueue());
  dbTables.seo_link_worker_requests = { at: '2026-09-03T10:00:00.000Z' };
  dbTables.seo_link_prospects = { n: '0' };
  dbTables.job_health = { job_name: SCHEDULER_HEARTBEAT_JOB, last_started_at: new Date(Date.now() - 5 * 60000) };
});

describe('buildWatchdogSnapshot', () => {
  test('a quiet portal is healthy with no reasons and carries no queue items', async () => {
    const snap = await buildWatchdogSnapshot();
    expect(snap.verdict).toBe('healthy');
    expect(snap.reasons).toEqual([]);
    expect(snap.database).toEqual({ ok: true, latency_ms: expect.any(Number) });
    expect(snap.jobs).toEqual({ available: true, total: 2, unhealthy: 0, items: [] });
    expect(snap.scheduler).toMatchObject({ available: true, heartbeat_job: SCHEDULER_HEARTBEAT_JOB, age_minutes: 5, ok: true });
    expect(snap.ops_queue.lanes[0]).toEqual({ key: 'calls', pending: 3, parked: 4, failed: 0, error: false });
    expect(JSON.stringify(snap)).not.toContain('Call processing');
    expect(snap.ops_queue.disabled).toBe(false);
    expect(JSON.stringify(snap)).not.toContain('Jane Customer');
    expect(snap.link_worker).toEqual({ available: true, last_claim_at: '2026-09-03T10:00:00.000Z', last_report_at: '2026-09-03T10:00:00.000Z', open_leases: 0, stale_leases: 0 });
    expect(snap.environment).toBe('test');
  });

  test('unhealthy jobs, failed queue rows, stale leases and a bad DB each become a stable reason key', async () => {
    isDatabaseReady.mockResolvedValue(false);
    getScheduledJobHealth.mockResolvedValue({
      total: 3, unhealthy: 2,
      jobs: [
        { job: 'geocoder-backstop', state: 'failing', last_success_age_minutes: 190, consecutive_failures: 3, last_error: 'ECONNRESET' },
        { job: 'old-digest', state: 'stale', last_success_age_minutes: 20000, consecutive_failures: 0, last_error: null },
        { job: 'fine', state: 'healthy', last_success_age_minutes: 1, consecutive_failures: 0, last_error: null },
      ],
    });
    getOpsQueue.mockResolvedValue({
      totals: { pending: 0, parked: 1, failed: 2 },
      lanes: [
        { key: 'calls', label: 'Call processing', pending: 0, parked: 1, failed: 2, error: null, items: [] },
        { key: 'content', label: 'Content', pending: 0, parked: 0, failed: 0, error: 'relation missing', items: [] },
      ],
    });
    dbTables.seo_link_prospects = { n: '1' };
    const snap = await buildWatchdogSnapshot();
    expect(snap.verdict).toBe('attention');
    expect(snap.reasons).toEqual([
      'db:degraded',
      'job:geocoder-backstop:failing',
      'job:old-digest:stale',
      'ops:calls:failed',
      'ops:content:error',
      'link_worker:stale_leases',
    ]);
    // keys carry no counts (one incident keeps one identity); the numbers live beside them
    expect(snap.ops_queue.lanes[0].failed).toBe(2);
    expect(snap.link_worker.stale_leases).toBe(1);
    expect(snap.jobs.items.map((j) => j.job)).toEqual(['geocoder-backstop', 'old-digest']);
    expect(snap.jobs.items[0]).toEqual({ job: 'geocoder-backstop', state: 'failing', last_success_age_minutes: 190, consecutive_failures: 3 });
    expect(JSON.stringify(snap)).not.toContain('ECONNRESET');
  });

  test('the ops queue is omitted (not failed) when its gate is off', async () => {
    gateEnvValue.mockImplementation((name) => name !== 'GATE_ADMIN_OPS_QUEUE');
    const snap = await buildWatchdogSnapshot();
    expect(getOpsQueue).not.toHaveBeenCalled();
    expect(snap.ops_queue).toEqual({ available: false, disabled: true, pending: 0, parked: 0, failed: 0, lanes: [] });
    expect(snap.verdict).toBe('healthy');
  });

  test('a FAILED ops-queue read (gate on) is an attention reason, with no message', async () => {
    getOpsQueue.mockRejectedValue(new Error('relation "ops" does not exist for 941-555-0100'));
    const snap = await buildWatchdogSnapshot();
    expect(snap.ops_queue).toEqual({ available: false, disabled: false, pending: 0, parked: 0, failed: 0, lanes: [] });
    expect(snap.reasons).toEqual(['ops:unavailable']);
    expect(snap.verdict).toBe('attention');
    expect(JSON.stringify(snap)).not.toContain('relation');
  });

  test('a throwing sub-read degrades to available:false WITHOUT its message and the rest still judges', async () => {
    getScheduledJobHealth.mockRejectedValue(new Error('relation "job_health" does not exist'));
    dbTables.seo_link_worker_requests = () => { const e = new Error('boom: jane@example.com +1 941 555 0100'); e.code = '42P01'; throw e; };
    const snap = await buildWatchdogSnapshot();
    expect(snap.jobs).toEqual({ available: false, total: 0, unhealthy: 0, items: [] });
    // the message never reaches the logger either — only the label and the error code
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).not.toMatch(/jane@example|555 0100|job_health/);
    expect(logged).toContain('link_worker read failed (42P01)');
    expect(logged).toContain('jobs read failed (Error)');
    expect(snap.link_worker.available).toBe(false);
    expect(JSON.stringify(snap)).not.toMatch(/job_health|555 0100|jane@example|42P01/);
    expect(snap.reasons).toEqual(['jobs:unavailable', 'link_worker:unavailable']);
    expect(snap.verdict).toBe('attention');
    expect(snap.database.ok).toBe(true);
  });

  test('a scheduler whose heartbeat job last ticked over an hour ago is silent — even though every job still classifies healthy', async () => {
    dbTables.job_health = { job_name: SCHEDULER_HEARTBEAT_JOB, last_started_at: new Date(Date.now() - 90 * 60000) };
    const snap = await buildWatchdogSnapshot();
    expect(snap.jobs.unhealthy).toBe(0);
    expect(snap.scheduler).toMatchObject({ ok: false, age_minutes: 90 });
    expect(snap.reasons).toEqual(['scheduler:silent']);
    expect(snap.verdict).toBe('attention');
  });

  test('no heartbeat row yet: a warming process is ok, a long-running one is silent', async () => {
    dbTables.job_health = undefined;
    const uptime = jest.spyOn(process, 'uptime');
    uptime.mockReturnValue(120);
    expect((await buildWatchdogSnapshot()).scheduler).toMatchObject({ ok: true, last_tick_at: null });
    uptime.mockReturnValue(4 * 3600);
    expect((await buildWatchdogSnapshot()).reasons).toEqual(['scheduler:silent']);
    uptime.mockRestore();
  });

  test('judge is pure and order-stable', () => {
    const r = _test.judge({
      database: { ok: true },
      scheduler: { available: true, ok: true },
      jobs: { available: true, items: [{ job: 'x', state: 'stuck' }] },
      ops_queue: { available: true, lanes: [{ key: 'ib', failed: 0 }] },
      link_worker: { available: true, stale_leases: 0 },
    });
    expect(r).toEqual({ verdict: 'attention', reasons: ['job:x:stuck'] });
  });
});
