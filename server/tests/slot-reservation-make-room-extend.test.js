jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-moves', () => ({ lockMoveForConversion: jest.fn(async () => null) }));
jest.mock('../services/estimate-stuck-alert', () => ({ noteExpiredHolds: jest.fn(async () => 0) }));
jest.mock('../routes/estimate-public', () => ({ isEstimateCustomerViewable: () => true }));
jest.mock('../services/scheduling/blackout-dates', () => ({ isBlackoutDate: jest.fn(async () => false) }));
jest.mock('../services/scheduling/expected-service-minutes', () => ({
  ...jest.requireActual('../services/scheduling/expected-service-minutes'),
  expectedServiceMinutes: jest.fn(async () => 50),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  verifyMakeRoomOffer: jest.fn(),
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 18 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'on') }));
// The held technician is still assignable (the rule B tests below hold a truck; the make-room ones hold none).
jest.mock('../services/technician-eligibility', () => ({
  ...jest.requireActual('../services/technician-eligibility'),
  assertAssignableTechnician: jest.fn(async () => {}),
}));

/**
 * extendReservation and GATE_BOOKING_MAKE_ROOM on (Codex pre-push P1): an ordinary hold can lapse, its hour can become
 * another customer's live make-room hold's move destination, and extend must not revive it so both are live. The check
 * runs for EVERY hold in mode on (read fresh), never counts the hold's own row, and supersedes through the clash path.
 */
const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const makeRoom = require('../services/scheduling/booking-make-room');
const slotReservation = require('../services/slot-reservation');

const DATE = '2027-05-20';
const EST = 'estimate-456';

const chain = (extra) => {
  const b = {};
  for (const name of ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotIn', 'andWhere', 'andWhereRaw', 'orWhereRaw', 'orWhereNull', 'orWhereNot', 'orWhere', 'whereNot', 'select', 'forUpdate', 'whereIn', 'update']) {
    b[name] = jest.fn(function call(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  }
  b.modify = jest.fn(function modify(callback) { callback(b); return b; });
  b.del = jest.fn().mockResolvedValue(1);
  return Object.assign(b, extra);
};

const HOLD = {
  id: 'hold-1', scheduled_date: DATE, window_start: '09:00:00', window_end: '10:00:00', technician_id: null, estimated_duration_minutes: 60,
  reservation_expires_at: '2027-05-20T13:15:00.000Z', _hold_limit_reached: false, _already_lapsed: false, _new_expiry: '2027-05-20T13:40:00.000Z',
  make_room_moves: null, lat: null, lng: null, reservation_service_mix: null, reservation_policy_version: null,
};

function harness({ hold = HOLD, destinationHit = null, probeRows = [], destinationProbe = true, superseded = false, chainProbes = [], probeRuns = true, estimate = {}, zones = [] } = {}) {
  const pre = chain({ first: jest.fn().mockResolvedValue({ id: hold.id, scheduled_date: DATE }) });
  const locked = chain({ first: jest.fn().mockResolvedValue(hold) });
  // A lapsed hold's rival live-hold read: none.
  const rival = chain({ first: jest.fn().mockResolvedValue(null) });
  const destination = chain({ first: jest.fn().mockResolvedValue(destinationHit) });
  const probe = chain({ orderBy: jest.fn(() => Promise.resolve(probeRows)) });
  const dead = chain({});
  const update = chain({ returning: jest.fn().mockResolvedValue([{ id: hold.id, reservation_expires_at: '2027-05-20T13:40:00.000Z' }]) });
  const queue = [pre, locked, ...(hold._already_lapsed ? [rival] : []), ...(destinationProbe ? [destination] : []), ...chainProbes, ...(probeRuns ? [probe] : []), ...(superseded ? [dead] : []), update];
  const estimates = chain({ first: jest.fn().mockResolvedValue({ id: EST, status: 'sent', _expired: false, ...estimate }) });
  const trx = jest.fn((table) => {
    if (table === 'estimates') return estimates;
    if (table === 'scheduled_services') return queue.shift();
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue(zones) };
    throw new Error(`unexpected table ${table}`);
  });
  trx.raw = jest.fn((sql) => ({ raw: sql }));
  trx.isTransaction = true;
  db.transaction = jest.fn(async (callback) => callback(trx));
  return { destination, probe, dead, update };
}

describe('extendReservation — another make-room hold\'s destinations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  });
  afterEach(() => { jest.useRealTimers(); });

  const extend = () => slotReservation.extendReservation({ estimateId: EST, scheduledServiceId: 'hold-1' });

  test('an ORDINARY hold whose hour is another live make-room hold\'s destination is superseded: SLOT_UNAVAILABLE, hold deleted, never extended', async () => {
    const { destination, dead, update } = harness({ destinationHit: { id: 'hold-other' }, superseded: true });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(destination.whereNotNull).toHaveBeenCalledWith('make_room_moves');
    // The hold's own row never blocks itself.
    expect(destination.whereNot).toHaveBeenCalledWith('id', 'hold-1');
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
    // An ordinary hold has no chain to prove.
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
  });

  test('no destination hit: the ordinary hold extends as before', async () => {
    const { update } = harness();
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(update.update).toHaveBeenCalledWith({ reservation_expires_at: '2027-05-20T13:40:00.000Z' });
  });

  test.each(['shadow', 'off'])('gate %s: no destination probe runs and the hold extends as before', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    const { destination, update } = harness({ destinationProbe: false });
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(destination.first).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalled();
  });
});

describe('extendReservation — a make-room hold\'s re-proven chain against other live chains (Codex pre-push P1)', () => {
  const PROOF = {
    shiftMin: 60,
    moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }, { id: 'visit-c', from: '10:00', to: '11:00', widthMin: 60 }],
  };
  // technician_id null keeps this harness off the technician read; the chain itself is what is under test.
  const MAKE_ROOM_HOLD = { ...HOLD, lat: 27.33, lng: -82.53, make_room_moves: { v: 1, date: DATE, techId: null, shiftMin: 60, moves: PROOF.moves } };
  const probeOf = (result = null) => chain({ first: jest.fn().mockResolvedValue(result) });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue(PROOF);
    db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  });
  afterEach(() => { jest.useRealTimers(); });

  const extend = () => slotReservation.extendReservation({ estimateId: EST, scheduledServiceId: 'hold-1' });

  test('the proof passes but a moved stop\'s new hour is another live chain\'s destination: superseded, never extended', async () => {
    const first = probeOf({ id: 'hold-other' });
    const { dead, update } = harness({ hold: MAKE_ROOM_HOLD, chainProbes: [first], superseded: true });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledTimes(1);
    expect(first.whereRaw).toHaveBeenCalledWith(expect.stringContaining("(m->>'to')::time"), ['11:00:00', '10:00']);
    // The hold's own chain never blocks itself.
    expect(first.whereNot).toHaveBeenCalledWith('id', 'hold-1');
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('the gate turns off while the proof runs: the make-room hold is superseded, never extended (Codex pre-push P1)', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValueOnce('on').mockReturnValue('off');
    const checks = [probeOf(), probeOf(), probeOf()];
    const { dead, update } = harness({ hold: MAKE_ROOM_HOLD, chainProbes: checks, superseded: true });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledTimes(1);
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('no other chain takes its stops or their new hours: the make-room hold extends', async () => {
    const checks = [probeOf(), probeOf(), probeOf()];
    const { update } = harness({ hold: MAKE_ROOM_HOLD, chainProbes: checks });
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(checks[2].whereRaw).toHaveBeenCalledWith(expect.stringContaining("(m->>'id') = ANY"), [['visit-b', 'visit-c']]);
    expect(update.update).toHaveBeenCalledWith({ reservation_expires_at: '2027-05-20T13:40:00.000Z' });
  });
});

// Codex #7796 P2: a make-room hold is kept only while its hour proves again (gate on, hour mode). In capacity mode the
// row can read as a capacity hold, whose extend runs no occupancy probe, so nothing would ever check its chain again.
describe('extendReservation — a make-room hold nothing can prove again is superseded (Codex #7796 P2)', () => {
  const MAKE_ROOM_HOLD = {
    ...HOLD,
    make_room_moves: { v: 1, date: DATE, techId: null, shiftMin: 60, moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }] },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_SCHEDULING_CAPACITY;
  });

  const extend = () => slotReservation.extendReservation({ estimateId: EST, scheduledServiceId: 'hold-1' });

  test('capacity mode turned on while it was live: refused with no proof and no probe, deleted, never extended', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const { dead, update } = harness({ hold: MAKE_ROOM_HOLD, destinationProbe: false, probeRuns: false, superseded: true });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('a row that reads as a capacity hold (policy version 2): the same refusal in hour mode', async () => {
    const { dead, update } = harness({
      hold: { ...MAKE_ROOM_HOLD, reservation_policy_version: 2 }, destinationProbe: false, probeRuns: false, superseded: true,
    });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test.each(['shadow', 'off'])('gate %s: refused before any destination read, even with the occupancy probe clear', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    const { probe, dead, update } = harness({ hold: MAKE_ROOM_HOLD, destinationProbe: false, superseded: true });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(probe.orderBy).toHaveBeenCalled();
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('an ordinary hold in capacity mode keeps extending (only make-room holds need a proof)', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const { update } = harness({ probeRuns: false });
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(update.update).toHaveBeenCalledWith({ reservation_expires_at: '2027-05-20T13:40:00.000Z' });
  });
});

// Owner rule B per truck (GATE_MULTI_TECH_CONFIRM), pre-push P1s on e81d7ed7c0 and e78306a32d: every extend checks the
// hold's truck, lapsed or live (a hold can run out while the extend waits on the date lock), and keeps the zone its
// far-south check read. A hold has no customer city, so an UNSTAMPED hold (its zone did not resolve at reserve) without
// the stamp is invisible to the next booking's stop read (zoneStopDays), and a second truck could take the same south
// day. A stamped hold keeps its stamp; gate off reads nothing and writes the expiry alone.
describe('extendReservation — a far-south hold per truck (owner rule B)', () => {
  const funnel = require('../services/scheduling/zone-day-funnel');
  const { gates } = require('../config/feature-gates');
  const VENICE = { id: 'zone-ven', zone_name: 'Venice / North Port', cities: ['Venice'] };
  const LAPSED = { ...HOLD, technician_id: 'tech-1', _already_lapsed: true };
  const VENICE_ESTIMATE = { address: '1 Test Way, Venice, FL 34285' };
  let spies = [];
  let funnelGate;
  beforeEach(() => {
    funnelGate = gates.southZoneDayFunnel;
    gates.southZoneDayFunnel = true;
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  });
  afterEach(() => { for (const spy of spies) spy.mockRestore(); spies = []; jest.useRealTimers(); gates.southZoneDayFunnel = funnelGate; });

  const extend = () => slotReservation.extendReservation({ estimateId: EST, scheduledServiceId: 'hold-1' });

  test.each([
    ['lapsed unstamped', null, true, { reservation_expires_at: '2027-05-20T13:40:00.000Z', zone: 'venice' }],
    ['lapsed stamped', 'venice', true, { reservation_expires_at: '2027-05-20T13:40:00.000Z' }],
    ['live unstamped', null, false, { reservation_expires_at: '2027-05-20T13:40:00.000Z', zone: 'venice' }],
  ])('a %s hold is checked and keeps the zone its check read on the row', async (_label, zone, lapsed, written) => {
    const mayTake = jest.fn().mockResolvedValue(true);
    spies = [jest.spyOn(funnel, 'perTruckLive').mockReturnValue(true), jest.spyOn(funnel, 'truckMayTakeDate').mockImplementation(mayTake)];
    const { update } = harness({ hold: { ...LAPSED, zone, _already_lapsed: lapsed }, destinationProbe: false, estimate: VENICE_ESTIMATE, zones: [VENICE] });
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(mayTake).toHaveBeenCalledWith(expect.any(Function), { estimateZone: VENICE, date: DATE, technicianId: 'tech-1' });
    expect(update.update).toHaveBeenCalledWith(written);
  });

  // Pre-push P1 on 2b747741a9: at the expiry cap the extend writes no new expiry, but an unstamped hold still takes the
  // stamp its check read (and only that), or the next booking's stop read misses it; a stamped hold writes nothing.
  test.each([
    ['unstamped', null, [[{ zone: 'venice' }]]],
    ['stamped', 'venice', []],
  ])('at the expiry cap, an %s hold writes only the stamp its check read', async (_label, zone, writes) => {
    const mayTake = jest.fn().mockResolvedValue(true);
    spies = [jest.spyOn(funnel, 'perTruckLive').mockReturnValue(true), jest.spyOn(funnel, 'truckMayTakeDate').mockImplementation(mayTake)];
    const capped = { ...LAPSED, zone, _already_lapsed: false, reservation_expires_at: '2027-05-20T13:40:00.000Z', _new_expiry: '2027-05-20T13:40:00.000Z' };
    const { update } = harness({ hold: capped, destinationProbe: false, estimate: VENICE_ESTIMATE, zones: [VENICE] });
    await expect(extend()).resolves.toEqual({ scheduledServiceId: 'hold-1', expiresAt: '2027-05-20T13:40:00.000Z' });
    expect(mayTake).toHaveBeenCalledWith(expect.any(Function), { estimateZone: VENICE, date: DATE, technicianId: 'tech-1' });
    expect(update.update.mock.calls).toEqual(writes);
  });

  test('gate off (one truck): nothing is asked and the expiry alone is written', async () => {
    const mayTake = jest.fn().mockResolvedValue(false);
    spies = [jest.spyOn(funnel, 'perTruckLive').mockReturnValue(false), jest.spyOn(funnel, 'truckMayTakeDate').mockImplementation(mayTake)];
    const { update } = harness({ hold: { ...LAPSED, zone: null }, destinationProbe: false, estimate: VENICE_ESTIMATE, zones: [VENICE] });
    await expect(extend()).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(mayTake).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith({ reservation_expires_at: '2027-05-20T13:40:00.000Z' });
  });

  // Pre-push P1 on c08db66cc0: a refused hold, live or lapsed, can only lose at accept, so it is superseded like a
  // clashing one: its delete commits before the 409, and a live one no longer blocks its truck's hour until it expires.
  test.each([['lapsed', true], ['live', false]])('another truck\'s far-south day: slot-taken, and the %s hold is released, not kept', async (_label, lapsed) => {
    spies = [jest.spyOn(funnel, 'perTruckLive').mockReturnValue(true), jest.spyOn(funnel, 'truckMayTakeDate').mockResolvedValue(false)];
    const { dead, update } = harness({ hold: { ...LAPSED, zone: null, _already_lapsed: lapsed }, destinationProbe: false, probeRuns: false, superseded: true, estimate: VENICE_ESTIMATE, zones: [VENICE] });
    await expect(extend()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(dead.where).toHaveBeenCalledWith({ id: 'hold-1' });
    expect(dead.del).toHaveBeenCalledTimes(1);
    expect(update.update).not.toHaveBeenCalled();
  });
});
