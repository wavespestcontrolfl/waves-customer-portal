/**
 * Intelligence Bar plan move (gap #22, GATE_IB_SERIES_MOVE): the card is the rebooker's own preview, and
 * Confirm runs the Dispatch board's staff move bound to that card. Synthetic ids and dates only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockPreviewSeriesMove = jest.fn();
jest.mock('../services/rebooker', () => ({
  previewSeriesMove: (...a) => mockPreviewSeriesMove(...a),
  needsLifecycleRewind: (row) => row.track_state === 'stale',
}));
const mockHasLivePackageChild = jest.fn(async () => false);
jest.mock('../services/package-followup-booking', () => ({ hasLivePackageChild: (...a) => mockHasLivePackageChild(...a) }));
const mockPlanCallFollowUpShift = jest.fn(async () => []);
jest.mock('../services/call-booking-catalog', () => ({ planCallFollowUpShift: (...a) => mockPlanCallFollowUpShift(...a) }));
const mockPlanVisitMoveForStaff = jest.fn();
const mockRunPlannedVisitMove = jest.fn();
jest.mock('../routes/admin-dispatch', () => ({
  planVisitMoveForStaff: (...a) => mockPlanVisitMoveForStaff(...a),
  runPlannedVisitMove: (...a) => mockRunPlannedVisitMove(...a),
}));

const db = require('../models/db');
const SeriesMove = require('../services/intelligence-bar/series-move');

const ANCHOR = 'svc-a';
const occ = (id, from, to, extra = {}) => ({
  id, from_date: from, status: 'confirmed', customer_confirmed: null, from_start: '09:00:00', from_end: '10:00:00',
  duration: 60, property_id: null, date_exception: false, cadence_date: null, to_date: to, to_start: '09:00:00', to_end: '10:00:00', ...extra,
});
const PREVIEW = {
  collective: true,
  occurrenceIds: ['svc-a', 'svc-b', 'svc-c'],
  occurrences: [occ('svc-a', '2099-03-02', '2099-03-04'), occ('svc-b', '2099-06-01', '2099-06-03'), occ('svc-c', '2099-08-31', '2099-09-02')],
  skippedCount: 0,
  conflicts: [],
  conflictSnapshot: [],
};
const rowsFor = (ids, extra = {}) => ids.map((id) => ({ id, visit_id: null, ...extra[id] }));

function wireRows(rows) {
  db.mockImplementation(() => ({ whereIn: () => ({ select: async () => rows }) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreviewSeriesMove.mockResolvedValue(PREVIEW);
  wireRows(rowsFor(PREVIEW.occurrenceIds));
});

describe('planSeriesMove: the card is the rebooker preview', () => {
  test('previews with the staff move options and keeps every visit\'s disclosed move', async () => {
    const out = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: { start: '09:00', end: '10:00' } });
    expect(mockPreviewSeriesMove).toHaveBeenCalledWith(ANCHOR, '2099-03-04', { start: '09:00', end: '10:00' }, { adminWindowRules: true, overlapAdvisory: true });
    expect(out.plan.occurrence_ids).toEqual(['svc-a', 'svc-b', 'svc-c']);
    expect(out.plan.occurrences).toBe(PREVIEW.occurrences);
    expect(out.plan.window).toEqual({ start: '09:00', end: '10:00' });
  });

  test('a date-only move previews with no anchor window', async () => {
    const out = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    expect(mockPreviewSeriesMove.mock.calls[0][2]).toEqual({});
    expect(out.plan.window).toBeNull();
  });

  test('a visit that shares a stop is refused up front (never carried undisclosed)', async () => {
    wireRows(rowsFor(PREVIEW.occurrenceIds, { 'svc-c': { visit_id: 'visit-9' } }));
    const out = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    expect(out.refusal.code).toBe('grouped_visit_move_unsupported');
  });

  test('a linked package visit 2 or a call-booked follow-up is refused', async () => {
    mockHasLivePackageChild.mockResolvedValueOnce(true);
    expect((await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null })).refusal.code).toBe('package_visit_two_linked');
    mockPlanCallFollowUpShift.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'child-1' }]);
    const out = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    expect(out.refusal.code).toBe('linked_follow_up_move_unsupported');
    expect(mockPlanCallFollowUpShift).toHaveBeenCalledWith(expect.objectContaining({ parentServiceId: 'svc-b', fromDate: '2099-06-01', toDate: '2099-06-03' }));
  });

  test('a landing window the admin rules refuse stops the card with the rule\'s words', async () => {
    mockPreviewSeriesMove.mockRejectedValueOnce(Object.assign(new Error('Appointments must start at 8:00 AM or later.'), { status: 422 }));
    const out = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    expect(out.refusal.error).toMatch(/8:00 AM or later\. Nothing was proposed\./);
  });

  test('a preview that is not a plan move refuses; a real fault rethrows', async () => {
    mockPreviewSeriesMove.mockResolvedValueOnce({ collective: false });
    expect((await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null })).refusal.error).toMatch(/could not be read/);
    mockPreviewSeriesMove.mockRejectedValueOnce(new Error('connection reset'));
    await expect(SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null })).rejects.toThrow('connection reset');
  });

  test('stale tracker state on a later visit and overlap dates ride the plan', async () => {
    mockPreviewSeriesMove.mockResolvedValueOnce({ ...PREVIEW, skippedCount: 1, conflicts: [{ occurrenceId: 'svc-b', date: '2099-06-03' }] });
    wireRows(rowsFor(PREVIEW.occurrenceIds, { 'svc-a': { track_state: 'stale' }, 'svc-c': { track_state: 'stale' } }));
    const { plan } = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    expect(plan.rewound_ids).toEqual(['svc-c']);
    expect(plan.conflict_dates).toEqual(['2099-06-03']);
    expect(plan.skipped_count).toBe(1);
  });
});

describe('seriesCardLines', () => {
  test('one line per visit with its old and new slot, plus the plan facts', async () => {
    const { plan } = await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window: null });
    const lines = SeriesMove.seriesCardLines({ ...plan, skipped_count: 1, conflict_dates: ['2099-06-03'], rewound_ids: ['svc-c'] }, { reason: 'customer asked' });
    const text = lines.map((l) => l.text);
    expect(text[0]).toBe('Recurring plan: 2 later visits move with this one (through 2099-09-02), as on the Dispatch board');
    expect(lines[1]).toEqual({ text: 'Visit 2099-03-02 09:00-10:00 → 2099-03-04 09:00-10:00', before: '2099-03-02 09:00-10:00', after: '2099-03-04 09:00-10:00' });
    expect(text).toContain('Visit 2099-08-31 09:00-10:00 → 2099-09-02 09:00-10:00');
    expect(text.join('\n')).toMatch(/1 visit in progress or skipped stays on its date/);
    expect(text.join('\n')).toMatch(/booked window on 2099-06-03/);
    expect(text.join('\n')).toMatch(/stale tracker state on 1 later visit/);
    expect(text.join('\n')).toMatch(/No customer text is sent/);
    expect(text.join('\n')).toMatch(/reason is kept on this bar action only/);
  });

  test('the last visit of a plan says nothing else moves', () => {
    const lines = SeriesMove.seriesCardLines({ occurrences: [occ('svc-a', '2099-03-02', '2099-03-04')] });
    expect(lines[0].text).toMatch(/last visit in the plan/);
  });
});

describe('runSeriesMove: Confirm runs the board move bound to the card', () => {
  const appt = { id: ANCHOR, scheduled_date: '2099-03-02', service_type: 'Quarterly Pest Control Service' };
  const admin = { isAdmin: true, technicianId: 'tech-1' };
  async function approvedPlan(window = null) {
    return (await SeriesMove.planSeriesMove({ appointmentId: ANCHOR, newDate: '2099-03-04', window })).plan;
  }

  test('happy path: board ack on the card\'s set, every disclosed slot bound, no customer text', async () => {
    const plan = await approvedPlan({ start: '09:00', end: '10:00' });
    const rescheduleOptions = { allowLive: true };
    mockPlanVisitMoveForStaff.mockResolvedValue({ plan: { rescheduleOptions, effectiveWindow: { start: '09:00', end: '10:00' } } });
    mockRunPlannedVisitMove.mockResolvedValue({ status: 200, body: { success: true, seriesMoveId: 'sm-1', occurrencesRescheduled: 3, warnings: ['2099-06-03 overlaps another appointment.'] } });
    const out = await SeriesMove.runSeriesMove({
      input: { appointment_id: ANCHOR, new_date: '2099-03-04', reason: 'customer asked', _series_move: plan },
      actionContext: admin, appt, dateStr: '2099-03-04', window: { start: '09:00', end: '10:00' }, customerName: 'Pat Example',
    });
    expect(mockPlanVisitMoveForStaff).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: ANCHOR, newDate: '2099-03-04', newWindow: { start: '09:00', end: '10:00' }, notifyCustomer: false,
      body: { seriesAck: true, seriesAckIds: ['svc-a', 'svc-b', 'svc-c'] },
      actor: { techRole: 'admin', technicianId: 'tech-1' }, sourceSurface: 'intelligence_bar',
    }));
    expect(rescheduleOptions.expectOccurrences).toBe(plan.occurrences);
    expect(rescheduleOptions.expectConflictSnapshot).toBe(plan.conflict_snapshot);
    expect(typeof rescheduleOptions.moveGuard).toBe('function');
    expect(rescheduleOptions.carryVisit).toBe(false);
    expect(mockRunPlannedVisitMove).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false, reasonCode: 'admin', serviceId: ANCHOR }));
    expect(out).toMatchObject({ success: true, plan_move: true, visits_moved: 3, customer_name: 'Pat Example', warning: '2099-06-03 overlaps another appointment.' });
  });

  test('a non-admin is refused before anything is read', async () => {
    const out = await SeriesMove.runSeriesMove({ input: { _series_move: await approvedPlan() }, actionContext: { isAdmin: false }, appt, dateStr: '2099-03-04', window: null });
    expect(out.code).toBe('permission_denied');
    expect(mockPlanVisitMoveForStaff).not.toHaveBeenCalled();
  });

  test('no card plan, or a plan that changed since the card, moves nothing', async () => {
    const noPin = await SeriesMove.runSeriesMove({ input: {}, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(noPin.preview_changed).toBe(true);
    const plan = await approvedPlan();
    mockPreviewSeriesMove.mockResolvedValueOnce({ ...PREVIEW, occurrences: [PREVIEW.occurrences[0], PREVIEW.occurrences[1], occ('svc-c', '2099-08-31', '2099-09-03')] });
    const drift = await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(drift.preview_changed).toBe(true);
    expect(mockPlanVisitMoveForStaff).not.toHaveBeenCalled();
  });

  test('the overlaps the card counted ride the plan and bind the commit', async () => {
    const snapshot = [{ target_id: 'svc-b', target_date: '2099-06-03', conflict_id: 'other-1', conflict_date: '2099-06-03' }];
    mockPreviewSeriesMove.mockResolvedValueOnce({ ...PREVIEW, conflictSnapshot: snapshot, conflicts: [{ occurrenceId: 'svc-b', date: '2099-06-03' }] });
    const plan = await approvedPlan();
    expect(plan.conflict_snapshot).toBe(snapshot);
    // A plan pin from before this field existed is not a card this commit can bind: refused.
    const { conflict_snapshot: _gone, ...oldPin } = plan;
    const out = await SeriesMove.runSeriesMove({ input: { _series_move: oldPin }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(out.preview_changed).toBe(true);
  });

  test('the move guard locks the plan rows, then refuses a linked visit added since the card', async () => {
    const plan = await approvedPlan();
    const rescheduleOptions = {};
    mockPlanVisitMoveForStaff.mockResolvedValue({ plan: { rescheduleOptions } });
    mockRunPlannedVisitMove.mockResolvedValue({ status: 200, body: { success: true, occurrencesRescheduled: 3 } });
    await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    const calls = [];
    const trx = jest.fn((table) => {
      const q = { whereIn: (...a) => { calls.push(['whereIn', table, ...a]); return q; }, orderBy: () => q, forUpdate: () => { calls.push(['forUpdate']); return q; }, select: async () => [] };
      return q;
    });
    await expect(rescheduleOptions.moveGuard({ trx })).resolves.toBeUndefined();
    expect(calls).toEqual([['whereIn', 'scheduled_services', 'id', ['svc-a', 'svc-b', 'svc-c']], ['forUpdate']]);
    expect(mockHasLivePackageChild).toHaveBeenLastCalledWith(trx, ['svc-a', 'svc-b', 'svc-c']);
    mockPlanCallFollowUpShift.mockResolvedValueOnce([{ id: 'child-1' }]);
    const err = await rescheduleOptions.moveGuard({ trx }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'linked_follow_up_move_unsupported' });
    expect(err.message).toMatch(/Nothing was moved\.$/);
    expect(SeriesMove._test.refusalFromThrown(err)).toEqual({ error: err.message, code: 'linked_follow_up_move_unsupported' });
  });

  test('a new overlap since the card is drift too', async () => {
    const plan = await approvedPlan();
    mockPreviewSeriesMove.mockResolvedValueOnce({ ...PREVIEW, conflicts: [{ occurrenceId: 'svc-b', date: '2099-06-03' }] });
    const out = await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(out.preview_changed).toBe(true);
  });

  test('the board refusing the ack, or the locked sweep differing, is preview_changed', async () => {
    const plan = await approvedPlan();
    mockPlanVisitMoveForStaff.mockResolvedValueOnce({ status: 409, body: { code: 'COLLECTIVE_MOVE_ACK_REQUIRED', error: 'plan changed' } });
    expect((await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null })).preview_changed).toBe(true);
    mockPlanVisitMoveForStaff.mockResolvedValueOnce({ plan: { rescheduleOptions: {} } });
    mockRunPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('The recurring dates or windows changed. Refresh the proposal.'), { statusCode: 409, code: 'SERIES_CHANGED' }));
    const out = await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(out.preview_changed).toBe(true);
  });

  test('a grouped stop found under the locks is a coded refusal; a 5xx rethrows', async () => {
    const plan = await approvedPlan();
    mockPlanVisitMoveForStaff.mockResolvedValue({ plan: { rescheduleOptions: {} } });
    mockRunPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('This series includes a service grouped with another at the same stop.'), { statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' }));
    const out = await SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null });
    expect(out.code).toBe('grouped_visit_move_unsupported');
    mockRunPlannedVisitMove.mockRejectedValueOnce(Object.assign(new Error('db down'), { statusCode: 500 }));
    await expect(SeriesMove.runSeriesMove({ input: { _series_move: plan }, actionContext: admin, appt, dateStr: '2099-03-04', window: null })).rejects.toThrow('db down');
  });
});

describe('moveWarning', () => {
  const { moveWarning } = SeriesMove._test;
  test('untimed landings and unfinished effects are named; a clean move has none', () => {
    expect(moveWarning({})).toBeNull();
    expect(moveWarning({ unassignedConflicts: [{ id: 'x', date: '2099-06-03' }] })).toMatch(/1 later visit\(s\) landed on a booked window.*2099-06-03/);
    expect(moveWarning({ notificationError: 'effects_in_progress' })).toMatch(/finishing in the background/);
  });
});

describe('route proposal (source guard): the plan pin is route-owned and the switch-off refusal stays', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');
  const start = src.indexOf("if (toolUse.name === 'reschedule_appointment' && params.appointment_id) {");
  const block = src.slice(start, src.indexOf("if (toolUse.name === 'trigger_review_request' || toolUse.name === 'reply_via_sms') {", start));

  test('a model-sent _series_move is dropped before the decision; only the rebooker plan is pinned', () => {
    expect(start).toBeGreaterThan(0);
    const drop = block.indexOf('delete params._series_move;');
    const decide = block.indexOf("movesAsSeries(pin, params.new_date)");
    const plan = block.indexOf('.planSeriesMove({ appointmentId: pin.id, newDate: dateStr, window: anchor.window })');
    const pinIt = block.indexOf('params._series_move = seriesMove;');
    expect(drop).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(drop);
    expect(plan).toBeGreaterThan(decide);
    expect(pinIt).toBeGreaterThan(plan);
    expect(block).toContain("preview = { ...preview, pinned_appointment: pin, ...(seriesMove ? { series_move: seriesMove } : {}) };");
  });

  test('switch off: the proposal refuses exactly as before', () => {
    const gate = block.indexOf("if (!require('../config/feature-gates').ibSeriesMoveLive()) {");
    const refuse = block.indexOf("code: 'collective_move_unsupported'");
    expect(gate).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(gate);
    expect(refuse).toBeLessThan(block.indexOf('.planSeriesMove('));
  });

  test('a plan move card is admin-only, as on the Dispatch board', () => {
    const adminOnly = block.indexOf("if (req.techRole !== 'admin') return { failed: true, modelResult: { error: 'Only an admin can move a recurring plan from the bar.");
    expect(adminOnly).toBeGreaterThan(block.indexOf('ibSeriesMoveLive()'));
    expect(adminOnly).toBeLessThan(block.indexOf('.planSeriesMove('));
  });
});
