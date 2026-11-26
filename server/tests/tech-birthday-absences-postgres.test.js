/**
 * Technician days off (owner 2026-11-24) against REAL Postgres, all inside ONE transaction that rolls back:
 * the daily sync writes ordinary absence rows, the partial unique index and cleared rows behave as the
 * service assumes, the existing readers (absentTechDays, assertAssignableTechnician, the board's out_today
 * query shape) honor the row with no new code, and the sync writes nothing to payroll and raises no notification.
 *
 * The suite's db is a proxy onto that transaction, so the sync (including the rows it writes for any other
 * active technician in the database) never commits anything. Runs in the DB-gated CI step (DATABASE_URL on
 * the migrated waves_test database) or a local scratch Postgres migrated with `knex migrate:latest`; it skips
 * without one. Fixtures are fictitious.
 */
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const { etDateString } = require('../utils/datetime-et');

jest.setTimeout(60000);

// 2031-01-15 noon ET; the horizon runs to 2031-05-15. 2031 is not a leap year.
const NOW = new Date('2031-01-15T17:00:00Z');
const IN_WINDOW = '2031-03-05';
const SECOND_WINDOW_DAY = '2031-04-10';

postgres('technician days off (real Postgres, rolled back)', () => {
  let database;
  let svc;
  let eligibility;
  let trx;
  const t = {};

  async function makeTech(name, { dob = null, status = 'active', ...patch } = {}) {
    const [row] = await trx('technicians')
      .insert({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        role: 'technician',
        employment_status: status,
        field_dispatchable: true,
        active: status === 'active',
        dob,
        ...patch,
      })
      .returning(['id', 'name']);
    return row;
  }

  const rowsFor = (id) => trx('technician_absences').where({ technician_id: id }).orderBy('absence_date').select('*');
  const dates = async (id) => (await rowsFor(id)).map((r) => (r.absence_date instanceof Date ? r.absence_date.toISOString().slice(0, 10) : String(r.absence_date).slice(0, 10)));
  const absenceCount = async () => Number((await trx('technician_absences').count('* as n').first()).n);

  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    svc = require('../services/tech-birthday-absences');
    eligibility = require('../services/technician-eligibility');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    t.plain = await makeTech('Synthetic Birthday', { dob: '1990-03-05' });
    t.twice = await makeTech('Synthetic Twice', { dob: '1988-04-10' });
    t.noDob = await makeTech('Synthetic NoDob');
    t.inactive = await makeTech('Synthetic Former', { dob: '1985-03-05', status: 'inactive' });
    t.office = await makeTech('Synthetic Office Staff', { dob: '1987-03-05', role: 'admin', field_dispatchable: false, employment_type: 'w2' });
    t.leap = await makeTech('Synthetic Leap', { dob: '1992-02-29' });
    t.sick = await makeTech('Synthetic Sick', { dob: '1991-03-05' });
    t.cleared = await makeTech('Synthetic Cleared', { dob: '1993-03-05' });
    await trx('technician_absences').insert({ technician_id: t.sick.id, absence_date: IN_WINDOW, reason: 'sick', note: 'synthetic' });
    await trx('technician_absences').insert({ technician_id: t.cleared.id, absence_date: IN_WINDOW, reason: 'other', cleared_at: new Date('2031-01-10T15:00:00Z') });
  });

  afterEach(async () => {
    await trx.rollback();
  });

  afterAll(async () => {
    await database.destroy();
  });

  test('writes one generic row per birthday in the window, and only for active technicians with a dob', async () => {
    const out = await svc.syncTechDaysOff({ now: NOW });
    expect(out.failed).toBe(0);
    expect(await dates(t.plain.id)).toEqual([IN_WINDOW]);
    expect(await dates(t.twice.id)).toEqual([SECOND_WINDOW_DAY]);
    expect(await dates(t.leap.id)).toEqual(['2031-02-28']);
    expect(await rowsFor(t.noDob.id)).toEqual([]);
    expect(await rowsFor(t.inactive.id)).toEqual([]);
    expect(await rowsFor(t.office.id)).toEqual([]); // office staff and admins are not field-dispatchable
    const [row] = await rowsFor(t.plain.id);
    expect(row).toMatchObject({ reason: 'other', note: null, created_by: null, cleared_at: null, redistribution: null, source: 'tech_days_off', system_cleared_at: null });
    // nothing reaches payroll
    expect(await trx('payroll_time_off').whereIn('technician_id', [t.plain.id, t.twice.id, t.leap.id]).first()).toBeUndefined();
  });

  test('an existing uncleared absence is left alone, and a cleared one is never re-created', async () => {
    await svc.syncTechDaysOff({ now: NOW });
    const [sick] = await rowsFor(t.sick.id);
    expect(sick).toMatchObject({ reason: 'sick', cleared_at: null });
    expect(await rowsFor(t.sick.id)).toHaveLength(1);
    const clearedRows = await rowsFor(t.cleared.id);
    expect(clearedRows).toHaveLength(1);
    expect(clearedRows[0].cleared_at).not.toBeNull();
  });

  test('a second tick writes nothing, and the open-row unique index still holds', async () => {
    await svc.syncTechDaysOff({ now: NOW });
    const before = await absenceCount();
    const out = await svc.syncTechDaysOff({ now: NOW });
    expect(out.written).toBe(0);
    expect(await absenceCount()).toBe(before);
    await trx.raw('SAVEPOINT attempt');
    await expect(trx('technician_absences').insert({ technician_id: t.plain.id, absence_date: IN_WINDOW, reason: 'other' }))
      .rejects.toMatchObject({ code: '23505' });
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
  });

  test('a row the office clears is not written again by the next tick', async () => {
    await svc.syncTechDaysOff({ now: NOW });
    await trx('technician_absences').where({ technician_id: t.plain.id, absence_date: IN_WINDOW }).update({ cleared_at: new Date('2031-01-20T15:00:00Z') });
    const out = await svc.syncTechDaysOff({ now: NOW });
    expect(out.written).toBe(0);
    expect(await rowsFor(t.plain.id)).toHaveLength(1);
  });

  test('a pass limited to some technician ids leaves every other technician alone', async () => {
    const out = await svc.syncTechDaysOff({ now: NOW, technicianIds: [t.plain.id] });
    expect(out.technicians).toBe(1);
    expect(await dates(t.plain.id)).toEqual([IN_WINDOW]);
    expect(await rowsFor(t.twice.id)).toEqual([]);
  });

  test('the existing readers honor the row with no new code', async () => {
    await svc.syncTechDaysOff({ now: NOW });
    const days = await eligibility.absentTechDays(trx, { dateFrom: '2031-04-01', dateTo: '2031-04-30', technicianIds: [t.twice.id, t.noDob.id] });
    expect(days).toEqual(new Set([`${t.twice.id}:${SECOND_WINDOW_DAY}`]));
    await expect(eligibility.assertAssignableTechnician(t.twice.id, { conn: trx, date: SECOND_WINDOW_DAY }))
      .rejects.toMatchObject({ code: 'TECH_NOT_ASSIGNABLE', status: 422 });
    await expect(eligibility.assertAssignableTechnician(t.twice.id, { conn: trx, date: '2031-04-11' })).resolves.toMatchObject({ id: t.twice.id });
    // the dispatch board's out_today predicate
    const out = await trx.raw(
      'SELECT EXISTS (SELECT 1 FROM technician_absences a WHERE a.technician_id = ? AND a.absence_date = ? AND a.cleared_at IS NULL) AS out_today',
      [t.twice.id, SECOND_WINDOW_DAY],
    );
    expect(out.rows[0].out_today).toBe(true);
  });

  describe('reconcile and reopen (real rows, real fence)', () => {
    const open = async (id) => (await rowsFor(id)).filter((r) => r.cleared_at === null);
    const day = (r) => r.absence_date.toISOString().slice(0, 10);

    test('a corrected dob clears the old future row (a system clear) and writes the new one', async () => {
      const tech = await makeTech('Synthetic Fixed', { dob: '1990-03-05' });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      expect(await dates(tech.id)).toEqual([IN_WINDOW]);
      await trx('technicians').where({ id: tech.id }).update({ dob: '1990-03-09' });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 1, cleared: 1, failed: 0 });
      const rows = await rowsFor(tech.id);
      expect(rows.map((r) => [day(r), r.cleared_at !== null])).toEqual([['2031-03-05', true], ['2031-03-09', false]]);
      expect(rows[0]).toMatchObject({ cleared_by: null, source: 'tech_days_off' });
      expect(rows[0].system_cleared_at).not.toBeNull();
      await expect(eligibility.assertAssignableTechnician(tech.id, { conn: trx, date: IN_WINDOW })).resolves.toMatchObject({ id: tech.id });
      await expect(eligibility.assertAssignableTechnician(tech.id, { conn: trx, date: '2031-03-09' })).rejects.toMatchObject({ code: 'TECH_NOT_ASSIGNABLE' });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, cleared: 0, reopened: 0 });
    });

    test('a technician who became inactive, not field-dispatchable, or lost the dob has the future row cleared', async () => {
      const a = await makeTech('Synthetic Left', { dob: '1990-03-05' });
      const b = await makeTech('Synthetic Desk Move', { dob: '1990-03-05' });
      const c = await makeTech('Synthetic No Dob', { dob: '1990-03-05' });
      const ids = [a.id, b.id, c.id];
      await svc.syncTechDaysOff({ now: NOW, technicianIds: ids });
      await trx('technicians').where({ id: a.id }).update({ employment_status: 'inactive', active: false });
      await trx('technicians').where({ id: b.id }).update({ field_dispatchable: false });
      await trx('technicians').where({ id: c.id }).update({ dob: null });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: ids })).toMatchObject({ written: 0, cleared: 3, failed: 0 });
      for (const id of ids) expect(await open(id)).toEqual([]);
    });

    test('a dob removed and then restored starts a new episode (a new id); the old system-cleared row stays as it was', async () => {
      const tech = await makeTech('Synthetic Restored', { dob: '1990-03-05' });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      const [original] = await rowsFor(tech.id);
      await trx('technicians').where({ id: tech.id }).update({ dob: null });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      expect(await open(tech.id)).toEqual([]);
      await trx('technicians').where({ id: tech.id }).update({ dob: '1990-03-05' });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, reopened: 1, failed: 0 });
      const rows = await rowsFor(tech.id);
      expect(rows).toHaveLength(2);
      const [oldRow] = rows.filter((r) => r.id === original.id);
      expect(oldRow.cleared_at).not.toBeNull();
      expect(oldRow.system_cleared_at).not.toBeNull();
      const [fresh] = await open(tech.id);
      expect(fresh).toMatchObject({ cleared_by: null, system_cleared_at: null, source: 'tech_days_off', reason: 'other' });
      expect(fresh.id).not.toBe(original.id);
      // a second pass changes nothing, and the unique open-row index holds
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, reopened: 0, cleared: 0 });
      // clear it again and restore again: a third episode, never a reopened row
      await trx('technicians').where({ id: tech.id }).update({ dob: null });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      await trx('technicians').where({ id: tech.id }).update({ dob: '1990-03-05' });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ reopened: 1 });
      expect(await rowsFor(tech.id)).toHaveLength(3);
    });

    test('a manual overflow dismissal of the old episode does not cover the new one: the sweep parks the stop again', async () => {
      process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
      try {
        const tech = await makeTech('Synthetic Dismissed', { dob: '1990-03-05' });
        const techOut = require('../services/tech-out');
        await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
        const [episodeOne] = await open(tech.id);
        const [visit] = await trx('scheduled_services').insert({
          technician_id: tech.id, scheduled_date: IN_WINDOW, status: 'pending', service_type: 'Synthetic Pest Visit',
          window_start: '09:00', window_end: '11:00',
        }).returning('id');
        const visitId = visit.id || visit;
        const alertsOf = () => trx('dispatch_alerts').where({ type: 'tech_out_overflow', tech_id: tech.id }).whereRaw("payload->>'date' = ?", [IN_WINDOW]).orderBy('created_at');
        // episode one: the sweep parks the stop; the dispatcher dismisses the card by hand; the next sweep leaves it dismissed
        await techOut.sweepAbsentTechDays({ now: NOW });
        let alerts = await alertsOf();
        expect(alerts).toHaveLength(1);
        expect(String(alerts[0].payload.absence_id)).toBe(String(episodeOne.id));
        await require('../services/dispatch-alerts').resolveAlert({ id: alerts[0].id, resolvedBy: null, trx });
        await techOut.sweepAbsentTechDays({ now: NOW });
        expect(await alertsOf()).toHaveLength(1);
        // the dob is removed and restored: a new episode with a new id
        await trx('technicians').where({ id: tech.id }).update({ dob: null });
        await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
        await trx('technicians').where({ id: tech.id }).update({ dob: '1990-03-05' });
        await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
        const [episodeTwo] = await open(tech.id);
        expect(episodeTwo.id).not.toBe(episodeOne.id);
        // the old dismissal (absence_id = episode one) does not cover the stop for the new episode
        await techOut.sweepAbsentTechDays({ now: NOW });
        alerts = await alertsOf();
        expect(alerts).toHaveLength(2);
        const fresh = alerts.find((a) => a.resolved_at === null);
        expect(String(fresh.payload.absence_id)).toBe(String(episodeTwo.id));
        expect(String(fresh.job_id)).toBe(String(visitId));
      } finally {
        delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
      }
    });

    test('a row the office cleared through clearTechOut records the office user and is never reopened', async () => {
      const tech = await makeTech('Synthetic Works', { dob: '1990-03-05' });
      const office = await makeTech('Synthetic Office User');
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      await require('../services/tech-out').clearTechOut({ technicianId: tech.id, date: IN_WINDOW, actorId: office.id });
      const [cleared] = await rowsFor(tech.id);
      expect(cleared).toMatchObject({ cleared_by: office.id, system_cleared_at: null, source: 'tech_days_off' });
      expect(cleared.cleared_at).not.toBeNull();
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, reopened: 0, skipped: 1 });
      expect(await open(tech.id)).toEqual([]);
      // even an office clear with no recorded user (cleared_by empty) has no system stamp, so it stays cleared
      await trx('technician_absences').where({ id: cleared.id }).update({ cleared_by: null });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ reopened: 0 });
      expect(await open(tech.id)).toEqual([]);
    });

    test('rows with another source (the office\'s, even a plain "other" with no note), cleared rows and past rows are never touched', async () => {
      const tech = await makeTech('Synthetic Office Rows', { dob: null });
      const author = await makeTech('Synthetic Author');
      const insert = (patch) => trx('technician_absences').insert({ technician_id: tech.id, reason: 'other', ...patch });
      await insert({ absence_date: '2031-02-01', reason: 'sick' });
      await insert({ absence_date: '2031-02-02', note: 'family' });
      await insert({ absence_date: '2031-02-03', created_by: author.id });
      await insert({ absence_date: '2031-02-04', cleared_at: new Date('2031-01-10T15:00:00Z') });
      await insert({ absence_date: '2031-01-14', source: 'tech_days_off' }); // yesterday: past, the sync's own
      await insert({ absence_date: '2031-02-05' }); // a plain 'other', no note, no author, source NULL: NOT the sync's
      await insert({ absence_date: '2031-02-06', source: 'tech_days_off' }); // the sync's own, dob null: this one IS cleared
      const before = await rowsFor(tech.id);
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 1, failed: 0 });
      const after = await rowsFor(tech.id);
      const changed = after.filter((row, n) => JSON.stringify(row) !== JSON.stringify(before[n]));
      expect(changed.map(day)).toEqual(['2031-02-06']);
    });

    test('an office-made row on the new birthday blocks a write, and the old own row still clears', async () => {
      const tech = await makeTech('Synthetic Same Day', { dob: '1990-03-05' });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      await trx('technicians').where({ id: tech.id }).update({ dob: '1990-03-09' });
      await trx('technician_absences').insert({ technician_id: tech.id, absence_date: '2031-03-09', reason: 'sick', note: 'office' });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, skipped: 1, cleared: 1 });
      expect((await open(tech.id)).map((r) => r.reason)).toEqual(['sick']);
    });

    test('a reconcile clear resolves the open parked overflow alerts of that tech-day, and only those', async () => {
      const tech = await makeTech('Synthetic Parked', { dob: '1990-03-05' });
      await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] });
      const alert = (patch) => trx('dispatch_alerts').insert({
        type: 'tech_out_overflow', severity: 'warn', tech_id: tech.id, payload: { date: IN_WINDOW }, ...patch,
      }).returning('id').then(([r]) => r.id || r);
      const mine = await alert({});
      const otherDay = await alert({ payload: { date: '2031-03-06' } });
      const otherType = await alert({ type: 'tech_late' });
      await trx('technicians').where({ id: tech.id }).update({ dob: null });
      expect(await svc.syncTechDaysOff({ now: NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 1, failed: 0 });
      const state = async (id) => (await trx('dispatch_alerts').where({ id }).first('resolved_at', 'resolved_by', 'payload'));
      const resolved = await state(mine);
      expect(resolved.resolved_at).not.toBeNull();
      expect(resolved.resolved_by).toBeNull();
      expect(resolved.payload.superseded_at).toBeTruthy(); // an automatic resolve, as clearTechOut does
      expect((await state(otherDay)).resolved_at).toBeNull();
      expect((await state(otherType)).resolved_at).toBeNull();
    });
  });

  test('the sync writes nothing to payroll and raises no notification', async () => {
    const tech = await makeTech('Synthetic Today', { dob: `1992-${etDateString().slice(5)}` });
    const notificationsBefore = Number((await trx('notifications').count('* as n').first()).n);
    expect(await svc.syncTechDaysOff({ technicianIds: [tech.id] })).toMatchObject({ written: 1, failed: 0 });
    expect(await trx('payroll_time_off').where({ technician_id: tech.id })).toEqual([]);
    expect(Number((await trx('notifications').count('* as n').first()).n)).toBe(notificationsBefore);
    expect(await trx('audit_log').whereRaw("metadata->>'technician_id' = ?", [tech.id])).toEqual([]);
  });

  test('office staff and admins (not field-dispatchable) get no row even on their day', async () => {
    const office = await makeTech('Synthetic Desk', { dob: `1992-${etDateString().slice(5)}`, role: 'admin', field_dispatchable: false });
    expect(await svc.syncTechDaysOff({ technicianIds: [office.id] })).toMatchObject({ technicians: 0, written: 0 });
    expect(await rowsFor(office.id)).toEqual([]);
  });

  // ---- Holiday taken days (owner 2026-11-24, Employee Handbook: Holidays) --------------------------------------------
  // 2026-11-24 noon ET; the horizon runs to 2027-03-24, so Christmas 2026 (Fri) and New Year's Day 2027 (Fri) are inside it.
  describe('holiday taken days', () => {
    const HOLIDAY_NOW = new Date('2026-11-24T17:00:00Z');
    const BIG6 = ['new_years_day', 'memorial_day', 'independence_day', 'labor_day', 'thanksgiving', 'christmas'];
    const MON_THU = [1, 2, 3, 4];

    async function setClosures(keys) {
      await trx('system_settings').where({ key: 'schedule_holiday_closures' }).del();
      await trx('system_settings').where({ key: 'schedule_weekly_days_off' }).del();
      if (keys) await trx('system_settings').insert({ key: 'schedule_holiday_closures', value: JSON.stringify(keys) });
    }
    const openRows = async (id) => (await rowsFor(id)).filter((r) => r.cleared_at == null);
    const openDates = async (id) => (await openRows(id)).map((r) => (r.absence_date instanceof Date ? r.absence_date.toISOString().slice(0, 10) : String(r.absence_date).slice(0, 10)));

    test('a Monday to Thursday technician is off the Thursday before a Friday holiday, and Waves stays open that day', async () => {
      await setClosures(BIG6);
      const tech = await makeTech('Synthetic MonThu', { work_days: MON_THU });
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ written: 2, failed: 0 });
      expect(await openDates(tech.id)).toEqual(['2026-12-24', '2026-12-31']);
      const [row] = await rowsFor(tech.id);
      expect(row).toMatchObject({ reason: 'other', note: null, source: 'tech_days_off', system_cleared_at: null });
      // the existing readers honor it, with no new code
      const days = await eligibility.absentTechDays(trx, { dateFrom: '2026-12-20', dateTo: '2026-12-31', technicianIds: [tech.id] });
      expect(days).toEqual(new Set([`${tech.id}:2026-12-24`, `${tech.id}:2026-12-31`]));
      const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
      const closed = await getBlackoutDates('2026-12-20', '2026-12-31', trx);
      expect(closed.has('2026-12-24')).toBe(false); // Waves is open the Thursday
      expect(closed.has('2026-12-25')).toBe(true);
    });

    test('Thanksgiving (a Thursday), a Sunday July 4 (its observed Monday is closed), NULL work_days and an every-day list give no row', async () => {
      await setClosures(['thanksgiving', 'independence_day']);
      const monThu = await makeTech('Synthetic MonThu2', { work_days: MON_THU });
      const nullDays = await makeTech('Synthetic NullDays');
      const allDays = await makeTech('Synthetic AllDays', { work_days: [0, 1, 2, 3, 4, 5, 6] });
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [monThu.id, nullDays.id] })).toMatchObject({ written: 0, failed: 0 });
      expect(await rowsFor(monThu.id)).toEqual([]);
      expect(await rowsFor(nullDays.id)).toEqual([]);
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [allDays.id] })).toMatchObject({ written: 0, failed: 0 });
      expect(await rowsFor(allDays.id)).toEqual([]);
      // July 4 2027 (Sunday): the pure rule names Monday 07-05, which the observed closure covers
      const july = await svc.syncTechDaysOff({ now: new Date('2027-06-20T17:00:00Z'), technicianIds: [monThu.id] });
      expect(july).toMatchObject({ written: 0, failed: 0 });
      expect(await rowsFor(monThu.id)).toEqual([]);
    });

    test('a birthday on the same date as a taken day is one row, and a second tick writes nothing', async () => {
      await setClosures(['christmas']);
      const tech = await makeTech('Synthetic Both', { work_days: MON_THU, dob: '1990-12-24' });
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ written: 1, failed: 0 });
      expect(await openDates(tech.id)).toEqual(['2026-12-24']);
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ written: 0, cleared: 0, failed: 0 });
      // the holiday reopened: the birthday still holds the day
      await setClosures([]);
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 0, failed: 0 });
      expect(await openDates(tech.id)).toEqual(['2026-12-24']);
    });

    test('a holiday reopened in settings clears its row as a system clear and resolves that day\'s parked alerts', async () => {
      await setClosures(['christmas']);
      const tech = await makeTech('Synthetic Reopen', { work_days: MON_THU });
      await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(await openDates(tech.id)).toEqual(['2026-12-24']);
      const [alert] = await trx('dispatch_alerts').insert({ type: 'tech_out_overflow', severity: 'warn', tech_id: tech.id, payload: { date: '2026-12-24' } }).returning('id');
      await setClosures([]);
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 1, written: 0, failed: 0 });
      const [row] = await rowsFor(tech.id);
      expect(row.cleared_at).not.toBeNull();
      expect(row.system_cleared_at).not.toBeNull();
      expect(row.cleared_by).toBeNull();
      expect((await trx('dispatch_alerts').where({ id: alert.id || alert }).first('resolved_at')).resolved_at).not.toBeNull();
      // closed again: a NEW episode (a new id), never the old row reopened
      await setClosures(['christmas']);
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ reopened: 1, failed: 0 });
      const rows = await rowsFor(tech.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).not.toBe(rows[1].id);
    });

    test('a work_days change moves the row; NULL work_days clears it', async () => {
      await setClosures(['christmas']);
      const tech = await makeTech('Synthetic Moves', { work_days: MON_THU });
      await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(await openDates(tech.id)).toEqual(['2026-12-24']);
      await trx('technicians').where({ id: tech.id }).update({ work_days: [1, 2, 3] });
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 1, written: 1, failed: 0 });
      expect(await openDates(tech.id)).toEqual(['2026-12-23']);
      await trx('technicians').where({ id: tech.id }).update({ work_days: null });
      expect(await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] })).toMatchObject({ cleared: 1, written: 0, failed: 0 });
      expect(await openDates(tech.id)).toEqual([]);
    });

    test('a technician who leaves loses the row; an office clear is never undone', async () => {
      await setClosures(['christmas', 'new_years_day']);
      const gone = await makeTech('Synthetic Leaves', { work_days: MON_THU });
      const back = await makeTech('Synthetic Back', { work_days: MON_THU });
      await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [gone.id, back.id] });
      await trx('technicians').where({ id: gone.id }).update({ employment_status: 'inactive', active: false });
      await trx('technician_absences').where({ technician_id: back.id, absence_date: '2026-12-24' })
        .update({ cleared_at: new Date('2026-11-25T15:00:00Z'), cleared_by: (await trx('technicians').first('id')).id });
      const out = await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [gone.id, back.id] });
      expect(out).toMatchObject({ cleared: 2, written: 0, failed: 0 });
      expect(await openDates(gone.id)).toEqual([]);
      expect(await openDates(back.id)).toEqual(['2026-12-31']);
    });

    test('a malformed stored closure list is an unreadable setting: no holiday row is written or cleared, one failure is counted', async () => {
      await setClosures(['christmas']);
      const tech = await makeTech('Synthetic Malformed', { work_days: MON_THU, dob: '1990-12-02' });
      await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(await openDates(tech.id)).toEqual(['2026-12-02', '2026-12-24']);
      await trx('system_settings').where({ key: 'schedule_holiday_closures' }).update({ value: '{not json' });
      await trx('technician_absences').where({ technician_id: tech.id, absence_date: '2026-12-02' }).del();
      const out = await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(out).toMatchObject({ written: 1, cleared: 0, failed: 1 });
      expect(await openDates(tech.id)).toEqual(['2026-12-02', '2026-12-24']); // the holiday row is still there
      // the default read is unchanged: fail open
      const { getClosedHolidays } = require('../services/scheduling/blackout-dates');
      expect((await getClosedHolidays(trx)).size).toBe(0);
      await expect(getClosedHolidays(trx, { strict: true })).rejects.toMatchObject({ code: 'MALFORMED_SETTING' });
    });

    test('an unreadable closure setting writes no holiday row and clears none, counts a failure, and birthdays still run', async () => {
      await setClosures(['christmas']);
      const tech = await makeTech('Synthetic Failing', { work_days: MON_THU, dob: '1990-12-02' });
      await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(await openDates(tech.id)).toEqual(['2026-12-02', '2026-12-24']);
      await setClosures([]);
      await trx('technician_absences').where({ technician_id: tech.id, absence_date: '2026-12-02' }).del();
      // A real read failure: the strict blackout read cannot find its table (DDL is transactional, so the rollback restores it).
      await trx.raw('ALTER TABLE schedule_blackout_dates RENAME TO schedule_blackout_dates_gone');
      const out = await svc.syncTechDaysOff({ now: HOLIDAY_NOW, technicianIds: [tech.id] });
      expect(out).toMatchObject({ written: 1, cleared: 0, failed: 1 });
      expect(await openDates(tech.id)).toEqual(['2026-12-02', '2026-12-24']);
    });
  });
});
