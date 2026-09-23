/**
 * Estimate picker travel gap (GATE_SLOT_TRAVEL_GAP) — the 2026-09-03 field-report case
 * (2026-09-03): the ASAP capacity lane offered 9–10 AM in Palmetto with a
 * 10–11 AM Bradenton stop ~33 modeled minutes away, because
 * filterCollidingSlots only rejected OVERLAP. With the gate on the filter also
 * rejects a window whose free time to any live row that day is below modeled
 * drive + buffer — the same predicate reserveSlot/commitReservation enforce.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0, total_feasible: 0 })) }));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { filterCollidingSlots } = estimateSlotAvailability._internals;

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  estimateSlotAvailability._internals.clearCaches();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PALMETTO = { lat: 27.545, lng: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.41 };
const DATE = '2027-05-20';
const RANGE = { dateFrom: DATE, dateTo: DATE };

let lastChain;
function wireRows(rows) {
  lastChain = {
    leftJoin: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return lastChain;
    throw new Error(`unexpected table ${table}`);
  });
}

// Neighbour: committed 10:00–11:00 Bradenton stop on tech-1.
const neighbourRow = (overrides = {}) => ({
  technician_id: 'tech-1', scheduled_date: DATE, window_start: '10:00:00', window_end: '11:00:00',
  estimated_duration_minutes: 60, zone: 'bradenton', customer_city: 'Bradenton', ...BRADENTON, ...overrides,
});
// Candidate: the ASAP 09:00–10:00 candidate (touches the neighbour, no overlap).
const candidateSlot = (overrides = {}) => ({
  slotId: `${DATE}_09-00_tech-1`, date: DATE, windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId: 'tech-1', ...overrides,
});

test('gate off: the touching 9 AM window survives and the query has no coordinate raws (legacy, byte for byte)', async () => {
  wireRows([neighbourRow()]);
  const out = await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: PALMETTO });
  expect(out).toHaveLength(1);
  expect(db.raw).not.toHaveBeenCalled();
  expect(lastChain.select.mock.calls[0]).toEqual(expect.arrayContaining([
    'scheduled_services.customer_id', 'scheduled_services.reservation_expires_at',
  ]));
});

test('gate on: the candidate window is dropped — 0 free minutes against ~33 drive + 15 buffer', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([neighbourRow()]);
  const out = await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: PALMETTO });
  expect(out).toHaveLength(0);
  expect(db.raw.mock.calls.some(([sql]) => /COALESCE\(scheduled_services\.lat/.test(sql))).toBe(true);
});

test('gate on: tech-blind — an UNASSIGNED neighbour row blocks an unassigned or tech-assigned candidate alike', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([neighbourRow({ technician_id: null, zone: null, customer_city: null })]);
  expect(await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
  expect(await filterCollidingSlots([candidateSlot({ techId: null })], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
});

test('gate on: a window with enough free time is kept (13:00 after an 11:00 end)', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([neighbourRow()]);
  // Codex r4 on #4663: an 08:00 candidate used to sit alongside 12:00 here
  // purely to exercise the "gap BEFORE the neighbour" direction — but 08:00
  // is before the documented customer grid (09:00-17:00), which
  // slotWindowFitsDay (this filter's own choke point) now enforces in every
  // mode, and 09:00 (the grid's first hour) touches this 10:00 neighbour
  // with zero gap — no grid-valid "before" example exists against this
  // fixture's neighbour. 12:00 alone still proves the "enough free time is
  // kept" claim; the 11:00 candidate proves the "not enough" claim below.
  const out = await filterCollidingSlots([
    candidateSlot({ slotId: `${DATE}_12-00_tech-1`, windowStart: '12:00', windowEnd: '13:00' }),
    candidateSlot({ slotId: `${DATE}_11-00_tech-1`, windowStart: '11:00', windowEnd: '12:00' }),
  ], { ...RANGE, coords: PALMETTO });
  expect(out.map((s) => s.windowStart)).toEqual(['12:00']);
});

test('gate on: a coordless stop (or a no-coords estimate) degrades to the 15-minute buffer only', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([neighbourRow({ lat: null, lng: null })]);
  // 0 free minutes < 15 → dropped; 15 free minutes (09:00-09:45, the
  // grid's first hour) → kept. Codex r4 on #4663: 08:45 was off-grid
  // (before 09:00) and off-the-hour; slotWindowFitsDay now enforces both.
  // Merge note (round 5): durationMinutes must match this candidate's own
  // 45-minute window here — candidateSlot()'s 60-minute default fed
  // travel-gap.js's effectiveEndMinutes a windowMinutes wider than the
  // real endMin, pushing the credited "effective end" to exactly 10:00
  // (the neighbour's start) and manufacturing a false zero-gap violation
  // on a window that has a real, sufficient 15 free minutes.
  expect(await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
  expect(await filterCollidingSlots(
    [candidateSlot({ windowStart: '09:00', windowEnd: '09:45', durationMinutes: 45 })], { ...RANGE, coords: PALMETTO },
  )).toHaveLength(1);
  // No estimate coords at all (the no-coords branch passes null) → same buffer-only rule.
  wireRows([neighbourRow()]);
  expect(await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: null })).toHaveLength(0);
  expect(await filterCollidingSlots(
    [candidateSlot({ windowStart: '09:00', windowEnd: '09:45', durationMinutes: 45 })], { ...RANGE, coords: null },
  )).toHaveLength(1);
});

test('gate on: the buffer env is honoured', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  process.env.SLOT_TRAVEL_BUFFER_MINUTES = '0';
  wireRows([neighbourRow({ lat: null, lng: null })]);
  // Coordless stop + zero buffer → touching is allowed again.
  expect(await filterCollidingSlots([candidateSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(1);
});
