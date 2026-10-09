// current-conflict.js: a visit that cannot stay in its slot
// (GATE_AUTO_DISPATCH_CONFLICT_MOVES, owner 2026-10-09).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn(),
  occupancyProbeEnd: (start, end) => end || `${String(Number(String(start).slice(0, 2)) + 1).padStart(2, '0')}:00`,
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ isBlackoutDate: jest.fn(async () => false) }));

const rebooker = require('../services/rebooker');
const blackout = require('../services/scheduling/blackout-dates');
const { currentConflict } = require('../services/auto-dispatch/current-conflict');

const CTX = { db: jest.fn(), conflictMoves: true };
const SERVICE = {
  id: 's1', customer_id: 'c1', technician_id: 't1', scheduled_date: '2026-12-07',
  window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60,
};
const row = (over = {}) => ({
  id: 'o1', customer_id: 'c2', technician_id: 't1', window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  blackout.isBlackoutDate.mockResolvedValue(false);
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [] });
});

test('gate off: no read and no conflict', async () => {
  expect(await currentConflict(SERVICE, { ...CTX, conflictMoves: false })).toBeNull();
  expect(rebooker.probeMoveConflicts).not.toHaveBeenCalled();
  expect(blackout.isBlackoutDate).not.toHaveBeenCalled();
});

test('a visit with no arrival window is never in conflict', async () => {
  expect(await currentConflict({ ...SERVICE, window_start: null }, CTX)).toBeNull();
  expect(rebooker.probeMoveConflicts).not.toHaveBeenCalled();
});

test('another customer in the same hour is an overlap; the probe excludes the visit and its group', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row()] });
  expect(await currentConflict(SERVICE, CTX, new Set(['s1', 's1-sibling'])))
    .toEqual({ kind: 'overlap', date: '2026-12-07', with: ['o1'] });
  const call = rebooker.probeMoveConflicts.mock.calls[0][0];
  expect(call.excludeServiceIds).toEqual(['s1', 's1-sibling']);
  expect(call.target).toMatchObject({ date: '2026-12-07', windowStart: '00:00', windowEnd: '23:59', technicianId: null });
});

test('back-to-back stops do not overlap; a partial overlap does', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ window_start: '11:00', window_end: '12:00' }), row({ id: 'o2', window_start: '09:00', window_end: '10:00' })] });
  expect(await currentConflict(SERVICE, CTX)).toBeNull();
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ window_start: '10:30', window_end: '11:30' })] });
  expect(await currentConflict(SERVICE, CTX)).toMatchObject({ kind: 'overlap', with: ['o1'] });
});

// The place read: scheduled_services rows by id (property + service address).
function placesDb(places) {
  return jest.fn(() => {
    const c = { leftJoin: () => c, whereIn: () => c, select: async () => places };
    return c;
  });
}

test('the same customer\'s other service at the same place is one stop, not an overlap', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ customer_id: 'c1' })] });
  const sameProperty = placesDb([{ id: 's1', property_id: 'p1' }, { id: 'o1', property_id: 'p1' }]);
  expect(await currentConflict(SERVICE, { ...CTX, db: sameProperty })).toBeNull();
  // No linked property and no stamp: both inherit the customer's primary address.
  const HOME = { customer_address_line1: '100 Example Street', customer_city: 'Example City', customer_zip: '00000' };
  const primary = placesDb([{ id: 's1', property_id: null, ...HOME }, { id: 'o1', property_id: null, ...HOME }]);
  expect(await currentConflict(SERVICE, { ...CTX, db: primary })).toBeNull();
});

test('the same customer at a second property in the hour IS an overlap (Codex #6207 r1 P1)', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ customer_id: 'c1' })] });
  const twoProperties = placesDb([{ id: 's1', property_id: 'p1' }, { id: 'o1', property_id: 'p2' }]);
  expect(await currentConflict(SERVICE, { ...CTX, db: twoProperties })).toMatchObject({ kind: 'overlap', with: ['o1'] });
  const stamp = (id, over) => ({
    id, property_id: null, service_address_line1: '100 Example Street', service_address_city: 'Example City', service_address_zip: '00000',
    customer_address_line1: '100 Example Street', customer_city: 'Example City', customer_zip: '00000', ...over,
  });
  const twoAddresses = placesDb([stamp('s1'), stamp('o1', { service_address_line1: '200 Sample Avenue', service_address_zip: '00001' })]);
  expect(await currentConflict(SERVICE, { ...CTX, db: twoAddresses })).toMatchObject({ kind: 'overlap', with: ['o1'] });
  // Two units of one building share the street line and zip (Codex r2 P1).
  const twoUnits = placesDb([stamp('s1', { service_address_line2: 'Apt 1' }), stamp('o1', { service_address_line2: 'Apt 2' })]);
  expect(await currentConflict(SERVICE, { ...CTX, db: twoUnits })).toMatchObject({ kind: 'overlap', with: ['o1'] });
  // No street line anywhere: the place is unknown, and unknown is a conflict.
  const unknown = placesDb([{ id: 's1', property_id: null }, { id: 'o1', property_id: null }]);
  expect(await currentConflict(SERVICE, { ...CTX, db: unknown })).toMatchObject({ kind: 'overlap', with: ['o1'] });
  // A row whose place cannot be read counts as a different place.
  const unread = placesDb([{ id: 's1', property_id: 'p1' }]);
  expect(await currentConflict(SERVICE, { ...CTX, db: unread })).toMatchObject({ kind: 'overlap', with: ['o1'] });
});

test('another customer needs no place read', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row()] });
  const db = placesDb([]);
  await currentConflict(SERVICE, { ...CTX, db });
  expect(db).not.toHaveBeenCalled();
});

test('another technician\'s stop does not count; an unassigned row and an interview do', async () => {
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ technician_id: 't2' })] });
  expect(await currentConflict(SERVICE, CTX)).toBeNull();
  rebooker.probeMoveConflicts.mockResolvedValue({ rows: [row({ technician_id: null }), row({ id: 'interview:a1', customer_id: null, technician_id: undefined })] });
  expect(await currentConflict(SERVICE, CTX)).toMatchObject({ kind: 'overlap', with: ['o1', 'interview:a1'] });
});

test('a closed day is its own conflict and is read first', async () => {
  blackout.isBlackoutDate.mockResolvedValue(true);
  expect(await currentConflict({ ...SERVICE, scheduled_date: '2026-11-26' }, CTX)).toEqual({ kind: 'closed_day', date: '2026-11-26' });
  expect(blackout.isBlackoutDate).toHaveBeenCalledWith('2026-11-26', CTX.db);
  expect(rebooker.probeMoveConflicts).not.toHaveBeenCalled();
});

test('a failed read propagates: the conflict is never guessed', async () => {
  rebooker.probeMoveConflicts.mockRejectedValue(new Error('db down'));
  await expect(currentConflict(SERVICE, CTX)).rejects.toThrow('db down');
});
