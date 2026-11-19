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
  getHourlyRainOutlook: jest.fn(async () => null),
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
const { getHourlyRainOutlook } = require('../services/weather-forecast');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;
const { filterUnchangedMakeRoomSlots } = estimateSlotAvailability._internals;
let scheduledRows = [];

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
      const queryState = { dateRange: null, ids: null, changedSince: null };
      const predicate = {
        where(column, operator, value) {
          if ((column === 'scheduled_services.updated_at' || column === 'scheduled_services.created_at')
            && operator === '>=') queryState.changedSince = value;
          return this;
        },
        orWhere(column, operator, value) {
          if (typeof column === 'function') column(this);
          else this.where(column, operator, value);
          return this;
        },
        andWhere(callback) {
          if (typeof callback === 'function') callback(this);
          return this;
        },
        whereNull: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        orWhereRaw: jest.fn().mockReturnThis(),
        whereNot(callback) { callback(this); return this; },
      };
      const builder = {
        where: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockImplementation(() => Object.assign(Promise.resolve([]), {
          pluck: jest.fn().mockResolvedValue([]),
        })),
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn((column, range) => {
          if (column === 'scheduled_services.scheduled_date') queryState.dateRange = range;
          return builder;
        }),
        whereNotIn: jest.fn().mockReturnThis(),
        whereIn: jest.fn((column, ids) => {
          if (column === 'scheduled_services.id') queryState.ids = new Set(ids.map(String));
          return builder;
        }),
        andWhere: jest.fn((callback) => {
          if (typeof callback === 'function') callback(predicate);
          return builder;
        }),
        select: jest.fn().mockImplementation(async (...columns) => {
          // The cached route query selects the technician/date pairs that passed its
          // stamped-or-recently-updated SQL predicate. The PostgreSQL suite exercises that predicate.
          if (columns.length === 2 && columns[0] === 'scheduled_services.technician_id') {
            return scheduledRows.filter(row => row.customer_id && (row.reservation_expires_at || row.updated_at));
          }
          return scheduledRows.filter((row) => {
            const date = String(row.scheduled_date || '').slice(0, 10);
            if (queryState.dateRange && (date < queryState.dateRange[0] || date > queryState.dateRange[1])) return false;
            if (queryState.ids && !queryState.ids.has(String(row.id))) return false;
            if (queryState.changedSince) {
              const boundary = new Date(queryState.changedSince).getTime();
              const updated = row.updated_at == null ? NaN : new Date(row.updated_at).getTime();
              const created = row.created_at == null ? NaN : new Date(row.created_at).getTime();
              if (!(updated >= boundary || created >= boundary)) return false;
            }
            return true;
          });
        }),
      };
      return builder;
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


const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_CUSTOMER_RAIN_RANK'];
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
    scheduledRows = [];
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

  test('a warm fixed-hour list locally vetoes a newly staff-claimed expired hold without regenerating offers', async () => {
    const first = await getAvailableSlots('est-rain-1', OPTS);
    expect([...first.primary, ...first.expander].some((slot) => slot.windowStart === '09:00')).toBe(true);
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);

    scheduledRows = [{
      id: 'staff-claimed-hold',
      technician_id: 'tech-1',
      scheduled_date: '2027-05-20',
      window_start: '09:00:00',
      window_end: '10:00:00',
      estimated_duration_minutes: 60,
      customer_id: 'office-customer',
      reservation_expires_at: '2027-05-14T14:00:00Z',
      source_estimate_id: 'another-estimate',
      zone: null,
      customer_city: null,
    }];

    const warm = await getAvailableSlots('est-rain-1', OPTS);
    expect(warm.metadata.cacheHit).toBe(true);
    expect([...warm.primary, ...warm.expander].some((slot) => slot.windowStart === '09:00')).toBe(false);
    expect(warm.metadata.firstDayAvailability).toBeNull();
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
  });

  test('a warm fixed-hour list rechecks local travel gaps with the cached pin and duration', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '15';
    const first = await getAvailableSlots('est-rain-1', OPTS);
    expect([...first.primary, ...first.expander].some((slot) => slot.windowStart === '09:00')).toBe(true);
    scheduledRows = [{
      id: 'new-remote-stop', technician_id: 'tech-1', scheduled_date: '2027-05-20',
      window_start: '10:00:00', window_end: '11:00:00', estimated_duration_minutes: 60,
      customer_id: 'cust-remote', reservation_expires_at: null, zone: null, customer_city: null,
      lat: 27.75, lng: -82.15, service_type: 'Pest Control', service_key_snapshot: null,
      is_recurring: false, is_callback: false,
    }];
    const warm = await getAvailableSlots('est-rain-1', OPTS);
    expect(warm.metadata.cacheHit).toBe(true);
    expect([...warm.primary, ...warm.expander].some((slot) => slot.windowStart === '09:00')).toBe(false);
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
  });

  test('cached make-room proof survives only while its source and technician-day are unchanged', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const slot = { slotId: 'signed-make-room', date: '2027-05-20', windowStart: '09:00', windowEnd: '10:00', techId: 'tech-1' };
    const proof = [{ slotId: slot.slotId, date: slot.date, techId: slot.techId, sourceIds: ['source-1'] }];
    const old = '2027-05-14T14:00:00.000Z';
    const boundary = '2027-05-14T15:00:00.000Z';
    const source = { id: 'source-1', technician_id: 'tech-1', scheduled_date: slot.date, status: 'confirmed', created_at: old, updated_at: old };

    scheduledRows = [source, { id: 'other-route', technician_id: 'tech-2', scheduled_date: slot.date, created_at: boundary, updated_at: boundary }];
    await expect(filterUnchangedMakeRoomSlots([slot], proof, { dateFrom: slot.date, dateTo: slot.date, cachedAt: boundary }))
      .resolves.toEqual([slot]);

    scheduledRows.push({ id: 'new-destination-row', technician_id: 'tech-1', scheduled_date: slot.date, created_at: boundary, updated_at: boundary });
    await expect(filterUnchangedMakeRoomSlots([slot], proof, { dateFrom: slot.date, dateTo: slot.date, cachedAt: boundary }))
      .resolves.toEqual([]);

    scheduledRows = [{ ...source, technician_id: 'tech-2' }];
    await expect(filterUnchangedMakeRoomSlots([slot], proof, { dateFrom: slot.date, dateTo: slot.date, cachedAt: boundary }))
      .resolves.toEqual([]);

    scheduledRows = [{ ...source, reservation_expires_at: null, updated_at: boundary }];
    await expect(filterUnchangedMakeRoomSlots([slot], proof, { dateFrom: slot.date, dateTo: slot.date, cachedAt: boundary }))
      .resolves.toEqual([]);

    const [signed] = estimateSlotAvailability._internals.signCustomerFacingSlots([{
      ...slot, makeRoom: true, makeRoomSourceIds: ['source-1'], durationMinutes: 60,
    }], 'est-rain-1');
    expect(signed).not.toHaveProperty('makeRoomSourceIds');
  });

  test('capacity cache rechecks only a stamped affected technician-day and preserves a valid flexible overlap', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-20', start_time: '09:00', technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: 4, stops_that_day: 3, route_mode: 'arrival_windows',
      }],
      evaluated: 1,
      total_feasible: 1,
    });
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const load = jest.spyOn(arrivalRoute, 'loadArrivalRouteContext').mockResolvedValue({ rows: [], target: {} });
    const evaluate = jest.spyOn(arrivalRoute, 'evaluateArrivalPlacement').mockReturnValue({ feasible: true });
    try {
      const first = await getAvailableSlots('est-rain-1', OPTS);
      expect([...first.primary, ...first.expander]).toHaveLength(1);

      scheduledRows = [
        // An ordinary flexible booking is already part of the certified route;
        // wall-clock overlap alone must never erase the cached promise.
        {
          technician_id: 'tech-1', scheduled_date: '2027-05-20', customer_id: 'normal-customer',
          reservation_expires_at: null,
        },
        // A stamped claim on another independent route does not affect tech-1.
        {
          technician_id: 'tech-2', scheduled_date: '2027-05-20', customer_id: 'other-customer',
          reservation_expires_at: '2027-05-14T14:00:00Z',
        },
      ];
      const unaffected = await getAvailableSlots('est-rain-1', OPTS);
      expect([...unaffected.primary, ...unaffected.expander]).toHaveLength(1);
      expect(load).not.toHaveBeenCalled();

      scheduledRows.push({
        technician_id: 'tech-1', scheduled_date: '2027-05-20', customer_id: 'office-customer',
        reservation_expires_at: '2027-05-14T14:00:00Z',
      });
      const valid = await getAvailableSlots('est-rain-1', OPTS);
      expect([...valid.primary, ...valid.expander]).toHaveLength(1);
      expect(load).toHaveBeenCalledWith(expect.objectContaining({
        date: '2027-05-20', technicianId: 'tech-1', includeClaimedReservations: true,
      }));
      expect(evaluate).toHaveBeenCalled();
      expect(findAvailableSlots).toHaveBeenCalledTimes(1);

      // The cleanup sweep clears the stale stamp but touches updated_at. A
      // subsequent warm hit must still recheck this newly booked route.
      scheduledRows[2].reservation_expires_at = null;
      scheduledRows[2].updated_at = '2027-05-14T15:01:00.000Z';
      evaluate.mockReturnValue({ feasible: false, reason: 'arrival_window' });
      const refused = await getAvailableSlots('est-rain-1', OPTS);
      expect([...refused.primary, ...refused.expander]).toEqual([]);
      expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
      evaluate.mockRestore();
      delete process.env.GATE_MULTI_TECH_CONFIRM;
    }
  });

  test('a cold build restored by a staff-booked expired hold never starts conditional hourly forecast ranking', async () => {
    process.env.GATE_CUSTOMER_RAIN_RANK = 'true';
    jest.setSystemTime(new Date('2027-05-18T15:00:00Z'));
    getHourlyRainOutlook.mockResolvedValue([{ startTime: '2027-05-20T09:00:00-04:00', rainChance: 80 }]);
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-20', start_time: '09:00', technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: 4, stops_that_day: 3,
      }],
      total_feasible: 1,
      restored_booking_used: true,
    });

    const guarded = await getAvailableSlots('est-rain-1', OPTS);
    expect([...guarded.primary, ...guarded.expander].length).toBeGreaterThan(0);
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();

    // An otherwise identical ordinary cold build keeps the existing forecast
    // behavior; the guard is request-local, not a global kill switch.
    estimateSlotAvailability._internals.clearCaches();
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-20', start_time: '09:00', technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: 4, stops_that_day: 3,
      }],
      total_feasible: 1,
      restored_booking_used: false,
    });
    scheduledRows = [{
      id: 'future-stamped-booking', technician_id: 'tech-1', scheduled_date: '2027-05-20',
      window_start: '15:00:00', window_end: '16:00:00', estimated_duration_minutes: 60,
      customer_id: 'office-customer', reservation_expires_at: '2027-05-18T16:00:00Z',
      reservation_lapsed: false, zone: null, customer_city: null,
    }];
    await getAvailableSlots('est-rain-1', OPTS);
    expect(getHourlyRainOutlook).toHaveBeenCalledTimes(1);

    // The same collision-reader callback suppresses ranking only once the DB
    // clock says the customer-linked stamp is actually lapsed.
    estimateSlotAvailability._internals.clearCaches();
    getHourlyRainOutlook.mockClear();
    scheduledRows[0].reservation_expires_at = '2027-05-18T14:00:00Z';
    scheduledRows[0].reservation_lapsed = true;
    await getAvailableSlots('est-rain-1', OPTS);
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    delete process.env.GATE_CUSTOMER_RAIN_RANK;
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
    findAvailableSlots.mockReset();
  });
});
