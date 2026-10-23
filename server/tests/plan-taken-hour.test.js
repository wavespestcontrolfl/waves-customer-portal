/**
 * scheduling/plan-taken-hour.js + the shared plan-writer probe it uses
 * (window-rules.js occupancyBlockFor / seriesCandidateDateClashRows, moved
 * from routes/admin-schedule.js unchanged). Owner 2026-10-22, audit D4.
 */
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(async () => []),
  techScopedConfirmActive: jest.fn(() => false),
}));

const { findConflictingVisits, techScopedConfirmActive } = require('../services/scheduling/occupancy');
const { occupancyBlockFor, seriesCandidateDateClashRows, ADMIN_OCCUPANCY_EXCLUDE_STATUSES } = require('../services/scheduling/window-rules');
const planTakenHour = require('../services/scheduling/plan-taken-hour');
const { etDateString, addETDays } = require('../utils/datetime-et');

const day = (n) => etDateString(addETDays(new Date(), n));

describe('occupancyBlockFor (moved from admin-schedule.js, same results)', () => {
  test.each([
    [{ window_start: '09:00', window_end: '10:00' }, { start: '09:00', end: '10:00' }],
    [{ window_start: '09:00:00', window_end: '10:30:00' }, { start: '09:00', end: '10:30' }],
    [{ window_start: '09:00', window_end: null, estimated_duration_minutes: 90 }, { start: '09:00', end: '10:30' }],
    [{ window_start: '09:00', window_end: '08:00' }, { start: '09:00', end: '10:00' }],
    [{ window_start: '23:30', window_end: null, estimated_duration_minutes: 60 }, { start: '23:30', end: '23:59' }],
    [{ window_start: null }, null],
    [{ window_start: '25:00' }, null],
  ])('%j -> %j', (row, block) => {
    expect(occupancyBlockFor(row)).toEqual(block);
  });
});

describe('seriesCandidateDateClashRows', () => {
  afterEach(() => findConflictingVisits.mockReset().mockImplementation(async () => []));

  test('a caller may pass its own statuses (the hand-off passes the night tool\'s)', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03', { excludeStatuses: ['x'] });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ excludeStatuses: ['x'] }));
  });

  test('interviews only when asked', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03', { includeInterviews: true });
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ includeInterviews: true }));
  });

  test('existing callers (no options): the same tech-blind probe as before', async () => {
    await seriesCandidateDateClashRows('conn', { window_start: '09:00', window_end: '10:00' }, '2026-11-03');
    expect(findConflictingVisits).toHaveBeenCalledWith({
      db: 'conn', date: '2026-11-03', windowStart: '09:00', windowEnd: '10:00', excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
    });
  });

  test('a windowless template reads nothing', async () => {
    expect(await seriesCandidateDateClashRows('conn', { window_start: null }, '2026-11-03')).toEqual([]);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });
});

describe('plan-taken-hour', () => {
  afterEach(() => {
    delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF;
    findConflictingVisits.mockReset().mockImplementation(async () => []);
  });
  const row = { customer_id: 'c1', technician_id: 't1', window_start: '09:00', window_end: '10:00' };

  test('hand-off fields clear every time field and set the due date', () => {
    expect(planTakenHour.handoffFields('2026-11-03T00:00:00.000Z')).toEqual({
      window_start: null, window_end: null, time_window: null, window_display: null, route_order: null,
      recurring_dispatch_due_date: '2026-11-03',
    });
  });

  test('gate off: never taken, nothing read', async () => {
    findConflictingVisits.mockResolvedValue([{ id: 'x' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(30) })).toBe(false);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('gate on: taken from four days out, through the tech-blind probe with the night tool\'s statuses', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(3) })).toBe(false);
    expect(findConflictingVisits).not.toHaveBeenCalled();
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(4) })).toBe(true);
    const probe = findConflictingVisits.mock.calls[0][0];
    expect(probe).toMatchObject({ date: day(4) });
    expect(probe.technicianId).toBeUndefined();
    // No customer is excluded wholesale (Codex #6476 r1 P1); a rescheduled or completed row is no stop (r1 P2).
    expect(probe.excludeCustomerId).toBeUndefined();
    expect(probe.excludeStatuses).toEqual(expect.arrayContaining(['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed']));
    // The owner's booked interviews hold the hour too, as for the night tool.
    expect(probe.includeInterviews).toBe(true);
  });

  test('once the schedule is technician-scoped: only the visit\'s own technician\'s stops and unassigned ones count (isOtherStop)', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    techScopedConfirmActive.mockReturnValue(true);
    try {
      const at = { ...row, scheduled_date: day(30) };
      findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2', technician_id: 't2' }]);
      expect(await planTakenHour.takenHourHandoff('conn', at)).toBe(false);
      findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2', technician_id: 't1' }]);
      expect(await planTakenHour.takenHourHandoff('conn', at)).toBe(true);
      findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2', technician_id: null }]);
      expect(await planTakenHour.takenHourHandoff('conn', at)).toBe(true);
      // An unassigned new visit is blocked by any technician's stop.
      findConflictingVisits.mockResolvedValue([{ id: 'x', customer_id: 'c2', technician_id: 't2' }]);
      expect(await planTakenHour.takenHourHandoff('conn', { ...at, technician_id: null })).toBe(true);
    } finally {
      techScopedConfirmActive.mockReturnValue(false);
    }
  });

  test('an interview in the hour (no customer) is taken', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockResolvedValue([{ id: 'interview:app-1', customer_id: null, conflict_reason: 'interview' }]);
    expect(await planTakenHour.takenHourHandoff('conn', { ...row, scheduled_date: day(30) })).toBe(true);
  });

  // The same customer is one stop only at the same place: the night tool's
  // own rule (auto-dispatch/current-conflict.js), measured from the NEW
  // visit's own place — its fields with the plan's template address applied
  // (Codex #6476 r1 P1, r2 P1).
  describe('the same customer', () => {
    // A knex-shaped read of the clash rows' places and of the customer's address.
    const placeConn = (places, customer = null) => {
      const q = { leftJoin: () => q, whereIn: () => q, select: async () => places };
      return jest.fn((table) => (table === 'customers' ? { where: () => ({ first: async () => customer }) } : q));
    };
    const at = (fields) => ({ ...row, scheduled_date: day(30), ...fields });
    beforeEach(() => {
      process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
    });

    test('at the same property: one stop, not taken', async () => {
      const conn = placeConn([{ id: 'own', property_id: 'prop-a' }]);
      expect(await planTakenHour.takenHourHandoff(conn, at({ property_id: 'prop-a' }))).toBe(false);
    });

    test('at another property: taken', async () => {
      const conn = placeConn([{ id: 'own', property_id: 'prop-b' }]);
      expect(await planTakenHour.takenHourHandoff(conn, at({ property_id: 'prop-a' }))).toBe(true);
    });

    test("the plan's template address wins over the row's own (the place the insert gets)", async () => {
      const moved = at({ property_id: 'prop-old', recurring_template_overrides: { appointment_address: { property_id: 'prop-new' } } });
      expect(await planTakenHour.takenHourHandoff(placeConn([{ id: 'own', property_id: 'prop-new' }]), moved)).toBe(false);
      expect(await planTakenHour.takenHourHandoff(placeConn([{ id: 'own', property_id: 'prop-old' }]), moved)).toBe(true);
    });

    test("an unstamped visit is at its customer's address", async () => {
      const conn = placeConn(
        [{ id: 'own', property_id: null, service_address_line1: '100 Sample Way', service_address_city: 'Sampletown', service_address_zip: '00000' }],
        { address_line1: '100 Sample Way', city: 'Sampletown', zip: '00000' },
      );
      expect(await planTakenHour.takenHourHandoff(conn, at({}))).toBe(false);
    });

    test('a place that cannot be read: taken', async () => {
      expect(await planTakenHour.takenHourHandoff(placeConn([]), at({ property_id: 'prop-a' }))).toBe(true);
    });

    test("its own stop beside another customer's: taken", async () => {
      findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }, { id: 'other', customer_id: 'c2' }]);
      const conn = placeConn([{ id: 'own', property_id: 'prop-a' }]);
      expect(await planTakenHour.takenHourHandoff(conn, at({ property_id: 'prop-a' }))).toBe(true);
    });
  });

  test('handOffTakenHours hands off the taken rows and keeps the input array', async () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    findConflictingVisits.mockImplementation(async ({ date }) => (date === day(40) ? [{ id: 'x', customer_id: 'c2' }] : []));
    const rows = [{ ...row, scheduled_date: day(20) }, { ...row, scheduled_date: day(40) }];
    const out = await planTakenHour.handOffTakenHours('conn', rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toMatchObject({ window_start: null, recurring_dispatch_due_date: day(40) });
    expect(rows[1].window_start).toBe('09:00');
    // Gate off: the same array back, nothing read.
    delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF;
    findConflictingVisits.mockClear();
    expect(await planTakenHour.handOffTakenHours('conn', rows)).toBe(rows);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('hand-off fields: only the columns the table has, when it says', () => {
    expect(planTakenHour.handoffFields('2026-11-03', { window_start: {}, recurring_dispatch_due_date: {} }))
      .toEqual({ window_start: null, recurring_dispatch_due_date: '2026-11-03' });
  });
});

// CALL FOLLOW-UP FREE HOUR (GATE_CALL_FOLLOWUP_FREE_HOUR; owner 2026-10-22,
// "fix", after a call follow-up landed on another customer's 10 AM): visit 2
// of a call keeps a copied hour only while that hour is free on its date.
describe('callFollowUpWindow', () => {
  const conn = { transaction: async (fn) => fn('sp') };
  const args = { visit1: { property_id: 'prop-a' }, customerId: 'c1', technicianId: 't1', date: day(7) };
  const planned = { window_start: '10:00', window_end: '11:00', window_display: '10:00 AM' };
  const startOf = async (...rest) => (await planTakenHour.callFollowUpWindow(...rest)).window_start;
  // Another customer's stop holds the hours in `taken` on visit 2's date.
  const holdHours = (taken) => findConflictingVisits.mockImplementation(async ({ windowStart }) => (
    taken.includes(windowStart) ? [{ id: `other-${windowStart}`, customer_id: 'c2' }] : []));
  beforeEach(() => { process.env.GATE_CALL_FOLLOWUP_FREE_HOUR = 'true'; });
  afterEach(() => {
    delete process.env.GATE_CALL_FOLLOWUP_FREE_HOUR;
    findConflictingVisits.mockReset().mockImplementation(async () => []);
  });

  test('a free planned window stays as planned', async () => {
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toBe(planned);
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
    // The probe reads visit 2's planned window, with the night tool's statuses and interviews.
    expect(findConflictingVisits.mock.calls[0][0]).toMatchObject({ date: day(7), windowStart: '10:00', windowEnd: '11:00', includeInterviews: true });
  });

  test('a taken planned hour moves to a one-hour window at the nearest free whole hour, the later of two equally near', async () => {
    holdHours(['10:00']);
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toEqual({ window_start: '11:00', window_end: '12:00', window_display: '11:00 AM' });
    holdHours(['10:00', '11:00']);
    expect(await startOf(conn, args, planned)).toBe('09:00');
    holdHours(['10:00', '11:00', '09:00', '12:00', '08:00']);
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toEqual({ window_start: '13:00', window_end: '14:00', window_display: '1:00 PM' });
  });

  test('only whole hours inside the shift (8 AM to the 6 PM close); none free keeps the planned window', async () => {
    holdHours(['17:00']);
    expect(await startOf(conn, args, { window_start: '17:00', window_end: '18:00', window_display: '5:00 PM' })).toBe('16:00');
    const all = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    holdHours(all);
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toBe(planned);
    const probed = findConflictingVisits.mock.calls.slice(-all.length).map(([a]) => a.windowStart);
    expect(probed.sort()).toEqual(all);
  });

  test('the same customer at the same place is one stop, not a reason to move', async () => {
    findConflictingVisits.mockResolvedValue([{ id: 'own', customer_id: 'c1' }]);
    const q = { leftJoin: () => q, whereIn: () => q, select: async () => [{ id: 'own', property_id: 'prop-a' }] };
    const placeConn = Object.assign(jest.fn((table) => (table === 'customers' ? { where: () => ({ first: async () => null }) } : q)), {
      transaction: async (fn) => fn(placeConn),
    });
    expect(await planTakenHour.callFollowUpWindow(placeConn, args, planned)).toBe(planned);
  });

  test('a time the call set, a package visit 2, and the gate off keep the planned window, unread', async () => {
    holdHours(['10:00']);
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned, { hourStated: true })).toBe(planned);
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned, { packageVisit: true })).toBe(planned);
    delete process.env.GATE_CALL_FOLLOWUP_FREE_HOUR;
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toBe(planned);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('a failed read keeps the planned window and never throws', async () => {
    findConflictingVisits.mockRejectedValue(new Error('db down'));
    expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toBe(planned);
    const failing = { transaction: async () => { throw new Error('savepoint failed'); } };
    expect(await planTakenHour.callFollowUpWindow(failing, args, planned)).toBe(planned);
  });

  test('the probe carries the technician the writer resolved; unassigned, every stop counts', async () => {
    const { techScopedConfirmActive } = require('../services/scheduling/occupancy');
    techScopedConfirmActive.mockReturnValue(true);
    try {
      // Technician t2's stop holds 10:00: not visit 2's technician (t1), so the hour is free.
      findConflictingVisits.mockImplementation(async ({ windowStart }) => (windowStart === '10:00' ? [{ id: 'x', customer_id: 'c2', technician_id: 't2' }] : []));
      expect(await planTakenHour.callFollowUpWindow(conn, args, planned)).toBe(planned);
      // Visit 2 goes to t2: the hour is taken.
      expect(await startOf(conn, { ...args, technicianId: 't2' }, planned)).toBe('11:00');
      // Visit 2 goes unassigned (its technician is not assignable): t2's stop still holds the hour.
      expect(await startOf(conn, { ...args, technicianId: null }, planned)).toBe('11:00');
    } finally {
      techScopedConfirmActive.mockReturnValue(false);
    }
  });
});

// The call pipeline's visit 2 (call-recording-processor.js
// ensureCallFollowUpVisit) is too large to drive here; its wiring is pinned
// by source, as call-lead-form-address-street-level.test.js pins the same
// function.
describe('callFollowUpWindow wiring in the call pipeline', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const fu = src.indexOf('const ensureCallFollowUpVisit = async (primaryRow, { fresh = false } = {}) => {');
  const fence = src.indexOf('fenceBookingDay(fenceSp, { date: fuPlan.scheduledDate, techId: followUpTechId })', fu);
  const insert = src.indexOf('source_action: packageFollowUp', fu);

  test("visit 2's window comes from callFollowUpWindow under the fence, with the resolved technician and the call's own flags", () => {
    const call = src.indexOf("const fuWindow = await require('./scheduling/plan-taken-hour').callFollowUpWindow(sp, {", fu);
    expect(fu).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(fu);
    // Read after the fence (Codex pre-push P1: two calls must not pick the same free hour) and before the insert.
    expect(call).toBeGreaterThan(fence);
    expect(call).toBeLessThan(insert);
    const block = src.slice(call, src.indexOf('packageVisit: packageFollowUp });', call));
    expect(block).toContain('technicianId: followUpTechId,');
    expect(block).toContain('window_start: fuStart,');
    expect(block).toContain('{ hourStated: fuPlan.hourStated,');
    // The insert writes that window and no other.
    const insertBlock = src.slice(src.indexOf("const [fuRow] = await sp('scheduled_services')", call), insert);
    expect(insertBlock).toContain('...fuWindow,');
    expect(insertBlock).not.toMatch(/window_(start|end|display):/);
  });

  test('the idempotency key stays on the planned hour, so a retry finds the same visit 2', () => {
    expect(src.slice(fu, insert + 2000)).toContain('confirmedStartAt: `${fuPlan.scheduledDate}T${fuStart}`,');
  });
});
