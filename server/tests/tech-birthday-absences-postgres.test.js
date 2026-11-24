/**
 * Technician days off (owner 2026-11-24) against REAL Postgres, all inside ONE transaction that rolls back:
 * the daily sync writes ordinary absence rows, the partial unique index and cleared rows behave as the
 * service assumes, the existing readers (absentTechDays, assertAssignableTechnician, the board's out_today
 * query shape) honor the row with no new code, and the day-of office reminder is one admin bell per technician
 * and date that writes nothing to payroll.
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
    expect(row).toMatchObject({ reason: 'other', note: null, created_by: null, cleared_at: null, redistribution: null });
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

  describe('the office reminder', () => {
    const today = etDateString();
    const bells = (id) => trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`tech-day-off-pay:${id}:${today}`]);

    async function bornToday(name, patch = {}) {
      return makeTech(name, { dob: `1992-${today.slice(5)}`, ...patch });
    }

    test('one bell for the day, still one after a second tick, and nothing in payroll', async () => {
      const tech = await bornToday('Synthetic Today');
      expect(await svc.syncTechDaysOff({ technicianIds: [tech.id] })).toMatchObject({ written: 1, reminded: 1, failed: 0 });
      const first = await bells(tech.id);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ category: 'payroll' });
      expect(first[0].title).toContain('paid day off');
      expect(`${first[0].title} ${first[0].body}`).not.toMatch(/birth/i);
      await svc.syncTechDaysOff({ technicianIds: [tech.id] });
      expect(await bells(tech.id)).toHaveLength(1);
      expect(await trx('payroll_time_off').where({ technician_id: tech.id })).toEqual([]);
      expect(await trx('audit_log').whereRaw("metadata->>'technician_id' = ?", [tech.id])).toEqual([]);
    });

    test('no bell when the office cleared the row, when the row is a sick day, or for office staff', async () => {
      const cleared = await bornToday('Synthetic Back');
      await trx('technician_absences').insert({ technician_id: cleared.id, absence_date: today, reason: 'other', cleared_at: new Date() });
      const sick = await bornToday('Synthetic Ill');
      await trx('technician_absences').insert({ technician_id: sick.id, absence_date: today, reason: 'sick' });
      const office = await bornToday('Synthetic Desk', { role: 'admin', field_dispatchable: false });
      expect(await svc.syncTechDaysOff({ technicianIds: [cleared.id, sick.id, office.id] })).toMatchObject({ reminded: 0, failed: 0 });
      for (const tech of [cleared, sick, office]) expect(await bells(tech.id)).toEqual([]);
    });
  });
});
