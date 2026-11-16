jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({
    slots: [{
      date: '2027-05-20', start_time: '09:00', technician: { id: 'tech-1', name: 'Synthetic Tech' }, detour_minutes: 4, stops_that_day: 3,
    }],
    evaluated: 1,
    total_feasible: 1,
  })),
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../services/scheduling/customer-route-check', () => ({ customerRouteCheckMode: jest.fn(() => 'off'), filterOfferedSlots: jest.fn() }));
jest.mock('../services/scheduling/booking-make-room', () => ({
  bookingMakeRoomMode: jest.fn(() => 'shadow'),
  startBackgroundCheck: jest.fn(async () => ({})),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  zoneRouteDaysLive: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const makeRoom = require('../services/scheduling/booking-make-room');
const estimateSlotAvailability = require('../services/estimate-slot-availability');

/**
 * getAvailableSlots(..., { paidCalls: false }) is the daily no-time-soon check's read (estimate-no-time-soon-check.js).
 * It must spend nothing: no Google road time (providerTravel: false into find-time), no geocode (stored customer
 * coordinates or COORDS_NEED_GEOCODE), no make-room row. Without the option nothing changes.
 */
const { getAvailableSlots } = estimateSlotAvailability;
const ESTIMATE_ROW = {
  id: 'est-free-1', status: 'sent', expires_at: null, customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231', estimate_data: null, service_interest: 'Pest Control',
};
let customerRow;

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    if (table === 'customers') return { where: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), first: jest.fn(async () => customerRow) };
    if (table === 'technicians') return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Synthetic Tech' }]) };
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(), whereBetween: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue([]) };
    if (table === 'technician_absences') {
      return { whereBetween: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const OFFER = { dateFrom: '2027-05-20', dateTo: '2027-05-20', offer: true };
const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
const savedKey = process.env.GOOGLE_MAPS_API_KEY;
afterAll(() => {
  if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
  if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = savedKey;
});

describe('getAvailableSlots paidCalls: false', () => {
  let fetchSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GOOGLE_MAPS_API_KEY = 'synthetic-key';
    customerRow = { latitude: 27.3364, longitude: -82.5307, address_line1: '123 Test St', city: 'Sarasota', state: 'FL', zip: '34231' };
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    fetchSpy = jest.fn(async () => { throw new Error('network must not be used'); });
    global.fetch = fetchSpy;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); });

  test('passes providerTravel: false into every find-time call, never fetches, and starts no make-room check', async () => {
    const result = await getAvailableSlots('est-free-1', { ...OFFER, paidCalls: false });
    expect([...result.primary, ...result.expander].length).toBeGreaterThan(0);
    expect(findAvailableSlots).toHaveBeenCalled();
    for (const [args] of findAvailableSlots.mock.calls) expect(args.providerTravel).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(makeRoom.startBackgroundCheck).not.toHaveBeenCalled();
  });

  test('stored customer coordinates that cannot be used throw COORDS_NEED_GEOCODE: no geocode, no find-time', async () => {
    customerRow = { ...customerRow, latitude: null, longitude: null };
    await expect(getAvailableSlots('est-free-1', { ...OFFER, paidCalls: false })).rejects.toMatchObject({ code: 'COORDS_NEED_GEOCODE' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  test('bypassCache reads the calendar each time (no result cache read or write)', async () => {
    await getAvailableSlots('est-free-1', { ...OFFER, paidCalls: false, bypassCache: true });
    const calls = findAvailableSlots.mock.calls.length;
    await getAvailableSlots('est-free-1', { ...OFFER, paidCalls: false, bypassCache: true });
    expect(findAvailableSlots.mock.calls.length).toBe(calls * 2);
  });

  test('without the option the page keeps the Google allowance, reads the make-room mode, and unusable coordinates do not throw', async () => {
    await getAvailableSlots('est-free-1', OFFER);
    for (const [args] of findAvailableSlots.mock.calls) expect(args.providerTravel).not.toBe(false);
    expect(makeRoom.startBackgroundCheck).toHaveBeenCalledTimes(1);
    estimateSlotAvailability._internals.clearCaches();
    customerRow = { ...customerRow, latitude: null, longitude: null };
    fetchSpy.mockImplementation(async () => ({ ok: true, json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 27.3, lng: -82.5 } } }] }) }));
    await expect(getAvailableSlots('est-free-1', OFFER)).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
