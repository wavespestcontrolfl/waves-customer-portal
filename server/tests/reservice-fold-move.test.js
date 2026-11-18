/**
 * services/reservice-fold.js moveFoldTarget and the office notice (GATE_RESERVICE_FOLD, owner 2026-11-17).
 * The Dispatch board's staff move is mocked; pinned here: what the fold asks of it (one plan visit only, the office's start
 * and technician, the confirmation choice), what the booking route gets back, that a refusal before any write means "book the
 * re-service as before", that any other error is not swallowed, and what reaches the moved visit.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-dispatch', () => ({
  planVisitMoveForStaff: jest.fn(),
  runPlannedVisitMove: jest.fn(),
}));
// The customer's own move (moveFoldTargetForCustomer): the rebooker, the reschedule page's text and routing helpers, the
// reminder path and the board broadcast are mocked; the lane check and the notice rules are the module's own inputs.
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({
  _internals: {
    moveNoticeArgs: jest.fn(async () => [{ timePromise: 'set_time' }]),
    dayPromiseMoveIntent: jest.fn(() => ({ customerAskedTime: true })),
    bookingPlacesInRoute: jest.fn(() => true),
  },
}));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn(async () => ({})) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => {}) }));
jest.mock('../services/scheduling/self-serve-notice', () => ({
  visitInsideMoveNoticeWindow: jest.fn(() => false),
  violatesSelfServeNotice: jest.fn(() => false),
}));
jest.mock('../services/reservice-scheduler', () => ({
  ...jest.requireActual('../services/reservice-scheduler'),
  openCallbackExistsForLane: jest.fn(async () => false),
}));

const dispatch = require('../routes/admin-dispatch');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const notice = require('../services/scheduling/self-serve-notice');
const { openCallbackExistsForLane } = require('../services/reservice-scheduler');
const { moveFoldTarget, moveFoldTargetForCustomer, foldOfficeNotice, foldLaneForServiceKey, FOLD_DAYS } = require('../services/reservice-fold');

const TARGET = {
  id: 'plan-1', customer_id: 'cust-1', property_id: null, service_id: 'svc-pest', is_callback: false,
  scheduled_date: '2099-11-29', status: 'pending', service_type: 'Quarterly Pest Control Service', customer_request: null, notes: 'Dog in yard',
};
const ACTOR = { techRole: 'admin', technicianId: 'staff-1' };
const PLAN = { plan: { rescheduleOptions: {} } };

let update;
let conn;
let query;
beforeEach(() => {
  jest.clearAllMocks();
  update = jest.fn().mockResolvedValue(1);
  // Only the office-words copy writes; there is no other read or write on the connection.
  query = { update };
  query.where = jest.fn(() => query);
  query.whereRaw = jest.fn(() => query);
  conn = jest.fn(() => query);
  conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  dispatch.planVisitMoveForStaff.mockResolvedValue(PLAN);
  dispatch.runPlannedVisitMove.mockResolvedValue({ status: 200, body: { notificationSent: true, warnings: ['Overlaps another visit.'] } });
});

const run = (extra = {}) => moveFoldTarget({
  conn, target: TARGET, date: '2099-11-17', windowStart: '10:00', technicianId: 'tech-9', notifyCustomer: true, actor: ACTOR,
  customerRequest: { text: 'Ants in the kitchen', source: 'call' }, notes: 'Ants in the kitchen', ...extra,
});

test('asks the staff move for this one visit: the office start, technician and text choice, no series', async () => {
  await run();
  expect(dispatch.planVisitMoveForStaff).toHaveBeenCalledWith({
    serviceId: 'plan-1', newDate: '2099-11-17', newWindow: { start: '10:00' }, notifyCustomer: true,
    body: { technicianId: 'tech-9' }, actor: ACTOR, sourceSurface: 'office_booking', seriesPolicy: 'single',
    // The lookup's picture of the visit is the rebooker's write fence (its customer, premise, service, plan kind, day and
    // status; still alone and not in a Quick Move hand-off), and a live visit is never moved.
    allowLive: false,
    expect: {
      customer_id: 'cust-1', property_id: null, service_id: 'svc-pest', service_type: 'Quarterly Pest Control Service',
      is_recurring: true, is_callback: false, scheduled_date: '2099-11-29', status: 'pending', visit_id: null, customer_pick_by: null,
    },
  });
  expect(dispatch.runPlannedVisitMove).toHaveBeenCalledWith(expect.objectContaining({
    plan: PLAN.plan, serviceId: 'plan-1', newDate: '2099-11-17', reasonCode: 'admin', notifyCustomer: true, actor: ACTOR,
    reasonText: expect.stringContaining('Re-service'),
  }));
});

test('no start and no technician chosen: the move sends neither, so the plan visit keeps its technician', async () => {
  await run({ windowStart: null, technicianId: undefined, notifyCustomer: false });
  expect(dispatch.planVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({ newWindow: null, body: {}, notifyCustomer: false }));
});

test('the office chose Unassigned: the move carries technicianId null, so the planner unassigns the moved visit', async () => {
  await run({ technicianId: null });
  expect(dispatch.planVisitMoveForStaff.mock.calls[0][0].body).toEqual({ technicianId: null });
});

test('a moved visit answers 200 with nothing created, the notice first and the move warnings after', async () => {
  const out = await run();
  expect(out.moved).toBe(true);
  expect(out.answer).toEqual({
    id: 'plan-1', recurringCreated: 0, appointments: [],
    warnings: [foldOfficeNotice(TARGET, '2099-11-17', '10:00'), 'Overlaps another visit.'],
    reserviceFold: { movedServiceId: 'plan-1', serviceType: TARGET.service_type, fromDate: '2099-11-29', toDate: '2099-11-17', start: '10:00', notificationSent: true },
  });
});

test('the office asked for the "visit moved" text and it did not go: the answer says so, with the reason', async () => {
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 200, body: { notificationSent: false, notificationError: 'No mobile number on file' } });
  const out = await run();
  expect(out.answer.warnings).toContain('The customer was not texted about the move: No mobile number on file.');
  expect(out.answer.reserviceFold.notificationSent).toBe(false);
  // No reason given: the plain fallback.
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 200, body: { notificationSent: false } });
  expect((await run()).answer.warnings).toContain('The customer was not texted about the move: the text could not be sent.');
});

test('no text line when the office chose no text, or the visit already sat on the slot', async () => {
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 200, body: {} });
  expect((await run({ notifyCustomer: false })).answer.warnings.join(' ')).not.toContain('not texted');
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 200, body: { notificationSent: false, notificationSkipped: 'already_at_target' } });
  expect((await run()).answer.warnings.join(' ')).not.toContain('not texted');
});

test('the notice is plain English of about 25 words and names the real visit and date', () => {
  const notice = foldOfficeNotice(TARGET, '2099-11-17', '10:00');
  expect(notice).toBe('No re-service booked: the Quarterly Pest Control Service on Sun, Nov 29 moved up to this time (within 14 days of the next plan visit).');
  expect(notice.split(/\s+/).length).toBeLessThanOrEqual(25);
  expect(FOLD_DAYS).toBe(14);
});

test('with no start asked the notice names the new day, not "this time"', () => {
  expect(foldOfficeNotice(TARGET, '2099-11-17', null))
    .toBe('No re-service booked: the Quarterly Pest Control Service on Sun, Nov 29 moved up to Tue, Nov 17 (within 14 days of the next plan visit).');
});

test("the customer's asked-for time reaches the planner only when it is exactly true", async () => {
  await run({ customerAskedTime: true });
  expect(dispatch.planVisitMoveForStaff.mock.calls[0][0].body).toEqual({ technicianId: 'tech-9', customerAskedTime: true });
  dispatch.planVisitMoveForStaff.mockClear();
  await run({ customerAskedTime: 'yes' });
  await run({ customerAskedTime: undefined, technicianId: undefined });
  expect(dispatch.planVisitMoveForStaff.mock.calls[0][0].body).toEqual({ technicianId: 'tech-9' });
  expect(dispatch.planVisitMoveForStaff.mock.calls[1][0].body).toEqual({});
});

const NOTES_LINE = (text) => ({ sql: "concat_ws(E'\\n', nullif(notes, ''), ?::text)", bindings: [`[Re-service folded in, Tue, Nov 17] ${text}`] });

test("a visit with no words takes the customer's words as its request; the notes are appended in SQL, not rewritten", async () => {
  await run();
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[0][0]).toEqual({ customer_request: 'Ants in the kitchen', customer_request_source: 'call' });
  expect(update.mock.calls[1][0]).toEqual({ notes: NOTES_LINE('Ants in the kitchen') });
});

test('a visit that already has words (or got them meanwhile) keeps them; the new words go into the notes line with their source', async () => {
  update.mockResolvedValueOnce(0);
  await run();
  expect(update.mock.calls[0][0]).toEqual({ customer_request: 'Ants in the kitchen', customer_request_source: 'call' });
  expect(update.mock.calls[1][0]).toEqual({
    notes: NOTES_LINE("Customer's words (call): Ants in the kitchen. Ants in the kitchen"),
  });
});

test('the fill also matches a visit that already holds these very words (a double tap never copies them into the notes)', async () => {
  await run();
  const guard = query.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
  const seen = [];
  const q = { whereNull: (c) => { seen.push(['null', c]); return q; }, orWhere: (c, v) => { seen.push(['or', c, v]); return q; } };
  guard(q);
  expect(seen).toEqual([['null', 'customer_request'], ['or', 'customer_request', ''], ['or', 'customer_request', 'Ants in the kitchen']]);
  // No words (notes only): the equality match is not added.
  query.where.mockClear();
  await run({ customerRequest: null });
  expect(query.where.mock.calls.some(([arg]) => typeof arg === 'function')).toBe(false);
});

test('words with no office notes: filled once and no notes write; no words and no notes: no write at all', async () => {
  await run({ notes: null });
  expect(update).toHaveBeenCalledTimes(1);
  update.mockClear();
  await run({ customerRequest: null, notes: null });
  expect(update).not.toHaveBeenCalled();
  await run({ customerRequest: null });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0]).toEqual({ notes: NOTES_LINE('Ants in the kitchen') });
});

test("the office's internal notes join the visit's own internal notes in SQL, in the same write as the notes", async () => {
  const INTERNAL_LINE = { sql: "concat_ws(E'\\n', nullif(internal_notes, ''), ?::text)", bindings: ['[Re-service folded in, Tue, Nov 17] Ring the office first'] };
  await run({ internalNotes: 'Ring the office first' });
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[1][0]).toEqual({ notes: NOTES_LINE('Ants in the kitchen'), internal_notes: INTERNAL_LINE });
  update.mockClear();
  // Internal notes alone: one write of that column only.
  await run({ customerRequest: null, notes: null, internalNotes: 'Ring the office first' });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0]).toEqual({ internal_notes: INTERNAL_LINE });
});

test('a failed copy of the words does not undo the move: the answer says to add them by hand', async () => {
  update.mockRejectedValue(Object.assign(new Error('insert into "scheduled_services" ... Ants in the kitchen'), { code: '22001' }));
  const out = await run();
  expect(out.moved).toBe(true);
  expect(out.answer.warnings[out.answer.warnings.length - 1]).toMatch(/did not copy/);
  // The log names the visit and the error code, never the database message (it carries the customer's words).
  const logger = require('../services/logger');
  expect(logger.error).toHaveBeenCalledWith('[reservice-fold] moved plan-1 but could not copy the office words (code 22001)');
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Ants in the kitchen');
});

test('the planner refuses: nothing moves and the caller books the re-service with the reason', async () => {
  dispatch.planVisitMoveForStaff.mockResolvedValue({ status: 409, body: { error: 'That time is taken.' } });
  const out = await run();
  expect(out.moved).toBe(false);
  expect(out.warning).toMatch(/booked as its own visit.*Sun, Nov 29.*That time is taken\./);
  expect(dispatch.runPlannedVisitMove).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test('the planner throws a refusal (no stored duration, past midnight): the caller books the re-service with the reason', async () => {
  dispatch.planVisitMoveForStaff.mockRejectedValueOnce(Object.assign(
    new Error('This visit has no stored duration — supply an explicit end time (HH:MM) with the new start'),
    { status: 422, statusCode: 422, isOperational: true },
  ));
  const out = await run();
  expect(out.moved).toBe(false);
  expect(out.warning).toContain('no stored duration');
  dispatch.planVisitMoveForStaff.mockRejectedValueOnce(Object.assign(
    new Error("That start time would run past midnight for this visit's duration — pick an earlier hour"),
    { statusCode: 409, isOperational: true, code: 'WINDOW_CROSSES_MIDNIGHT' },
  ));
  expect((await run()).warning).toContain('past midnight');
  expect(dispatch.runPlannedVisitMove).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test('a thrown 4xx from the move refused before the rebooker wrote: the caller books the re-service, nothing is copied', async () => {
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('Visit changed.'), { statusCode: 409 }));
  const out = await run();
  expect(out).toMatchObject({ moved: false });
  expect(out.warning).toContain('Visit changed.');
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('Area limit reached.'), { status: 422 }));
  expect((await run()).warning).toContain('Area limit reached.');
  expect(update).not.toHaveBeenCalled();
});

test('a refusal is never read as a fold, even for a plan visit already on the re-service day with no start asked', async () => {
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('Cannot reschedule a en_route job'), { statusCode: 409 }));
  const out = await run({ target: { ...TARGET, scheduled_date: '2099-11-17' }, windowStart: null });
  expect(out.moved).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

test('an answer of 300 or more came after the rebooker wrote: the fold stands and the office is told to check the visit', async () => {
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 500, body: { error: 'Late.' } });
  const out = await run();
  expect(out.moved).toBe(true);
  expect(out.answer.id).toBe('plan-1');
  expect(out.answer.warnings).toContain('The move reported an error after it saved (Late.). Check the visit.');
  expect(out.answer.warnings).toContain('The customer was not texted about the move: the text could not be sent.');
  expect(update).toHaveBeenCalledTimes(2);
});

test('any other error, from the plan or the move, is not swallowed', async () => {
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(new Error('boom'));
  await expect(run()).rejects.toThrow('boom');
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('db down'), { statusCode: 500 }));
  await expect(run()).rejects.toThrow('db down');
  dispatch.planVisitMoveForStaff.mockRejectedValueOnce(new Error('pool closed'));
  await expect(run()).rejects.toThrow('pool closed');
});

test('only the pest and lawn re-service keys fold; a rodent follow-up never does', () => {
  expect(foldLaneForServiceKey('pest_re_service')).toBe('pest');
  expect(foldLaneForServiceKey('lawn_re_service')).toBe('lawn');
  expect(foldLaneForServiceKey('rodent_trapping_followup')).toBeNull();
  expect(foldLaneForServiceKey('pest_control_quarterly')).toBeNull();
  expect(foldLaneForServiceKey(undefined)).toBeNull();
});

// ── The customer's own pick on the /reservice link (GATE_RESERVICE_FOLD_LINK) ─────────────────────────────────────────────
describe('moveFoldTargetForCustomer', () => {
  const FULL = {
    id: 'plan-1', customer_id: 'cust-1', property_id: null, service_id: 'svc-1', is_callback: false,
    scheduled_date: '2099-11-29', window_start: '13:00:00', window_end: '14:00:00', technician_id: 'tech-2',
    service_type: 'Quarterly Pest Control Service', status: 'confirmed',
  };
  const SLOT = { start_time: '09:00', end_time: '11:00', technician_id: 'tech-1' };
  const SVC = { id: 'plan-1' };
  const customerRun = (extra = {}) => moveFoldTargetForCustomer({
    conn, target: FULL, svc: SVC, elig: { ok: true }, lane: 'pest', date: '2099-11-17', slot: SLOT,
    customerRequest: { text: 'Ants', source: 'picker', pests: ['ants'], pestLabels: ['Ants'] }, ...extra,
  });
  beforeEach(() => { SmartRebooker.reschedule.mockResolvedValue({}); });

  test('moves ONE visit as the customer: the picker slot, its technician, the fold fence, and none of the staff options', async () => {
    const out = await customerRun();
    expect(out).toEqual({ moved: true });
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    const [id, date, window, reason, initiator, options] = SmartRebooker.reschedule.mock.calls[0];
    expect([id, date, window, reason, initiator]).toEqual(['plan-1', '2099-11-17', { start: '09:00', end: '11:00' }, 'reservice_fold', 'customer']);
    expect(options).toEqual({
      technicianId: 'tech-1', seriesPolicy: 'single', travelGap: true, capacityPlacement: true, placeInRoute: true,
      customerAskedTime: true,
      expect: {
        customer_id: 'cust-1', property_id: null, service_id: 'svc-1', service_type: FULL.service_type, is_recurring: true, is_callback: false,
        scheduled_date: '2099-11-29', status: 'confirmed', visit_id: null, customer_pick_by: null,
        window_start: '13:00:00', technician_id: 'tech-2',
      },
      beforeMove: expect.any(Function),
    });
    for (const staffOption of ['allowLive', 'overlapAdvisory', 'adminWindowRules', 'roadSpender']) expect(options).not.toHaveProperty(staffOption);
    // reason_code is varchar(30) and initiated_by varchar(20) on reschedule_log.
    expect(reason.length).toBeLessThanOrEqual(30);
    expect(initiator.length).toBeLessThanOrEqual(20);
  });

  test('after the commit: the words and pests are carried once, exactly one reschedule text goes out, the board is told', async () => {
    await customerRun();
    expect(update.mock.calls[0][0]).toEqual({ customer_request: 'Ants', customer_request_source: 'picker', customer_request_pests: '["ants"]' });
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('plan-1', '2099-11-17T09:00', { timePromise: 'set_time' });
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: 'plan-1', actorId: null });
  });

  test('a visit that already has words keeps them; the new words and pests go into the notes line', async () => {
    update.mockResolvedValueOnce(0);
    await customerRun();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].notes.bindings[0]).toBe("[Re-service folded in, Tue, Nov 17] Customer's words (picker): Ants. Pests: Ants.");
  });

  test('a 4xx refusal wrote nothing: moved false, and nothing is carried, texted or broadcast', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('That time is no longer open.'), { statusCode: 409, code: 'SLOT_TAKEN' }));
    expect(await customerRun()).toEqual({ moved: false, why: 'That time is no longer open.' });
    expect(update).not.toHaveBeenCalled();
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  test('any other error is not swallowed', async () => {
    SmartRebooker.reschedule.mockRejectedValue(new Error('boom'));
    await expect(customerRun()).rejects.toThrow('boom');
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
  });

  test('a failure in the words, the text or the broadcast never undoes the move', async () => {
    update.mockRejectedValue(Object.assign(new Error('bindings: Ants'), { code: '23505' }));
    AppointmentReminders.handleReschedule.mockRejectedValueOnce(new Error('twilio down'));
    emitDispatchJobUpdate.mockRejectedValueOnce(new Error('socket'));
    expect(await customerRun()).toEqual({ moved: true });
    // The log names the visit and the error code, never the message (it can carry the customer's words).
    const logged = require('../services/logger').error.mock.calls.map(([m]) => m).join(' ');
    expect(logged).toContain('code 23505');
    expect(logged).not.toContain('bindings');
  });

  describe('beforeMove (inside the rebooker\'s locks)', () => {
    const guard = async ({ trx = { raw: jest.fn(async () => ({})) }, ...extra } = {}) => {
      await customerRun(extra);
      const { beforeMove } = SmartRebooker.reschedule.mock.calls.at(-1)[5];
      await beforeMove(trx);
      return trx;
    };

    test('takes the same reservice-lane lock createSelfBooking takes, then passes when nothing is open', async () => {
      const trx = await guard();
      expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['reservice-lane', 'cust-1:pest_re_service']);
      expect(openCallbackExistsForLane).toHaveBeenCalledWith(trx, 'cust-1', 'pest');
    });

    test('refuses with an open re-service on the lane (ALREADY_BOOKED, a 4xx: the caller books/replays)', async () => {
      openCallbackExistsForLane.mockResolvedValueOnce(true);
      await expect(guard()).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_BOOKED' });
    });

    test('refuses a plan visit inside the move notice (unless the visit is a missed one) and a slot inside the booking notice', async () => {
      notice.visitInsideMoveNoticeWindow.mockReturnValueOnce(true);
      await expect(guard()).rejects.toMatchObject({ statusCode: 409, code: 'SELF_SERVE_NOTICE' });
      notice.visitInsideMoveNoticeWindow.mockReturnValueOnce(true);
      await expect(guard({ elig: { ok: true, missed: true } })).resolves.toBeDefined();
      notice.violatesSelfServeNotice.mockReturnValueOnce(true);
      await expect(guard()).rejects.toMatchObject({ statusCode: 409, code: 'SELF_SERVE_NOTICE' });
      expect(notice.violatesSelfServeNotice).toHaveBeenLastCalledWith({ date: '2099-11-17', startTime: '09:00' });
    });
  });
});
