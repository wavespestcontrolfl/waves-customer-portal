// deploy-kill-retry: a registered job whose job_health row reads "killed
// mid-run" is re-run. The row is the retry request (nothing is held in
// memory), so a pass that could not start the retry leaves it for the next.
// Bounds: registered only, killed run recent, failure count under the cap,
// and the job's own shouldRetry check.
let mockHealthRows = [];
let mockHealthReadFails = false;
const mockQueries = [];
jest.mock('../models/db', () => jest.fn(() => {
  const q = { where: null };
  const b = {
    where(w) { q.where = w; return b; },
    async select() {
      mockQueries.push(q);
      if (mockHealthReadFails) throw new Error('db down');
      return mockHealthRows.filter((r) => r.last_status === q.where.last_status && r.last_error === q.where.last_error);
    },
  };
  return b;
}));
// The retry lock. Default: the lock is free and the body runs at once.
// mockBeforeBody stands in for the time spent waiting for the lock.
let mockBeforeBody = null;
jest.mock('../utils/cron-lock', () => ({
  DEAD_RUN_ERROR: jest.requireActual('../utils/cron-lock').DEAD_RUN_ERROR,
  runExclusive: jest.fn(async (_name, fn) => {
    if (mockBeforeBody) mockBeforeBody();
    return fn();
  }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { isScheduledTick } = require('../utils/scheduled-cron');
const { DEAD_RUN_ERROR, runExclusive } = require('../utils/cron-lock');
const {
  registerDeployKillRetry,
  retryDeployKilledJobs,
  RETRY_MAX_AGE_MS,
  RETRY_MAX_CONSECUTIVE_FAILURES,
  _private,
} = require('../utils/deploy-kill-retry');

const NOW = new Date('2026-10-03T08:03:00Z').getTime();
const killedRow = (job_name, over = {}) => ({
  job_name,
  last_status: 'failed',
  last_error: DEAD_RUN_ERROR,
  last_started_at: new Date('2026-10-03T07:55:00Z'),
  consecutive_failures: 1,
  ...over,
});

describe('retryDeployKilledJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _private.registry.clear();
    mockHealthRows = [];
    mockHealthReadFails = false;
    mockQueries.length = 0;
    mockBeforeBody = null;
  });

  test('re-runs a registered killed job as scheduled work; an unregistered one never runs', async () => {
    let ranAsTick = null;
    const run = jest.fn(async () => { ranAsTick = isScheduledTick(); });
    registerDeployKillRetry('property-enrich-backfill', run);
    mockHealthRows = [killedRow('property-enrich-backfill'), killedRow('billing-daily')];

    expect(await retryDeployKilledJobs({ now: NOW })).toEqual(['property-enrich-backfill']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ranAsTick).toBe(true);
    expect(mockQueries[0].where).toEqual({ last_status: 'failed', last_error: DEAD_RUN_ERROR });
    expect(runExclusive).toHaveBeenCalledWith('deploy-kill-retry:property-enrich-backfill', expect.any(Function), { recordHealth: false });
  });

  test('a second instance that gets the retry lock after the first finished does not run the job again', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-enrich-backfill', run);
    mockHealthRows = [killedRow('property-enrich-backfill')];
    // Both instances read the killed row. This one then waits for the lock
    // while the other instance retries the job to success.
    mockBeforeBody = () => { mockHealthRows = [killedRow('property-enrich-backfill', { last_status: 'success', last_error: null })]; };

    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('no run while another instance holds the retry lock', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-enrich-backfill', run);
    mockHealthRows = [killedRow('property-enrich-backfill')];
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });

    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('the row is the request: a pass that could not read it retries on the next pass', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-enrich-backfill', run);
    mockHealthRows = [killedRow('property-enrich-backfill')];

    mockHealthReadFails = true;
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();

    mockHealthReadFails = false;
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual(['property-enrich-backfill']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('no retry once the row left the killed state (restarted, succeeded, or failed on its own error)', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    for (const over of [{ last_status: 'running' }, { last_status: 'success', last_error: null }, { last_error: 'boom' }]) {
      mockHealthRows = [killedRow('property-lookup-canary', over)];
      expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    }
    expect(run).not.toHaveBeenCalled();
  });

  test('no retry for a killed run older than the age bound', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    mockHealthRows = [killedRow('property-lookup-canary', { last_started_at: new Date(NOW - RETRY_MAX_AGE_MS - 1000) })];
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    mockHealthRows = [killedRow('property-lookup-canary', { last_started_at: null })];
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('stops retrying past the consecutive-failure cap', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    mockHealthRows = [killedRow('property-lookup-canary', { consecutive_failures: RETRY_MAX_CONSECUTIVE_FAILURES })];
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual(['property-lookup-canary']);
    mockHealthRows = [killedRow('property-lookup-canary', { consecutive_failures: RETRY_MAX_CONSECUTIVE_FAILURES + 1 })];
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('shouldRetry false refuses the retry; a throwing check leaves it for the next pass', async () => {
    const run = jest.fn();
    const shouldRetry = jest.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('state unreadable'))
      .mockResolvedValueOnce(true);
    registerDeployKillRetry('property-lookup-canary', run, { shouldRetry });
    mockHealthRows = [killedRow('property-lookup-canary')];

    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual(['property-lookup-canary']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenLastCalledWith(mockHealthRows[0]);
  });

  test('fail-soft: a throwing retry does not stop the other jobs', async () => {
    const good = jest.fn();
    registerDeployKillRetry('throws', jest.fn(async () => { throw new Error('boom'); }));
    registerDeployKillRetry('good', good);
    mockHealthRows = [killedRow('throws'), killedRow('good')];

    expect(await retryDeployKilledJobs({ now: NOW })).toEqual(['good']);
    expect(good).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('throws: retry failed, left for the next pass (boom)'));
  });

  test('an empty registry reads nothing', async () => {
    expect(await retryDeployKilledJobs({ now: NOW })).toEqual([]);
    expect(mockQueries).toHaveLength(0);
  });

  test('registration rejects a missing name, a missing function, or a bad shouldRetry', () => {
    expect(() => registerDeployKillRetry('', () => {})).toThrow();
    expect(() => registerDeployKillRetry('x', null)).toThrow();
    expect(() => registerDeployKillRetry('x', () => {}, { shouldRetry: 'yes' })).toThrow();
  });
});
