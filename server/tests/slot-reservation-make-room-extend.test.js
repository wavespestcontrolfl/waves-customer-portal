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

function harness({ hold = HOLD, destinationHit = null, probeRows = [], destinationProbe = true, superseded = false, chainProbes = [] } = {}) {
  const pre = chain({ first: jest.fn().mockResolvedValue({ id: hold.id, scheduled_date: DATE }) });
  const locked = chain({ first: jest.fn().mockResolvedValue(hold) });
  const destination = chain({ first: jest.fn().mockResolvedValue(destinationHit) });
  const probe = chain({ orderBy: jest.fn(() => Promise.resolve(probeRows)) });
  const dead = chain({});
  const update = chain({ returning: jest.fn().mockResolvedValue([{ id: hold.id, reservation_expires_at: '2027-05-20T13:40:00.000Z' }]) });
  const queue = [pre, locked, ...(destinationProbe ? [destination] : []), ...chainProbes, probe, ...(superseded ? [dead] : []), update];
  const estimates = chain({ first: jest.fn().mockResolvedValue({ id: EST, status: 'sent', _expired: false }) });
  const trx = jest.fn((table) => {
    if (table === 'estimates') return estimates;
    if (table === 'scheduled_services') return queue.shift();
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
