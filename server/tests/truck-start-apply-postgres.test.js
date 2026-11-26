// Truck sets the shift start (GATE_TRUCK_CLOCK_IN=start) on real migrated PostgreSQL: the follow-up job
// writes the shift from the day's truck_clock_in_shadow row, once, in one transaction.
//
// Safety: the suite refuses to run unless DATABASE_URL is a local database that is plainly disposable
// (CI's `waves_test`, or a database whose name carries `_qa`). Every technician is created here and every
// job call is scoped to them (applyTruckStarts({ technicianIds })), so another suite's rows are never
// read or written. The clock is frozen (only Date: the pg driver keeps its real timers) and the work days
// are in 2031, far from any other suite's data. The vehicle agreement lookup is a stub with a completion
// time per technician (its tables are append-only evidence), except one test that runs the real query
// inside a transaction that is rolled back. Nothing is sent: the admin bell is a recording stub.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const mockAgreementCompletedAt = new Map();
jest.mock('../services/staff-onboarding', () => ({
  VEHICLE_AGREEMENT_KEY: 'staff.vehicle-use-commuting-agreement',
  hasCompletedIssuedRecord: jest.fn(async (_conn, technicianId, _key, _now, opts = {}) => {
    const completedAt = mockAgreementCompletedAt.get(technicianId);
    if (!completedAt) return false;
    return !opts.completedBy || completedAt.getTime() <= new Date(opts.completedBy).getTime();
  }),
}));

const { randomUUID } = require('node:crypto');
const { parseETDateTime } = require('../utils/datetime-et');
const { ACTIVE_WRITE_GENERATION } = require('../constants/staff-time');

const MIN = 60 * 1000;
const REAL_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'];
// Wednesday 2031-02-05 and the days around it (EST, UTC-5).
const DAY = '2031-02-05';
const NEXT_DAY = '2031-02-06';
const PREV_DAY = '2031-02-04';
const et = (hhmm, day = DAY) => parseETDateTime(`${day}T${hhmm}`);

postgres('truck sets the shift start on PostgreSQL (GATE_TRUCK_CLOCK_IN=start)', () => {
  let database;
  let db;
  let apply;
  let timeTracking;
  let realOnboarding;
  const techIds = [];
  const priorGate = process.env.GATE_TRUCK_CLOCK_IN;
  const priorMaint = process.env.STAFF_MAINTENANCE_MODE;
  let bells;
  let raise;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const name = url.pathname.replace(/^\//, '');
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const disposable = (process.env.CI === 'true' && name === 'waves_test') || /_qa(_|$)/.test(name) || /^waves_qa_[a-f0-9]{32}$/.test(name);
    if (!local || !disposable) throw new Error('Use a disposable local database (CI waves_test or a name with _qa)');
    db = require('../models/db');
    database = db;
    timeTracking = require('../services/time-tracking');
    apply = require('../services/truck-start-apply');
    realOnboarding = jest.requireActual('../services/staff-onboarding');
  });

  beforeEach(() => {
    process.env.GATE_TRUCK_CLOCK_IN = 'start';
    delete process.env.STAFF_MAINTENANCE_MODE;
    mockAgreementCompletedAt.clear();
    bells = [];
    raise = jest.fn(async (category, spec, opts) => { bells.push({ category, spec, opts }); return { id: randomUUID() }; });
    jest.useFakeTimers({ now: et('10:00'), doNotFake: REAL_TIMERS });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (techIds.length) {
      const entryIds = await database('time_entries').whereIn('technician_id', techIds).pluck('id');
      if (entryIds.length) await database('audit_log').whereIn('resource_id', entryIds).del();
      await database('time_entry_daily_summary').whereIn('technician_id', techIds).del();
      await database('time_weekly_summary').whereIn('technician_id', techIds).del();
      await database('time_entries').whereIn('technician_id', techIds).del();
      await database('truck_clock_in_shadow').whereIn('technician_id', techIds).del();
      await database('technicians').whereIn('id', techIds).del();
      techIds.length = 0;
    }
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = priorGate;
    if (priorMaint === undefined) delete process.env.STAFF_MAINTENANCE_MODE; else process.env.STAFF_MAINTENANCE_MODE = priorMaint;
    await database?.destroy();
  });

  async function makeTech({ signedAt = et('06:00', PREV_DAY), active = true } = {}) {
    const id = randomUUID();
    techIds.push(id);
    await database('technicians').insert({
      id, name: `QA Truck ${id.slice(0, 8)}`, email: `qa-truck-start-${id.slice(0, 8)}@example.invalid`, role: 'technician', active,
    });
    if (signedAt) mockAgreementCompletedAt.set(id, signedAt);
    return id;
  }

  const shadow = (technicianId, eventAt, over = {}) => database('truck_clock_in_shadow').insert({
    technician_id: technicianId,
    work_date: DAY,
    trigger: 'first_arrival',
    event_at: eventAt,
    would_clock_in: true,
    skip_reason: null,
    lat: 27.3,
    lng: -82.5,
    event_time_known: true,
    event_verified: true,
    ...over,
  });
  const shadowRow = (technicianId) => database('truck_clock_in_shadow')
    .where({ technician_id: technicianId }).first('*', database.raw('work_date::text AS work_day'));
  const shifts = (technicianId) => database('time_entries').where({ technician_id: technicianId, entry_type: 'shift' }).orderBy('clock_in');
  const addShift = (technicianId, clockIn, clockOut = null, over = {}) => database('time_entries').insert({
    technician_id: technicianId,
    entry_type: 'shift',
    status: clockOut ? 'completed' : 'active',
    clock_in: clockIn,
    clock_out: clockOut,
    duration_minutes: clockOut ? Math.round(((clockOut - clockIn) / MIN) * 100) / 100 : null,
    source: 'app',
    staff_write_generation: ACTIVE_WRITE_GENERATION,
    ...over,
  }).returning('*').then((rows) => rows[0]);
  // The tick's clock is also the system clock (the job re-reads Date after it holds its locks).
  const tick = (technicianIds, now = et('10:00')) => {
    jest.setSystemTime(now);
    return apply.applyTruckStarts({ now, raise, technicianIds });
  };
  const at = (hhmm, day = DAY) => et(hhmm, day);

  test('case A: no entry that day, the shift starts at the GPS time (not at the tick)', async () => {
    const tech = await makeTech();
    await shadow(tech, at('08:00'));
    const result = await tick([tech], at('08:02'));
    expect(result).toMatchObject({ applied: 1, errors: 0 });

    const rows = await shifts(tech);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', source: 'truck_gps', entry_type: 'shift' });
    expect(rows[0].clock_in.toISOString()).toBe(at('08:00').toISOString());
    expect(rows[0].clock_in_lat).not.toBeNull();

    const row = await shadowRow(tech);
    expect(row.applied_action).toBe('clocked_in');
    expect(row.applied_at).toBeInstanceOf(Date);
    expect(row.applied_detail).toMatchObject({ shift_id: rows[0].id });
    const audit = await database('audit_log').where({ resource_id: rows[0].id, action: 'payroll.time_entry_truck_start_created' });
    expect(audit).toHaveLength(1);
    expect(bells).toHaveLength(0);
  });

  test('case A is the same shift a tap would make: Clock out works on it', async () => {
    const tech = await makeTech();
    await shadow(tech, at('08:00'));
    await tick([tech], at('08:02'));
    jest.setSystemTime(at('16:00'));
    const closed = await timeTracking.clockOut(tech);
    expect(closed).toBeTruthy();
    const [shift] = await shifts(tech);
    expect(shift.status).toBe('completed');
    expect(Number(shift.duration_minutes)).toBe(480);
  });

  test('case B: an active shift tapped later moves back to the GPS time, original kept and audited', async () => {
    const tech = await makeTech();
    const tapped = await addShift(tech, at('08:11'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:12'));

    const [shift] = await shifts(tech);
    expect(shift.id).toBe(tapped.id);
    expect(shift.clock_in.toISOString()).toBe(at('08:00').toISOString());
    expect(shift.original_clock_in.toISOString()).toBe(at('08:11').toISOString());
    expect(shift.status).toBe('active');
    expect(shift.notes).toMatch(/Start moved from 8:11 AM to 8:00 AM/);
    const row = await shadowRow(tech);
    expect(row.applied_action).toBe('moved_earlier');
    expect(row.applied_detail).toMatchObject({ original_clock_in: at('08:11').toISOString(), clock_in: at('08:00').toISOString() });
    const audit = await database('audit_log').where({ resource_id: shift.id, action: 'payroll.time_entry_truck_start_moved' });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ from: at('08:11').toISOString(), to: at('08:00').toISOString() });
    expect(bells).toHaveLength(0);
  });

  test('case B on a closed shift: duration recomputed, status edited, original start and end kept', async () => {
    const tech = await makeTech();
    const done = await addShift(tech, at('08:11'), at('12:00'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('12:30'));
    const [shift] = await shifts(tech);
    expect(shift.id).toBe(done.id);
    expect(shift.clock_in.toISOString()).toBe(at('08:00').toISOString());
    expect(shift.status).toBe('edited');
    expect(Number(shift.duration_minutes)).toBe(240);
    expect(shift.original_clock_in.toISOString()).toBe(at('08:11').toISOString());
    expect(shift.original_clock_out.toISOString()).toBe(at('12:00').toISOString());
    expect((await shadowRow(tech)).applied_action).toBe('moved_earlier');
  });

  test('case B is refused when another shift sits in the gap: no pay change, one bell', async () => {
    const tech = await makeTech();
    // Yesterday-evening shift that ran past midnight into the gap (an overlap, not the day's shift).
    await addShift(tech, at('22:00', PREV_DAY), at('08:05'), { status: 'completed' });
    const tapped = await addShift(tech, at('08:11'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:12'));
    const after = await database('time_entries').where({ id: tapped.id }).first();
    expect(after.clock_in.toISOString()).toBe(at('08:11').toISOString());
    expect(after.original_clock_in).toBeNull();
    const row = await shadowRow(tech);
    expect(row).toMatchObject({ applied_action: 'needs_review' });
    expect(row.applied_detail).toMatchObject({ reason: 'overlaps_existing_shift', notified: true });
    expect(bells).toHaveLength(1);
  });

  test('case B is refused on an approved day: nothing moves, one bell', async () => {
    const tech = await makeTech();
    const tapped = await addShift(tech, at('08:11'));
    await database('time_entry_daily_summary').insert({ technician_id: tech, work_date: DAY, status: 'approved' });
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:12'));
    expect((await database('time_entries').where({ id: tapped.id }).first()).clock_in.toISOString()).toBe(at('08:11').toISOString());
    expect(await shadowRow(tech)).toMatchObject({ applied_action: 'needs_review' });
    expect((await shadowRow(tech)).applied_detail.reason).toBe('week_closed');
    expect(bells).toHaveLength(1);
  });

  test('case C: clocked in 14 minutes before the truck: pay unchanged, one bell with the owner text', async () => {
    const tech = await makeTech();
    const tapped = await addShift(tech, at('07:46'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:01'));
    const [shift] = await shifts(tech);
    expect(shift.clock_in.toISOString()).toBe(at('07:46').toISOString());
    expect(shift.id).toBe(tapped.id);
    const row = await shadowRow(tech);
    expect(row.applied_action).toBe('flag_early_tap');
    expect(row.applied_detail).toMatchObject({ minutes_early: 14, notified: true });
    expect(bells).toHaveLength(1);
    expect(bells[0].spec.why).toBe('Clocked in 14 min before the truck arrived at the first stop — shop stop or check.');
    expect(bells[0].opts.dedupeKey).toBe(`truck-start:${tech}:${DAY}`);
  });

  test('case C within 5 minutes: ok_within_tolerance, no bell', async () => {
    const tech = await makeTech();
    await addShift(tech, at('07:56'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:01'));
    expect(await shadowRow(tech)).toMatchObject({ applied_action: 'ok_within_tolerance' });
    expect(bells).toHaveLength(0);
  });

  test('a shift clocked out before the arrival, or several shifts: no pay change, needs_review, one bell each', async () => {
    const closedFirst = await makeTech();
    await addShift(closedFirst, at('06:00'), at('07:30'));
    await shadow(closedFirst, at('08:00'));
    const several = await makeTech();
    await addShift(several, at('07:00'), at('07:30'));
    await addShift(several, at('07:45'));
    await shadow(several, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([closedFirst, several], at('08:02'));

    expect((await shadowRow(closedFirst)).applied_detail.reason).toBe('shift_closed_before_arrival');
    expect((await shadowRow(several)).applied_detail.reason).toBe('several_shifts');
    expect(await shifts(closedFirst)).toHaveLength(1);
    expect(await shifts(several)).toHaveLength(2);
    expect(bells).toHaveLength(2);
  });

  test('case A is refused when an open shift from an earlier day still overlaps', async () => {
    const tech = await makeTech();
    await addShift(tech, at('20:00', PREV_DAY));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:02'));
    expect(await shifts(tech)).toHaveLength(1);
    expect((await shadowRow(tech)).applied_detail).toMatchObject({ reason: 'overlaps_existing_shift' });
    expect(bells).toHaveLength(1);
  });

  test('idempotent: a stamped row is never processed again, no second write and no second bell', async () => {
    const tech = await makeTech();
    await addShift(tech, at('07:40'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    await tick([tech], at('08:01'));
    const stamped = (await shadowRow(tech)).applied_at;
    const again = await tick([tech], at('08:03'));
    expect(again).toMatchObject({ applied: 0, skipped: 0, bells: 0 });
    expect((await shadowRow(tech)).applied_at.getTime()).toBe(stamped.getTime());
    expect(bells).toHaveLength(1);
  });

  test('two ticks at the same moment write exactly one shift', async () => {
    const tech = await makeTech();
    await shadow(tech, at('08:00'));
    const results = await Promise.all([1, 2, 3, 4].map(() => tick([tech], at('08:01'))));
    expect(results.reduce((sum, r) => sum + r.applied, 0)).toBe(1);
    expect(await shifts(tech)).toHaveLength(1);
    expect(await database('audit_log').where({ action: 'payroll.time_entry_truck_start_created' }).whereIn('resource_id', (await shifts(tech)).map((s) => s.id))).toHaveLength(1);
  });

  test('a crash before commit leaves the row for the next tick and writes nothing', async () => {
    const tech = await makeTech();
    await shadow(tech, at('08:00'));
    const spy = jest.spyOn(timeTracking, 'createTruckStartShift').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XX000' }));
    const first = await tick([tech], at('08:01'));
    expect(first).toMatchObject({ applied: 0, errors: 1 });
    expect(await shifts(tech)).toHaveLength(0);
    expect((await shadowRow(tech)).applied_at).toBeNull();
    spy.mockRestore();
    expect(await tick([tech], at('08:03'))).toMatchObject({ applied: 1 });
    expect(await shifts(tech)).toHaveLength(1);
  });

  test('a bell that fails after the commit is retried by the next tick, and goes out once', async () => {
    const tech = await makeTech();
    await addShift(tech, at('07:40'));
    await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
    // Down for the tick's own try and for its same-tick retry pass.
    raise.mockRejectedValueOnce(new Error('bell down')).mockRejectedValueOnce(new Error('bell down'));
    await tick([tech], at('08:01'));
    expect((await shadowRow(tech)).applied_detail.notified).toBe(false);
    await tick([tech], at('08:03'));
    expect((await shadowRow(tech)).applied_detail.notified).toBe(true);
    expect(bells).toHaveLength(1);
    await tick([tech], at('08:05'));
    expect(bells).toHaveLength(1);
  });

  describe('eligibility on the real tables', () => {
    test('an agreement completed AFTER the GPS time is refused, final for the day, nothing written', async () => {
      const tech = await makeTech({ signedAt: at('08:30') });
      await shadow(tech, at('08:00'));
      await tick([tech], at('08:35'));
      expect(await shifts(tech)).toHaveLength(0);
      expect(await shadowRow(tech)).toMatchObject({ applied_action: 'skipped:agreement_not_signed_by_event' });
      // Final: signing earlier is impossible, and a later tick does not look again.
      expect(await tick([tech], at('09:00'))).toMatchObject({ applied: 0, skipped: 0 });
      expect(await shifts(tech)).toHaveLength(0);
    });

    test('an agreement completed at the GPS time, or before it, is accepted', async () => {
      const exact = await makeTech({ signedAt: at('08:00') });
      await shadow(exact, at('08:00'));
      await tick([exact], at('08:01'));
      expect(await shifts(exact)).toHaveLength(1);
    });

    test('no agreement on file, an inactive technician and an unreal GPS time are skipped', async () => {
      const unsigned = await makeTech({ signedAt: null });
      const inactive = await makeTech({ active: false });
      const unknownTime = await makeTech();
      await shadow(unsigned, at('08:00'));
      await shadow(inactive, at('08:00'));
      await shadow(unknownTime, at('08:00'), { event_time_known: false });
      await tick([unsigned, inactive, unknownTime], at('08:01'));
      expect((await shadowRow(unsigned)).applied_action).toBe('skipped:agreement_not_signed_by_event');
      expect((await shadowRow(inactive)).applied_action).toBe('skipped:technician_inactive');
      expect((await shadowRow(unknownTime)).applied_action).toBe('skipped:event_time_unknown');
      for (const id of [unsigned, inactive, unknownTime]) expect(await shifts(id)).toHaveLength(0);
      expect(bells).toHaveLength(0);
    });

    test('the real agreement query honors completedBy (rolled back, nothing kept)', async () => {
      const tech = await makeTech({ signedAt: null });
      const key = `qa-truck-start-${randomUUID().slice(0, 8)}`;
      const rollback = new Error('rollback');
      await expect(database.transaction(async (trx) => {
        const [template] = await trx('document_templates').insert({
          template_key: key, name: 'QA agreement', audience: 'staff', staff_kind: 'form', staff_access: 'staff',
        }).returning('id');
        const [version] = await trx('document_template_versions').insert({
          template_id: template.id, version_number: 1, title: 'QA', body: 'QA', published_at: at('05:00', PREV_DAY), effective_at: at('05:00', PREV_DAY),
        }).returning('id');
        await trx('staff_document_records').insert({
          version_id: version.id, content_hash: 'x'.repeat(64), created_by: tech, owner_id: tech, due_at: at('09:00'), completed_at: at('08:30'),
        });
        const read = (eventAt) => realOnboarding.hasCompletedIssuedRecord(trx, tech, key, eventAt, { completedBy: eventAt });
        expect(await read(at('08:00'))).toBe(false);
        expect(await read(at('08:30'))).toBe(true);
        expect(await read(at('09:00'))).toBe(true);
        expect(await realOnboarding.hasCompletedIssuedRecord(trx, tech, key, at('09:00'))).toBe(true);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await database('document_templates').where({ template_key: key }).first()).toBeUndefined();
    });
  });

  describe('day boundaries (Eastern, never a fixed UTC offset)', () => {
    test('11 PM auto-close: 10:59 PM is written, 11:00 PM is not, and a tick after the close writes nothing', async () => {
      const before = await makeTech();
      const at11 = await makeTech();
      const afterClose = await makeTech();
      await shadow(before, at('22:59'));
      await shadow(at11, at('23:00'));
      await shadow(afterClose, at('22:50'));
      // A tick at 10:59:30 PM handles the first two; the third waits for a tick after the close.
      await tick([before, at11], new Date(at('22:59').getTime() + 30 * 1000));
      expect((await shadowRow(before)).applied_action).toBe('clocked_in');
      expect((await shadowRow(at11)).applied_action).toBe('skipped:after_auto_close');
      expect(await shifts(at11)).toHaveLength(0);

      await tick([afterClose], new Date(at('23:00').getTime() + 30 * 1000));
      expect((await shadowRow(afterClose)).applied_action).toBe('skipped:after_auto_close');
      expect(await shifts(afterClose)).toHaveLength(0);
    });

    test('a shift made at 10:59 PM is still closed by the 11 PM close path (it is an ordinary active shift)', async () => {
      const tech = await makeTech();
      await shadow(tech, at('22:58'));
      await tick([tech], at('22:59'));
      jest.setSystemTime(at('23:00'));
      const closed = await timeTracking.closeActiveShiftAtomically(tech, { autoCloseReason: 'cron_11pm', shiftNote: 'AUTO CLOCK-OUT: 11 PM cron' });
      expect(closed).toBeTruthy();
      expect((await shifts(tech))[0].status).not.toBe('active');
    });

    test('midnight: a row from yesterday is not touched after midnight, the new day is', async () => {
      const tech = await makeTech();
      await shadow(tech, at('21:00'));
      await tick([tech], at('00:00', NEXT_DAY));
      expect((await shadowRow(tech)).applied_at).toBeNull();
      expect(await shifts(tech)).toHaveLength(0);

      const next = await makeTech();
      await shadow(next, at('00:00', NEXT_DAY), { work_date: NEXT_DAY });
      const result = await tick([next], new Date(at('00:00', NEXT_DAY).getTime() + 20 * 1000));
      expect(result.applied).toBe(1);
      const [shift] = await shifts(next);
      expect(shift.clock_in.toISOString()).toBe(at('00:00', NEXT_DAY).toISOString());
      expect((await shadowRow(next)).work_day).toBe(NEXT_DAY);
    });

    test('an 8:30 PM arrival is still its own Eastern day although UTC has rolled over', async () => {
      const tech = await makeTech();
      await shadow(tech, at('20:30'));
      await tick([tech], at('20:31'));
      expect((await shadowRow(tech)).applied_action).toBe('clocked_in');
      expect((await shifts(tech))[0].clock_in.toISOString()).toBe('2031-02-06T01:30:00.000Z');
    });

    test('a row whose GPS time falls on another Eastern day than its work date is refused', async () => {
      const tech = await makeTech();
      await shadow(tech, at('23:59', PREV_DAY));
      await tick([tech], at('08:00'));
      expect((await shadowRow(tech)).applied_action).toBe('skipped:event_wrong_day');
      expect(await shifts(tech)).toHaveLength(0);
    });

    test('daylight saving: the 11 PM close follows the zone (EDT day, UTC-4)', async () => {
      const tech = await makeTech();
      const summerDay = '2031-07-16';
      await shadow(tech, et('22:59', summerDay), { work_date: summerDay });
      jest.setSystemTime(et('22:59', summerDay));
      await tick([tech], et('22:59', summerDay));
      expect((await shadowRow(tech)).applied_action).toBe('clocked_in');
      expect((await shifts(tech))[0].clock_in.toISOString()).toBe('2031-07-17T02:59:00.000Z');
    });
  });

  describe('audit round 1', () => {
    test('a row from an unverified webhook, or from before the column, is never paid', async () => {
      const unverified = await makeTech();
      const legacy = await makeTech();
      await shadow(unverified, at('08:00'), { event_verified: false });
      await shadow(legacy, at('08:00'), { event_verified: null });
      await tick([unverified, legacy], at('08:01'));
      expect((await shadowRow(unverified)).applied_action).toBe('skipped:event_unverified');
      expect((await shadowRow(legacy)).applied_action).toBe('skipped:event_unverified');
      expect(await shifts(unverified)).toHaveLength(0);
      expect(await shifts(legacy)).toHaveLength(0);
    });

    test('a tick that waits on a lock past 11 PM writes nothing (the clock is re-read after the locks)', async () => {
      const tech = await makeTech();
      await shadow(tech, at('22:58'));
      const weekStart = require('../utils/staff-time-work-date').staffWeekStartForWorkDate(DAY);
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let locked;
      const lockTaken = new Promise((resolve) => { locked = resolve; });
      const holder = database.transaction(async (trx) => {
        await timeTracking.lockStaffWeek(trx, tech, weekStart);
        locked();
        await held;
      });
      await lockTaken;
      const running = tick([tech], at('22:58:30'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      jest.setSystemTime(at('23:00:20'));
      release();
      await holder;
      await running;
      expect((await shadowRow(tech)).applied_action).toBe('skipped:after_auto_close');
      expect(await shifts(tech)).toHaveLength(0);
    });

    test('the 11 PM closer waits for a write in flight, and a later write is refused by the clock', async () => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let locked;
      const lockTaken = new Promise((resolve) => { locked = resolve; });
      const inFlight = database.transaction(async (trx) => {
        await trx.raw("SELECT pg_advisory_xact_lock_shared(hashtextextended('truck-start-close', 0))");
        locked();
        await held;
      });
      await lockTaken;
      let barrierDone = false;
      const barrier = apply.waitForTruckStartWrites().then(() => { barrierDone = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(barrierDone).toBe(false);
      release();
      await inFlight;
      await barrier;
      expect(barrierDone).toBe(true);
    });

    test('a GPS time slightly ahead leaves the row pending, then applies it once the time has come', async () => {
      const tech = await makeTech();
      await shadow(tech, at('08:01:30'));
      const early = await tick([tech], at('08:00'));
      expect(early).toMatchObject({ applied: 0, skipped: 0, errors: 0 });
      expect((await shadowRow(tech)).applied_at).toBeNull();
      expect(await shifts(tech)).toHaveLength(0);
      await tick([tech], at('08:02'));
      expect((await shadowRow(tech)).applied_action).toBe('clocked_in');
      expect((await shifts(tech))[0].clock_in.toISOString()).toBe(at('08:01:30').toISOString());
    });

    test('a bell whose receipt is null is not marked sent; the next tick sends it once', async () => {
      const tech = await makeTech();
      await addShift(tech, at('07:40'));
      await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
      raise.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await tick([tech], at('08:01'));
      expect((await shadowRow(tech)).applied_detail.notified).toBe(false);
      await tick([tech], at('08:03'));
      expect((await shadowRow(tech)).applied_detail.notified).toBe(true);
      expect(raise).toHaveBeenCalledTimes(3);
    });

    test('an unsent review bell is retried the next Eastern day under its own work date; shifts are not written then', async () => {
      const tech = await makeTech();
      await addShift(tech, at('07:40'));
      await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
      raise.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'));
      await tick([tech], at('08:01'));
      expect((await shadowRow(tech)).applied_detail.notified).toBe(false);
      // The process was down overnight. A new day's row for the same technician is also pending.
      await shadow(tech, at('06:01', NEXT_DAY), { work_date: NEXT_DAY });
      await tick([tech], at('06:00', NEXT_DAY));
      const first = await database('truck_clock_in_shadow').where({ technician_id: tech, work_date: DAY }).first();
      expect(first.applied_detail.notified).toBe(true);
      expect(bells).toHaveLength(1);
      expect(bells[0].opts.dedupeKey).toBe(`truck-start:${tech}:${DAY}`);
      expect(bells[0].opts.metadata.workDate).toBe(DAY);
      // The new day's row (6:01 AM) is a minute ahead of the 6:00 AM tick, so it waits.
      expect((await database('truck_clock_in_shadow').where({ technician_id: tech, work_date: NEXT_DAY }).first()).applied_at).toBeNull();
    });

    test.each([
      ['an office-edited shift starting 3 minutes before the truck', { status: 'edited', edited_by: null }, '07:57', 'shift_edited_by_office'],
      ['an approved shift starting 14 minutes before the truck', { approval_status: 'approved' }, '07:46', 'shift_not_pending'],
      ['a disputed shift starting 3 minutes before the truck', { approval_status: 'disputed' }, '07:57', 'shift_not_pending'],
    ])('%s is a review with a bell, not a quiet pass', async (_label, over, clockIn, reason) => {
      const tech = await makeTech();
      await addShift(tech, at(clockIn), at('12:00'), over);
      await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
      await tick([tech], at('08:01'));
      const row = await shadowRow(tech);
      expect(row.applied_action).toBe('needs_review');
      expect(row.applied_detail.reason).toBe(reason);
      expect(bells).toHaveLength(1);
    });

    test('an early tap on an approved day is a review (the week guard runs on a no-change outcome too)', async () => {
      const tech = await makeTech();
      await addShift(tech, at('07:56'));
      await database('time_entry_daily_summary').insert({ technician_id: tech, work_date: DAY, status: 'approved' });
      await shadow(tech, at('08:00'), { would_clock_in: false, skip_reason: 'already_clocked_in' });
      await tick([tech], at('08:01'));
      expect((await shadowRow(tech)).applied_detail.reason).toBe('week_closed');
      expect(bells).toHaveLength(1);
    });
  });

  describe('switches and scope', () => {
    test.each([undefined, 'off', 'shadow', 'true', 'live'])('GATE_TRUCK_CLOCK_IN=%p writes nothing', async (value) => {
      const tech = await makeTech();
      await shadow(tech, at('08:00'));
      if (value === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = value;
      await tick([tech], at('08:01'));
      expect(await shifts(tech)).toHaveLength(0);
      expect((await shadowRow(tech)).applied_at).toBeNull();
    });

    test('staff maintenance mode writes nothing', async () => {
      const tech = await makeTech();
      await shadow(tech, at('08:00'));
      process.env.STAFF_MAINTENANCE_MODE = 'true';
      await tick([tech], at('08:01'));
      expect(await shifts(tech)).toHaveLength(0);
    });

    test('only the named technicians are touched', async () => {
      const mine = await makeTech();
      const other = await makeTech();
      await shadow(mine, at('08:00'));
      await shadow(other, at('08:00'));
      await tick([mine], at('08:01'));
      expect(await shifts(mine)).toHaveLength(1);
      expect(await shifts(other)).toHaveLength(0);
      expect((await shadowRow(other)).applied_at).toBeNull();
    });
  });
});
