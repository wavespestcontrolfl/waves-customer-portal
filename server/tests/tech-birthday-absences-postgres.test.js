/**
 * Technician days off (owner 2026-11-24) against REAL Postgres, all inside ONE transaction that rolls back:
 * the daily sync writes ordinary absence rows, the partial unique index and cleared rows behave as the
 * service assumes, the existing readers (absentTechDays, assertAssignableTechnician, the board's out_today
 * query shape) honor the row with no new code, and the pay half (GATE_TECH_BIRTHDAY_PAY) records one
 * holiday-kind entry that a pay run counts exactly once and that never draws the time-off bank.
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
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031-01-15 noon ET; the horizon runs to 2031-05-15. 2031 is not a leap year.
const NOW = new Date('2031-01-15T17:00:00Z');
const IN_WINDOW = '2031-03-05';
const SECOND_WINDOW_DAY = '2031-04-10';

// A finished staff week a few weeks back, derived from the real clock (payroll time off refuses a date more than 400
// days from today, so a fixed date would start failing), and the day inside it a pay-half tick runs on.
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const WEEK = staffWeekStartForWorkDate(addStaffWorkDays(etDateString(), -21));
const WEEK_END = addStaffWorkDays(WEEK, 6);
const PAY_DAY = addStaffWorkDays(WEEK, 3);
const PAY_NOW = parseETDateTime(`${PAY_DAY}T12:00`);
const PAY_DOB = `1992-${PAY_DAY.slice(5)}`; // 1992 is a leap year, so any month and day is a real date

postgres('technician days off (real Postgres, rolled back)', () => {
  let database;
  let svc;
  let eligibility;
  let trx;
  const OLD_PAY = process.env.GATE_TECH_BIRTHDAY_PAY;
  const OLD_PAYROLL = process.env.GATE_PAYROLL;
  const OLD_TIME_OFF = process.env.GATE_PAYROLL_TIME_OFF;
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
    delete process.env.GATE_TECH_BIRTHDAY_PAY;
    t.plain = await makeTech('Synthetic Birthday', { dob: '1990-03-05' });
    t.twice = await makeTech('Synthetic Twice', { dob: '1988-04-10' });
    t.noDob = await makeTech('Synthetic NoDob');
    t.inactive = await makeTech('Synthetic Former', { dob: '1985-03-05', status: 'inactive' });
    t.leap = await makeTech('Synthetic Leap', { dob: '1992-02-29' });
    t.sick = await makeTech('Synthetic Sick', { dob: '1991-03-05' });
    t.cleared = await makeTech('Synthetic Cleared', { dob: '1993-03-05' });
    await trx('technician_absences').insert({ technician_id: t.sick.id, absence_date: IN_WINDOW, reason: 'sick', note: 'synthetic' });
    await trx('technician_absences').insert({ technician_id: t.cleared.id, absence_date: IN_WINDOW, reason: 'other', cleared_at: new Date('2031-01-10T15:00:00Z') });
  });

  afterEach(async () => {
    await trx.rollback();
    for (const [name, old] of [['GATE_TECH_BIRTHDAY_PAY', OLD_PAY], ['GATE_PAYROLL', OLD_PAYROLL], ['GATE_PAYROLL_TIME_OFF', OLD_TIME_OFF]]) {
      if (old === undefined) delete process.env[name]; else process.env[name] = old;
    }
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
    const [row] = await rowsFor(t.plain.id);
    expect(row).toMatchObject({ reason: 'other', note: null, created_by: null, cleared_at: null, redistribution: null });
    // the pay half is dark: nothing reaches payroll
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

  describe('the pay half', () => {
    const rowsOff = (id) => trx('payroll_time_off').where({ technician_id: id }).select('*');
    const payDate = (row) => (row.work_date instanceof Date ? row.work_date.toISOString().slice(0, 10) : String(row.work_date).slice(0, 10));

    async function payTech(name, patch = {}) {
      const tech = await makeTech(name, {
        dob: PAY_DOB, employment_type: 'w2', pay_rate: '22.00', ...patch,
      });
      await trx('payroll_w4_elections').insert({
        technician_id: tech.id, form_year: Number(WEEK.slice(0, 4)), filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
      });
      await trx('time_weekly_summary').insert({
        technician_id: tech.id, week_start: WEEK, week_end: WEEK_END, status: 'approved', regular_minutes: '1800.00', overtime_minutes: '0.00',
      });
      return tech;
    }
    const tickOn = (techIds) => svc.syncTechDaysOff({ now: PAY_NOW, technicianIds: techIds });

    beforeEach(() => {
      process.env.GATE_TECH_BIRTHDAY_PAY = 'true';
      process.env.GATE_PAYROLL = 'true';
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
    });

    test('on the day, with the gate on: one 10 hour holiday entry, through the service (audited), once', async () => {
      const tech = await payTech('Synthetic Payday');
      const out = await tickOn([tech.id]);
      expect(out).toMatchObject({ written: 1, paid: 1, failed: 0 });
      const rows = await rowsOff(tech.id);
      expect(rows).toHaveLength(1);
      expect(payDate(rows[0])).toBe(PAY_DAY);
      expect(rows[0]).toMatchObject({ kind: 'holiday', minutes: '600.00', note: 'Paid day off', illness: false });
      const audit = await trx('audit_log').where({ action: 'payroll.time_off_added' }).whereRaw("metadata->>'technician_id' = ?", [tech.id]);
      expect(audit).toHaveLength(1);
      // a second tick the same day writes nothing more
      expect(await tickOn([tech.id])).toMatchObject({ written: 0, paid: 0, paySkipped: 1 });
      expect(await rowsOff(tech.id)).toHaveLength(1);
    });

    test('gate off: the absence is written and no pay entry is', async () => {
      delete process.env.GATE_TECH_BIRTHDAY_PAY;
      const tech = await payTech('Synthetic Dark');
      expect(await tickOn([tech.id])).toMatchObject({ written: 1, paid: 0 });
      expect(await rowsOff(tech.id)).toEqual([]);
    });

    test('a pay run counts the day exactly once, at the straight rate, and never draws the time-off bank', async () => {
      const payrollRuns = require('../services/payroll-runs');
      const tech = await payTech('Synthetic Bank', { pto_hours_per_year: '80', hire_date: '2025-01-06' });
      await tickOn([tech.id]);
      await tickOn([tech.id]);
      const created = await payrollRuns.draftRun({ weekStart: WEEK }, null, trx);
      const check = created.checks.find((c) => c.name === tech.name);
      // 30 hours worked + 10 hours of holiday at 22.00 an hour; no paid time off, so the bank is untouched
      expect(check).toMatchObject({
        regularHours: '30.00', ptoHours: '0.00', holidayHours: '10.00', ptoPayCents: 0, holidayPayCents: 22000, grossCents: 88000,
      });
      const bankUse = await trx('payroll_checks').where({ id: check.id }).first('pto_minutes');
      expect(Number(bankUse.pto_minutes)).toBe(0);
      expect(await rowsOff(tech.id)).toHaveLength(1);
      // recomputing the same draft reads the same single entry
      const again = await payrollRuns.recomputeRun(created.id, null, trx);
      expect(again.checks.find((c) => c.name === tech.name)).toMatchObject({ holidayHours: '10.00', grossCents: 88000 });
    });

    test('never over an entry the office made for the date, and never again after the office removed it', async () => {
      const tech = await payTech('Synthetic Office');
      await trx('payroll_time_off').insert({ technician_id: tech.id, work_date: PAY_DAY, kind: 'pto', minutes: '480.00' });
      expect(await tickOn([tech.id])).toMatchObject({ paid: 0, paySkipped: 1 });
      expect(await rowsOff(tech.id)).toMatchObject([{ kind: 'pto', minutes: '480.00' }]);

      const other = await payTech('Synthetic Removed');
      await tickOn([other.id]);
      const [entry] = await rowsOff(other.id);
      await require('../services/payroll-time-off').deleteTimeOff(entry.id, null, trx);
      expect(await rowsOff(other.id)).toEqual([]);
      expect(await tickOn([other.id])).toMatchObject({ paid: 0, paySkipped: 1 });
      expect(await rowsOff(other.id)).toEqual([]);
    });

    test('a tick that did not run is made up by a later one, once', async () => {
      const tech = await payTech('Synthetic Late');
      delete process.env.GATE_TECH_BIRTHDAY_PAY;
      await tickOn([tech.id]); // the absence row is written; the pay half is dark
      process.env.GATE_TECH_BIRTHDAY_PAY = 'true';
      const later = new Date(PAY_NOW.getTime() + 3 * 24 * 3600 * 1000);
      expect(await svc.syncTechDaysOff({ now: later, technicianIds: [tech.id] })).toMatchObject({ paid: 1, written: 0 });
      expect(await svc.syncTechDaysOff({ now: later, technicianIds: [tech.id] })).toMatchObject({ paid: 0, paySkipped: 1 });
      const rows = await rowsOff(tech.id);
      expect(rows).toHaveLength(1);
      expect(payDate(rows[0])).toBe(PAY_DAY);
    });

    test('an office-cleared absence and a contractor pay nothing', async () => {
      const cleared = await payTech('Synthetic Back');
      await trx('technician_absences').insert({ technician_id: cleared.id, absence_date: PAY_DAY, reason: 'other', cleared_at: new Date() });
      const contractor = await payTech('Synthetic Contract', { employment_type: '1099' });
      const out = await tickOn([cleared.id, contractor.id]);
      expect(out).toMatchObject({ paid: 0, paySkipped: 2 });
      expect(await rowsOff(cleared.id)).toEqual([]);
      expect(await rowsOff(contractor.id)).toEqual([]);
    });
  });
});
