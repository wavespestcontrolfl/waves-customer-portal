jest.mock('../models/db', () => ({
  client: {
    acquireConnection: jest.fn(),
    releaseConnection: jest.fn(),
  },
}));
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
