/**
 * Codex r3 P0 on #4663: capacity mode's shared shift (scheduling/policy.js
 * SHIFT.startMinutes) starts at 08:00 for EVERY caller of findAvailableSlots,
 * but the documented public/token offer grid
 * (docs/public-route-contracts.md, scheduling/customer-windows.js
 * CUSTOMER_HOUR_GRID) is 09:00-17:00. A caller that marks itself
 * customerFacing must never receive an 08:00 candidate from capacity mode;
 * a staff/optimizer caller that leaves customerFacing unset must be
 * unaffected — it can still see 08:00.
 *
 * This mocks the route-evaluation internals (arrival-route.js) so the test
 * is purely about find-time's own enumeration/admission boundary, not real
 * route feasibility — every on-the-hour candidate the loop generates is
 * treated as feasible, so the test can assert exactly which start times the
 * loop itself produced.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  createSchedulingTravel: () => ({ preload: async () => {}, diagnostics: () => ({}) }),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: () => false,
  loadArrivalRouteContext: jest.fn(async () => ({
    target: { id: 'candidate', service_type: 'pest_control' },
    rows: [],
  })),
  enumerateArrivalPlacements: jest.fn(),
  // Every enumerated placement is feasible — the test only cares which
  // start times the loop itself generated and admitted.
  // Detour grows with the hour (10 minutes per hour after 08:00) so the
  // self-serve detour cap has something to hide.
  evaluateArrivalPlacement: jest.fn((_context, options) => ({
    feasible: true, routeOrder: ['candidate'], detourMinutes: (Number(options.windowStart.slice(0, 2)) - 8) * 10,
    driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0, estimatedArrival: null, arrivals: [{}],
    finishMinute: 1000, travelSource: 'none', travelReasons: [],
  })),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');

function chain(result) {
  const c = {};
  // whereBetween/whereNull/whereIn: findCapacitySlots' absentTechDays read
  // (technician-eligibility.js) against 'technician_absences' — every other
  // table in this suite only ever needs `where`.
  ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const FUTURE_DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1',
  dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 50, serviceType: 'pest_control',
};

describe('capacity mode (GATE_SCHEDULING_CAPACITY) customer-grid admission', () => {
  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
  });
  afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

  test('a customerFacing caller never gets an 08:00 candidate — only the documented 09:00-17:00 grid', async () => {
    const { slots } = await findAvailableSlots({ ...BASE, customerFacing: true });
    const startTimes = slots.map((s) => s.start_time);
    expect(startTimes.length).toBeGreaterThan(0);
    expect(startTimes).not.toContain('08:00');
    for (const t of startTimes) {
      expect(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']).toContain(t);
    }
  });

  test('a staff caller (customerFacing unset) still gets an 08:00 candidate', async () => {
    const { slots } = await findAvailableSlots(BASE);
    const startTimes = slots.map((s) => s.start_time);
    expect(startTimes).toContain('08:00');
  });
});

// GATE_TECH_OUT_REDISTRIBUTE's slot-discovery counterpart (codex #4678
// pre-push auditor P1), capacity path (findCapacitySlots).
describe('absent tech-days (technician_absences, GATE_TECH_OUT_REDISTRIBUTE) — capacity mode', () => {
  const NEXT_DATE = nextBookableDate(new Date(`${FUTURE_DATE}T12:00:00Z`)).toISOString().slice(0, 10);

  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    db.mockImplementation((table) => {
      if (table === 'technicians') return chain([{ id: 'tech-1', name: 'A' }]);
      if (table === 'technician_absences') return chain([{ technician_id: 'tech-1', absence_date: FUTURE_DATE }]);
      return chain([]);
    });
  });
  afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

  test('the marked-out date yields no candidates while the other date in range still does', async () => {
    const { slots } = await findAvailableSlots({ ...BASE, dateTo: NEXT_DATE });
    const dates = new Set(slots.map((s) => s.date));
    expect(dates.has(FUTURE_DATE)).toBe(false);
    expect(dates.has(NEXT_DATE)).toBe(true);
  });
});

// Owner ruling 2026-09-25: self-serve surfaces hide slots adding more than 30
// round-trip drive minutes; staff and phone callers see every fit.
describe('self-serve detour cap (capacity mode)', () => {
  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
  });
  afterEach(() => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    delete process.env.SCHEDULING_MAX_DETOUR_MINUTES;
  });

  test('a customerFacing caller never sees a slot adding more than 30 minutes, and learns why', async () => {
    const result = await findAvailableSlots({ ...BASE, customerFacing: true });
    expect(result.slots.map((s) => s.start_time).sort()).toEqual(['09:00', '10:00', '11:00']);
    expect(result.rejections.detour_cap).toBe(6); // 12:00-17:00
    expect(result.slots[0].return_time).toBe('16:40');
  });

  test('staff callers keep every fit', async () => {
    const result = await findAvailableSlots(BASE);
    expect(result.slots.map((s) => s.start_time)).toContain('17:00');
    expect(result.rejections.detour_cap).toBeUndefined();
  });

  test('SCHEDULING_MAX_DETOUR_MINUTES overrides the cap', async () => {
    process.env.SCHEDULING_MAX_DETOUR_MINUTES = '50';
    const result = await findAvailableSlots({ ...BASE, customerFacing: true });
    expect(result.slots.map((s) => s.start_time)).toContain('13:00');
    expect(result.slots.map((s) => s.start_time)).not.toContain('14:00');
  });
});
