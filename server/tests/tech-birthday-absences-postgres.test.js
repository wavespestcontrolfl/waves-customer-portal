/**
 * Technician birthdays as technician_absences rows (owner 2026-11-24) against REAL Postgres: the daily
 * sync writes ordinary absence rows, the partial unique index and cleared rows behave as the service
 * assumes, and the existing readers (absentTechDays, assertAssignableTechnician, the board's out_today
 * query shape) honor the row with no new code.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a local scratch
 * Postgres migrated with `knex migrate:latest`; it skips without one. Fixtures are fictitious. Every row
 * it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031-01-15 noon ET; the horizon runs to 2031-05-15. 2031 is not a leap year.
const NOW = new Date('2031-01-15T17:00:00Z');
const IN_WINDOW = '2031-03-05';
const SECOND_WINDOW_DAY = '2031-04-10';

postgres('technician birthday absences (real Postgres)', () => {
  let db;
  let svc;
  let eligibility;
  const made = { techIds: [] };
  const t = {};

  async function makeTech(name, { dob = null, status = 'active' } = {}) {
    const [row] = await db('technicians')
      .insert({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        role: 'technician',
        employment_status: status,
        field_dispatchable: true,
        active: status === 'active',
        dob,
      })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  const rowsFor = (id) => db('technician_absences').where({ technician_id: id }).orderBy('absence_date').select('*');
  const dates = async (id) => (await rowsFor(id)).map((r) => (r.absence_date instanceof Date ? r.absence_date.toISOString().slice(0, 10) : String(r.absence_date).slice(0, 10)));

  beforeAll(async () => {
    db = require('../models/db');
    svc = require('../services/tech-birthday-absences');
    eligibility = require('../services/technician-eligibility');
    t.plain = await makeTech('Synthetic Birthday', { dob: '1990-03-05' });
    t.twice = await makeTech('Synthetic Twice', { dob: '1988-04-10' });
    t.noDob = await makeTech('Synthetic NoDob');
    t.inactive = await makeTech('Synthetic Former', { dob: '1985-03-05', status: 'inactive' });
    t.leap = await makeTech('Synthetic Leap', { dob: '1992-02-29' });
    t.sick = await makeTech('Synthetic Sick', { dob: '1991-03-05' });
    t.cleared = await makeTech('Synthetic Cleared', { dob: '1993-03-05' });
    await db('technician_absences').insert({ technician_id: t.sick.id, absence_date: IN_WINDOW, reason: 'sick', note: 'synthetic' });
    await db('technician_absences').insert({ technician_id: t.cleared.id, absence_date: IN_WINDOW, reason: 'other', cleared_at: new Date('2031-01-10T15:00:00Z') });
  });

  afterAll(async () => {
    if (made.techIds.length) {
      await db('technician_absences').whereIn('technician_id', made.techIds).del();
      await db('technicians').whereIn('id', made.techIds).del();
    }
    await db.destroy();
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
  });

  test('an existing uncleared absence is left alone, and a cleared one is never re-created', async () => {
    const [sick] = await rowsFor(t.sick.id);
    expect(sick).toMatchObject({ reason: 'sick', cleared_at: null });
    expect(await rowsFor(t.sick.id)).toHaveLength(1);
    const clearedRows = await rowsFor(t.cleared.id);
    expect(clearedRows).toHaveLength(1);
    expect(clearedRows[0].cleared_at).not.toBeNull();
  });

  test('a second tick writes nothing, and the open-row unique index still holds', async () => {
    const before = await db('technician_absences').whereIn('technician_id', made.techIds).count('* as n').first();
    const out = await svc.syncTechDaysOff({ now: NOW });
    expect(out.written).toBe(0);
    const after = await db('technician_absences').whereIn('technician_id', made.techIds).count('* as n').first();
    expect(Number(after.n)).toBe(Number(before.n));
    await expect(db('technician_absences').insert({ technician_id: t.plain.id, absence_date: IN_WINDOW, reason: 'other' }))
      .rejects.toMatchObject({ code: '23505' });
  });

  test('a row the office clears is not written again by the next tick', async () => {
    await db('technician_absences').where({ technician_id: t.plain.id, absence_date: IN_WINDOW }).update({ cleared_at: new Date('2031-01-20T15:00:00Z') });
    const out = await svc.syncTechDaysOff({ now: NOW });
    expect(out.written).toBe(0);
    expect(await rowsFor(t.plain.id)).toHaveLength(1);
  });

  test('the existing readers honor the row with no new code', async () => {
    // t.twice still has its uncleared row
    const days = await eligibility.absentTechDays(db, { dateFrom: '2031-04-01', dateTo: '2031-04-30', technicianIds: [t.twice.id, t.noDob.id] });
    expect(days).toEqual(new Set([`${t.twice.id}:${SECOND_WINDOW_DAY}`]));
    await expect(eligibility.assertAssignableTechnician(t.twice.id, { conn: db, date: SECOND_WINDOW_DAY }))
      .rejects.toMatchObject({ code: 'TECH_NOT_ASSIGNABLE', status: 422 });
    await expect(eligibility.assertAssignableTechnician(t.twice.id, { conn: db, date: '2031-04-11' })).resolves.toMatchObject({ id: t.twice.id });
    // the dispatch board's out_today predicate
    const out = await db.raw(
      'SELECT EXISTS (SELECT 1 FROM technician_absences a WHERE a.technician_id = ? AND a.absence_date = ? AND a.cleared_at IS NULL) AS out_today',
      [t.twice.id, SECOND_WINDOW_DAY],
    );
    expect(out.rows[0].out_today).toBe(true);
  });
});
