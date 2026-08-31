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
const { runExclusive, recordJobStart, recordJobEnd } = require('../utils/cron-lock');

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

const healthCalls = (conn) =>
  conn.query.mock.calls.map(([arg]) => arg).filter((arg) => arg.text.includes('job_health'));

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

  test('a successful run records start (upsert) and success end ON THE HELD CONNECTION', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await runExclusive('lawn-pricing-sweep', async () => 'ok');

    const writes = healthCalls(conn);
    // Start: upsert with running status
    expect(writes[0].text).toContain('INSERT INTO job_health');
    expect(writes[0].text).toContain('ON CONFLICT (job_name)');
    expect(writes[0].text).toContain("'running'");
    expect(writes[0].values).toEqual(['lawn-pricing-sweep', expect.any(Date)]);
    // End: success clears the failure streak and stamps last_success_at
    expect(writes[1].text).toContain("last_status = 'success'");
    expect(writes[1].text).toContain('consecutive_failures = 0');
    expect(writes[1].text).toContain('last_error = NULL');
    expect(writes[1].values).toEqual(['lawn-pricing-sweep', expect.any(Date), expect.any(Number)]);
  });

  test('NEVER acquires a second pool connection while the lock connection is held', async () => {
    // The regression this file exists to prevent: job_health writes through
    // the shared pool while the advisory-lock connection is pinned let a
    // top-of-hour cron herd drain the pool and self-deadlock (prod outage
    // 08-30: KnexTimeout on /api/pay and /api/auth/refresh).
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await runExclusive('herd-job', async () => 'ok');
    await expect(
      runExclusive('herd-job', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(db).not.toHaveBeenCalledWith('job_health');
    expect(db.client.acquireConnection).toHaveBeenCalledTimes(2); // one per run
    expect(healthCalls(conn).length).toBe(4); // both runs recorded on conn
  });

  test('a failing run records the error, increments the streak, and still throws', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await expect(
      runExclusive('ga4-sync', async () => { throw new Error('quota exceeded'); }),
    ).rejects.toThrow('quota exceeded');

    const fail = healthCalls(conn).find((c) => c.text.includes("last_status = 'failed'"));
    expect(fail.text).toContain('consecutive_failures = consecutive_failures + 1');
    expect(fail.values).toEqual(['ga4-sync', expect.any(Date), expect.any(Number), 'quota exceeded']);
  });

  test('recorded errors mask phone-number-shaped digit runs (Twilio payload echo)', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    await expect(
      runExclusive('review-followups', async () => {
        throw new Error("Twilio: The 'To' number +1 (941) 555-0134 is not a valid phone number");
      }),
    ).rejects.toThrow();

    const fail = healthCalls(conn).find((c) => c.text.includes("last_status = 'failed'"));
    const recordedError = fail.values[3];
    expect(recordedError).not.toContain('941');
    expect(recordedError).toContain('[redacted-number]');
  });

  test('recordHealth: false records nothing for dynamic per-entity locks', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    const result = await runExclusive('review-send:cust-123', async () => 'sent', { recordHealth: false });
    expect(result).toBe('sent');
    expect(healthCalls(conn)).toEqual([]);
    expect(db).not.toHaveBeenCalledWith('job_health');
  });

  test('skipped ticks record nothing', async () => {
    const conn = mockConnection(false);
    db.client.acquireConnection.mockResolvedValue(conn);

    await runExclusive('test-job', jest.fn());
    expect(healthCalls(conn)).toEqual([]);
    expect(db).not.toHaveBeenCalledWith('job_health');
  });

  test('recorder failure never breaks the job (pre-migration safety)', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);
    conn.query.mockImplementation(async ({ text }) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (text.includes('job_health')) throw new Error('relation "job_health" does not exist');
      return { rows: [] };
    });

    const body = jest.fn().mockResolvedValue({ sent: 2 });
    const result = await runExclusive('test-job', body);

    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 2 });
  });

  test('standalone recorders (no held connection) still write through the pool', async () => {
    // scheduler.js records skipped-tick failures OUTSIDE runExclusive — no
    // pinned connection exists there, so the pool path is correct.
    await recordJobStart('reschedule-intent-watcher');
    expect(db).toHaveBeenCalledWith('job_health');
    expect(db.__builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_name: 'reschedule-intent-watcher', last_status: 'running',
    }));

    await recordJobEnd('reschedule-intent-watcher', Date.now(), new Error('tick skipped: no_connection'));
    expect(db.__builder.update).toHaveBeenCalledWith(expect.objectContaining({
      last_status: 'failed',
      last_error: 'tick skipped: no_connection',
    }));
  });
});
