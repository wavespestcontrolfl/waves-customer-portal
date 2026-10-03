/**
 * SMS scheduling move executor (GATE_SMS_SCHEDULING_ACT_MOVE, dark): a
 * recorded would-move is carried out only through the reschedule link's own
 * verdict, picker and mover; every refusal leaves the visit alone and closes
 * the claim; nothing throws. Synthetic people and numbers only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const act = require('../services/sms-scheduling-act');

const GATE = 'GATE_SMS_SCHEDULING_ACT_MOVE';
const NOW = new Date('2026-10-02T15:00:00Z');
const REPLIED = new Date('2026-10-02T14:59:30Z');
const VISIT_ID = '11111111-1111-4111-8111-111111111111';
const OFFER = { id: 'offer-1', kind: 'move_visit', customer_id: 'cust-1', scheduled_service_id: VISIT_ID, sent_at: new Date('2026-10-02T13:00:00Z') };
const SLOT = { date: '2026-10-06', start: '10:00', end: '12:00' };
const VISIT = { id: VISIT_ID, customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-10-05', window_start: '08:00:00', window_end: '10:00:00' };
const SVC = { ...VISIT, visit_id: null, self_booking_id: null, is_recurring: false, customer_active: true };

// A knex stand-in for the two decision-row writes the executor makes itself.
function fakeDb({ claim = true, marked = true } = {}) {
  const writes = [];
  const dbh = jest.fn(() => {
    const q = {
      where: () => q,
      whereNull: () => q,
      // The read-back of the guard's "moved" mark after the mover returns.
      first: async () => (marked ? { id: 'dec-1' } : undefined),
      update: (values) => { writes.push(values); q.updated = values; return q; },
      returning: async () => (claim ? [{ id: 'dec-1' }] : []),
      then: (resolve) => resolve(1),
    };
    return q;
  });
  dbh.fn = { now: () => 'now()' };
  return { dbh, writes };
}

function fakeDeps(over = {}) {
  return {
    reschedulePublic: {
      loadById: jest.fn(async () => SVC),
      pageEligibility: jest.fn(async () => ({ ok: true })),
      shouldReanchor: jest.fn(() => false),
      bookingRange: jest.fn(() => ({ rangeFrom: '2026-10-03', rangeTo: '2026-11-15' })),
      buildAvailabilityForService: jest.fn(async () => ({ days: [{ date: '2026-10-06', slots: [{ start_time: '10:00', end_time: '12:00', technician_id: 'tech-1' }] }] })),
      ...(over.reschedulePublic || {}),
    },
    loadBookingConfig: jest.fn(async () => ({})),
    notice: { visitInsideMoveNoticeWindow: jest.fn(() => false), violatesSelfServeNotice: jest.fn(() => false), ...(over.notice || {}) },
    rebooker: { reschedule: jest.fn(async () => ({})), rescheduleSeries: jest.fn(async () => ({ seriesMoveId: 'series-1' })), ...(over.rebooker || {}) },
    reminders: { handleReschedule: jest.fn(async () => null) },
    emitDispatchJobUpdate: jest.fn(async () => null),
    applySeriesMoveEffects: jest.fn(async () => ({ notificationSent: true })),
  };
}

const run = (over = {}, deps = fakeDeps(), fake = fakeDb()) => act.executeMove({
  decisionId: 'dec-1', offer: OFFER, slot: SLOT, visit: VISIT, repliedAt: REPLIED, now: NOW, dbh: fake.dbh, deps, ...over,
}).then((result) => ({ result, deps, fake }));

afterEach(() => { delete process.env[GATE]; });

test('gate off: nothing is claimed, read or moved', async () => {
  const { result, deps, fake } = await run();
  expect(result).toEqual({ executed: false, reason: 'gate_off' });
  expect(fake.dbh).not.toHaveBeenCalled();
  expect(deps.rebooker.reschedule).not.toHaveBeenCalled();
});

describe('gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('a one-time visit moves through the single mover, pinned to the visit that was checked, and the standard text goes out once', async () => {
    const { result, deps } = await run();
    expect(result).toMatchObject({ executed: true, status: 'moved', date: '2026-10-06', start: '10:00', end: '12:00' });
    expect(deps.rebooker.reschedule).toHaveBeenCalledTimes(1);
    const [id, date, window, reason, by, options] = deps.rebooker.reschedule.mock.calls[0];
    expect([id, date, window, reason, by]).toEqual([VISIT_ID, '2026-10-06', { start: '10:00', end: '12:00' }, 'customer_request', 'sms_offer_ai']);
    expect(options).toMatchObject({
      technicianId: 'tech-1', seriesPolicy: 'single', capacityPlacement: true, travelGap: true, sourceSurface: 'sms_reply', operationKey: 'sms_offer:dec-1',
      expect: { scheduled_date: '2026-10-05', window_start: '08:00:00', window_end: '10:00:00', status: 'confirmed', customer_id: 'cust-1', visit_id: null },
    });
    expect(typeof options.moveGuard).toBe('function');
    expect(deps.rebooker.rescheduleSeries).not.toHaveBeenCalled();
    expect(deps.reminders.handleReschedule).toHaveBeenCalledWith(VISIT_ID, '2026-10-06T10:00');
    expect(deps.emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
  });

  test("a recurring visit's date move goes through the series mover and its one shared text", async () => {
    const deps = fakeDeps({ reschedulePublic: { shouldReanchor: jest.fn(() => true) } });
    const { result } = await run({}, deps);
    expect(result).toMatchObject({ executed: true, seriesMoveId: 'series-1' });
    expect(deps.rebooker.reschedule).not.toHaveBeenCalled();
    const options = deps.rebooker.rescheduleSeries.mock.calls[0][5];
    expect(options).toMatchObject({ notifyRequested: true, expectAnchor: { scheduled_date: '2026-10-05', window_start: '08:00:00' } });
    expect(typeof options.moveGuard).toBe('function');
    expect(deps.applySeriesMoveEffects).toHaveBeenCalledWith(expect.objectContaining({ serviceId: VISIT_ID, notify: true }));
    expect(deps.reminders.handleReschedule).not.toHaveBeenCalled();
  });

  test.each([
    ['a reply older than 15 minutes', { repliedAt: new Date('2026-10-02T14:40:00Z') }, {}, 'reply_too_old'],
    ['a visit that is gone', {}, { loadById: jest.fn(async () => null) }, 'visit_missing'],
    ['a visit that changed since the decide step read it', {}, { loadById: jest.fn(async () => ({ ...SVC, window_start: '09:00:00' })) }, 'visit_changed'],
    ['a visit the reschedule link refuses', {}, { pageEligibility: jest.fn(async () => ({ ok: false, reason: 'grouped' })) }, 'not_eligible'],
    ['a date outside the booking range', {}, { bookingRange: jest.fn(() => ({ rangeFrom: '2026-10-07', rangeTo: '2026-11-15' })) }, 'outside_booking_range'],
    ['a time the picker no longer offers', {}, { buildAvailabilityForService: jest.fn(async () => ({ days: [{ date: '2026-10-06', slots: [{ start_time: '13:00', end_time: '15:00' }] }] })) }, 'slot_gone'],
  ])('%s is refused before the mover runs', async (_name, over, page, reason) => {
    const deps = fakeDeps({ reschedulePublic: page });
    const { result, fake } = await run(over, deps);
    expect(result).toMatchObject({ executed: false, status: 'refused', reason });
    expect(deps.rebooker.reschedule).not.toHaveBeenCalled();
    expect(deps.reminders.handleReschedule).not.toHaveBeenCalled();
    expect(fake.writes[fake.writes.length - 1]).toMatchObject({ execution_status: 'refused' });
  });

  test('a refusal under the move locks, and a mover refusal, send no text', async () => {
    for (const [error, reason] of [
      [Object.assign(new Error('x'), { code: 'SMS_ACT_REFUSED', refusal: 'reminder_offer_pending' }), 'reminder_offer_pending'],
      [Object.assign(new Error('taken'), { statusCode: 409, code: 'SLOT_UNAVAILABLE' }), 'mover_refused'],
    ]) {
      const deps = fakeDeps({ rebooker: { reschedule: jest.fn(async () => { throw error; }) } });
      const { result } = await run({}, deps);
      expect(result).toMatchObject({ executed: false, status: 'refused', reason });
      expect(deps.reminders.handleReschedule).not.toHaveBeenCalled();
    }
  });

  test('a mover that returns without the guard having marked the decision sends no text', async () => {
    const deps = fakeDeps();
    const { result } = await run({}, deps, fakeDb({ marked: false }));
    expect(result).toMatchObject({ executed: false, status: 'refused', reason: 'guard_not_run' });
    expect(deps.reminders.handleReschedule).not.toHaveBeenCalled();
  });

  test("the link's notice rules are checked again inside the mover, for the visit and for the new time", async () => {
    for (const notice of [{ visitInsideMoveNoticeWindow: () => true }, { violatesSelfServeNotice: () => true }]) {
      // A mover that runs its beforeMove hook, as the real one does under its locks.
      const reschedule = jest.fn(async (...args) => { await args[5].beforeMove(); return {}; });
      const deps = fakeDeps({ notice, rebooker: { reschedule } });
      const { result } = await run({}, deps);
      expect(reschedule).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ executed: false, status: 'refused', reason: 'self_serve_notice' });
      expect(deps.reminders.handleReschedule).not.toHaveBeenCalled();
    }
    // A missed visit is being rebooked: its own past start does not refuse it.
    const deps = fakeDeps({ notice: { visitInsideMoveNoticeWindow: () => true }, reschedulePublic: { pageEligibility: jest.fn(async () => ({ ok: true, missed: true })) },
      rebooker: { reschedule: jest.fn(async (...args) => { await args[5].beforeMove(); return {}; }) } });
    expect((await run({}, deps)).result).toMatchObject({ executed: true });
  });

  test('an unexpected error is recorded as failed and never thrown', async () => {
    const deps = fakeDeps({ rebooker: { reschedule: jest.fn(async () => { throw new Error('boom'); }) } });
    const { result, fake } = await run({}, deps);
    expect(result).toEqual({ executed: false, status: 'failed', reason: 'error' });
    expect(fake.writes[fake.writes.length - 1]).toMatchObject({ execution_status: 'failed' });
  });

  test('a decision another executor already took is left alone', async () => {
    const deps = fakeDeps();
    const { result } = await run({}, deps, fakeDb({ claim: false }));
    expect(result).toEqual({ executed: false, reason: 'already_claimed' });
    expect(deps.reschedulePublic.loadById).not.toHaveBeenCalled();
  });

  test('a booking offer is never executed here', async () => {
    const { result, fake } = await run({ offer: { ...OFFER, kind: 'book_new' } });
    expect(result).toEqual({ executed: false, reason: 'missing_input' });
    expect(fake.dbh).not.toHaveBeenCalled();
  });
});
