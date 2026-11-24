/**
 * GATE_TECH_WORK_DAYS (owner 2026-10-25) against REAL Postgres: technicians.work_days
 * (migration 20261025200000), the slot-discovery seam, the commit-time refusal at
 * automatic paths, the office warning, and series upkeep. A mocked knex proves none
 * of the CHECK, the smallint[] round trip or the real queries.
 * An office booking also says when the technician's shift does not hold the visit
 * (GATE_TECH_SHIFT_HOURS, D4 part 3c): the last block, on the same real rows.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or
 * a local scratch Postgres migrated with `knex migrate:latest`; it skips without one.
 * Fixtures are fictitious. Every row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The lead booking route is called as the office (the last block).
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Synthetic', last_name: 'Office' };
    req.techRole = 'admin';
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
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
  const made = { techIds: [], visitIds: [], absenceIds: [], leads: [] };
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
    // The lead booked in the last block: its visits, then the lead and its customer. Best effort,
    // on a database made for tests.
    for (const { leadId, customerId } of made.leads) {
      const visits = await db('scheduled_services').where({ customer_id: customerId }).pluck('id').catch(() => []);
      made.visitIds.push(...visits);
      for (const [table, where] of [['ad_service_attribution', { lead_id: leadId }], ['lead_activities', { lead_id: leadId }],
        ['customer_interactions', { customer_id: customerId }]]) {
        await db(table).where(where).del().catch(() => {});
      }
    }
    if (made.visitIds.length) {
      await db('activity_log').whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del().catch(() => {});
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.absenceIds.length) await db('technician_absences').whereIn('id', made.absenceIds).del();
    for (const { leadId, customerId } of made.leads) {
      await db('leads').where({ id: leadId }).del().catch(() => {});
      await db('customers').where({ id: customerId }).del().catch(() => {});
    }
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

  // GATE_TECH_SHIFT_HOURS (D4 part 3c): an office booking is told when the technician's shift does
  // not hold the visit. One reader gives both lines (technician-eligibility.dayWarningsFor), so each
  // path is asked once and never refused.
  describe('the office is told the shift (GATE_TECH_SHIFT_HOURS)', () => {
    // A Monday to Friday a year out, counted from today in Eastern time: the lead route refuses a date
    // that has passed, so a fixed week would fail once it did. Never WEEK itself (other blocks book it).
    const dayAfter = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const today = require('../utils/datetime-et').etDateString();
    const untilMonday = (8 - new Date(`${today}T12:00:00Z`).getUTCDay()) % 7;
    const monday = [364, 371].map((n) => dayAfter(today, n + untilMonday)).find((day) => day !== WEEK[0]);
    const [MON2, TUE2, WED2, THU2, FRI2] = [0, 1, 2, 3, 4].map((n) => dayAfter(monday, n));
    let service;
    let serviceRow;
    let morning;
    const line = () => `${morning.name}'s shift is 8:00 AM to 12:00 PM. This visit is outside those hours.`;
    const shiftLines = (warnings) => (warnings || []).filter((w) => /shift is/.test(w));
    beforeAll(async () => {
      service = require('../services/booking/new-caller-visit');
      serviceRow = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
      // On shift 08:00 to 12:00, Monday to Thursday.
      morning = await makeTech('Synthetic Morning', MON_THU);
      await db('technicians').where({ id: morning.id }).update({ shift_start: '08:00', shift_end: '12:00' });
    });
    afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });
    const book = async (scheduledDate, windowStart, durationMinutes, technicianId = morning.id) => {
      const booked = await service.bookNewCallerVisit({
        input: { scheduledDate, windowStart, durationMinutes, serviceId: serviceRow.id, address: ADDRESS, technicianId },
      });
      made.visitIds.push(booked.visit.id);
      return booked;
    };

    test('an office create outside the shift is saved on the technician and told; inside it, nothing; the length counts', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const late = await book(MON2, '14:00', 60);
      expect((await db('scheduled_services').where({ id: late.visit.id }).first('technician_id')).technician_id).toBe(morning.id);
      expect(late.warnings).toEqual([line()]);
      expect((await book(TUE2, '09:00', 60)).warnings).toEqual([]);
      // 11:00 for 90 minutes ends at 12:30, after the shift; for 60 minutes it ends with it.
      expect((await book(WED2, '11:00', 90)).warnings).toEqual([line()]);
      expect((await book(THU2, '11:00', 60)).warnings).toEqual([]);
      // A technician id spelled in capitals is the same technician: Postgres reads it back in lower case.
      expect((await book(THU2, '15:00', 60, morning.id.toUpperCase())).warnings).toEqual([line()]);
    });

    test('gate off: the same create has no line; both gates on, a day off gives the day-off line alone', async () => {
      expect((await book(MON2, '16:00', 60)).warnings).toEqual([]);
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      process.env.GATE_TECH_WORK_DAYS = 'true';
      expect((await book(FRI2, '16:00', 60)).warnings).toEqual([`${morning.name} does not work on Fridays.`]);
    });

    test('a lead booked from the office outside the shift is saved and told (POST /admin/leads/:id/schedule-appointment)', async () => {
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use('/admin/leads', require('../routes/admin-leads'));
      app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
      const server = app.listen(0, '127.0.0.1');
      // The lead is listed for afterAll before its rows are written, and the server closes whatever fails.
      const lead = { leadId: randomUUID(), customerId: randomUUID() };
      made.leads.push(lead);
      const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/admin/leads/${lead.leadId}/schedule-appointment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceType: 'Pest Control', technicianId: morning.id, ...body }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
      try {
        await new Promise((resolve) => server.once('listening', resolve));
        const phone = `+194155501${String(10 + Math.floor(Math.random() * 90))}`;
        await db('customers').insert({
          id: lead.customerId, first_name: 'Synthetic', last_name: 'Lead', active: true,
          email: `synthetic-lead-${lead.customerId}@example.invalid`, phone,
        });
        await db('leads').insert({ id: lead.leadId, customer_id: lead.customerId, first_name: 'Synthetic', phone });
        process.env.GATE_TECH_SHIFT_HOURS = 'true';
        // 11:00 for 90 minutes ends at 12:30, after the shift.
        const late = await post({ date: MON2, time: '11:00', durationMinutes: 90 });
        expect({ status: late.status, error: late.body.error, lines: shiftLines(late.body.warnings) }).toEqual({ status: 200, error: undefined, lines: [line()] });
        const visit = await db('scheduled_services').where({ customer_id: lead.customerId }).first('technician_id');
        expect(visit.technician_id).toBe(morning.id);
        const inside = await post({ date: TUE2, time: '11:00', durationMinutes: 60, rebook: true });
        expect({ status: inside.status, error: inside.body.error, lines: shiftLines(inside.body.warnings) }).toEqual({ status: 200, error: undefined, lines: [] });
        delete process.env.GATE_TECH_SHIFT_HOURS;
        const off = await post({ date: WED2, time: '15:00', durationMinutes: 60, rebook: true });
        expect({ status: off.status, error: off.body.error, lines: shiftLines(off.body.warnings) }).toEqual({ status: 200, error: undefined, lines: [] });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
