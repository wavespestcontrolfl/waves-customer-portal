// Truck sets the shift start (GATE_TRUCK_CLOCK_IN=start): the pure decisions of
// services/truck-start-apply.js with a frozen clock. The SQL (locks, one write per row, the
// day boundaries) is proved on real PostgreSQL in truck-start-apply-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/staff-onboarding', () => ({
  VEHICLE_AGREEMENT_KEY: 'staff.vehicle-use-commuting-agreement',
  hasCompletedIssuedRecord: jest.fn(),
}));

const db = require('../models/db');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { applyTruckStarts, _test } = require('../services/truck-start-apply');

const { skipReason, decideDay, autoCloseAt, isDeferred } = _test;
const MIN = 60 * 1000;
// Wednesday 2026-11-25, 10:00 AM EST (UTC-5).
const NOW = new Date('2026-11-25T15:00:00.000Z');
const WORK_DATE = '2026-11-25';
const at = (minutesFromNow) => new Date(NOW.getTime() + minutesFromNow * MIN);
const tech = { id: 't1', active: true };
const row = (over = {}) => ({ event_at: at(-3), event_time_known: true, event_verified: true, ...over });
const shift = (over = {}) => ({
  id: 's1', entry_type: 'shift', status: 'active', approval_status: 'pending', clock_in: at(-3), clock_out: null,
  edited_by: null, original_clock_in: null, ...over,
});
const eligible = (over = {}) => skipReason({
  row: row(), workDate: WORK_DATE, technician: tech, agreementOk: true, now: NOW, ...over,
});

describe('autoCloseAt', () => {
  test('is 11 PM Eastern of the work day, in EST and in EDT', () => {
    expect(autoCloseAt('2026-11-25').toISOString()).toBe('2026-11-26T04:00:00.000Z');
    expect(autoCloseAt('2026-07-15').toISOString()).toBe('2026-07-16T03:00:00.000Z');
  });
});

describe('skipReason (eligibility; every reason is final for the day)', () => {
  test('a real, past, same-day GPS time with a signed agreement is eligible', () => {
    expect(eligible()).toBeNull();
  });

  test.each([
    ['webhook not verified (log or disabled mode)', { row: row({ event_verified: false }) }, 'event_unverified'],
    ['row from before the verified column', { row: row({ event_verified: null }) }, 'event_unverified'],
    ['event time was not the GPS time', { row: row({ event_time_known: false }) }, 'event_time_unknown'],
    ['event time unknown on a row from before the column', { row: row({ event_time_known: null }) }, 'event_time_unknown'],
    ['event time is not a date', { row: row({ event_at: 'nope' }) }, 'event_time_invalid'],
    ['event time is in the future past the tolerance', { row: row({ event_at: at(3) }) }, 'event_in_future'],
    ['event time is on another Eastern day', { row: row({ event_at: new Date('2026-11-25T04:30:00.000Z') }) }, 'event_wrong_day'],
    ['technician row missing', { technician: null }, 'technician_inactive'],
    ['technician inactive', { technician: { id: 't1', active: false } }, 'technician_inactive'],
    ['agreement not completed by the GPS time', { agreementOk: false }, 'agreement_not_signed_by_event'],
  ])('%s', (_label, over, expected) => {
    expect(eligible(over)).toBe(expected);
  });

  test('two minutes ahead is within the tolerance, but the job waits for it (isDeferred)', () => {
    expect(eligible({ row: row({ event_at: at(2) }) })).toBeNull();
    expect(isDeferred(at(2), NOW)).toBe(true);
    expect(isDeferred(at(0.01), NOW)).toBe(true);
    expect(isDeferred(at(0), NOW)).toBe(false);
    expect(isDeferred(at(-1), NOW)).toBe(false);
  });

  test('an arrival at or after 11 PM Eastern is refused', () => {
    const late = new Date('2026-11-26T04:00:00.000Z');
    expect(eligible({ row: row({ event_at: late }), now: new Date('2026-11-26T04:00:30.000Z') })).toBe('after_auto_close');
    const justBefore = new Date('2026-11-26T03:59:00.000Z');
    expect(eligible({ row: row({ event_at: justBefore }), now: new Date('2026-11-26T03:59:30.000Z') })).toBeNull();
  });

  test('a tick that runs after the 11 PM close writes nothing, even for an earlier arrival', () => {
    expect(eligible({ now: new Date('2026-11-26T04:00:30.000Z') })).toBe('after_auto_close');
  });

  test('the Eastern work day, not UTC, decides the day (an arrival at 8:30 PM EST is still the same day)', () => {
    const evening = new Date('2026-11-26T01:30:00.000Z');
    expect(eligible({ row: row({ event_at: evening }), now: new Date('2026-11-26T01:31:00.000Z') })).toBeNull();
  });
});

describe('decideDay', () => {
  const decide = (entries, eventAt = at(-3), now = NOW) => decideDay({ entries, eventAt, now });

  test('case A: no entry that day creates a shift at the GPS time', () => {
    expect(decide([])).toMatchObject({ action: 'clocked_in', mutate: 'create', detail: { clock_in: at(-3).toISOString() } });
  });

  test('case A is refused for a stale row (a person decides)', () => {
    expect(decide([], at(-31))).toMatchObject({ action: 'needs_review', detail: { reason: 'row_too_old' } });
    expect(decide([], at(-30))).toMatchObject({ action: 'clocked_in' });
  });

  test('case A with entries but no shift, or a voided shift, needs review', () => {
    expect(decide([{ entry_type: 'admin_time', status: 'completed' }])).toMatchObject({ detail: { reason: 'entries_without_shift' } });
    expect(decide([shift({ status: 'voided' })])).toMatchObject({ action: 'needs_review', detail: { reason: 'shift_voided' } });
  });

  test('case B: the first shift starts later than the GPS time, so it moves back', () => {
    const result = decide([shift({ clock_in: at(8) })], at(-3));
    expect(result).toMatchObject({
      action: 'moved_earlier',
      detail: { shift_id: 's1', original_clock_in: at(8).toISOString(), clock_in: at(-3).toISOString(), minutes_moved: 11 },
    });
    expect(result.mutate.move.id).toBe('s1');
  });

  test('case B on a closed shift moves it too', () => {
    expect(decide([shift({ status: 'completed', clock_in: at(1), clock_out: at(60) })], at(-3))).toMatchObject({ action: 'moved_earlier' });
  });

  test.each([
    ['edited by the office', { status: 'edited' }, 'shift_edited_by_office'],
    ['edited_by set', { edited_by: 'admin-1' }, 'shift_edited_by_office'],
    ['already moved once', { original_clock_in: at(20) }, 'shift_edited_by_office'],
    ['approval in review', { approval_status: 'disputed' }, 'shift_not_pending'],
    ['approved', { approval_status: 'approved' }, 'shift_not_pending'],
  ])('case B is refused for a shift %s', (_label, over, reason) => {
    expect(decide([shift({ clock_in: at(8), ...over })], at(-3))).toMatchObject({ action: 'needs_review', detail: { reason } });
  });

  test.each([
    ['edited by the office', { status: 'edited' }],
    ['edited_by set', { edited_by: 'admin-1' }],
    ['already moved once', { original_clock_in: at(-20) }],
    ['in review', { approval_status: 'disputed' }],
    ['approved', { approval_status: 'approved' }],
  ])('a shift %s is a review even when the tap is early or within tolerance', (_label, over) => {
    // 3 minutes before the truck: would be ok_within_tolerance; 14 minutes: would be flag_early_tap.
    expect(decide([shift({ clock_in: at(-6), ...over })], at(-3))).toMatchObject({ action: 'needs_review' });
    expect(decide([shift({ clock_in: at(-17), ...over })], at(-3))).toMatchObject({ action: 'needs_review' });
  });

  test('a no-change outcome carries the shift so the week guard can run on it', () => {
    expect(decide([shift({ clock_in: at(-6) })], at(-3)).shift.id).toBe('s1');
    expect(decide([shift({ clock_in: at(-17) })], at(-3)).shift.id).toBe('s1');
  });

  test('case C: more than 5 minutes earlier flags the tap and changes nothing', () => {
    const result = decide([shift({ clock_in: at(-17) })], at(-3));
    expect(result).toMatchObject({ action: 'flag_early_tap', detail: { shift_id: 's1', minutes_early: 14 } });
    expect(result.mutate).toBeUndefined();
  });

  test('exactly 5 minutes earlier is within the tolerance, so is 0', () => {
    expect(decide([shift({ clock_in: at(-8) })], at(-3))).toMatchObject({ action: 'ok_within_tolerance', detail: { minutes_early: 5 } });
    expect(decide([shift({ clock_in: at(-3) })], at(-3))).toMatchObject({ action: 'ok_within_tolerance' });
    expect(decide([shift({ clock_in: at(-8.1) })], at(-3))).toMatchObject({ action: 'flag_early_tap' });
  });

  test('a shift already clocked out before the arrival needs review (no pay change)', () => {
    const closed = shift({ status: 'completed', clock_in: at(-120), clock_out: at(-10) });
    expect(decide([closed], at(-3))).toMatchObject({ action: 'needs_review', detail: { reason: 'shift_closed_before_arrival' } });
    const closedAtArrival = shift({ status: 'completed', clock_in: at(-120), clock_out: at(-3) });
    expect(decide([closedAtArrival], at(-3))).toMatchObject({ detail: { reason: 'shift_closed_before_arrival' } });
  });

  test('a shift closed after the arrival is compared normally', () => {
    const closed = shift({ status: 'completed', clock_in: at(-20), clock_out: at(-1) });
    expect(decide([closed], at(-3))).toMatchObject({ action: 'flag_early_tap' });
  });

  test('several shifts need review', () => {
    expect(decide([shift(), shift({ id: 's2', clock_in: at(1) })])).toMatchObject({
      action: 'needs_review', detail: { reason: 'several_shifts', shifts: 2 },
    });
  });
});

describe('applyTruckStarts gate and maintenance switches', () => {
  const saved = { gate: process.env.GATE_TRUCK_CLOCK_IN, maint: process.env.STAFF_MAINTENANCE_MODE };
  afterEach(() => {
    if (saved.gate === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved.gate;
    if (saved.maint === undefined) delete process.env.STAFF_MAINTENANCE_MODE; else process.env.STAFF_MAINTENANCE_MODE = saved.maint;
    db.mockReset();
  });

  test.each([undefined, '', 'off', 'shadow', 'true', 'live'])('GATE_TRUCK_CLOCK_IN=%p runs nothing and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = value;
    expect(await applyTruckStarts({ now: NOW })).toMatchObject({ off: true, applied: 0 });
    expect(db).not.toHaveBeenCalled();
  });

  test('staff maintenance mode runs nothing', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'start';
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    expect(await applyTruckStarts({ now: NOW })).toMatchObject({ maintenance: true });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('the owner bell passes the admin notification rules', () => {
  const saved = process.env.GATE_TRUCK_CLOCK_IN;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved;
  });

  function chain(result) {
    const c = {};
    ['where', 'whereNull', 'orderBy', 'limit', 'join', 'whereIn', 'whereRaw', 'select', 'first', 'update'].forEach((m) => { c[m] = jest.fn().mockReturnValue(c); });
    c.pluck = jest.fn().mockResolvedValue([]);
    c.then = (resolve) => Promise.resolve(result).then(resolve);
    return c;
  }

  test.each([
    ['flag_early_tap', { minutes_early: 14, shift_id: 's1' }],
    ['needs_review', { reason: 'several_shifts' }],
    ['needs_review', { reason: 'week_closed' }],
    ['needs_review', { reason: 'something_new' }],
  ])('%s %j composes without a violation', async (action, detail) => {
    process.env.GATE_TRUCK_CLOCK_IN = 'start';
    const raised = [];
    // today's list is empty; the retry pass returns one flagged row that still needs its bell.
    let call = 0;
    db.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([]);
      return chain([{ id: 'r1', technician_id: 't1', event_at: at(-3), applied_action: action, applied_detail: detail, work_date_text: WORK_DATE, name: 'Alex Rivera-Montgomery-Longname' }]);
    });
    db.raw = jest.fn();
    await applyTruckStarts({ now: NOW, raise: async (category, spec, opts) => { raised.push({ category, spec, opts }); return { id: 'n1' }; } });
    expect(raised).toHaveLength(1);
    expect(() => composeAdminAlert(raised[0].spec)).not.toThrow();
    expect(raised[0].category).toBe('payroll');
    expect(raised[0].opts.dedupeKey).toBe(`truck-start:t1:${WORK_DATE}`);
    if (action === 'flag_early_tap') {
      expect(raised[0].spec.why).toBe('Clocked in 14 min before the truck arrived at the first stop — shop stop or check.');
    }
  });

  const flaggedRow = (over = {}) => ({
    id: 'r1', technician_id: 't1', event_at: at(-3), applied_action: 'needs_review', applied_detail: { reason: 'several_shifts' },
    work_date_text: WORK_DATE, name: 'Alex Rivera', ...over,
  });
  const runWith = async (raise, rowOver) => {
    process.env.GATE_TRUCK_CLOCK_IN = 'start';
    const chains = [];
    let call = 0;
    db.mockImplementation(() => {
      call += 1;
      const c = chain(call === 1 ? [] : [flaggedRow(rowOver)]);
      chains.push(c);
      return c;
    });
    db.raw = jest.fn();
    const summary = await applyTruckStarts({ now: NOW, raise });
    return { summary, chains };
  };

  test.each([
    ['null (insert failed)', null],
    ['undefined', undefined],
    ['a suppressed alert with no id', { id: null, suppressed: true }],
  ])('a receipt of %s is not a sent bell: nothing is stamped notified', async (_label, receipt) => {
    const raise = jest.fn().mockResolvedValue(receipt);
    const { summary, chains } = await runWith(raise);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(summary.bells).toBe(0);
    // chains[1] is the retry query; a stamp would be a third db() call with update().
    expect(chains).toHaveLength(2);
  });

  test('a persisted id (a deduplicated existing one too) is a sent bell and is stamped', async () => {
    const raise = jest.fn().mockResolvedValue({ id: 'existing-id', deduped: true });
    const { summary, chains } = await runWith(raise);
    expect(summary.bells).toBe(1);
    expect(chains).toHaveLength(3);
    expect(chains[2].update).toHaveBeenCalledTimes(1);
  });

  test('a review bell left from an earlier Eastern day is retried under the row\'s own work date', async () => {
    const raise = jest.fn().mockResolvedValue({ id: 'n1' });
    await runWith(raise, { work_date_text: '2026-11-24' });
    expect(raise.mock.calls[0][2].dedupeKey).toBe('truck-start:t1:2026-11-24');
    expect(raise.mock.calls[0][1].subject.id).toBe('truck-start:t1:2026-11-24');
    expect(raise.mock.calls[0][2].metadata.workDate).toBe('2026-11-24');
  });
});
