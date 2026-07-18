jest.mock('../models/db', () => {
  // Callable knex mock: db('job_health') feeds the job-health recorder,
  // db.client feeds the advisory-lock plumbing.
  const builder = {
    insert: jest.fn(() => builder),
    onConflict: jest.fn(() => builder),
    merge: jest.fn(async () => undefined),
    where: jest.fn(() => builder),
    update: jest.fn(async () => 1),
  };
  const fn = jest.fn(() => builder);
  fn.client = {
    acquireConnection: jest.fn(),
    releaseConnection: jest.fn(),
  };
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  fn.__builder = builder;
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { runExclusive } = require('../utils/cron-lock');

function mockConnection(lockGranted) {
  return {
    query: jest.fn(async ({ text }) => {
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: lockGranted }] };
      }
      return { rows: [] };
    }),
  };
}

describe('cron-lock runExclusive', () => {
  beforeEach(() => jest.clearAllMocks());

  test('runs the body and unlocks when the lease is acquired', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    const body = jest.fn().mockResolvedValue({ sent: 3 });
    const result = await runExclusive('test-job', body);

    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 3 });
    const calls = conn.query.mock.calls.map(([arg]) => arg.text);
    expect(calls.some((t) => t.includes('pg_try_advisory_lock'))).toBe(true);
    expect(calls.some((t) => t.includes('pg_advisory_unlock'))).toBe(true);
    expect(db.client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('skips the body when another holder has the lease', async () => {
    const conn = mockConnection(false);
    db.client.acquireConnection.mockResolvedValue(conn);

    const body = jest.fn();
    const result = await runExclusive('test-job', body);

    expect(body).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'lease_held' });
    // No unlock for a lock we never held.
    const calls = conn.query.mock.calls.map(([arg]) => arg.text);
    expect(calls.some((t) => t.includes('pg_advisory_unlock'))).toBe(false);
    expect(db.client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('unlocks and releases even when the body throws', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await expect(
      runExclusive('test-job', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    const calls = conn.query.mock.calls.map(([arg]) => arg.text);
    expect(calls.some((t) => t.includes('pg_advisory_unlock'))).toBe(true);
    expect(db.client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('flags the connection for destruction when unlock fails', async () => {
    const conn = {
      query: jest.fn(async ({ text }) => {
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (text.includes('pg_advisory_unlock')) throw new Error('connection reset');
        return { rows: [] };
      }),
    };
    db.client.acquireConnection.mockResolvedValue(conn);

    const result = await runExclusive('test-job', async () => 'ok');

    expect(result).toBe('ok');
    // A session that may still hold the advisory lock must not be reused
    // by the pool — knex destroys connections with __knex__disposed set.
    expect(conn.__knex__disposed).toMatch(/unlock failed/);
    expect(db.client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('skips (without throwing) when no DB connection is available', async () => {
    db.client.acquireConnection.mockRejectedValue(new Error('pool exhausted'));

    const body = jest.fn();
    const result = await runExclusive('test-job', body);

    expect(body).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'no_connection' });
  });
});

describe('cron-lock job-health recorder', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a successful run records start (upsert) and success end', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await runExclusive('lawn-pricing-sweep', async () => 'ok');

    expect(db).toHaveBeenCalledWith('job_health');
    // Start: upsert with running status
    expect(db.__builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_name: 'lawn-pricing-sweep', last_status: 'running',
    }));
    expect(db.__builder.onConflict).toHaveBeenCalledWith('job_name');
    // End: success clears the failure streak and stamps last_success_at
    expect(db.__builder.update).toHaveBeenCalledWith(expect.objectContaining({
      last_status: 'success',
      consecutive_failures: 0,
      last_error: null,
      last_success_at: expect.any(Date),
      last_duration_ms: expect.any(Number),
    }));
  });

  test('a failing run records the error, increments the streak, and still throws', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await expect(
      runExclusive('ga4-sync', async () => { throw new Error('quota exceeded'); }),
    ).rejects.toThrow('quota exceeded');

    expect(db.__builder.update).toHaveBeenCalledWith(expect.objectContaining({
      last_status: 'failed',
      last_error: 'quota exceeded',
      consecutive_failures: expect.objectContaining({ __raw: 'consecutive_failures + 1' }),
    }));
  });

  test('skipped ticks record nothing', async () => {
    const conn = mockConnection(false);
    db.client.acquireConnection.mockResolvedValue(conn);

    await runExclusive('test-job', jest.fn());
    expect(db).not.toHaveBeenCalledWith('job_health');
  });

  test('recorder failure never breaks the job (pre-migration safety)', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);
    db.__builder.merge.mockRejectedValueOnce(new Error('relation "job_health" does not exist'));
    db.__builder.update.mockRejectedValueOnce(new Error('relation "job_health" does not exist'));

    const body = jest.fn().mockResolvedValue({ sent: 2 });
    const result = await runExclusive('test-job', body);

    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 2 });
  });
});
