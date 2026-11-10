jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'on') }));

/**
 * GATE_BOOKING_MAKE_ROOM on (owner 2026-11-09): while a customer's make-room hold is LIVE, each stop it would move later
 * is also busy at its destination on that technician-day (the page's filterCollidingSlots), so no other customer is
 * offered the hour the moved stop is going to. The stop's current row stays busy as it is. Mode off and shadow read
 * nothing of the chain.
 */
const db = require('../models/db');
const makeRoom = require('../services/scheduling/booking-make-room');
const { filterCollidingSlots } = require('../services/estimate-slot-availability');

const DATE = '2027-05-20';
const row = (id, start, end, extra = {}) => ({
  id, technician_id: 'tech-1', scheduled_date: DATE, window_start: `${start}:00`, window_end: `${end}:00`, estimated_duration_minutes: 60,
  zone: null, customer_id: `cust-${id}`, reservation_expires_at: null, customer_city: null, ...extra,
});
const MOVES = { v: 1, date: DATE, techId: 'tech-1', shiftMin: 60, moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }] };
const hold = (extra = {}) => row('hold-1', '09:00', '10:00', { customer_id: null, reservation_expires_at: '2027-05-20T20:00:00Z', make_room_moves: MOVES, ...extra });

let selected;
function rowsReturn(rows) {
  const builder = {};
  for (const name of ['leftJoin', 'whereBetween', 'whereNotIn', 'andWhere']) builder[name] = jest.fn(() => builder);
  builder.select = jest.fn(async (...cols) => { selected = cols; return rows; });
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return builder;
    throw new Error(`unexpected table ${table}`);
  });
  db.raw = jest.fn((sql) => sql);
}
const slot = (start) => ({ date: DATE, windowStart: start, windowEnd: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, durationMinutes: 60, techId: 'tech-1' });
const free = async (starts, rows, extra = {}) => (await filterCollidingSlots(starts.map(slot), { dateFrom: DATE, dateTo: DATE, ...extra })).map((s) => s.windowStart);

describe('filterCollidingSlots — a live make-room hold also holds each move\'s destination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
  });

  test('mode on: 10:00 (where visit-b is going) is taken; its old hour and the hold stay taken; 11:00 and 12:00 are free', async () => {
    rowsReturn([row('visit-b', '09:00', '10:00'), hold()]);
    expect(await free(['09:00', '10:00', '11:00', '12:00'])).toEqual(['11:00', '12:00']);
    expect(selected).toContain('scheduled_services.make_room_moves');
  });

  test('without the chain, the same rows leave 10:00 free (only the destination is new)', async () => {
    rowsReturn([row('visit-b', '09:00', '10:00'), hold({ make_room_moves: null })]);
    expect(await free(['09:00', '10:00'])).toEqual(['10:00']);
  });

  test.each(['shadow', 'off'])('mode %s reads nothing of the chain: the column is not selected and 10:00 stays free', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    rowsReturn([row('visit-b', '09:00', '10:00'), hold()]);
    expect(await free(['09:00', '10:00'])).toEqual(['10:00']);
    expect(selected).not.toContain('scheduled_services.make_room_moves');
  });

  test('capacity mode never reads it either', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      rowsReturn([]);
      await filterCollidingSlots([{ ...slot('10:00'), routeMode: 'arrival_windows' }], { dateFrom: DATE, dateTo: DATE });
      expect(db).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_SCHEDULING_CAPACITY;
    }
  });

  test('only a hold carries destinations: a committed row with a stray chain adds none', async () => {
    rowsReturn([row('visit-b', '09:00', '10:00'), row('visit-z', '13:00', '14:00', { make_room_moves: MOVES })]);
    expect(await free(['10:00'])).toEqual(['10:00']);
  });

  test('a chain also arrives as a JSON string; a damaged one adds nothing and breaks nothing', async () => {
    rowsReturn([row('visit-b', '09:00', '10:00'), hold({ make_room_moves: JSON.stringify(MOVES) })]);
    expect(await free(['10:00', '11:00'])).toEqual(['11:00']);
    rowsReturn([row('visit-b', '09:00', '10:00'), hold({ make_room_moves: '{not json' })]);
    expect(await free(['10:00'])).toEqual(['10:00']);
  });

  test('a move whose stop is gone from the day adds nothing', async () => {
    rowsReturn([hold()]);
    expect(await free(['10:00'])).toEqual(['10:00']);
  });

  test('another technician\'s slot at the destination is unaffected once technicians are scoped; this technician\'s is taken', async () => {
    rowsReturn([row('visit-b', '09:00', '10:00'), hold()]);
    const kept = await filterCollidingSlots([{ ...slot('10:00'), techId: 'tech-2' }, slot('10:00')], { dateFrom: DATE, dateTo: DATE });
    // Technician-blind (the gate unset): the committed destination blocks every technician's slot there.
    expect(kept).toEqual([]);
  });

  test('this estimate\'s own hold is the caller\'s to exclude (ownEstimateId): its chain never blocks itself', async () => {
    // The query excludes the own hold row, so its chain never reaches the loop.
    rowsReturn([row('visit-b', '09:00', '10:00')]);
    expect(await free(['10:00'], null, { ownEstimateId: 'est-1' })).toEqual(['10:00']);
  });
});
