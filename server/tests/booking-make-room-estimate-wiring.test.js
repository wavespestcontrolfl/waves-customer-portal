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
  findMakeRoomOffers: jest.fn(async () => ({ hours: [], report: null })),
  verifyMakeRoomHour: jest.fn(async () => ({ shiftMin: 60, moves: [] })),
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
    makeRoom.findMakeRoomOffers.mockImplementation(async () => ({ hours: [], report: null }));
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

/**
 * Mode on (owner 2026-11-09 "YES"), hour mode: the page awaits the sooner pass and adds the earliest passing make-room
 * hour as its first card, signed under its own policy. Off and shadow never reach findMakeRoomOffers.
 */
describe('getAvailableSlots — the make-room offer (GATE_BOOKING_MAKE_ROOM on)', () => {
  const { verifySlotOffer, splitSignedSlotId, CAPACITY_OFFER_POLICY, MAKE_ROOM_OFFER_POLICY } = require('../utils/slot-offer-token');
  const HOUR = { date: '2027-05-19', start: '09:00', techId: 'tech-1', shiftMin: 60, detourMin: 6, moves: [] };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    mockDb();
    db.raw = jest.fn((sql) => sql);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    makeRoom.findMakeRoomOffers.mockImplementation(async () => ({ hours: [HOUR], report: {} }));
  });
  afterEach(() => { jest.useRealTimers(); });

  const verifies = (slot, policy) => {
    const signed = splitSignedSlotId(slot.slotId);
    const [h, m] = slot.windowStart.split(':').map(Number);
    return verifySlotOffer({
      surface: 'estimate', scopeId: 'est-room-1', date: slot.date, startMinutes: h * 60 + m, technicianId: slot.techId,
      durationMinutes: slot.durationMinutes, exp: signed.exp, policy, arrivalGrace: signed.arrivalGrace,
    }, signed.sig);
  };

  test('awaits the offer pass with the page\'s own arguments, and not the background check', async () => {
    await getAvailableSlots('est-room-1', OFFER);
    expect(makeRoom.findMakeRoomOffers).toHaveBeenCalledTimes(1);
    expect(makeRoom.startBackgroundCheck).not.toHaveBeenCalled();
    const [arg] = makeRoom.findMakeRoomOffers.mock.calls[0];
    expect(arg).toMatchObject({ estimateId: 'est-room-1', coords: { lat: 27.3364, lng: -82.5307 }, dateFrom: '2027-05-20', dateTo: '2027-05-20' });
    expect(typeof arg.admit).toBe('function');
    expect(typeof arg.placement).toBe('function');
    expect(arg.pool.length).toBeGreaterThan(0);
  });

  test('the earliest passing hour is ONE extra slot, first in the list, in the shape of the page\'s other slots', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const free = await getAvailableSlots('est-room-1', OFFER);
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    const result = await getAvailableSlots('est-room-1', OFFER);
    const all = [...result.primary, ...result.expander];
    // The list was full (the page's total): the hour goes first and the last free card makes room.
    expect(keys(result)).toEqual(['2027-05-19 09:00', ...keys(free)].slice(0, keys(free).length));
    const [room] = all;
    const [freeSlot] = [...free.primary, ...free.expander];
    expect(Object.keys(room).sort()).toEqual(Object.keys(freeSlot).sort());
    expect(room).toMatchObject({ date: '2027-05-19', windowStart: '09:00', windowEnd: '10:00', durationMinutes: expect.any(Number), techId: 'tech-1', routeOptimal: false, nearbyJob: null });
    expect(room.slotId).toMatch(/^2027-05-19_09-00_tech-1\./);
    expect(room).not.toHaveProperty('makeRoom');
  });

  test('the make-room slot is signed with its own policy: it verifies under it and under no other', async () => {
    const result = await getAvailableSlots('est-room-1', OFFER);
    const [room, ...rest] = [...result.primary, ...result.expander];
    expect(verifies(room, MAKE_ROOM_OFFER_POLICY)).toBe(true);
    expect(verifies(room, undefined)).toBe(false);
    expect(verifies(room, CAPACITY_OFFER_POLICY)).toBe(false);
    // The free slots keep their normal signature and fail the make-room policy.
    expect(rest.length).toBeGreaterThan(0);
    for (const slot of rest) {
      expect(verifies(slot, undefined)).toBe(true);
      expect(verifies(slot, MAKE_ROOM_OFFER_POLICY)).toBe(false);
    }
  });

  test('the free list\'s counts and scarcity badge are unchanged', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const free = await getAvailableSlots('est-room-1', OFFER);
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    const result = await getAvailableSlots('est-room-1', OFFER);
    expect(result.metadata.firstDayAvailability).toEqual(free.metadata.firstDayAvailability);
  });

  test('never more than the list\'s own total: the last card makes room', async () => {
    const result = await getAvailableSlots('est-room-1', { ...OFFER, maxResults: 1, expanderMaxResults: 1 });
    expect(keys(result)).toHaveLength(2);
    expect(keys(result)[0]).toBe('2027-05-19 09:00');
  });

  test.each([
    ['no passing hour', async () => ({ hours: [], report: {} })],
    ['an error', async () => { throw new Error('boom'); }],
    ['a rejected pass', () => Promise.reject(new Error('boom'))],
    ['a pass that never answers', () => new Promise(() => {})],
  ])('%s: the free list is served exactly as without the gate', async (_label, impl) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const baseline = keys(await getAvailableSlots('est-room-1', OFFER));
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    makeRoom.findMakeRoomOffers.mockImplementation(impl);
    const pending = getAvailableSlots('est-room-1', OFFER);
    await jest.advanceTimersByTimeAsync(3000);
    expect(keys(await pending)).toEqual(baseline);
  });

  test('a technician-name read that never answers is inside the same wait: the free list is served (Codex pre-push P1)', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const baseline = keys(await getAvailableSlots('est-room-1', OFFER));
    estimateSlotAvailability._internals.clearCaches();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    const base = db.getMockImplementation();
    const hangs = jest.fn(() => new Promise(() => {}));
    db.mockImplementation((table) => (table === 'technicians'
      ? { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Synthetic Tech' }]), first: hangs }
      : base(table)));
    const pending = getAvailableSlots('est-room-1', OFFER);
    await jest.advanceTimersByTimeAsync(3000);
    expect(keys(await pending)).toEqual(baseline);
    expect(hangs).toHaveBeenCalled();
  });

  test('the technician-name read answers in time: the card names the technician', async () => {
    const base = db.getMockImplementation();
    db.mockImplementation((table) => (table === 'technicians'
      ? { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Synthetic Tech' }]), first: jest.fn().mockResolvedValue({ name: 'Synthetic Tech' }) }
      : base(table)));
    const result = await getAvailableSlots('est-room-1', OFFER);
    expect([...result.primary, ...result.expander][0]).toMatchObject({ date: '2027-05-19', windowStart: '09:00', techFirstName: 'Synthetic' });
  });

  test('capacity mode offers nothing: no offer pass, the background check runs as before', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await getAvailableSlots('est-room-1', OFFER);
    expect(makeRoom.findMakeRoomOffers).not.toHaveBeenCalled();
    expect(makeRoom.startBackgroundCheck).toHaveBeenCalledTimes(1);
    expect(makeRoom.startBackgroundCheck.mock.calls[0][0].mode).toBe('on');
  });

  test('shadow and off never reach the offer pass', async () => {
    for (const mode of ['off', 'shadow']) {
      estimateSlotAvailability._internals.clearCaches();
      makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
      await getAvailableSlots('est-room-1', OFFER);
    }
    expect(makeRoom.findMakeRoomOffers).not.toHaveBeenCalled();
  });

  test('a caller that did not ask for an offer list never gets the hour', async () => {
    const result = await getAvailableSlots('est-room-1', OPTS);
    expect(keys(result)).not.toContain('2027-05-19 09:00');
    expect(makeRoom.findMakeRoomOffers).not.toHaveBeenCalled();
  });

  test('a list built with the hour is never served from, or to, another mode\'s cache entry', async () => {
    await getAvailableSlots('est-room-1', OFFER);
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    const shadow = await getAvailableSlots('est-room-1', OFFER);
    expect(shadow.metadata.cacheHit).toBe(false);
    expect(keys(shadow)).not.toContain('2027-05-19 09:00');
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    const again = await getAvailableSlots('est-room-1', OFFER);
    expect(again.metadata.cacheHit).toBe(true);
    expect(keys(again)).toContain('2027-05-19 09:00');
    expect(makeRoom.findMakeRoomOffers).toHaveBeenCalledTimes(1);
  });
});

describe('verifyMakeRoomOffer — the hold\'s proof is the finder\'s own check for one hour', () => {
  const { verifyMakeRoomOffer } = estimateSlotAvailability;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => { jest.useRealTimers(); });
  const args = (extra = {}) => ({
    conn: 'trx', estimate: { id: 'est-room-1' }, serviceProfile: null, serviceMix: { services: ['pest_control'] }, estimateZone: null,
    coords: { lat: 27.3, lng: -82.5 }, date: '2027-05-20', windowStart: '09:00:00', techId: 'tech-1', durationMinutes: 60, candidateExpectedMinutes: 50, ...extra,
  });

  test('hands booking-make-room the one hour, this estimate\'s capability rows and the page\'s own admit and placement rules', async () => {
    const result = await verifyMakeRoomOffer(args());
    expect(result).toEqual({ shiftMin: 60, moves: [] });
    const [call] = makeRoom.verifyMakeRoomHour.mock.calls[0];
    expect(call).toMatchObject({
      conn: 'trx', date: '2027-05-20', startMin: 540, techId: 'tech-1', durationMinutes: 60, estimateId: 'est-room-1',
      point: { lat: 27.3, lng: -82.5 }, candidateExpectedMinutes: 50, capabilityRows: [{ service_type: 'pest control' }],
    });
    expect(call.admit({ date: '2027-05-20', windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId: 'tech-1' })).toBe(true);
    expect(call.admit({ date: '2027-05-21', windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId: 'tech-1' })).toBe(false);
    expect(typeof call.placement).toBe('function');
  });

  test('no pin, or an error anywhere, is a refusal and never a throw', async () => {
    expect(await verifyMakeRoomOffer(args({ coords: null }))).toEqual({ reason: 'no_pin' });
    makeRoom.verifyMakeRoomHour.mockRejectedValueOnce(new Error('boom'));
    expect(await verifyMakeRoomOffer(args())).toEqual({ reason: 'error' });
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
