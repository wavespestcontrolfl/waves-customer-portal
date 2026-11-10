jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'on'), _internals: { MOVED_BY: 'booking_make_room' } }));
jest.mock('../services/day-replan', () => ({ _internals: { applyDeps: jest.fn(() => ({ writerDeps: true })) } }));
jest.mock('../services/day-replan/apply', () => ({
  _internals: { recheckVisit: jest.fn(async () => undefined), writeMoves: jest.fn(), assertNoClash: jest.fn(async () => undefined), reconcileReminders: jest.fn(async () => undefined) },
}));
jest.mock('../services/customer-credit', () => ({
  outermostTransaction: (trx) => { let scope = trx; while (scope && scope.parentTransaction) scope = scope.parentTransaction; return scope; },
}));
jest.mock('../services/day-replan/after-move', () => ({ afterMoveEffects: jest.fn(async () => undefined), repairMoved: jest.fn(async () => undefined) }));

/**
 * The make-room accept's writer module (services/scheduling/booking-make-room-accept.js): the writes, the apply.js code
 * mapping, the after-commit steps (silent, best-effort) and the repair's row selection.
 */
const logger = require('../services/logger');
const apply = require('../services/day-replan/apply');
const afterMove = require('../services/day-replan/after-move');
const accept = require('../services/scheduling/booking-make-room-accept');

const DATE = '2027-05-20';
const PAYLOAD = { v: 1, date: DATE, techId: 'tech-1', shiftMin: 60, moves: [{ id: 'visit-b', from: '09:00', to: '10:30', widthMin: 45 }] };

beforeEach(() => jest.clearAllMocks());

describe('isRefusalCode', () => {
  test.each(['NOT_MOVABLE', 'CHANGED_SINCE_PLAN', 'SLOT_TAKEN'])('%s is a refusal', (code) => expect(accept.isRefusalCode(code)).toBe(true));
  test.each(['ROUTE_CHANGED', '40P01', undefined])('%s is not', (code) => expect(accept.isRefusalCode(code)).toBe(false));
});

describe('writeMakeRoomMoves', () => {
  const trxWith = (rows) => {
    const trx = jest.fn(() => ({ whereIn: () => ({ select: async () => rows }) }));
    return trx;
  };

  test('minutes of the new hour, open end from a NULL window_end, the booking_make_room initiator, then the clash check', async () => {
    apply._internals.writeMoves.mockResolvedValue([{ id: 'visit-b' }]);
    const trx = trxWith([{ id: 'visit-b', window_end: null }]);
    const written = await accept.writeMakeRoomMoves(trx, { dateStr: DATE, techId: 'tech-1', payload: PAYLOAD });
    expect(apply._internals.recheckVisit).toHaveBeenCalledWith(trx, { writerDeps: true }, { id: 'visit-b', dateStr: DATE, toStart: 630 });
    expect(apply._internals.writeMoves).toHaveBeenCalledWith(trx, { writerDeps: true }, {
      dateStr: DATE, moves: [{ id: 'visit-b', toStart: 630, widthMin: 45, openEnd: true }], initiator: 'booking_make_room', reasonCode: 'booking_make_room',
    });
    expect(apply._internals.assertNoClash).toHaveBeenCalledWith(trx, { writerDeps: true }, { dateStr: DATE, techId: 'tech-1', written: [{ id: 'visit-b' }] });
    expect(written).toEqual([{ id: 'visit-b' }]);
  });

  test('a booked end stays a booked end', async () => {
    apply._internals.writeMoves.mockResolvedValue([]);
    await accept.writeMakeRoomMoves(trxWith([{ id: 'visit-b', window_end: '10:00:00' }]), { dateStr: DATE, techId: 'tech-1', payload: PAYLOAD });
    expect(apply._internals.writeMoves.mock.calls[0][2].moves[0].openEnd).toBe(false);
  });

  test('a re-check refusal stops before any write', async () => {
    apply._internals.recheckVisit.mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'NOT_MOVABLE' }));
    await expect(accept.writeMakeRoomMoves(trxWith([]), { dateStr: DATE, techId: 'tech-1', payload: PAYLOAD })).rejects.toMatchObject({ code: 'NOT_MOVABLE' });
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
  });
});

describe('makeRoomAfterCommit', () => {
  const written = [{ id: 'visit-b', start: '10:30', end: '11:15' }];

  test('reminders first (re-read from the committed rows), then the record steps', async () => {
    const conn = {};
    await accept.makeRoomAfterCommit({ dateStr: DATE, written, conn });
    expect(apply._internals.reconcileReminders).toHaveBeenCalledWith(conn, { writerDeps: true }, { ids: ['visit-b'] });
    expect(afterMove.afterMoveEffects).toHaveBeenCalledWith(conn, { dateStr: DATE, written });
    expect(apply._internals.reconcileReminders.mock.invocationCallOrder[0]).toBeLessThan(afterMove.afterMoveEffects.mock.invocationCallOrder[0]);
  });

  test('never throws: a failed reminder sync is logged', async () => {
    apply._internals.reconcileReminders.mockRejectedValueOnce(new Error('boom'));
    await expect(accept.makeRoomAfterCommit({ dateStr: DATE, written, conn: {} })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('reconcileMakeRoomMoves', () => {
  function logConn(rows) {
    const calls = [];
    const chain = {
      where: jest.fn((...args) => { calls.push(['where', ...args]); return chain; }),
      whereRaw: jest.fn((sql) => { calls.push(['whereRaw', sql]); return chain; }),
      distinct: jest.fn(async () => rows),
    };
    const conn = jest.fn((table) => { calls.push(['table', table]); return chain; });
    return { conn, calls };
  }

  test('selects booking_make_room moves dated today or later from the last 3 days, once per visit', async () => {
    const { conn, calls } = logConn([{ scheduled_service_id: 'visit-b' }, { scheduled_service_id: 'visit-b' }, { scheduled_service_id: 'visit-c' }]);
    await expect(accept.reconcileMakeRoomMoves(conn, { today: DATE })).resolves.toBe(2);
    expect(calls).toEqual(expect.arrayContaining([
      ['table', 'reschedule_log'], ['where', { initiated_by: 'booking_make_room' }], ['where', 'new_date', '>=', DATE],
    ]));
    expect(calls.find(([kind]) => kind === 'whereRaw')[1]).toContain("interval '3 days'");
    expect(apply._internals.reconcileReminders).toHaveBeenCalledWith(conn, { writerDeps: true }, { ids: ['visit-b', 'visit-c'] });
    expect(afterMove.repairMoved.mock.calls.map(([, id]) => id)).toEqual(['visit-b', 'visit-c']);
  });

  test('nothing to repair: no work, zero', async () => {
    const { conn } = logConn([]);
    await expect(accept.reconcileMakeRoomMoves(conn, { today: DATE })).resolves.toBe(0);
    expect(apply._internals.reconcileReminders).not.toHaveBeenCalled();
  });

  test('one visit that fails to repair does not stop the others; a read failure returns 0', async () => {
    const { conn } = logConn([{ scheduled_service_id: 'visit-b' }, { scheduled_service_id: 'visit-c' }]);
    afterMove.repairMoved.mockRejectedValueOnce(new Error('boom'));
    await expect(accept.reconcileMakeRoomMoves(conn, { today: DATE })).resolves.toBe(2);
    expect(afterMove.repairMoved).toHaveBeenCalledTimes(2);
    const broken = jest.fn(() => { throw new Error('db down'); });
    await expect(accept.reconcileMakeRoomMoves(broken, { today: DATE })).resolves.toBe(0);
  });
});

describe('scheduleMakeRoomAfterCommit', () => {
  test('a savepoint is followed to the outermost transaction', async () => {
    let release;
    const outer = { executionPromise: null };
    const savepoint = { parentTransaction: outer, executionPromise: Promise.resolve() };
    outer.executionPromise = new Promise((resolve) => { release = resolve; });
    const pending = accept.scheduleMakeRoomAfterCommit(savepoint, { dateStr: DATE, written: [{ id: 'visit-b' }] });
    await Promise.resolve();
    expect(afterMove.afterMoveEffects).not.toHaveBeenCalled();
    release();
    await pending;
    expect(afterMove.afterMoveEffects).toHaveBeenCalledTimes(1);
  });
});
