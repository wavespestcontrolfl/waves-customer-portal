/**
 * Technician birthday off (owner 2026-11-24) against REAL Postgres: technicians.dob
 * (migration 20260428000007) through the slot-discovery seam, the commit-time refusal and
 * series upkeep. A mocked knex proves none of the DATE column's round trip or the real queries.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a
 * local scratch Postgres migrated with `knex migrate:latest`; it skips without one.
 * Fixtures are fictitious. Every row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031 is not a leap year. 2032-02-29 exists; 2031-02-28 is the common-year stand-in.
const DAY_BEFORE = '2031-03-04';
const BIRTHDAY = '2031-03-05';
const DAY_AFTER = '2031-03-06';
const RANGE = { dateFrom: '2031-03-01', dateTo: '2031-03-10' };

postgres('technician birthday off (real Postgres)', () => {
  let db;
  let eligibility;
  const made = { techIds: [] };
  let birthdayTech;
  let noDobTech;
  let leapTech;
  let inactiveTech;

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

  beforeAll(async () => {
    db = require('../models/db');
    eligibility = require('../services/technician-eligibility');
    birthdayTech = await makeTech('Synthetic Birthday', { dob: '1990-03-05' });
    noDobTech = await makeTech('Synthetic NoDob');
    leapTech = await makeTech('Synthetic Leap', { dob: '1992-02-29' });
    inactiveTech = await makeTech('Synthetic Former', { dob: '1985-03-05', status: 'inactive' });
  });

  afterAll(async () => {
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  describe('absentTechDays (the slot-discovery seam)', () => {
    test('an active technician is away on their own birthday, any year, and only then', async () => {
      const ids = [birthdayTech.id, noDobTech.id, inactiveTech.id];
      const days = await eligibility.absentTechDays(db, { ...RANGE, technicianIds: ids });
      expect(days).toEqual(new Set([`${birthdayTech.id}:${BIRTHDAY}`]));
    });

    test('a Feb 29 birthday is kept on Feb 28 in a common year and on Feb 29 in a leap year', async () => {
      const common = await eligibility.absentTechDays(db, { dateFrom: '2031-02-20', dateTo: '2031-03-02', technicianIds: [leapTech.id] });
      expect(common).toEqual(new Set([`${leapTech.id}:2031-02-28`]));
      const leap = await eligibility.absentTechDays(db, { dateFrom: '2032-02-20', dateTo: '2032-03-02', technicianIds: [leapTech.id] });
      expect(leap).toEqual(new Set([`${leapTech.id}:2032-02-29`]));
    });

    test('includeBirthdays: false leaves it out', async () => {
      const days = await eligibility.absentTechDays(db, { ...RANGE, technicianIds: [birthdayTech.id], includeBirthdays: false });
      expect(days).toEqual(new Set());
    });

    test('inside a transaction the same read holds', async () => {
      await db.transaction(async (trx) => {
        const days = await eligibility.absentTechDays(trx, { ...RANGE, technicianIds: [birthdayTech.id] });
        expect(days).toEqual(new Set([`${birthdayTech.id}:${BIRTHDAY}`]));
      });
    });
  });

  describe('assertAssignableTechnician', () => {
    test('refuses the birthday, allows the day before and after, and the technician with no dob', async () => {
      await expect(eligibility.assertAssignableTechnician(birthdayTech.id, { conn: db, date: BIRTHDAY }))
        .rejects.toMatchObject({ code: 'TECH_NOT_ASSIGNABLE', status: 422, message: expect.stringContaining(`is unavailable on ${BIRTHDAY}`) });
      await expect(eligibility.assertAssignableTechnician(birthdayTech.id, { conn: db, date: DAY_BEFORE })).resolves.toMatchObject({ id: birthdayTech.id });
      await expect(eligibility.assertAssignableTechnician(birthdayTech.id, { conn: db, date: DAY_AFTER })).resolves.toMatchObject({ id: birthdayTech.id });
      await expect(eligibility.assertAssignableTechnician(noDobTech.id, { conn: db, date: BIRTHDAY })).resolves.toMatchObject({ id: noDobTech.id });
    });

    test('inside a transaction (FOR SHARE) the refusal holds', async () => {
      await db.transaction(async (trx) => {
        await expect(eligibility.assertAssignableTechnician(birthdayTech.id, { conn: trx, date: BIRTHDAY }))
          .rejects.toMatchObject({ code: 'TECH_NOT_ASSIGNABLE' });
      });
    });
  });

  describe('series upkeep seeds a birthday child unassigned', () => {
    let seedTechnician;
    beforeAll(() => {
      seedTechnician = require('../routes/admin-schedule')._test.assignableRecurringTemplateTechnicianId;
    });
    const parent = (id) => ({ id: 'parent-1', technician_id: id });

    test('the birthday child has no technician; the next day keeps them', async () => {
      expect(await seedTechnician(db, parent(birthdayTech.id), BIRTHDAY)).toBeNull();
      expect(await seedTechnician(db, parent(birthdayTech.id), DAY_AFTER)).toBe(birthdayTech.id);
      expect(await seedTechnician(db, parent(noDobTech.id), BIRTHDAY)).toBe(noDobTech.id);
    });
  });
});
