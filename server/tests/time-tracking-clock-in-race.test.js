// clockIn() is what keeps two concurrent geofence ENTERs from making two
// shifts: it locks the technician row (FOR UPDATE), then refuses when a shift
// is already active. The refusal carries a code so the geofence handler can
// fall through to startJob instead of treating it as a failure.

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

describe('clockIn serialization for geofence auto clock-in', () => {
  test('locks the technician row and records source geofence_auto', async () => {
    const { trx, calls } = makeTrx();
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const entry = await timeTracking.clockIn('tech-1', {
      lat: 27.1, lng: -82.4, source: 'geofence_auto', notes: 'Auto clock-in on arrival at first stop',
    });

    expect(calls.forUpdate).toBe(1);
    expect(calls.inserted).toHaveLength(1);
    expect(calls.inserted[0]).toMatchObject({
      technician_id: 'tech-1', entry_type: 'shift', status: 'active', source: 'geofence_auto',
    });
    expect(entry.id).toBe('shift-new');
  });

  test('an already-active shift is refused with code ALREADY_CLOCKED_IN and no second insert', async () => {
    const { trx, calls } = makeTrx({ existingShift: { id: 'shift-1' } });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await expect(timeTracking.clockIn('tech-1', { source: 'geofence_auto' }))
      .rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN', message: expect.stringMatching(/^Already clocked in/) });
    expect(calls.inserted).toHaveLength(0);
  });

  test('an inactive tech is refused with ACCOUNT_INACTIVE', async () => {
    const { trx, calls } = makeTrx({ technician: null });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    await expect(timeTracking.clockIn('tech-1', { source: 'geofence_auto' }))
      .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    expect(calls.inserted).toHaveLength(0);
  });
});
