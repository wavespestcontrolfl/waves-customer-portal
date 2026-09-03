/**
 * Estimate picker travel gap (GATE_SLOT_TRAVEL_GAP) — the Rod Lindsay case
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

// Paul: committed 10:00–11:00 Bradenton stop on tech-1.
const paulRow = (overrides = {}) => ({
  technician_id: 'tech-1', scheduled_date: DATE, window_start: '10:00:00', window_end: '11:00:00',
  estimated_duration_minutes: 60, zone: 'bradenton', customer_city: 'Bradenton', ...BRADENTON, ...overrides,
});
// Rod: the ASAP 09:00–10:00 candidate (touches Paul, no overlap).
const rodSlot = (overrides = {}) => ({
  slotId: `${DATE}_09-00_tech-1`, date: DATE, windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId: 'tech-1', ...overrides,
});

test('gate off: the touching 9 AM window survives and the query has no coordinate raws (legacy, byte for byte)', async () => {
  wireRows([paulRow()]);
  const out = await filterCollidingSlots([rodSlot()], { ...RANGE, coords: PALMETTO });
  expect(out).toHaveLength(1);
  expect(db.raw).not.toHaveBeenCalled();
  expect(lastChain.select.mock.calls[0]).toHaveLength(7);
});

test('gate on: the Rod window is dropped — 0 free minutes against ~33 drive + 15 buffer', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([paulRow()]);
  const out = await filterCollidingSlots([rodSlot()], { ...RANGE, coords: PALMETTO });
  expect(out).toHaveLength(0);
  expect(db.raw.mock.calls.some(([sql]) => /COALESCE\(scheduled_services\.lat/.test(sql))).toBe(true);
});

test('gate on: tech-blind — an UNASSIGNED Paul row blocks an unassigned or tech-assigned candidate alike', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([paulRow({ technician_id: null, zone: null, customer_city: null })]);
  expect(await filterCollidingSlots([rodSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
  expect(await filterCollidingSlots([rodSlot({ techId: null })], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
});

test('gate on: a window with enough free time is kept (13:00 after an 11:00 end, or 08:00 before 10:00 with a 60-min gap)', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([paulRow()]);
  const out = await filterCollidingSlots([
    rodSlot({ slotId: `${DATE}_08-00_tech-1`, windowStart: '08:00', windowEnd: '09:00' }),
    rodSlot({ slotId: `${DATE}_12-00_tech-1`, windowStart: '12:00', windowEnd: '13:00' }),
    rodSlot({ slotId: `${DATE}_11-00_tech-1`, windowStart: '11:00', windowEnd: '12:00' }),
  ], { ...RANGE, coords: PALMETTO });
  expect(out.map((s) => s.windowStart)).toEqual(['08:00', '12:00']);
});

test('gate on: a coordless stop (or a no-coords estimate) degrades to the 15-minute buffer only', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  wireRows([paulRow({ lat: null, lng: null })]);
  // 0 free minutes < 15 → dropped; 15 free minutes (08:45–09:45) → kept.
  expect(await filterCollidingSlots([rodSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(0);
  expect(await filterCollidingSlots(
    [rodSlot({ windowStart: '08:45', windowEnd: '09:45' })], { ...RANGE, coords: PALMETTO },
  )).toHaveLength(1);
  // No estimate coords at all (the no-coords branch passes null) → same buffer-only rule.
  wireRows([paulRow()]);
  expect(await filterCollidingSlots([rodSlot()], { ...RANGE, coords: null })).toHaveLength(0);
  expect(await filterCollidingSlots(
    [rodSlot({ windowStart: '08:45', windowEnd: '09:45' })], { ...RANGE, coords: null },
  )).toHaveLength(1);
});

test('gate on: the buffer env is honoured', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  process.env.SLOT_TRAVEL_BUFFER_MINUTES = '0';
  wireRows([paulRow({ lat: null, lng: null })]);
  // Coordless stop + zero buffer → touching is allowed again.
  expect(await filterCollidingSlots([rodSlot()], { ...RANGE, coords: PALMETTO })).toHaveLength(1);
});
