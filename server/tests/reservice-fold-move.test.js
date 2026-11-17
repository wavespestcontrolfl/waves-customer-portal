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

const dispatch = require('../routes/admin-dispatch');
const { moveFoldTarget, foldOfficeNotice, foldLaneForServiceKey, FOLD_DAYS } = require('../services/reservice-fold');

const TARGET = { id: 'plan-1', scheduled_date: '2099-11-29', status: 'pending', service_type: 'Quarterly Pest Control Service', customer_request: null, notes: 'Dog in yard' };
const ACTOR = { techRole: 'admin', technicianId: 'staff-1' };
const PLAN = { plan: { rescheduleOptions: {} } };

let update;
let first;
let conn;
beforeEach(() => {
  jest.clearAllMocks();
  update = jest.fn().mockResolvedValue(1);
  // The re-read after a refused move: by default the visit is still where it was.
  first = jest.fn().mockResolvedValue({ scheduled_date: new Date('2099-11-29T04:00:00Z'), window_start: '09:00:00', status: 'pending' });
  const query = { update, first };
  query.where = jest.fn(() => query);
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
    // The lookup's picture of the visit is the rebooker's write fence, and a live visit is never moved.
    allowLive: false,
    expect: { scheduled_date: '2099-11-29', status: 'pending', visit_id: null, customer_pick_by: null },
  });
  expect(dispatch.runPlannedVisitMove).toHaveBeenCalledWith(expect.objectContaining({
    plan: PLAN.plan, serviceId: 'plan-1', newDate: '2099-11-17', reasonCode: 'admin', notifyCustomer: true, actor: ACTOR,
    reasonText: expect.stringContaining('Re-service'),
  }));
});

test('no start and no technician chosen: the move sends neither', async () => {
  await run({ windowStart: null, technicianId: null, notifyCustomer: false });
  expect(dispatch.planVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({ newWindow: null, body: {}, notifyCustomer: false }));
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
  await run({ customerAskedTime: undefined, technicianId: null });
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

test('a failed copy of the words does not undo the move: the answer says to add them by hand', async () => {
  update.mockRejectedValue(new Error('db down'));
  const out = await run();
  expect(out.moved).toBe(true);
  expect(out.answer.warnings[out.answer.warnings.length - 1]).toMatch(/did not copy/);
});

test('the planner refuses: nothing moves and the caller books the re-service with the reason', async () => {
  dispatch.planVisitMoveForStaff.mockResolvedValue({ status: 409, body: { error: 'That time is taken.' } });
  const out = await run();
  expect(out.moved).toBe(false);
  expect(out.warning).toMatch(/booked as its own visit.*Sun, Nov 29.*That time is taken\./);
  expect(dispatch.runPlannedVisitMove).not.toHaveBeenCalled();
  expect(first).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test('a 409 from the rebooker: the visit did not move, so the caller books the re-service with the reason', async () => {
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('Visit changed.'), { statusCode: 409 }));
  const out = await run();
  expect(out).toMatchObject({ moved: false });
  expect(out.warning).toContain('Visit changed.');
  expect(first).toHaveBeenCalledTimes(1);
});

test('a status of 300 or more from the move is read the same way', async () => {
  dispatch.runPlannedVisitMove.mockResolvedValue({ status: 422, body: { error: 'Nope.' } });
  const out = await run();
  expect(out.moved).toBe(false);
  expect(out.warning).toContain('Nope.');
  expect(first).toHaveBeenCalledTimes(1);
});

test('an error after the move saved: the visit is on the asked slot, so it answers as a fold and says to check the visit', async () => {
  first.mockResolvedValue({ scheduled_date: '2099-11-17', window_start: '10:00:00', status: 'confirmed' });
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('Visit changed.'), { statusCode: 409 }));
  const out = await run();
  expect(out.moved).toBe(true);
  expect(out.answer.id).toBe('plan-1');
  expect(out.answer.warnings).toContain('The move reported an error after it saved (Visit changed.). Check the visit.');
  expect(update).toHaveBeenCalledTimes(2);
  // ...and the same for a 300+ answer; with no start asked, the date alone decides.
  first.mockResolvedValue({ scheduled_date: '2099-11-17', window_start: '09:00:00', status: 'pending' });
  dispatch.runPlannedVisitMove.mockResolvedValueOnce({ status: 500, body: { error: 'Late.' } });
  const again = await run({ windowStart: null });
  expect(again.moved).toBe(true);
  expect(again.answer.warnings.join(' ')).toContain('(Late.)');
});

test('the re-read does not count a visit on the date at another start, or one that was cancelled', async () => {
  dispatch.runPlannedVisitMove.mockResolvedValue({ status: 500, body: { error: 'Late.' } });
  first.mockResolvedValue({ scheduled_date: '2099-11-17', window_start: '09:00:00', status: 'pending' });
  expect((await run()).moved).toBe(false);
  first.mockResolvedValue({ scheduled_date: '2099-11-17', window_start: '10:00:00', status: 'cancelled' });
  expect((await run()).moved).toBe(false);
});

test('any other error is not swallowed', async () => {
  dispatch.runPlannedVisitMove.mockRejectedValueOnce(new Error('boom'));
  await expect(run()).rejects.toThrow('boom');
});

test('only the pest and lawn re-service keys fold; a rodent follow-up never does', () => {
  expect(foldLaneForServiceKey('pest_re_service')).toBe('pest');
  expect(foldLaneForServiceKey('lawn_re_service')).toBe('lawn');
  expect(foldLaneForServiceKey('rodent_trapping_followup')).toBeNull();
  expect(foldLaneForServiceKey('pest_control_quarterly')).toBeNull();
  expect(foldLaneForServiceKey(undefined)).toBeNull();
});
