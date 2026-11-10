/**
 * Live make-room destinations as occupancy (Codex #7796 P2). A live make-room hold keeps its own window and the new hour
 * of each regular stop its chain moves at accept. With GATE_BOOKING_MAKE_ROOM on, every occupancy reader that counts
 * holds counts those destinations too: the commit probe (findConflictingVisits, used by /book, availability confirm,
 * the voice agent, the rebooker and the other writers) and the offer side (listOccupiedWindows). Off or shadow: no read.
 * The SQL itself runs against real Postgres in reservation-hold-grace-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'on') }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  multiTechConfirmLive: jest.fn(() => false),
}));

const gates = require('../config/feature-gates');
const makeRoom = require('../services/scheduling/booking-make-room');
const { findConflictingVisits, listOccupiedWindows, DEFAULT_EXCLUDE_STATUSES } = require('../services/scheduling/occupancy');

const DATE = '2027-05-20';
const HOLD = {
  id: 'hold-9', technician_id: 'tech-1', status: 'pending', service_type: 'Lawn Care',
  reservation_expires_at: '2027-05-20T13:15:00.000Z', source_estimate_id: 'estimate-9', date_key: DATE,
  make_room_moves: {
    v: 1, date: DATE, techId: 'tech-1', shiftMin: 60,
    moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }, { id: 'visit-c', from: '10:00', to: '11:00', widthMin: 60 }],
  },
};

// Thenable knex-ish builder: every chain method records and returns the builder; awaiting it yields `rows`.
function builder(rows = []) {
  const b = {};
  for (const name of ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw',
    'orWhereNull', 'orWhereNot', 'orWhere', 'whereBetween', 'leftJoin', 'select', 'orderBy']) {
    b[name] = jest.fn(function call(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  }
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return b;
}

function connection({ holds = [HOLD], visits = [], raw = true } = {}) {
  const conn = jest.fn(() => builder(visits));
  if (raw) conn.raw = jest.fn(async () => ({ rows: holds }));
  return conn;
}

const probe = (conn, window, extra = {}) => findConflictingVisits({ db: conn, date: DATE, ...window, ...extra });

describe('findConflictingVisits — a live make-room hold\'s destinations (mode on)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    gates.multiTechConfirmLive.mockReturnValue(false);
  });

  test('a moved stop\'s new hour over the window comes back as the hold\'s row at that hour', async () => {
    const conn = connection();
    const rows = await probe(conn, { windowStart: '11:00', windowEnd: '12:00' });
    expect(rows).toEqual([expect.objectContaining({
      id: 'hold-9', customer_id: null, technician_id: 'tech-1', scheduled_date: DATE,
      window_start: '11:00:00', window_end: '12:00:00', status: 'pending',
      reservation_expires_at: '2027-05-20T13:15:00.000Z', conflict_reason: 'make_room_destination',
    })]);
    expect(conn.raw).toHaveBeenCalledTimes(1);
    expect(conn.raw).toHaveBeenCalledWith(expect.stringContaining('make_room_moves IS NOT NULL'),
      [DATE, DATE, DEFAULT_EXCLUDE_STATUSES, [], [], null, null]);
  });

  test('a window that only touches a destination is free (half-open, like every overlap here)', async () => {
    expect(await probe(connection(), { windowStart: '12:00', windowEnd: '13:00' })).toEqual([]);
    expect(await probe(connection(), { windowStart: '09:00', windowEnd: '10:00' })).toEqual([]);
  });

  test('two destinations of one hold under the window: one row, at the first', async () => {
    const rows = await probe(connection(), { windowStart: '10:30', windowEnd: '11:30' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'hold-9', window_start: '10:00:00', window_end: '11:00:00' });
  });

  test('the visits the probe found come first; the destination row is added after them', async () => {
    const visit = { id: 'visit-x', customer_id: 'customer-x', window_start: '11:00:00', window_end: '12:00:00', reservation_service_mix: null };
    const rows = await probe(connection({ visits: [visit] }), { windowStart: '11:00', windowEnd: '12:00' });
    expect(rows.map((row) => row.id)).toEqual(['visit-x', 'hold-9']);
  });

  test('includeHolds false (the reservation probes, which run their own destination checks): no read', async () => {
    const conn = connection();
    expect(await probe(conn, { windowStart: '11:00', windowEnd: '12:00' }, { includeHolds: false })).toEqual([]);
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test.each(['shadow', 'off'])('gate %s: no read, the result is unchanged', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    const conn = connection();
    expect(await probe(conn, { windowStart: '11:00', windowEnd: '12:00' })).toEqual([]);
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('a connection with no raw SQL (unit-test doubles): no read, nothing added', async () => {
    expect(await probe(connection({ raw: false }), { windowStart: '11:00', windowEnd: '12:00' })).toEqual([]);
  });

  test('inside a transaction the read runs in a savepoint', async () => {
    const conn = connection();
    const savepoint = { raw: jest.fn(async () => ({ rows: [HOLD] })) };
    conn.isTransaction = true;
    conn.transaction = jest.fn(async (callback) => callback(savepoint));
    const rows = await probe(conn, { windowStart: '11:00', windowEnd: '12:00' });
    expect(rows).toEqual([expect.objectContaining({ id: 'hold-9', conflict_reason: 'make_room_destination' })]);
    expect(savepoint.raw).toHaveBeenCalledTimes(1);
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('the caller\'s excluded rows, statuses and technician scope reach the read', async () => {
    gates.multiTechConfirmLive.mockReturnValue(true);
    const conn = connection();
    await probe(conn, { windowStart: '11:00', windowEnd: '12:00' }, {
      excludeServiceIds: ['visit-b'], excludeStatuses: ['cancelled'], technicianId: 'tech-1',
    });
    expect(conn.raw).toHaveBeenCalledWith(expect.any(String), [DATE, DATE, ['cancelled'], ['visit-b'], ['visit-b'], 'tech-1', 'tech-1']);
  });

  test('a failed read fails the probe (the commit-side callers are guards)', async () => {
    const conn = connection();
    conn.raw.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(probe(conn, { windowStart: '11:00', windowEnd: '12:00' })).rejects.toThrow('connection reset');
  });
});

describe('listOccupiedWindows — a live make-room hold\'s destinations (mode on)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
  });

  test('each destination is an occupied window for the offer builders', async () => {
    const conn = connection();
    const rows = await listOccupiedWindows({ db: conn, dateFrom: DATE, dateTo: '2027-05-22', excludeServiceIds: ['visit-z'] });
    expect(rows).toEqual([
      expect.objectContaining({ id: 'hold-9', date: DATE, startMin: 600, endMin: 660, customer_id: null, conflict_reason: 'make_room_destination' }),
      expect.objectContaining({ id: 'hold-9', date: DATE, startMin: 660, endMin: 720 }),
    ]);
    expect(conn.raw).toHaveBeenCalledWith(expect.any(String), [DATE, '2027-05-22', DEFAULT_EXCLUDE_STATUSES, ['visit-z'], ['visit-z'], null, null]);
  });

  test('gate shadow: no read, the rows are unchanged', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    const conn = connection();
    expect(await listOccupiedWindows({ db: conn, dateFrom: DATE, dateTo: DATE })).toEqual([]);
    expect(conn.raw).not.toHaveBeenCalled();
  });
});
