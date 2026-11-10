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
jest.mock('../services/scheduling/booking-make-room', () => ({
  bookingMakeRoomMode: jest.fn(() => 'off'),
  _internals: { MOVED_BY: 'booking_make_room' },
}));
// The day re-plan writer is the collaborator under test's neighbour: its calls are recorded, in order.
jest.mock('../services/day-replan', () => ({ _internals: { applyDeps: jest.fn(() => ({ writerDeps: true })) } }));
jest.mock('../services/day-replan/apply', () => ({
  _internals: { recheckVisit: jest.fn(), writeMoves: jest.fn(), assertNoClash: jest.fn(), reconcileReminders: jest.fn(async () => undefined) },
}));
jest.mock('../services/day-replan/after-move', () => ({ afterMoveEffects: jest.fn(async () => undefined), repairMoved: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  outermostTransaction: (trx) => { let scope = trx; while (scope && scope.parentTransaction) scope = scope.parentTransaction; return scope; },
}));

/**
 * GATE_BOOKING_MAKE_ROOM = true (owner 2026-11-09 "YES"), commitReservation: accepting a make-room hold proves the chain
 * again under the accept's locks and moves the regular stops later inside the accept transaction, BEFORE the narrow
 * and global overlap probes (which then see the stops at their new hours). Any refusal writes nothing.
 */
const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const makeRoom = require('../services/scheduling/booking-make-room');
const apply = require('../services/day-replan/apply');
const afterMove = require('../services/day-replan/after-move');
const slotReservation = require('../services/slot-reservation');

const DATE = '2027-05-20';
const EST = 'estimate-456';
const PROOF = {
  shiftMin: 60,
  moves: [{ id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 }, { id: 'visit-c', from: '10:00', to: '11:00', widthMin: 60 }],
};
const PAYLOAD = { v: 1, date: DATE, techId: 'tech-1', shiftMin: 60, moves: PROOF.moves };

let events;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const chain = (label, extra = {}) => {
  const b = {};
  for (const name of ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotIn', 'andWhere', 'andWhereRaw', 'orWhereRaw', 'select', 'forUpdate', 'whereIn', 'update', 'orWhere', 'whereNot', 'orWhereNull', 'orWhereNot', 'insert']) {
    b[name] = jest.fn(function call(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  }
  b.modify = jest.fn(function modify(callback) { callback(b); return b; });
  return Object.assign(b, extra, label ? { _label: label } : {});
};
const firstOf = (label, value) => chain(label, { first: jest.fn(async () => { events.push(label); return value; }) });
const globalProbe = (rows = []) => chain('committed-probe', { orderBy: jest.fn(() => { events.push('committed-probe'); return Promise.resolve(rows); }) });

const heldRow = (extra = {}) => ({
  id: 'hold-1', source_estimate_id: EST, scheduled_date: DATE, window_start: '09:00:00', window_end: '10:00:00', technician_id: 'tech-1',
  reservation_expires_at: '2027-05-20T13:15:00.000Z', make_room_moves: PAYLOAD, ...extra,
});

/**
 * One commit transaction. scheduled_services calls come in this order: the pre-read, the FOR UPDATE reload, the chain
 * clash probes (one per moved stop, then the shared-stop probe), the moved rows' window_end read, the narrow check, the
 * committed probe, the destination probe (every accept in mode on), the graduation update.
 */
function commitTrx({ pre = heldRow(), locked = heldRow(), narrow = null, global = [], destination = null, clash = [null, null, null], skipChain = false, lockRows = !skipChain, executionPromise = undefined } = {}) {
  const lock = chain('lock-moved', { select: jest.fn(async () => { events.push('lock-moved'); return [{ id: 'visit-b' }, { id: 'visit-c' }]; }) });
  lock.orderBy = jest.fn(() => lock);
  const queue = [
    firstOf('pre-read', pre),
    firstOf('reload', locked),
    // The moved stops' rows, FOR UPDATE, right before the proof (reached whenever the gate check passes).
    ...(lockRows ? [lock] : []),
    ...(skipChain ? [] : [
      firstOf('chain-probe-1', clash[0]), firstOf('chain-probe-2', clash[1]), firstOf('chain-probe-3', clash[2]),
      chain('moved-rows', { select: jest.fn(async () => { events.push('moved-rows'); return [{ id: 'visit-b', window_end: '10:00:00' }, { id: 'visit-c', window_end: null }]; }) }),
    ]),
    firstOf('narrow-check', narrow),
    globalProbe(global),
    // Another live make-room hold's moved stop over the accepted window (acceptedWindowOnMakeRoomDestination).
    firstOf('destination-probe', destination),
  ];
  const update = chain('graduation', { returning: jest.fn(async () => { events.push('graduation'); return [{ id: 'hold-1', customer_id: 'customer-1', technician_id: null }]; }) });
  queue.push(update);
  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return queue.shift();
    if (table === 'technicians') return chain(null, { first: jest.fn(async () => ({ id: 'tech-1', employment_status: 'active', field_dispatchable: true })), forShare: jest.fn().mockReturnThis() });
    if (table === 'technician_absences') return { where: () => ({ whereNull: () => ({ first: async () => null }) }) };
    throw new Error(`unexpected table ${table}`);
  });
  trx.raw = jest.fn((sql, args) => {
    const key = String(args && args[1]);
    if (/^(tech-1|unassigned):/.test(key)) events.push(`lock:tech-day:${key.split(':')[0]}`);
    else if (key.includes(DATE)) events.push('lock:rung-1');
    else events.push('lock:other');
    return { raw: sql };
  });
  if (executionPromise) trx.executionPromise = executionPromise;
  return { trx, update, queue, lock };
}

const accept = (trx, extra = {}) => slotReservation.commitReservation({
  scheduledServiceId: 'hold-1', customerId: 'customer-1', estimate: { id: EST, service_interest: 'Pest Control' }, serviceMode: 'recurring', selectedFrequency: 'quarterly', trx, ...extra,
});

const WRITTEN = [{ id: 'visit-b', customer_id: 'c-b', visit_id: null, start: '10:00', end: '11:00' }, { id: 'visit-c', customer_id: 'c-c', visit_id: null, start: '11:00', end: '12:00' }];

// The fixtures sit on DATE (2027-05-20). Only Date is frozen, well before it, so the accept's booking-notice check never
// reaches them whatever day the suite runs (Codex #7799 P1). The suite's setImmediate flushes and every timer stay real.
beforeAll(() => {
  jest.useFakeTimers({
    now: new Date('2027-05-01T15:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
  });
});
afterAll(() => { jest.useRealTimers(); });

// The booking-window config cache starts unknown; one read through the pool warms it (the commit then reads nothing).
beforeAll(async () => {
  db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
  await require('../services/scheduling/customer-windows').refreshCustomerBookingWindowConfig(db);
});

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  makeRoom.bookingMakeRoomMode.mockReturnValue('on');
  estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue(PROOF);
  apply._internals.recheckVisit.mockImplementation(async () => { events.push('recheck'); });
  apply._internals.writeMoves.mockImplementation(async () => { events.push('write-moves'); return WRITTEN; });
  apply._internals.assertNoClash.mockImplementation(async () => { events.push('assert-no-clash'); });
  db.mockImplementation((table) => (table === 'booking_config' ? { first: jest.fn().mockResolvedValue(undefined) } : undefined));
});

describe('commitReservation — a make-room hold moves the stops at accept (mode on)', () => {
  test('equal proof: recheck, write and clash check run before the narrow check and the committed probe; the hold graduates', async () => {
    const { trx, update } = commitTrx();
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1', customer_id: 'customer-1' });
    const at = (name) => events.indexOf(name);
    expect(at('lock:rung-1')).toBeGreaterThanOrEqual(0);
    expect(at('lock:tech-day:tech-1')).toBeGreaterThan(at('lock:rung-1'));
    expect(at('recheck')).toBeGreaterThan(at('chain-probe-3'));
    expect(at('write-moves')).toBeGreaterThan(at('recheck'));
    expect(at('assert-no-clash')).toBeGreaterThan(at('write-moves'));
    expect(at('narrow-check')).toBeGreaterThan(at('assert-no-clash'));
    expect(at('committed-probe')).toBeGreaterThan(at('narrow-check'));
    expect(at('graduation')).toBeGreaterThan(at('committed-probe'));
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer-1', reservation_expires_at: null }));
    expect(apply._internals.recheckVisit.mock.calls.map(([, , a]) => [a.id, a.dateStr, a.toStart])).toEqual([['visit-b', DATE, 600], ['visit-c', DATE, 660]]);
    expect(apply._internals.writeMoves).toHaveBeenCalledWith(trx, { writerDeps: true }, {
      dateStr: DATE,
      moves: [{ id: 'visit-b', toStart: 600, widthMin: 60, openEnd: false }, { id: 'visit-c', toStart: 660, widthMin: 60, openEnd: true }],
      initiator: 'booking_make_room', reasonCode: 'booking_make_room',
    });
    expect(apply._internals.assertNoClash).toHaveBeenCalledWith(trx, { writerDeps: true }, { dateStr: DATE, techId: 'tech-1', written: WRITTEN });
    // The proof ran with the accepted profile on the hold's own hour and technician.
    expect(estimateSlotAvailability.verifyMakeRoomOffer).toHaveBeenCalledWith(expect.objectContaining({ date: DATE, windowStart: '09:00:00', techId: 'tech-1', durationMinutes: 60 }));
  });

  // Codex pre-push P1 on PR 4: a customer's confirmation takes no occupancy lock, so the moved rows are locked before
  // the proof and held through the writes; a confirmation that lands first is seen, one that lands later waits.
  test('the moved stops\' rows are locked FOR UPDATE, in id order, after the tech-day locks and before the proof', async () => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockImplementation(async () => { events.push('proof'); return PROOF; });
    const { trx, lock } = commitTrx();
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1' });
    const at = (name) => events.indexOf(name);
    expect(at('lock-moved')).toBeGreaterThan(at('lock:tech-day:unassigned'));
    expect(at('proof')).toBeGreaterThan(at('lock-moved'));
    expect(at('recheck')).toBeGreaterThan(at('proof'));
    expect(lock.whereIn).toHaveBeenCalledWith('id', ['visit-b', 'visit-c']);
    expect(lock.orderBy).toHaveBeenCalledWith('id');
    expect(lock.forUpdate).toHaveBeenCalled();
  });

  // Codex pre-push P1 on PR 4: the gate is the kill switch; it is read again right before the writes.
  test('the gate turns off while the proof runs: the ordinary slot-taken answer, nothing written', async () => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockImplementation(async () => {
      makeRoom.bookingMakeRoomMode.mockReturnValue('shadow');
      return PROOF;
    });
    const { trx, update } = commitTrx();
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(events).toContain('lock-moved');
    expect(apply._internals.recheckVisit).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('the tech-day locks are two (this technician, the unassigned day) and follow rung 1', async () => {
    const { trx } = commitTrx();
    await accept(trx);
    const locks = events.filter((name) => name.startsWith('lock:') && name !== 'lock:other');
    expect(locks).toEqual(['lock:rung-1', 'lock:tech-day:tech-1', 'lock:tech-day:unassigned']);
  });

  test.each([['off'], ['shadow']])('mode %s: the ordinary slot-taken answer, nothing proved or written', async (mode) => {
    makeRoom.bookingMakeRoomMode.mockReturnValue(mode);
    const { trx, update } = commitTrx({ skipChain: true });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
    expect(events).not.toContain('lock-moved');
  });

  test('the proof fails: the ordinary slot-taken answer, nothing written', async () => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue({ reason: 'no_chain' });
    const { trx, update } = commitTrx({ skipChain: true, lockRows: true });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(apply._internals.recheckVisit).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test('the proof differs from the stored chain (a stop moved later again): slot-taken, nothing written', async () => {
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue({ shiftMin: 60, moves: [{ ...PROOF.moves[0], to: '10:30' }, PROOF.moves[1]] });
    const { trx } = commitTrx({ skipChain: true, lockRows: true });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
  });

  test('ids compare as strings: a numeric id in the stored chain still equals the proof', async () => {
    const numeric = { ...PAYLOAD, moves: PAYLOAD.moves.map((m, i) => ({ ...m, id: 100 + i })) };
    estimateSlotAvailability.verifyMakeRoomOffer.mockResolvedValue({ shiftMin: 60, moves: PROOF.moves.map((m, i) => ({ ...m, id: String(100 + i) })) });
    const { trx } = commitTrx({ pre: heldRow({ make_room_moves: numeric }), locked: heldRow({ make_room_moves: numeric }) });
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1' });
  });

  test('another live chain clashes with this one: slot-taken, nothing written', async () => {
    const { trx, update } = commitTrx({ clash: [{ id: 'other-hold' }, null, null] });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
    expect(update.update).not.toHaveBeenCalled();
  });

  test.each(['NOT_MOVABLE', 'CHANGED_SINCE_PLAN', 'SLOT_TAKEN'])('the writer refuses with %s: slot-taken', async (code) => {
    apply._internals.recheckVisit.mockRejectedValue(Object.assign(new Error('x'), { code }));
    apply._internals.writeMoves.mockRejectedValue(Object.assign(new Error('x'), { code }));
    const { trx, update } = commitTrx();
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(update.update).not.toHaveBeenCalled();
  });

  test('a writer error that is not a refusal is rethrown as it is', async () => {
    apply._internals.recheckVisit.mockRejectedValue(Object.assign(new Error('db down'), { code: '57P01' }));
    const { trx } = commitTrx();
    await expect(accept(trx)).rejects.toMatchObject({ code: '57P01' });
  });

  test('the committed probe hits after the move: the accept fails (the caller\'s rollback undoes the moves)', async () => {
    const { trx, update } = commitTrx({ narrow: { id: 'visit-z' } });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(apply._internals.writeMoves).toHaveBeenCalledTimes(1);
    expect(update.update).not.toHaveBeenCalled();
  });

  test('another live chain\'s moved stop holds the accepted window: the accept fails after the move (rolled back with it)', async () => {
    const { trx, update } = commitTrx({ destination: { id: 'hold-other' } });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(events.indexOf('write-moves')).toBeLessThan(events.indexOf('destination-probe'));
    expect(update.update).not.toHaveBeenCalled();
  });

  test('an already-committed row returns at once: no proof, no writes, no after-commit work', async () => {
    const done = heldRow({ reservation_expires_at: null, customer_id: 'customer-1' });
    const { trx } = commitTrx({ pre: done, locked: done, skipChain: true });
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
  });

  test('the technician changed between the pre-read and the lock: RESERVATION_EXPIRED, nothing proved', async () => {
    const { trx } = commitTrx({ locked: heldRow({ technician_id: 'tech-2' }), skipChain: true });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
  });

  test('the chain changed between the pre-read and the lock: RESERVATION_EXPIRED', async () => {
    const { trx } = commitTrx({ locked: heldRow({ make_room_moves: { ...PAYLOAD, shiftMin: 30 } }), skipChain: true });
    await expect(accept(trx)).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
  });

  test('an ordinary hold takes no tech-day lock and runs no proof or move', async () => {
    const plain = heldRow({ make_room_moves: null });
    const { trx } = commitTrx({ pre: plain, locked: plain, skipChain: true });
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1' });
    expect(events.filter((name) => name.startsWith('lock:tech-day'))).toHaveLength(0);
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
  });
});

// Codex #7796 round 4: in capacity mode the overlap probes do not run and the arrival-capacity check alone could accept a
// make-room hold, so the move step itself refuses it before any lock, proof or write.
describe('moveMakeRoomStops — capacity mode refuses a make-room hold', () => {
  test('the ordinary slot-taken answer, with no read, proof or write', async () => {
    const trx = jest.fn(() => { throw new Error('no read expected'); });
    const { moveMakeRoomStops } = slotReservation._internals;
    await expect(moveMakeRoomStops(trx, {
      row: heldRow(), estimate: { id: EST }, serviceProfile: null, effectiveDurationMinutes: 60, scheduledDate: DATE, useCapacity: true,
    })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', slotId: `${DATE}_09-00_tech-1` });
    expect(trx).not.toHaveBeenCalled();
    expect(estimateSlotAvailability.verifyMakeRoomOffer).not.toHaveBeenCalled();
    expect(apply._internals.writeMoves).not.toHaveBeenCalled();
  });
});

describe('commitReservation — the silent syncs follow the caller\'s commit', () => {
  test('they run only after the caller transaction\'s executionPromise resolves', async () => {
    let finish;
    const executionPromise = new Promise((resolve) => { finish = resolve; });
    const { trx } = commitTrx({ executionPromise });
    await accept(trx);
    await flush();
    expect(afterMove.afterMoveEffects).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(apply._internals.reconcileReminders).toHaveBeenCalledWith(db, { writerDeps: true }, { ids: ['visit-b', 'visit-c'] });
    expect(afterMove.afterMoveEffects).toHaveBeenCalledWith(db, { dateStr: DATE, written: WRITTEN });
  });

  test('they do not run when the caller transaction rolls back', async () => {
    let fail;
    const executionPromise = new Promise((_resolve, reject) => { fail = reject; });
    const { trx } = commitTrx({ executionPromise });
    await accept(trx);
    fail(new Error('rolled back'));
    await flush();
    expect(apply._internals.reconcileReminders).not.toHaveBeenCalled();
    expect(afterMove.afterMoveEffects).not.toHaveBeenCalled();
  });

  test('a transaction with no commit hook leaves the sync to the repair job and never fails the accept', async () => {
    const { trx } = commitTrx();
    await expect(accept(trx)).resolves.toMatchObject({ id: 'hold-1' });
    await flush();
    expect(afterMove.afterMoveEffects).not.toHaveBeenCalled();
  });
});
