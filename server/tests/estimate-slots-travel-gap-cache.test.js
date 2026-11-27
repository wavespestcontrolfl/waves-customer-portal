jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({
    slots: [{
      date: '2027-05-20',
      start_time: '09:00',
      technician: { id: 'tech-1', name: 'Adam Benetti' },
      detour_minutes: 4,
      stops_that_day: 3,
    }],
    evaluated: 1,
    total_feasible: 1,
  })),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  zoneRouteDaysLive: jest.fn(() => false),
  // Moving PR B1: the offer window reads a new-home estimate's move-in date.
  movingEstimateLive: jest.fn(() => false),
  // The travel-gap rule reads its gate through the registry's parser at call
  // time (scheduling/travel-gap.js); keep the real helper so the collision
  // filter runs exactly as it does in prod with the gate unset.
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  // The same-hour technician scope (GATE_MULTI_TECH_CONFIRM) reads the real call-time reader.
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
  // The new visit's planning minutes (planning-minutes.js planningTableLive) read the real plan-mode reader.
  schedulingPlanMinutesOnly: jest.requireActual('../config/feature-gates').schedulingPlanMinutesOnly,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;

/**
 * Wrapper-cache key vs the travel policy (GH codex #3803 r1 P1): reserveSlot
 * reads GATE_SLOT_TRAVEL_GAP / SLOT_TRAVEL_BUFFER_MINUTES at call time, but
 * filterCollidingSlots ran when the 5-minute wrapper entry was built. A flip
 * or buffer change must miss the cache, or the picker keeps serving slots the
 * reserve now rejects until TTL.
 */
const ESTIMATE_ROW = {
  id: 'est-rain-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231',
  estimate_data: null,
  service_interest: 'Pest Control',
};

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(ESTIMATE_ROW),
      };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.3364,
          longitude: -82.5307,
          address_line1: '123 Test St',
          city: 'Sarasota',
          state: 'FL',
          zip: '34231',
        }),
      };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]),
      };
    }
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue([]) };
    }
    if (table === 'technician_absences') {
      // buildAsapCapacitySlots' absentTechDays read (technician-eligibility.js)
      // — no tech is marked out in this suite.
      return {
        whereBetween: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}


const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_SCHEDULING_CAPACITY'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getAvailableSlots — wrapper cache keyed by the travel policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    mockDb();
    db.raw = jest.fn((sql) => sql); // gate-on collision filter selects guarded coords
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); });

  const OPTS = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };

  test('capacity activation cannot reuse a legacy signed-slot cache entry', async () => {
    await getAvailableSlots('est-rain-1', OPTS);
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
    delete process.env.GATE_SCHEDULING_CAPACITY;
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
  });

  test('gate flip and buffer change each miss the cache; an unchanged policy hits it', async () => {
    const off = await getAvailableSlots('est-rain-1', OPTS);
    expect(off.metadata.cacheHit).toBe(false);
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);

    // Route lane: find-time got NO buffer while the gate was off.
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 0 }));

    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
    // …and the customer-facing buffer once it is on.
    expect(findAvailableSlots).toHaveBeenLastCalledWith(expect.objectContaining({ bufferMinutes: 15 }));
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);

    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '25';
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);

    // Kill switch: back to the gate-off entry (still warm), never the gate-on one.
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
  });

  // The texting AI's send-time recheck (offerableEstimateSlots {fresh}) must
  // read the CURRENT calendar and every slot the page's filters allow.
  test('bypassCache: recomputes over a warm entry, never reads it and never writes its own over it', async () => {
    await getAvailableSlots('est-rain-1', OPTS);
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
    findAvailableSlots.mockClear();

    const fresh = await getAvailableSlots('est-rain-1', { ...OPTS, bypassCache: true });
    expect(fresh.metadata.cacheHit).toBe(false);
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    // the page's own entry is untouched and still warm
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);

    // a bypass on a COLD cache does not populate it either
    estimateSlotAvailability._internals.clearCaches();
    await getAvailableSlots('est-rain-1', { ...OPTS, bypassCache: true });
    expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
  });

  test('uncapped (maxResults large, expanderMaxResults 0) returns every slot the filters allow; the default cut is the curated 9', async () => {
    const days = [];
    for (let d = 17; d <= 28; d += 1) days.push(`2027-05-${d}`);
    const many = () => ({
      slots: days.map((date) => ({
        date, start_time: '09:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 3,
      })),
      evaluated: days.length,
      total_feasible: days.length,
    });
    const WINDOW = { dateFrom: '2027-05-17', dateTo: '2027-05-28' };
    findAvailableSlots.mockImplementation(async () => many());
    const cut = await getAvailableSlots('est-rain-1', WINDOW);
    const all = await getAvailableSlots('est-rain-1', { ...WINDOW, bypassCache: true, maxResults: 10000, expanderMaxResults: 0 });
    const count = (r) => r.primary.length + r.expander.length;
    expect(count(cut)).toBe(9);
    expect(all.expander).toEqual([]);
    expect(count(all)).toBeGreaterThan(9);
    // everything the curated cut showed is inside the uncapped read
    const keyOf = (s) => `${s.date}|${s.windowStart}`;
    const allKeys = new Set(all.primary.map(keyOf));
    for (const slot of [...cut.primary, ...cut.expander]) expect(allKeys.has(keyOf(slot))).toBe(true);
    // calendarSlots carries the full open pool across all days (beyond the 9-slot curated cap),
    // signed and sorted chronologically, along with explicit metadata.dateFrom/dateTo bounds.
    expect(Array.isArray(cut.calendarSlots)).toBe(true);
    expect(cut.calendarSlots.length).toBeGreaterThan(9);
    expect(new Set(cut.calendarSlots.map((s) => s.date)).size).toBe(days.length);
    expect(cut.metadata.dateFrom).toBe('2027-05-17');
    expect(cut.metadata.dateTo).toBe('2027-05-28');
    const { splitSignedSlotId } = require('../utils/slot-offer-token');
    expect(cut.calendarSlots.every((s) => splitSignedSlotId(s.slotId) !== null)).toBe(true);
    // Cache hit preserves calendarSlots too.
    const cached = await getAvailableSlots('est-rain-1', WINDOW);
    expect(cached.metadata.cacheHit).toBe(true);
    expect(cached.calendarSlots.length).toBe(cut.calendarSlots.length);
    findAvailableSlots.mockReset();
  });

  test('each slot shares the exact same signed slotId across primary, expander, and calendarSlots even across ms ticks', async () => {
    let tick = Date.parse('2027-05-14T15:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      tick += 7;
      return tick;
    });
    try {
      const WINDOW = { dateFrom: '2027-05-20', dateTo: '2027-05-22' };
      findAvailableSlots.mockResolvedValue({
        slots: [
          { date: '2027-05-20', start_time: '09:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 2 },
          { date: '2027-05-21', start_time: '10:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 2 },
          { date: '2027-05-22', start_time: '11:00', technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 2 },
        ],
        evaluated: 3,
        total_feasible: 3,
      });
      const res = await getAvailableSlots('est-rain-1', WINDOW);
      const calendarIds = new Set(res.calendarSlots.map((s) => s.slotId));
      for (const slot of [...res.primary, ...res.expander]) {
        expect(calendarIds.has(slot.slotId)).toBe(true);
      }
    } finally {
      nowSpy.mockRestore();
      findAvailableSlots.mockReset();
    }
  });

  test('findEstimateSlots returns full calendarSlots and summarizes total open count beyond the 9-slot cap', async () => {
    const days = ['2027-05-20', '2027-05-21', '2027-05-22', '2027-05-23'];
    const hours = ['09:00', '10:00', '11:00', '14:00'];
    const slots = days.flatMap((date) => hours.map((start_time) => ({
      date, start_time, technician: { id: 'tech-1', name: 'Adam Benetti' }, detour_minutes: 4, stops_that_day: 2,
    })));
    findAvailableSlots.mockResolvedValue({ slots, evaluated: slots.length, total_feasible: slots.length });
    const res = await estimateSlotAvailability.findEstimateSlots('est-rain-1', { query: '2027-05-20' });
    expect(Array.isArray(res.calendarSlots)).toBe(true);
    expect(res.calendarSlots.length).toBeGreaterThanOrEqual(4);
    expect(res.summary).toContain(`${res.calendarSlots.length} open times`);

    // A route-optimal opening that lands only in calendarSlots (beyond the curated 12-slot cap)
    // must still report nearby=true so the summary doesn't deny a nearby route shown in the grid.
    const farSlots = [];
    for (let d = 17; d <= 29; d += 1) {
      farSlots.push({
        date: `2027-05-${d}`,
        start_time: '09:00',
        technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: d === 29 ? 4 : 45,
        stops_that_day: d === 29 ? 2 : 0,
      });
    }
    findAvailableSlots.mockResolvedValue({ slots: farSlots, evaluated: farSlots.length, total_feasible: farSlots.length });
    const nearbyRes = await estimateSlotAvailability.findEstimateSlots('est-rain-1', { query: 'May' });
    expect(nearbyRes.primary.every((s) => !s.routeOptimal)).toBe(true);
    expect(nearbyRes.expander.every((s) => !s.routeOptimal)).toBe(true);
    expect(nearbyRes.calendarSlots.some((s) => s.routeOptimal)).toBe(true);
    expect(nearbyRes.nearby).toBe(true);
    expect(nearbyRes.summary).not.toMatch(/No route near you/i);
  });

  test('wrapper cache key separates arrival-grace and rain-rank policy settings', async () => {
    const featureGates = require('../config/feature-gates');
    const prevGrace = process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
    try {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      delete process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
      featureGates.isEnabled.mockReturnValue(false);
      expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
      expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(true);
      process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '45';
      expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
      featureGates.isEnabled.mockImplementation((flag) => flag === 'customerRainRank');
      expect((await getAvailableSlots('est-rain-1', OPTS)).metadata.cacheHit).toBe(false);
    } finally {
      featureGates.isEnabled.mockReturnValue(false);
      if (prevGrace === undefined) delete process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
      else process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = prevGrace;
    }
  });
});
