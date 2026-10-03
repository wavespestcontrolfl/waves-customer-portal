// deploy-kill-retry: a job cron-lock settled as "process exited mid-run" is
// re-run once — only if it registered, only while the killed run is recent,
// and only while its consecutive-failure count is under the cap.
const healthRows = {};
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({
    _where: null,
    where(w) { this._where = w; return this; },
    async first() {
      const row = healthRows[this._where.job_name];
      if (row === 'throw') throw new Error('db down');
      return row;
    },
  }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { isScheduledTick } = require('../utils/scheduled-cron');
const {
  registerDeployKillRetry,
  retryDeployKilledJobs,
  RETRY_MAX_AGE_MS,
  RETRY_MAX_CONSECUTIVE_FAILURES,
  _private,
} = require('../utils/deploy-kill-retry');

const NOW = new Date('2026-10-03T08:03:00Z').getTime();
const killedRow = (over = {}) => ({
  last_status: 'failed',
  last_started_at: new Date('2026-10-03T07:55:00Z'),
  consecutive_failures: 1,
  ...over,
});

describe('retryDeployKilledJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _private.registry.clear();
    for (const k of Object.keys(healthRows)) delete healthRows[k];
  });

  test('re-runs a registered job once, as scheduled work, and skips an unregistered one', async () => {
    let ranAsTick = null;
    const run = jest.fn(async () => { ranAsTick = isScheduledTick(); });
    registerDeployKillRetry('property-enrich-backfill', run);
    healthRows['property-enrich-backfill'] = killedRow();
    healthRows['billing-daily'] = killedRow();

    const retried = await retryDeployKilledJobs(['billing-daily', 'property-enrich-backfill'], { now: NOW });

    expect(retried).toEqual(['property-enrich-backfill']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ranAsTick).toBe(true);
  });

  test('no retry when a newer tick already restarted the job', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    healthRows['property-lookup-canary'] = killedRow({ last_status: 'running' });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual([]);
    healthRows['property-lookup-canary'] = killedRow({ last_status: 'success' });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('no retry for a killed run older than the age bound', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    healthRows['property-lookup-canary'] = killedRow({ last_started_at: new Date(NOW - RETRY_MAX_AGE_MS - 1000) });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual([]);
    healthRows['property-lookup-canary'] = killedRow({ last_started_at: null });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('stops retrying past the consecutive-failure cap', async () => {
    const run = jest.fn();
    registerDeployKillRetry('property-lookup-canary', run);
    healthRows['property-lookup-canary'] = killedRow({ consecutive_failures: RETRY_MAX_CONSECUTIVE_FAILURES });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual(['property-lookup-canary']);
    healthRows['property-lookup-canary'] = killedRow({ consecutive_failures: RETRY_MAX_CONSECUTIVE_FAILURES + 1 });
    expect(await retryDeployKilledJobs(['property-lookup-canary'], { now: NOW })).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('fail-soft: an unreadable row or a throwing retry does not stop the other jobs', async () => {
    const good = jest.fn();
    registerDeployKillRetry('unreadable', jest.fn());
    registerDeployKillRetry('throws', jest.fn(async () => { throw new Error('boom'); }));
    registerDeployKillRetry('good', good);
    healthRows.unreadable = 'throw';
    healthRows.throws = killedRow();
    healthRows.good = killedRow();

    const retried = await retryDeployKilledJobs(['unreadable', 'throws', 'good'], { now: NOW });

    expect(retried).toEqual(['throws', 'good']);
    expect(good).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('throws: retry failed: boom'));
  });

  test('an empty or missing settle list is a no-op', async () => {
    expect(await retryDeployKilledJobs([], { now: NOW })).toEqual([]);
    expect(await retryDeployKilledJobs(undefined, { now: NOW })).toEqual([]);
  });

  test('registration rejects a missing name or function', () => {
    expect(() => registerDeployKillRetry('', () => {})).toThrow();
    expect(() => registerDeployKillRetry('x', null)).toThrow();
  });
});
