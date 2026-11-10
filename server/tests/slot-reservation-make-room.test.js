jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-moves', () => ({ lockMoveForConversion: jest.fn(async () => null) }));
jest.mock('../services/estimate-stuck-alert', () => ({ noteExpiredHolds: jest.fn(async () => 0) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  async resolveCatalogSlotProfile(estimate, options) { return this.resolveEstimateSlotProfile(estimate, options); },
  resolveEstimateSlotProfile: jest.fn(() => ({ durationMinutes: 60, serviceLabel: 'Pest Control', services: [{ service: 'pest_control', visitsPerYear: 4 }] })),
  resolveEstimateCoords: jest.fn(async () => ({ lat: 27.33, lng: -82.53 })),
  verifyMakeRoomOffer: jest.fn(),
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 18 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));
// The gate lives in booking-make-room (bookingMakeRoomMode); only that function is the reserve path's concern here.
jest.mock('../services/scheduling/booking-make-room', () => ({ bookingMakeRoomMode: jest.fn(() => 'off') }));

/**
 * GATE_BOOKING_MAKE_ROOM on (owner 2026-11-09 "YES"), reserveSlot: the hold of the page's one make-room hour. The hour is
 * the one a regular stop (visit-b) holds. With mode on, a capacity-off hour-mode reserve, and the make-room signature,
 * the transaction rebuilds the chain under its locks and the hold's own overlap probes skip the chain's moved stops.
 * Nothing moves a visit: accepting such a hold fails closed (commitReservation below).
 */
const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const makeRoom = require('../services/scheduling/booking-make-room');
const slotReservation = require('../services/slot-reservation');
const { signSlotOffer, appendOfferToSlotId, MAKE_ROOM_OFFER_POLICY } = require('../utils/slot-offer-token');

const DATE = '2027-05-20';
const EST = 'estimate-456';
const ADDRESS = '1 Test Way, Sarasota, FL 34231';

function slotId({ policy, hhmm = '09:00', techId = 'tech-1', estimateId = EST, durationMinutes = 60 } = {}) {
  const [h, m] = hhmm.split(':').map(Number);
  const offer = signSlotOffer({
    surface: 'estimate', scopeId: String(estimateId), date: DATE, startMinutes: h * 60 + m, technicianId: techId, durationMinutes, policy,
  });
  return appendOfferToSlotId(`${DATE}_${hhmm.replace(':', '-')}_${techId}`, offer);
}

const PROOF = {
  shiftMin: 60,
  moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }, { id: 'visit-c', from: '10:00', to: '11:00', widthMin: 60 }],
};
const PAYLOAD = { v: 1, date: DATE, techId: 'tech-1', shiftMin: 60, moves: PROOF.moves };

const chain = (extra) => {
  const b = {};
  for (const name of ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotIn', 'andWhere', 'andWhereRaw', 'orWhereRaw', 'orWhereNull', 'orWhereNot', 'select', 'forUpdate', 'insert', 'whereIn', 'update', 'orWhere', 'whereNot']) {
    b[name] = jest.fn(function call(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  }
  b.del = jest.fn().mockResolvedValue(1);
  b.modify = jest.fn(function modify(callback) { callback(b); return b; });
  return Object.assign(b, extra);
};
const liveHolds = (rows = []) => chain({ select: jest.fn().mockResolvedValue(rows) });
const conflictProbe = (result = null) => chain({ first: jest.fn().mockResolvedValue(result) });
const globalProbe = (rows = []) => chain({ orderBy: jest.fn(() => Promise.resolve(rows)) });
const destinationProbe = (result = null) => chain({ first: jest.fn().mockResolvedValue(result) });
// makeRoomChainClash on PROOF's chain: visit-b's new hour, visit-c's new hour, then the shared-stop probe.
const chainProbes = ({ first = null, second = null, shared = null } = {}) => [destinationProbe(first), destinationProbe(second), destinationProbe(shared)];
const inserter = () => chain({ returning: jest.fn().mockResolvedValue([{ id: 'hold-1', reservation_expires_at: '2027-05-20T13:15:00.000Z' }]) });
const updater = () => chain({ returning: jest.fn().mockResolvedValue([{ id: 'hold-1', reservation_expires_at: '2027-05-20T13:15:00.000Z' }]) });

function harness(builders) {
  const estimateBuilder = chain({ first: jest.fn().mockResolvedValue({ id: EST, status: 'sent', service_interest: 'Pest Control', address: ADDRESS }) });
  const technicianBuilder = chain({ first: jest.fn().mockResolvedValue({ id: 'tech-1', employment_status: 'active', field_dispatchable: true }), forShare: jest.fn(() => technicianBuilder) });
  const queue = [...builders];
  const trx = jest.fn((table) => {
    if (table === 'estimates') return estimateBuilder;
    if (table === 'technicians') return technicianBuilder;
    if (table === 'scheduled_services') return queue.shift();
    if (table === 'technician_absences') return { where: () => ({ whereNull: () => ({ first: async () => null }) }) };
    throw new Error(`unexpected table ${table}`);
  });
  trx.raw = jest.fn((sql) => ({ raw: sql }));
  trx.isTransaction = true;
  db.transaction = jest.fn(async (callback) => callback(trx));
  return { trx, queue };
}

describe('reserveSlot — the make-room hold', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue(PROOF);
    db.mockImplementation((table) => {
      if (table === 'booking_config') return { first: jest.fn().mockResolvedValue(undefined) };
      if (table === 'estimates') return { where: () => ({ first: jest.fn().mockResolvedValue({ id: EST, customer_id: null, address: ADDRESS }) }) };
      return undefined;
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  const roomSlot = () => slotId({ policy: MAKE_ROOM_OFFER_POLICY });

  test('a make-room signature in mode on: the chain is rebuilt for that exact hour under the date and tech-day locks, then stored on the hold', async () => {
    const holds = liveHolds();
    const conflict = conflictProbe(null);
    const probe = globalProbe([]);
    const destination = destinationProbe(null);
    const insert = inserter();
    const { trx } = harness([holds, conflict, probe, destination, ...chainProbes(), insert]);

    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).resolves.toEqual({
      scheduledServiceId: 'hold-1', expiresAt: '2027-05-20T13:15:00.000Z',
    });

    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledTimes(1);
    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledWith(expect.objectContaining({
      conn: trx, date: DATE, windowStart: '09:00:00', techId: 'tech-1', durationMinutes: 60, coords: { lat: 27.33, lng: -82.53 },
      estimate: expect.objectContaining({ id: EST }),
    }));
    // After the date lock and the tech-day lock, before the hold's own reads.
    const lockOrder = (key) => trx.raw.mock.invocationCallOrder[trx.raw.mock.calls.findIndex((c) => Array.isArray(c[1]) && c[1][1] === key)];
    const proofOrder = estimateSlotAvailability.verifyMakeRoomOffer.mock.invocationCallOrder[0];
    expect(lockOrder(`occupancy:${DATE}`)).toBeLessThan(proofOrder);
    expect(lockOrder(`tech-1:${DATE}`)).toBeLessThan(proofOrder);
    expect(proofOrder).toBeLessThan(holds.select.mock.invocationCallOrder[0]);
    // The chain is stored on the hold row only.
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({ customer_id: null, window_start: '09:00:00', make_room_moves: PAYLOAD }));
  });

  test('the hold\'s own probes skip ONLY the chain\'s moved stops; every probe still runs', async () => {
    const conflict = conflictProbe(null);
    const probe = globalProbe([]);
    const { queue } = harness([liveHolds(), conflict, probe, destinationProbe(null), ...chainProbes(), inserter()]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() });
    expect(queue).toHaveLength(0);
    // Tech-scoped overlap probe: the tech and the window still apply, minus the moved stops.
    expect(conflict.where).toHaveBeenCalledWith('technician_id', 'tech-1');
    expect(conflict.andWhereRaw).toHaveBeenCalledWith(expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'), ['10:00:00', 60, '09:00:00']);
    expect(conflict.whereNotIn).toHaveBeenCalledWith('id', ['visit-b', 'visit-c']);
    // Tech-blind global probe (findConflictingVisits): the window still applies, minus the moved stops.
    expect(probe.whereRaw).toHaveBeenCalledWith(expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'), ['10:00:00', 60, '09:00:00']);
    expect(probe.whereNotIn).toHaveBeenCalledWith('id', ['visit-b', 'visit-c']);
  });

  test('another visit in the hour still blocks the hold (the global probe finds it)', async () => {
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([{ id: 'visit-x', technician_id: 'tech-2', window_start: '09:00:00' }]), destinationProbe(null), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test('the chain changed since the offer: the proof fails, so the ordinary slot-taken answer and no hold', async () => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue({ reason: 'fixed_time_told' });
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: roomSlot().split('.')[0] && expect.stringContaining(`${DATE}_09-00_tech-1`) });
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test.each([
    ['an empty chain', { shiftMin: 60, moves: [] }],
    ['no answer', undefined],
  ])('%s from the proof is a refusal', async (_label, proof) => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue(proof);
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test.each(['off', 'shadow'])('mode %s: a make-room signature is not an offer; the proof never runs and nothing is held', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test('capacity mode never takes the make-room path', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      const insert = inserter();
      harness([insert]);
      await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toBeTruthy();
      expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
      expect(insert.insert).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_SCHEDULING_CAPACITY;
    }
  });

  test('a normal slotId, an unsigned one and another estimate\'s make-room signature never reach the path', async () => {
    for (const id of [slotId({}), `${DATE}_09-00_tech-1`, slotId({ policy: MAKE_ROOM_OFFER_POLICY, estimateId: 'estimate-other' }), slotId({ policy: MAKE_ROOM_OFFER_POLICY, hhmm: '10:00' }).replace('_10-00_', '_09-00_')]) {
      const insert = inserter();
      harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), insert]);
      if (id === slotId({})) {
        // A normal offer is an ordinary reserve in mode on: held with no chain, and the proof never runs.
        await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: id })).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
        expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('make_room_moves');
      } else {
        await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: id })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
        expect(insert.insert).not.toHaveBeenCalled();
      }
      expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    }
  });

  test('a normal hold probes exactly as before: no moved-stop exclusion anywhere', async () => {
    const conflict = conflictProbe(null);
    const probe = globalProbe([]);
    harness([liveHolds(), conflict, probe, destinationProbe(null), inserter()]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(conflict.whereNotIn).not.toHaveBeenCalledWith('id', expect.anything());
    expect(probe.whereNotIn).not.toHaveBeenCalledWith('id', expect.anything());
  });

  test('another customer\'s live make-room hold keeps its move destinations: a window over one is taken (mode on)', async () => {
    const destination = destinationProbe({ id: 'hold-other' });
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destination, insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({ hhmm: '10:00' }) })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(insert.insert).not.toHaveBeenCalled();
    // The probe reads live customer-less holds that carry a chain, on this technician-day, overlapping the window.
    expect(destination.whereNotNull).toHaveBeenCalledWith('make_room_moves');
    // The occupancy tech scope (multi-tech confirm off here): every technician, never one technician's rows only.
    expect(destination.orWhere).not.toHaveBeenCalled();
    expect(destination.whereRaw).toHaveBeenCalledWith(expect.stringContaining('jsonb_array_elements(make_room_moves->'), ['11:00:00', '10:00:00']);
  });

  test('competing chains (Codex pre-push P1): a moved stop\'s new hour on another live chain\'s destination is taken; no hold', async () => {
    const [first, second, shared] = chainProbes({ first: { id: 'hold-other' } });
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), first, second, shared, insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(insert.insert).not.toHaveBeenCalled();
    // visit-b's new hour (10:00 for 60 minutes), against live holds that carry a chain.
    expect(first.whereNotNull).toHaveBeenCalledWith('make_room_moves');
    expect(first.whereRaw).toHaveBeenCalledWith(expect.stringContaining("(m->>'to')::time"), ['11:00:00', '10:00']);
    expect(second.first).not.toHaveBeenCalled();
  });

  test('competing chains: a stop another live chain also moves is taken; every new hour is checked first', async () => {
    const [first, second, shared] = chainProbes({ shared: { id: 'hold-other' } });
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), first, second, shared, insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(insert.insert).not.toHaveBeenCalled();
    expect(second.whereRaw).toHaveBeenCalledWith(expect.stringContaining("(m->>'to')::time"), ['12:00:00', '11:00']);
    expect(shared.whereNotNull).toHaveBeenCalledWith('make_room_moves');
    expect(shared.whereRaw).toHaveBeenCalledWith(expect.stringContaining("(m->>'id') = ANY"), [['visit-b', 'visit-c']]);
  });

  test('an ordinary hold runs no chain probe (it has no chain)', async () => {
    const { queue } = harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), inserter()]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(queue).toHaveLength(0);
  });

  test('mode off or shadow runs no destination probe (the reserve path is as before)', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    const insert = inserter();
    const { queue } = harness([liveHolds(), conflictProbe(null), globalProbe([]), insert]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(queue).toHaveLength(0);
    expect(insert.insert.mock.calls[0][0]).not.toHaveProperty('make_room_moves');
  });

  test('re-reserving the same make-room hour refreshes the hold with the chain just proven; the refresh probe skips the moved stops', async () => {
    const existing = {
      id: 'hold-1', scheduled_date: DATE, window_start: '09:00:00', technician_id: 'tech-1', estimated_duration_minutes: 60,
      reservation_service_mix: null, make_room_moves: { ...PAYLOAD, shiftMin: 120 },
    };
    const probe = globalProbe([]);
    const update = updater();
    const chainChecks = chainProbes();
    harness([liveHolds([existing]), probe, destinationProbe(null), ...chainChecks, update]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    expect(probe.whereNotIn).toHaveBeenCalledWith('id', ['hold-1', 'visit-b', 'visit-c']);
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ make_room_moves: PAYLOAD }));
    // The hold's own (older) chain never counts against its new one.
    for (const check of chainChecks) expect(check.whereNot).toHaveBeenCalledWith('id', 'hold-1');
  });

  test('re-reserving a hold that no longer needs a chain (a normal offer) drops it', async () => {
    const existing = {
      id: 'hold-1', scheduled_date: DATE, window_start: '09:00:00', technician_id: 'tech-1', estimated_duration_minutes: 60,
      reservation_service_mix: null, make_room_moves: PAYLOAD,
    };
    const update = updater();
    harness([liveHolds([existing]), globalProbe([]), destinationProbe(null), update]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ make_room_moves: null }));
  });
});

describe('reserveSlot — the gate is read again inside the transaction (Codex pre-push P0)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReset();
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue(PROOF);
    db.mockImplementation((table) => {
      if (table === 'booking_config') return { first: jest.fn().mockResolvedValue(undefined) };
      if (table === 'estimates') return { where: () => ({ first: jest.fn().mockResolvedValue({ id: EST, customer_id: null, address: ADDRESS }) }) };
      return undefined;
    });
  });
  afterEach(() => { jest.useRealTimers(); });
  const roomSlot = () => slotId({ policy: MAKE_ROOM_OFFER_POLICY });

  test('the gate is off by the time the signature is checked: the make-room offer is refused, the proof never runs, no row is written', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test('the gate turns off after the proof, before the hold row is written: the ordinary slot-taken answer and no row', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValueOnce('on').mockReturnValue('off');
    const insert = inserter();
    harness([liveHolds(), conflictProbe(null), globalProbe([]), destinationProbe(null), insert]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledTimes(1);
    expect(insert.insert).not.toHaveBeenCalled();
  });

  test('the gate turns off before a same-slot refresh writes: the hold is not refreshed', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValueOnce('on').mockReturnValue('off');
    const existing = {
      id: 'hold-1', scheduled_date: DATE, window_start: '09:00:00', technician_id: 'tech-1', estimated_duration_minutes: 60,
      reservation_service_mix: null, make_room_moves: PAYLOAD,
    };
    const update = updater();
    harness([liveHolds([existing]), globalProbe([]), destinationProbe(null), update]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: roomSlot() })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(update.update).not.toHaveBeenCalled();
  });

  test('an ordinary hold uses the fresh in-transaction value for the destination probe: gate off, no probe runs', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('off');
    const insert = inserter();
    const { queue } = harness([liveHolds(), conflictProbe(null), globalProbe([]), insert]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(queue).toHaveLength(0);
  });
});

describe('makeRoomDestinationClash — the occupancy technician scope (Codex pre-push P1)', () => {
  const savedGate = process.env.GATE_MULTI_TECH_CONFIRM;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = savedGate;
  });
  const probe = (extra = {}) => {
    const builder = destinationProbe(null);
    const trx = jest.fn(() => builder);
    return slotReservation._internals.makeRoomDestinationClash(trx, { date: DATE, techId: 'tech-1', windowStart: '10:00:00', windowEnd: '11:00:00', ...extra }).then(() => builder);
  };

  test('multi-tech confirm on: that technician\'s rows plus the unassigned ones', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const builder = await probe();
    expect(builder.whereNull).toHaveBeenCalledWith('technician_id');
    expect(builder.orWhere).toHaveBeenCalledWith('technician_id', 'tech-1');
  });

  test('multi-tech confirm off: every technician (no technician predicate at all)', async () => {
    delete process.env.GATE_MULTI_TECH_CONFIRM;
    const builder = await probe();
    expect(builder.orWhere).not.toHaveBeenCalled();
    expect(builder.where).not.toHaveBeenCalledWith('technician_id', expect.anything());
  });

  test('a technician-less window is never scoped, and the caller\'s own hold id is excluded', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const builder = await probe({ techId: null, excludeId: 'hold-own' });
    expect(builder.orWhere).not.toHaveBeenCalled();
    expect(builder.whereNot).toHaveBeenCalledWith('id', 'hold-own');
  });
});

describe('a hold revived by a refresh must not sit on another make-room hold\'s destination (Codex pre-push P1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    makeRoom.bookingMakeRoomMode.mockReset();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    db.mockImplementation((table) => {
      if (table === 'booking_config') return { first: jest.fn().mockResolvedValue(undefined) };
      if (table === 'estimates') return { where: () => ({ first: jest.fn().mockResolvedValue({ id: EST, customer_id: null, address: ADDRESS }) }) };
      return undefined;
    });
  });
  afterEach(() => { jest.useRealTimers(); });
  const ordinary = {
    id: 'hold-1', scheduled_date: DATE, window_start: '09:00:00', technician_id: 'tech-1', estimated_duration_minutes: 60,
    reservation_service_mix: null, make_room_moves: null,
  };

  test('same-slot refresh: a destination hit supersedes the hold and answers SLOT_UNAVAILABLE; the probe excludes the hold itself', async () => {
    const destination = destinationProbe({ id: 'hold-other' });
    const dead = chain({});
    const update = updater();
    harness([liveHolds([ordinary]), globalProbe([]), destination, dead, update]);
    await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(destination.whereNot).toHaveBeenCalledWith('id', 'hold-1');
    expect(dead.del).toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('same-slot refresh with no hit still refreshes', async () => {
    const update = updater();
    await (async () => {
      harness([liveHolds([ordinary]), globalProbe([]), destinationProbe(null), update]);
      await expect(slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) })).resolves.toMatchObject({ scheduledServiceId: 'hold-1' });
    })();
    expect(update.update).toHaveBeenCalled();
  });

  test('gate off: the refresh runs no destination probe', async () => {
    makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
    const update = updater();
    const { queue } = harness([liveHolds([ordinary]), globalProbe([]), update]);
    await slotReservation.reserveSlot({ estimateId: EST, slotId: slotId({}) });
    expect(queue).toHaveLength(0);
  });
});

describe('commitReservation — a make-room hold fails closed until the accept change moves the stops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeRoom.bookingMakeRoomMode.mockReturnValue('on');
    db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  });

  const heldRow = {
    id: 'hold-1', source_estimate_id: EST, scheduled_date: DATE, window_start: '09:00:00', window_end: '10:00:00', technician_id: 'tech-1',
    reservation_expires_at: '2027-05-20T13:15:00.000Z', make_room_moves: PAYLOAD,
  };

  function commitTrx({ narrow = null, global = [] }) {
    const dateProbe = chain({ first: jest.fn().mockResolvedValue({ scheduled_date: DATE, technician_id: 'tech-1' }) });
    const reservation = chain({ first: jest.fn().mockResolvedValue(heldRow) });
    const conflict = chain({ whereNot: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(narrow) });
    const probe = globalProbe(global);
    const update = updater();
    const queue = [dateProbe, reservation, conflict, probe, update];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return queue.shift();
      if (table === 'technicians') return chain({ first: jest.fn().mockResolvedValue({ id: 'tech-1', employment_status: 'active', field_dispatchable: true }), forShare: jest.fn().mockReturnThis() });
      if (table === 'technician_absences') return { where: () => ({ whereNull: () => ({ first: async () => null }) }) };
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));
    return { trx, update, conflict, probe };
  }

  const accept = (trx) => slotReservation.commitReservation({
    scheduledServiceId: 'hold-1', customerId: 'customer-1', estimate: { id: EST, service_interest: 'Pest Control' }, serviceMode: 'recurring', selectedFrequency: 'quarterly', trx,
  });

  test.each([
    ['the technician-scoped probe', { narrow: { id: 'visit-b' } }],
    ['the tech-blind global probe', { global: [{ id: 'visit-b', technician_id: 'tech-1', window_start: '09:00:00' }] }],
  ])('the regular stop still sits in the held hour: %s refuses the accept through the taken-slot path, and nothing is written', async (_label, found) => {
    const { trx, update, conflict, probe } = commitTrx(found);
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(update.update).not.toHaveBeenCalled();
    // The commit probes know nothing of the chain: only the hold itself is excluded.
    expect(conflict.whereNot).toHaveBeenCalledWith('id', 'hold-1');
    if (found.global) expect(probe.whereNotIn).toHaveBeenCalledWith('id', ['hold-1']);
    expect(trx.mock.calls.map(([table]) => table)).not.toContain('reschedule_log');
  });
});
