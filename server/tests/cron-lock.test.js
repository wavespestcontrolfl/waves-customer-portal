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

  test('over-cap jobs WAIT for a slot without a connection — and never drop the tick', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const herd = Array.from({ length: 10 }, (_, i) =>
      runExclusive(`herd-${i}`, () => gate, { recordHealth: false, waitForSlot: true }));

    // 11th distinct job while 10 lock connections are pinned: it must wait
    // (holding no connection), not skip — date-scoped once-a-day jobs like
    // monthly billing cannot recover a dropped tick tomorrow.
    const overflowBody = jest.fn(async () => 'billed');
    const overflow = runExclusive('billing-monthly', overflowBody, { recordHealth: false, waitForSlot: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(overflowBody).not.toHaveBeenCalled();
    // No 11th pool connection was checked out while waiting.
    expect(db.client.acquireConnection).toHaveBeenCalledTimes(10);

    release('swept');
    await expect(Promise.all(herd)).resolves.toEqual(Array(10).fill('swept'));
    // The waiter gets the freed slot and runs to completion.
    await expect(overflow).resolves.toBe('billed');
    expect(overflowBody).toHaveBeenCalledTimes(1);

    // Slots are returned: the next tick runs normally.
    const after = await runExclusive('after-herd', async () => 'ran', { recordHealth: false, waitForSlot: true });
    expect(after).toBe('ran');
  });

  test('the holder cap scales down with the active pool size (small dev/test pools)', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);
    // Dev/test pools max out at 10 — the cap must leave half of THAT, not
    // assume prod's 20 (ten holders on a ten-connection pool is the
    // deadlock this module exists to prevent).
    db.client.pool = { max: 10 };
    try {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const herd = Array.from({ length: 5 }, (_, i) =>
        runExclusive(`small-${i}`, () => gate, { recordHealth: false, waitForSlot: true }));

      const overflowBody = jest.fn(async () => 'ran');
      const overflow = runExclusive('small-overflow', overflowBody, { recordHealth: false, waitForSlot: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(overflowBody).not.toHaveBeenCalled();
      expect(db.client.acquireConnection).toHaveBeenCalledTimes(5);

      release('swept');
      await expect(Promise.all(herd)).resolves.toEqual(Array(5).fill('swept'));
      await expect(overflow).resolves.toBe('ran');
    } finally {
      delete db.client.pool;
    }
  });

  test("an ACTIVE job's next tick coalesces — it never queues a replay of the sweep", async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = runExclusive('sms-sweep', () => gate, { recordHealth: false, waitForSlot: true });
    await new Promise((resolve) => setImmediate(resolve));

    // Second tick while the first still runs: it must never rerun the
    // sweep — a queued replay right after the first run releases the
    // advisory lock risks duplicate sends.
    const replayBody = jest.fn();
    const second = runExclusive('sms-sweep', replayBody, { recordHealth: false, waitForSlot: true });

    release('swept');
    await expect(first).resolves.toBe('swept');
    await expect(second).resolves.toEqual({ skipped: true, reason: 'lease_held' });
    expect(replayBody).not.toHaveBeenCalled();
  });

  test('a coalesced tick inherits a leaseless outcome and does the work itself', async () => {
    const conn = mockConnection(true);
    // First run gets its slot but its connection acquire FAILS — it never
    // held the lease, so its work was not done. The overlapping tick must
    // not report lease_held over a run that ran nothing (deploy overlap on
    // a once-daily job would drop both invocations).
    let failAcquire;
    const pendingAcquire = new Promise((resolve, reject) => { failAcquire = reject; });
    db.client.acquireConnection
      .mockReturnValueOnce(pendingAcquire)
      .mockResolvedValue(conn);

    const firstBody = jest.fn();
    const first = runExclusive('billing-monthly', firstBody, { recordHealth: false, waitForSlot: true });
    await new Promise((resolve) => setImmediate(resolve));

    const secondBody = jest.fn(async () => 'billed');
    const second = runExclusive('billing-monthly', secondBody, { recordHealth: false, waitForSlot: true });
    await new Promise((resolve) => setImmediate(resolve));

    failAcquire(new Error('pool exhausted'));
    await expect(first).resolves.toEqual({ skipped: true, reason: 'no_connection' });
    await expect(second).resolves.toBe('billed');
    expect(firstBody).not.toHaveBeenCalled();
    expect(secondBody).toHaveBeenCalledTimes(1);
  });

  test('a queued tick fails (no_connection) instead of running past the wait bound', async () => {
    jest.useFakeTimers();
    try {
      const conn = mockConnection(true);
      db.client.acquireConnection.mockResolvedValue(conn);

      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const herd = Array.from({ length: 10 }, (_, i) =>
        runExclusive(`herd-${i}`, () => gate, { recordHealth: false, waitForSlot: true }));
      await Promise.resolve();

      const lateBody = jest.fn();
      const late = runExclusive('billing-monthly', lateBody, { recordHealth: false, waitForSlot: true });

      // Ten minutes pass with no slot: the tick must FAIL visibly, not run
      // whenever a slot opens — date-sensitive bodies recompute their
      // target date at execution time and would charge the wrong cohort.
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      await expect(late).resolves.toEqual({ skipped: true, reason: 'no_connection' });
      expect(lateBody).not.toHaveBeenCalled();

      release('swept');
      await expect(Promise.all(herd)).resolves.toEqual(Array(10).fill('swept'));
    } finally {
      jest.useRealTimers();
    }
  });

  test('request-scoped locks (recordHealth: false) never wait behind the herd', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);
    db.client.pool = { max: 10 };
    try {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const herd = Array.from({ length: 5 }, (_, i) =>
        runExclusive(`herd-${i}`, () => gate, { recordHealth: false, waitForSlot: true }));

      // Cap is full, but an admin-route dynamic lock keeps the immediate
      // try-lock behavior — an HTTP request parked behind a long cron
      // would mutate after the client gave up.
      const sent = await runExclusive('review-send:cust-42', async () => 'sent', { recordHealth: false });
      expect(sent).toBe('sent');

      release('swept');
      await Promise.all(herd);
    } finally {
      delete db.client.pool;
    }
  });

  test('nested runExclusive is reentrant — no self-deadlock at the minimum cap', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);
    // DB_POOL_MAX floor is 2 → cap 1: the outer job holds the only slot,
    // so a non-reentrant inner call would wait on itself forever.
    db.client.pool = { max: 2 };
    try {
      const result = await runExclusive('outer-job', async () =>
        runExclusive('inner-job', async () => 'nested-ok', { recordHealth: false }),
      { recordHealth: false });
      expect(result).toBe('nested-ok');
      // The nested lock must ride the OUTER session — a second pooled
      // connection at max 2 pins the whole pool before the inner body
      // ever queries it.
      expect(db.client.acquireConnection).toHaveBeenCalledTimes(1);
      const conn = await db.client.acquireConnection.mock.results[0].value;
      const lockCalls = conn.query.mock.calls
        .map(([arg]) => arg)
        .filter((arg) => arg.text.includes('pg_try_advisory_lock'));
      expect(lockCalls.map((c) => c.values[0])).toEqual(['cron:outer-job', 'cron:inner-job']);
      // Owner releases once; the nested call must not double-release.
      expect(db.client.releaseConnection).toHaveBeenCalledTimes(1);
    } finally {
      delete db.client.pool;
    }
  });

  test('a second tick of a job already queued for a slot coalesces into a lease_held skip', async () => {
    const conn = mockConnection(true);
    db.client.acquireConnection.mockResolvedValue(conn);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const herd = Array.from({ length: 10 }, (_, i) =>
      runExclusive(`herd-${i}`, () => gate, { recordHealth: false, waitForSlot: true }));

    const queuedBody = jest.fn(async () => 'ran-once');
    const queued = runExclusive('minute-job', queuedBody, { recordHealth: false, waitForSlot: true });
    await new Promise((resolve) => setImmediate(resolve));
    // Cron fires again while the first tick still waits: coalesce, don't
    // stack a backlog of stale ticks behind the queued one.
    const repeatBody = jest.fn();
    const repeat = runExclusive('minute-job', repeatBody, { recordHealth: false, waitForSlot: true });

    release('swept');
    await Promise.all(herd);
    await expect(queued).resolves.toBe('ran-once');
    await expect(repeat).resolves.toEqual({ skipped: true, reason: 'lease_held' });
    expect(queuedBody).toHaveBeenCalledTimes(1);
    expect(repeatBody).not.toHaveBeenCalled();
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
