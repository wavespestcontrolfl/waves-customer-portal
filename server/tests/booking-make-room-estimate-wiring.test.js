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
      technician: { id: 'tech-1', name: 'Synthetic Tech' },
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
jest.mock('../services/scheduling/customer-route-check', () => ({
  customerRouteCheckMode: jest.fn(() => 'off'),
  filterOfferedSlots: jest.fn(),
}));
jest.mock('../services/scheduling/booking-make-room', () => ({
  bookingMakeRoomMode: jest.fn(() => 'off'),
  startBackgroundCheck: jest.fn(async () => ({})),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  zoneRouteDaysLive: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
}));

const db = require('../models/db');
const makeRoom = require('../services/scheduling/booking-make-room');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;

/**
 * GATE_BOOKING_MAKE_ROOM on the estimate page (owner 2026-11-06): the make-room check starts once per BUILT offer
 * list, over the same final pool the page serves, and never changes, delays or breaks that list.
 */
const ESTIMATE_ROW = {
  id: 'est-room-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231',
  estimate_data: null,
  service_interest: 'Pest Control',
};

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ latitude: 27.3364, longitude: -82.5307, address_line1: '123 Test St', city: 'Sarasota', state: 'FL', zip: '34231' }),
      };
    }
    if (table === 'technicians') return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Synthetic Tech' }]) };
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue([]) };
    if (table === 'technician_absences') {
      return { whereBetween: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const OPTS = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };
const OFFER = { ...OPTS, offer: true };
const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
afterAll(() => {
  if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
  else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
});

const keys = (result) => [...result.primary, ...result.expander].map((s) => `${s.date} ${s.windowStart}`);

describe('getAvailableSlots — make-room check wiring (GATE_BOOKING_MAKE_ROOM)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    makeRoom.startBackgroundCheck.mockImplementation(async () => ({}));
  });
  afterEach(() => { jest.useRealTimers(); });

  test('gate off: the check never starts', async () => {
    await getAvailableSlots('est-room-1', OFFER);
    expect(makeRoom.startBackgroundCheck).not.toHaveBeenCalled();
  });

  test('shadow: one check per built list, over the final pool, with the estimate pin, length and dates; the list is unchanged', async () => {
    const baseline = keys(await getAvailableSlots('est-room-1', OFFER));
    expect(baseline.length).toBeGreaterThan(0);
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    const served = keys(await getAvailableSlots('est-room-1', OFFER));
    expect(served).toEqual(baseline);
    expect(makeRoom.startBackgroundCheck).toHaveBeenCalledTimes(1);
    const [arg] = makeRoom.startBackgroundCheck.mock.calls[0];
    expect(arg).toMatchObject({
      mode: 'shadow', surface: 'estimate', estimateId: 'est-room-1', coords: { lat: 27.3364, lng: -82.5307 },
      dateFrom: '2027-05-20', dateTo: '2027-05-20',
    });
    expect(arg.durationMinutes).toBeGreaterThan(0);
    // The page's travel-gap credit for the new visit, for the sooner pass's screen.
    expect(Number.isFinite(arg.candidateExpectedMinutes)).toBe(true);
    expect(typeof arg.admit).toBe('function');
    expect(typeof arg.placement).toBe('function');
    // The pool holds every time the page served.
    const pooled = arg.pool.map((s) => `${s.date} ${s.windowStart}`);
    for (const key of served) expect(pooled).toContain(key);
  });

  test('a caller that did not ask for an offer list never starts it', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    await getAvailableSlots('est-room-1', OPTS);
    expect(makeRoom.startBackgroundCheck).not.toHaveBeenCalled();
  });

  test('a cache hit does not start it again', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    await getAvailableSlots('est-room-1', OFFER);
    const second = await getAvailableSlots('est-room-1', OFFER);
    expect(second.metadata.cacheHit).toBe(true);
    expect(makeRoom.startBackgroundCheck).toHaveBeenCalledTimes(1);
  });

  test('a failing or never-ending check never touches the list', async () => {
    const baseline = keys(await getAvailableSlots('est-room-1', OFFER));
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    makeRoom.startBackgroundCheck.mockRejectedValue(new Error('boom'));
    expect(keys(await getAvailableSlots('est-room-1', OFFER))).toEqual(baseline);
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.startBackgroundCheck.mockImplementation(() => new Promise(() => {}));
    expect(keys(await getAvailableSlots('est-room-1', OFFER))).toEqual(baseline);
  });
});

describe('makeRoomAdmit — the page\'s own offer rules for a tried hour', () => {
  const { makeRoomAdmit } = estimateSlotAvailability._internals;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z')); // Friday 11:00 ET
  });
  afterEach(() => { jest.useRealTimers(); });

  const admit = (overrides = {}) => makeRoomAdmit({
    opts: { includeWeekends: false, minimumLeadMinutes: 24 * 60, timeOfDay: 'any', ...overrides.opts },
    serviceProfile: { services: [] },
    dateFrom: '2027-05-14',
    dateTo: '2027-05-28',
    funnelDays: overrides.funnelDays || null,
    funnel: overrides.funnel || null,
  });
  const slot = (date, start, end) => ({ date, windowStart: start, windowEnd: end, durationMinutes: 60, techId: 'tech-1' });

  test('a weekday hour on the customer grid, past the notice, inside the dates', () => {
    expect(admit()(slot('2027-05-20', '09:00', '10:00'))).toBe(true);
  });

  test.each([
    ['off the customer grid', slot('2027-05-20', '08:00', '09:00')],
    ['a Saturday with weekends off', slot('2027-05-22', '09:00', '10:00')],
    ['inside the 24-hour notice', slot('2027-05-15', '09:00', '10:00')],
    ['after the request\'s last date', slot('2027-05-31', '09:00', '10:00')],
  ])('refused: %s', (_label, candidate) => {
    expect(admit()(candidate)).toBe(false);
  });

  test('the time of day and the zone days apply too', () => {
    expect(admit({ opts: { timeOfDay: 'morning' } })(slot('2027-05-20', '14:00', '15:00'))).toBe(false);
    expect(admit({ funnelDays: new Set(['2027-05-21']) })(slot('2027-05-20', '09:00', '10:00'))).toBe(false);
    expect(admit({ funnelDays: new Set(['2027-05-20']) })(slot('2027-05-20', '09:00', '10:00'))).toBe(true);
  });

  test('a zone the funnel seeded (no cluster day left): the seed day counts, other days do not', () => {
    const seeded = { funnelDays: new Set(), funnel: { mode: 'seeded', seedDate: '2027-05-21' } };
    expect(admit(seeded)(slot('2027-05-21', '09:00', '10:00'))).toBe(true);
    expect(admit(seeded)(slot('2027-05-20', '09:00', '10:00'))).toBe(false);
    // A cluster day still counts while the page seeded another day: had its hour been free, the page would offer it.
    const seededWithCluster = { funnelDays: new Set(['2027-05-20']), funnel: { mode: 'seeded', seedDate: '2027-05-21' } };
    expect(admit(seededWithCluster)(slot('2027-05-20', '09:00', '10:00'))).toBe(true);
  });
});
