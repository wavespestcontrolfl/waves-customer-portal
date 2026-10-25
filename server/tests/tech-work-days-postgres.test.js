/**
 * GATE_TECH_WORK_DAYS (owner 2026-10-25) against REAL Postgres: technicians.work_days
 * (migration 20261025200000), the slot-discovery seam, the commit-time refusal at
 * automatic paths, the office warning, and series upkeep. A mocked knex proves none
 * of the CHECK, the smallint[] round trip or the real queries.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or
 * a local scratch Postgres migrated with `knex migrate:latest`; it skips without one.
 * Fixtures are fictitious. Every row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// New Appointment's new-caller Book is a real office create; its own gate is on here.
// techWorkDaysLive stays the real reader (it reads the environment at call time).
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => (gate === 'newCallerBooking' ? true : actual.isEnabled(gate)) };
});

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031-03-03 is a Monday; Sunday 2031-03-09 is also the spring-forward day.
const WEEK = ['2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06', '2031-03-07', '2031-03-08', '2031-03-09'];
const [MON, TUE, , THU, FRI, SAT, SUN] = WEEK;
const MON_THU = [1, 2, 3, 4];
const ADDRESS = { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 };

postgres('technician work days (real Postgres)', () => {
  let db;
  let eligibility;
  const made = { techIds: [], visitIds: [], absenceIds: [] };
  let monThu;
  let everyDay;

  async function makeTech(name, workDays) {
    const [row] = await db('technicians')
      .insert({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        role: 'technician',
        employment_status: 'active',
        field_dispatchable: true,
        active: true,
        work_days: workDays,
      })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    db = require('../models/db');
    eligibility = require('../services/technician-eligibility');
    monThu = await makeTech('Synthetic Weekday', MON_THU);
    everyDay = await makeTech('Synthetic Everyday', null);
    const [absence] = await db('technician_absences')
      .insert({ technician_id: everyDay.id, absence_date: TUE, reason: 'other' })
      .returning(['id']);
    made.absenceIds.push(absence.id);
  });

  afterEach(() => { delete process.env.GATE_TECH_WORK_DAYS; });

  afterAll(async () => {
    if (made.visitIds.length) {
      await db('activity_log').whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del().catch(() => {});
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.absenceIds.length) await db('technician_absences').whereIn('id', made.absenceIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  describe('the column and its CHECK', () => {
    test('NULL and a one-to-seven list of days 0..6 are accepted and read back as numbers', async () => {
      const row = await db('technicians').where({ id: monThu.id }).first('work_days');
      expect(row.work_days).toEqual(MON_THU);
      expect((await db('technicians').where({ id: everyDay.id }).first('work_days')).work_days).toBeNull();
      const t = await makeTech('Synthetic Allweek', [0, 1, 2, 3, 4, 5, 6]);
      expect((await db('technicians').where({ id: t.id }).first('work_days')).work_days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    test.each([
      ['an empty list', '{}'],
      ['a day above 6', '{1,7}'],
      ['a negative day', '{-1,2}'],
      ['a NULL element', '{1,NULL}'],
      ['a two-dimensional list', '{{1},{2}}'],
      ['more than seven days', '{0,1,2,3,4,5,6,0}'],
    ])('refuses %s', async (_label, literal) => {
      await expect(db.raw('UPDATE technicians SET work_days = ?::smallint[] WHERE id = ?', [literal, monThu.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'technicians_work_days_check' });
      expect((await db('technicians').where({ id: monThu.id }).first('work_days')).work_days).toEqual(MON_THU);
    });

    test('the migration is idempotent and its down removes the column and the CHECK (rolled back here)', async () => {
      const migration = require('../models/migrations/20261025200000_technician_work_days');
      await expect(migration.up(db)).resolves.toBeUndefined();
      const marker = new Error('roll back the DDL');
      await expect(db.transaction(async (trx) => {
        await migration.down(trx);
        expect(await trx.schema.hasColumn('technicians', 'work_days')).toBe(false);
        await migration.down(trx); // a second down is a no-op
        await migration.up(trx);
        expect(await trx.schema.hasColumn('technicians', 'work_days')).toBe(true);
        throw marker;
      })).rejects.toBe(marker);
      expect(await db.schema.hasColumn('technicians', 'work_days')).toBe(true);
    });
  });

  describe('absentTechDays (the slot-discovery seam)', () => {
    const range = { dateFrom: MON, dateTo: SUN };

    test('gate off: only the uncleared absence, work_days ignored', async () => {
      const days = await eligibility.absentTechDays(db, { ...range, technicianIds: [monThu.id, everyDay.id] });
      expect(days).toEqual(new Set([`${everyDay.id}:${TUE}`]));
    });

    test('gate on: the Monday-to-Thursday tech is also off Fri, Sat and Sun (across the DST day); the all-days tech is not', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const days = await eligibility.absentTechDays(db, { ...range, technicianIds: [monThu.id, everyDay.id] });
      expect(days).toEqual(new Set([
        `${everyDay.id}:${TUE}`, `${monThu.id}:${FRI}`, `${monThu.id}:${SAT}`, `${monThu.id}:${SUN}`,
      ]));
    });

    test('the open-visit nudge opts out: gate on, includeOffDays false returns absences only', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const days = await eligibility.absentTechDays(db, { ...range, technicianIds: [monThu.id, everyDay.id], includeOffDays: false });
      expect(days).toEqual(new Set([`${everyDay.id}:${TUE}`]));
      // The nudge's own call site passes the option.
      expect(require('fs').readFileSync(require.resolve('../services/tech-open-visit-nudge'), 'utf8')).toContain('includeOffDays: false');
    });

    test('technicianIds narrows the off-day read too', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const days = await eligibility.absentTechDays(db, { ...range, technicianIds: [everyDay.id] });
      expect(days).toEqual(new Set([`${everyDay.id}:${TUE}`]));
    });
  });

  describe('assertAssignableTechnician at an automatic commit point', () => {
    test('with workDays and the gate on, a Friday is refused 422 TECH_NOT_ASSIGNABLE and a Thursday is not', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await db.transaction(async (trx) => {
        await expect(eligibility.assertAssignableTechnician(monThu.id, { conn: trx, date: FRI, workDays: true }))
          .rejects.toMatchObject({ status: 422, code: eligibility.NOT_ASSIGNABLE, offDay: true });
        await expect(eligibility.assertAssignableTechnician(monThu.id, { conn: trx, date: THU, workDays: true }))
          .resolves.toMatchObject({ id: monThu.id });
        await expect(eligibility.assertAssignableTechnician(everyDay.id, { conn: trx, date: FRI, workDays: true }))
          .resolves.toMatchObject({ id: everyDay.id });
      });
    });

    test('without the option (an office path) or with the gate off, the Friday is accepted', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await expect(eligibility.assertAssignableTechnician(monThu.id, { conn: db, date: FRI })).resolves.toMatchObject({ id: monThu.id });
      delete process.env.GATE_TECH_WORK_DAYS;
      await expect(eligibility.assertAssignableTechnician(monThu.id, { conn: db, date: FRI, workDays: true }))
        .resolves.toMatchObject({ id: monThu.id });
    });
  });

  describe('an office create onto an off day saves and warns', () => {
    let service;
    let serviceRow;
    beforeAll(async () => {
      service = require('../services/booking/new-caller-visit');
      serviceRow = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    });
    const input = (scheduledDate) => ({
      scheduledDate, windowStart: '10:00', serviceId: serviceRow.id, address: ADDRESS, technicianId: monThu.id,
    });

    test('gate on: the Friday visit is saved on the technician and the result carries "does not work on Fridays"', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const booked = await service.bookNewCallerVisit({ input: input(FRI) });
      made.visitIds.push(booked.visit.id);
      const row = await db('scheduled_services').where({ id: booked.visit.id }).first('technician_id', 'scheduled_date');
      expect(row.technician_id).toBe(monThu.id);
      expect(booked.warnings).toEqual([`${monThu.name} does not work on Fridays.`]);
    });

    test('gate on: a Thursday visit has no warning; gate off: no warning on the Friday either', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const thursday = await service.bookNewCallerVisit({ input: input(THU) });
      made.visitIds.push(thursday.visit.id);
      expect(thursday.warnings).toEqual([]);
      delete process.env.GATE_TECH_WORK_DAYS;
      const friday = await service.bookNewCallerVisit({ input: input(SAT) });
      made.visitIds.push(friday.visit.id);
      expect(friday.warnings).toEqual([]);
    });
  });

  describe('the office board assignment onto an off day saves and warns (assignDispatchJob)', () => {
    let service;
    let serviceRow;
    beforeAll(async () => {
      service = require('../services/booking/new-caller-visit');
      serviceRow = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    });
    async function unassignedVisit(scheduledDate) {
      const booked = await service.bookNewCallerVisit({
        input: { scheduledDate, windowStart: '14:00', serviceId: serviceRow.id, address: ADDRESS, technicianId: null },
      });
      made.visitIds.push(booked.visit.id);
      return booked.visit.id;
    }

    test('gate on: assigning the Monday-to-Thursday tech to a Friday visit succeeds with one warning line', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const jobId = await unassignedVisit(FRI);
      const { assignDispatchJob } = require('../services/dispatch-assignment');
      const out = await assignDispatchJob({ jobId, technicianId: monThu.id, actorId: null, emit: false });
      expect(out).toMatchObject({ changed: true, technicianName: monThu.name, warnings: [`${monThu.name} does not work on Fridays.`] });
      expect((await db('scheduled_services').where({ id: jobId }).first('technician_id')).technician_id).toBe(monThu.id);
    });

    test('gate on, a work day, and gate off: no warnings key', async () => {
      const { assignDispatchJob } = require('../services/dispatch-assignment');
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const thursdayJob = await unassignedVisit(THU);
      expect(await assignDispatchJob({ jobId: thursdayJob, technicianId: monThu.id, actorId: null, emit: false }))
        .not.toHaveProperty('warnings');
      delete process.env.GATE_TECH_WORK_DAYS;
      const fridayJob = await unassignedVisit(FRI);
      expect(await assignDispatchJob({ jobId: fridayJob, technicianId: monThu.id, actorId: null, emit: false }))
        .not.toHaveProperty('warnings');
    });
  });

  describe('series upkeep seeds an off-day child unassigned', () => {
    let seedTechnician;
    beforeAll(() => {
      seedTechnician = require('../routes/admin-schedule')._test.assignableRecurringTemplateTechnicianId;
    });
    const parent = () => ({ id: 'parent-1', technician_id: monThu.id });

    test('gate on: the Friday child is seeded unassigned, the Thursday child keeps the technician', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      expect(await seedTechnician(db, parent(), FRI)).toBeNull();
      expect(await seedTechnician(db, parent(), THU)).toBe(monThu.id);
      expect(await seedTechnician(db, { id: 'parent-2', technician_id: everyDay.id }, FRI)).toBe(everyDay.id);
    });

    test('gate off: the Friday child keeps the technician, as before', async () => {
      expect(await seedTechnician(db, parent(), FRI)).toBe(monThu.id);
    });

    test('inside a transaction (the nightly top-up path) the same rule holds', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await db.transaction(async (trx) => {
        expect(await seedTechnician(trx, parent(), SAT)).toBeNull();
      });
    });
  });
});
