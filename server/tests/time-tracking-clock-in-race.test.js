// clockIn() keeps two concurrent clock-ins from making two shifts: it locks the
// technician row (FOR UPDATE), then refuses when a shift is already active. The
// refusal carries the code ALREADY_CLOCKED_IN so the caller can tell it apart.

jest.mock('../models/db', () => ({ transaction: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const timeTracking = require('../services/time-tracking');

function makeTrx({ technician = { id: 'tech-1' }, existingShift = null } = {}) {
  const calls = { forUpdate: 0, inserted: [] };
  const trx = jest.fn((table) => {
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        forUpdate: jest.fn(function forUpdate() { calls.forUpdate += 1; return this; }),
        first: jest.fn().mockResolvedValue(technician),
      };
    }
    return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(existingShift),
      insert: jest.fn((row) => {
        calls.inserted.push(row);
        return { returning: jest.fn().mockResolvedValue([{ id: 'shift-new', ...row }]) };
      }),
    };
  });
  return { trx, calls };
}

describe('clockIn serialization', () => {
  test('locks the technician row and records source auto', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const entry = await timeTracking.clockIn('tech-1', {
      lat: 27.1, lng: -82.4, source: 'auto', notes: 'Auto clock-in on arrival at first stop',
    });

    expect(calls.forUpdate).toBe(1);
    expect(calls.inserted).toHaveLength(1);
    expect(calls.inserted[0]).toMatchObject({
      technician_id: 'tech-1', entry_type: 'shift', status: 'active', source: 'auto',
    });
    expect(entry.id).toBe('shift-new');
  });

  test('an already-active shift is refused with code ALREADY_CLOCKED_IN and no second insert', async () => {
    const { trx, calls } = makeTrx({ existingShift: { id: 'shift-1' } });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await expect(timeTracking.clockIn('tech-1', { source: 'auto' }))
      .rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN', message: expect.stringMatching(/^Already clocked in/) });
    expect(calls.inserted).toHaveLength(0);
  });

  test('an inactive tech is refused with ACCOUNT_INACTIVE', async () => {
    const { trx, calls } = makeTrx({ technician: null });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await expect(timeTracking.clockIn('tech-1', { source: 'auto' }))
      .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    expect(calls.inserted).toHaveLength(0);
  });
});

describe('clockIn clockInAt', () => {
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

  test('no clockInAt stamps now (the app route passes nothing)', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const before = Date.now();
    await timeTracking.clockIn('tech-1', { source: 'app' });
    const stamped = calls.inserted[0].clock_in.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  test('clockInAt becomes clock_in', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const at = minutesAgo(12);
    await timeTracking.clockIn('tech-1', { source: 'truck_gps', clockInAt: at });
    expect(calls.inserted[0].clock_in).toBe(at);
    expect(calls.inserted[0].source).toBe('truck_gps');
  });

  test.each([
    ['30 minutes ago minus a second is too old', () => minutesAgo(30.02), 'CLOCK_IN_AT_TOO_OLD'],
    ['an hour ago is too old', () => minutesAgo(60), 'CLOCK_IN_AT_TOO_OLD'],
    ['3 minutes ahead is the future', () => new Date(Date.now() + 3 * 60 * 1000), 'CLOCK_IN_AT_FUTURE'],
    ['an invalid date', () => new Date('not a date'), 'INVALID_CLOCK_IN_AT'],
  ])('rejects %s with code %s and writes nothing', async (_name, makeAt, code) => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(timeTracking.clockIn('tech-1', { clockInAt: makeAt() }))
      .rejects.toMatchObject({ code, statusCode: 400, isOperational: true });
    expect(calls.inserted).toHaveLength(0);
    expect(calls.forUpdate).toBe(0);
  });

  test('accepts the edges: 29 minutes ago and 1 minute ahead', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await timeTracking.clockIn('tech-1', { clockInAt: minutesAgo(29) });
    await timeTracking.clockIn('tech-1', { clockInAt: new Date(Date.now() + 60 * 1000) });
    expect(calls.inserted).toHaveLength(2);
  });
});

describe('clockInInTransaction', () => {
  test('runs in the caller transaction without opening one, and refuses a second shift', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockClear();
    const entry = await timeTracking.clockInInTransaction(trx, 'tech-1', { source: 'truck_gps' });
    expect(entry.id).toBe('shift-new');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(calls.inserted).toHaveLength(1);

    const second = makeTrx({ existingShift: { id: 'shift-1' } });
    await expect(timeTracking.clockInInTransaction(second.trx, 'tech-1', {}))
      .rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN' });
    expect(second.calls.inserted).toHaveLength(0);
  });
});
