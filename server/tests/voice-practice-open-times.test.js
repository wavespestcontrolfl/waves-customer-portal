'use strict';

/**
 * Practice-line `get_availability`: zero paid provider requests.
 * Proves that on the GPT-Live practice line:
 *  - coordinates come ONLY from `booking._internals.resolveBookingCoords({ city })` (real exported helper, city-only centroid path — NO `address` or `estimate_id`)
 *  - `parseWhen` (LLM date parser) is NEVER called
 *  - `buildBookingAvailability` receives `paidLookups: false` (no Open-Meteo rain chips/rank, no Google Routes)
 *  - no network (`global.fetch`) runs
 *  - the spoken result promises NO booking, hold, confirmation, or callback.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  gateEnvValue: jest.fn((name) => process.env[name] === 'true'),
  zoneRouteDaysLive: jest.fn(() => false),
  schedulingPlanMinutesOnly: jest.fn(() => false),
}));
jest.mock('../services/scheduling/parse-when', () => ({
  parseWhen: jest.fn(() => { throw new Error('parseWhen LLM must not run on practice line'); }),
  summarizeWindow: jest.fn(),
}));

const mockResolveBookingCoords = jest.fn(async ({ city, address, estimate_id } = {}) => {
  if (address || estimate_id) throw new Error('practice line must pass city only (never address or estimate_id)');
  return String(city || '').toLowerCase() === 'bradenton'
    ? { lat: 27.4989, lng: -82.5748, disclosable: false }
    : { lat: null, lng: null, disclosable: false };
});
const mockLoadBookingConfig = jest.fn(async () => ({ slot_duration_minutes: 60, advance_days_min: 1, advance_days_max: 7 }));
const mockBuildBookingAvailability = jest.fn(async () => ({
  slots: [
    { date: '2026-12-01', start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', start: '9:00 AM' },
    { date: '2026-12-02', start_time: '13:00', end_time: '14:00', start_label: '1:00 PM', start: '1:00 PM' },
  ],
}));

jest.mock('../routes/booking', () => ({
  _internals: {
    resolveBookingCoords: (...args) => mockResolveBookingCoords(...args),
    loadBookingConfig: (...args) => mockLoadBookingConfig(...args),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
  },
}));

const { executeTool, activeTools } = require('../services/voice-agent/relay-tools');
const { isEnabled } = require('../config/feature-gates');

const PROMISE_RE = /follow up|follow-up|will call|call you|call back|callback to|reach out|team member will|capture the lead/i;

beforeEach(() => jest.clearAllMocks());

describe('practice-line get_availability (zero paid provider calls)', () => {
  test('real booking._internals exports resolveBookingCoords, loadBookingConfig, and buildBookingAvailability', () => {
    const actualBooking = jest.requireActual('../routes/booking');
    expect(typeof actualBooking._internals.resolveBookingCoords).toBe('function');
    expect(typeof actualBooking._internals.loadBookingConfig).toBe('function');
    expect(typeof actualBooking._internals.buildBookingAvailability).toBe('function');
  });

  test('uses city-only resolveBookingCoords + paidLookups:false, never sends address/geocoder or fetch, and promises no booking or callback', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(() => { throw new Error('no external network on practice line'); });
    try {
      const out = await executeTool(
        'get_availability',
        { city: 'Bradenton', address_line1: '123 Main St', zip: '34202' },
        { practiceLine: true, sandbox: true, callSid: 'CA-practice-avail-1' },
      );

      expect(mockResolveBookingCoords).toHaveBeenCalledWith({ city: 'Bradenton' });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockBuildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
        lat: 27.4989,
        lng: -82.5748,
        paidLookups: false,
        noCustomerReads: true,
        verifiedOnly: true,
      }));
      expect(mockBuildBookingAvailability.mock.calls[0][0].surface).toBeUndefined();
      expect(out).toContain('Open times: Tuesday December 1 at 9 AM; Wednesday December 2 at 1 PM.');
      expect(out).toContain('PRACTICE LINE — NOTHING IS BOOKED OR HELD.');
      expect(out).toMatch(/call or text the Waves office/);
      expect(out.replace(/do not promise a callback/gi, '')).not.toMatch(PROMISE_RE);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('verifiedOnly failure fails closed to unavailable text directing caller to the office', async () => {
    mockBuildBookingAvailability.mockRejectedValueOnce(new Error('occupancy mirror unread'));
    const out = await executeTool('get_availability', { city: 'Bradenton' }, { practiceLine: true, sandbox: true });
    expect(out).toMatch(/not available on this practice line/i);
    expect(out).toMatch(/call or text the Waves office/);
    expect(out).not.toMatch(PROMISE_RE);
  });

  test('noCustomerReads boundary executes zero customers table reads/joins AND honors tech_schedule_blocks under capacity mode', async () => {
    const oldCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      let findAvailableSlots;
      let listOccupiedWindows;
      const queriedTables = [];
      const joinedTables = [];
      const makeChain = (table) => {
        let rows = [];
        if (table === 'technicians') rows = [{ id: 'tech-1', name: 'Tech One' }];
        else if (table === 'tech_schedule_blocks') {
          rows = [{ id: 'blk-1', date: '2026-12-01', technician_id: 'tech-1', start_time: '08:00:00', end_time: '12:00:00' }];
        }
        const q = {
          where: () => q,
          whereIn: () => q,
          whereNot: () => q,
          whereNotIn: () => q,
          whereBetween: () => q,
          whereNull: () => q,
          whereNotNull: () => q,
          whereRaw: () => q,
          andWhere: () => q,
          orWhere: () => q,
          orWhereRaw: () => q,
          orderBy: () => q,
          limit: () => q,
          leftJoin: (joinTable) => {
            joinedTables.push(String(joinTable));
            if (String(joinTable).includes('customers')) throw new Error('FORBIDDEN customers join on practice line');
            return q;
          },
          select: () => Promise.resolve(rows),
          first: () => Promise.resolve(null),
          then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
        };
        return q;
      };
      const strictDb = jest.fn((table) => {
        queriedTables.push(String(table));
        if (String(table).includes('customers')) throw new Error('FORBIDDEN customers query on practice line');
        return makeChain(table);
      });
      strictDb.raw = (sql) => sql;

      jest.isolateModules(() => {
        jest.doMock('../models/db', () => strictDb);
        jest.doMock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
        jest.doMock('../services/technician-eligibility', () => ({
          applyAssignable: (q) => q,
          absentTechDays: jest.fn(async () => new Set()),
          loadTechShifts: jest.fn(async () => () => null),
          shiftBounds: (_s, openMin, closeMin) => ({ openMin, closeMin }),
        }));
        jest.doMock('../services/scheduling/tech-start-point', () => ({
          techColumns: (cols) => cols,
          techStartPoint: () => null,
        }));
        jest.doMock('../services/scheduling/expected-service-minutes', () => ({
          ensureCatalogLoaded: jest.fn(async () => {}),
          expectedMinutesSync: (_row, fallback) => fallback,
        }));
        ({ findAvailableSlots } = require('../services/scheduling/find-time'));
        ({ listOccupiedWindows } = require('../services/scheduling/occupancy'));
      });

      const slotsRes = await findAvailableSlots({
        lat: 27.4989,
        lng: -82.5748,
        durationMinutes: 60,
        dateFrom: '2026-12-01',
        dateTo: '2026-12-02',
        includeWeekends: true,
        noCustomerReads: true,
        providerTravel: false,
      });
      const occRes = await listOccupiedWindows({
        db: strictDb,
        dateFrom: '2026-12-01',
        dateTo: '2026-12-02',
        withCoords: true,
        noCustomerReads: true,
      });

      expect(slotsRes.slots.length).toBeGreaterThan(0);
      const dec1Slots = slotsRes.slots.filter((s) => s.date === '2026-12-01');
      expect(dec1Slots.length).toBeGreaterThan(0);
      expect(dec1Slots.every((s) => s.start_time >= '12:00')).toBe(true);
      expect(occRes).toEqual([]);
      expect(queriedTables).toContain('tech_schedule_blocks');
      expect(queriedTables.some((t) => t.includes('customers'))).toBe(false);
      expect(joinedTables.some((t) => t.includes('customers'))).toBe(false);
    } finally {
      if (oldCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = oldCapacity;
    }
  });

  test('coalesces overlapping schedule blocks and enclosed visits so blocked hours are never offered', async () => {
    const oldCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      let findAvailableSlots;
      const makeChain = (table) => {
        let rows = [];
        if (table === 'technicians') rows = [{ id: 'tech-1', name: 'Tech One' }];
        else if (table === 'scheduled_services') {
          rows = [
            {
              id: 'svc-enclosed',
              technician_id: 'tech-1',
              scheduled_date: '2026-12-01',
              window_start: '09:00:00',
              window_end: '10:00:00',
              status: 'scheduled',
              service_type: 'Pest Control',
            },
            {
              id: 'svc-overlap',
              technician_id: 'tech-1',
              scheduled_date: '2026-12-02',
              window_start: '10:00:00',
              window_end: '12:00:00',
              status: 'scheduled',
              service_type: 'Pest Control',
            },
          ];
        } else if (table === 'tech_schedule_blocks') {
          rows = [
            { id: 'blk-full', date: '2026-12-01', technician_id: 'tech-1', start_time: '08:00:00', end_time: '17:00:00' },
            { id: 'blk-morning', date: '2026-12-02', technician_id: 'tech-1', start_time: '08:00:00', end_time: '11:00:00' },
          ];
        }
        const q = {
          where: () => q,
          whereIn: () => q,
          whereNot: () => q,
          whereNotIn: () => q,
          whereBetween: () => q,
          whereNull: () => q,
          whereNotNull: () => q,
          whereRaw: () => q,
          andWhere: () => q,
          orWhere: () => q,
          orWhereRaw: () => q,
          orderBy: () => q,
          limit: () => q,
          leftJoin: () => q,
          select: () => Promise.resolve(rows),
          first: () => Promise.resolve(null),
          then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
        };
        return q;
      };
      const strictDb = jest.fn((table) => makeChain(table));
      strictDb.raw = (sql) => sql;

      jest.isolateModules(() => {
        jest.doMock('../models/db', () => strictDb);
        jest.doMock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
        jest.doMock('../services/technician-eligibility', () => ({
          applyAssignable: (q) => q,
          absentTechDays: jest.fn(async () => new Set()),
          loadTechShifts: jest.fn(async () => () => null),
          shiftBounds: (_s, openMin, closeMin) => ({ openMin, closeMin }),
        }));
        jest.doMock('../services/scheduling/tech-start-point', () => ({
          techColumns: (cols) => cols,
          techStartPoint: () => null,
        }));
        jest.doMock('../services/scheduling/expected-service-minutes', () => ({
          ensureCatalogLoaded: jest.fn(async () => {}),
          expectedMinutesSync: (_row, fallback) => fallback,
        }));
        ({ findAvailableSlots } = require('../services/scheduling/find-time'));
      });

      const slotsRes = await findAvailableSlots({
        lat: 27.4989,
        lng: -82.5748,
        durationMinutes: 60,
        dateFrom: '2026-12-01',
        dateTo: '2026-12-02',
        includeWeekends: true,
        noCustomerReads: true,
        providerTravel: false,
      });
      const dec1Slots = slotsRes.slots.filter((s) => s.date === '2026-12-01');
      const dec2Slots = slotsRes.slots.filter((s) => s.date === '2026-12-02');
      expect(dec1Slots).toEqual([]);
      expect(dec2Slots.length).toBeGreaterThan(0);
      expect(dec2Slots.every((s) => s.start_time >= '12:00')).toBe(true);
    } finally {
      if (oldCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = oldCapacity;
    }
  });

  test('unknown or missing city asks for a service-area city without calling buildBookingAvailability', async () => {
    const out = await executeTool('get_availability', { city: 'Atlantis' }, { practiceLine: true, sandbox: true });
    expect(out).toContain('Could not match that city');
    expect(mockResolveBookingCoords).toHaveBeenCalledWith({ city: 'Atlantis' });
    expect(mockBuildBookingAvailability).not.toHaveBeenCalled();
  });

  test('selfBooking gate off returns practice unavailable wording with no callback promise', async () => {
    isEnabled.mockReturnValueOnce(false);
    const out = await executeTool('get_availability', { city: 'Bradenton' }, { practiceLine: true, sandbox: true });
    expect(out).toMatch(/not available on this practice line/i);
    expect(out).not.toMatch(PROMISE_RE);
  });

  test('practice get_availability tool schema asks for city only and promises no confirmation', () => {
    const tool = activeTools({ practiceLine: true }).find((t) => t.name === 'get_availability');
    expect(tool).toBeTruthy();
    expect(Object.keys(tool.input_schema.properties)).toEqual(['city']);
    expect(tool.description).not.toMatch(/team member|follow up|confirms the appointment/i);
  });
});
