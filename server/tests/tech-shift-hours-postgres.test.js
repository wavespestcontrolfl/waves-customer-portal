/**
 * GATE_TECH_SHIFT_HOURS (owner 2026-11-19, ad budget rule v2 page item D4) against
 * REAL Postgres: technicians.shift_start / shift_end (migration 20261120213000), the
 * time round trip, the CHECK, and loadTechShifts reading the hours and today's
 * clock-in from time_entries on the Staff work date. A mocked knex proves none of
 * the CHECK, the time type or the Eastern work-date SQL.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or
 * a local scratch Postgres migrated with `knex migrate:latest`; it skips without one.
 * Fixtures are fictitious. Every row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031-03-04 is a Tuesday before the 2031-03-09 spring-forward (EST, UTC-5).
// 15:00Z = 10:00 AM EST on 2031-03-04.
const NOW = new Date('2031-03-04T15:00:00Z');
const TODAY = '2031-03-04';
const TOMORROW = '2031-03-05';

postgres('technician shift hours (real Postgres)', () => {
  let db;
  let eligibility;
  let ACTIVE_WRITE_GENERATION;
  const made = { techIds: [], entryIds: [] };
  let dayTech;
  let lateTech;
  let noHours;

  async function makeTech(name, hours) {
    const [row] = await db('technicians')
      .insert({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        role: 'technician',
        employment_status: 'active',
        field_dispatchable: true,
        active: true,
        shift_start: hours ? hours[0] : null,
        shift_end: hours ? hours[1] : null,
      })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  async function clockIn(techId, at, status) {
    const id = randomUUID();
    await db('time_entries').insert({
      id,
      technician_id: techId,
      entry_type: 'shift',
      status,
      staff_write_generation: status === 'active' ? ACTIVE_WRITE_GENERATION : null,
      clock_in: new Date(at),
      ...(status === 'active' ? {} : { clock_out: new Date(new Date(at).getTime() + 60 * 60000), duration_minutes: 60 }),
    });
    made.entryIds.push(id);
  }

  beforeAll(async () => {
    db = require('../models/db');
    eligibility = require('../services/technician-eligibility');
    ({ ACTIVE_WRITE_GENERATION } = require('../constants/staff-time'));
    dayTech = await makeTech('Synthetic Shift', ['08:00', '18:00']);
    lateTech = await makeTech('Synthetic Late', ['10:00', '20:00']);
    noHours = await makeTech('Synthetic Open', null);
    // dayTech: a completed clock-in at 7:52 AM EST today (out at 8:52), an active one at 9:30 AM, a voided one
    // at 6:00 AM, and a completed one the evening before (01:00Z on 2031-03-04 is 8:00 PM EST on 2031-03-03:
    // the UTC date is today, the Staff work date is not).
    await clockIn(dayTech.id, '2031-03-04T12:52:00Z', 'completed');
    await clockIn(dayTech.id, '2031-03-04T14:30:00Z', 'active');
    await clockIn(dayTech.id, '2031-03-04T11:00:00Z', 'voided');
    await clockIn(dayTech.id, '2031-03-04T01:00:00Z', 'completed');
    // lateTech: only last evening's clock-in, which is not today's.
    await clockIn(lateTech.id, '2031-03-04T01:30:00Z', 'completed');
  });

  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });

  afterAll(async () => {
    if (made.entryIds.length) await db('time_entries').whereIn('id', made.entryIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  describe('the columns and their CHECK', () => {
    test('both NULL, or both set, are accepted; the times read back as HH:MM:SS', async () => {
      expect(await db('technicians').where({ id: dayTech.id }).first('shift_start', 'shift_end'))
        .toEqual({ shift_start: '08:00:00', shift_end: '18:00:00' });
      expect(await db('technicians').where({ id: noHours.id }).first('shift_start', 'shift_end'))
        .toEqual({ shift_start: null, shift_end: null });
    });

    test.each([
      ['only a start', '07:00', null],
      ['only an end', null, '17:00'],
      ['an end before the start', '18:00', '08:00'],
      ['an end equal to the start', '08:00', '08:00'],
    ])('refuses %s', async (_label, start, end) => {
      await expect(db('technicians').where({ id: noHours.id }).update({ shift_start: start, shift_end: end }))
        .rejects.toMatchObject({ code: '23514', constraint: 'technicians_shift_hours_check' });
      expect(await db('technicians').where({ id: noHours.id }).first('shift_start', 'shift_end'))
        .toEqual({ shift_start: null, shift_end: null });
    });

    test('the migration is idempotent and its down removes both columns and the CHECK (rolled back here)', async () => {
      const migration = require('../models/migrations/20261120213000_technician_shift_hours');
      await expect(migration.up(db)).resolves.toBeUndefined();
      const marker = new Error('roll back the DDL');
      await expect(db.transaction(async (trx) => {
        await migration.down(trx);
        expect(await trx.schema.hasColumn('technicians', 'shift_start')).toBe(false);
        expect(await trx.schema.hasColumn('technicians', 'shift_end')).toBe(false);
        await migration.down(trx); // a second down is a no-op
        await migration.up(trx);
        expect(await trx.schema.hasColumn('technicians', 'shift_end')).toBe(true);
        throw marker;
      })).rejects.toBe(marker);
      expect(await db.schema.hasColumn('technicians', 'shift_start')).toBe(true);
    });
  });

  describe('loadTechShifts', () => {
    const ids = () => [dayTech.id, lateTech.id, noHours.id];

    test('gate off: every lookup is null', async () => {
      const shiftOf = await eligibility.loadTechShifts(db, { technicianIds: ids(), now: NOW });
      expect(shiftOf(dayTech.id, TODAY)).toBeNull();
    });

    test('gate on: today runs from the first clock-in that is not voided, on the Eastern work date', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const shiftOf = await eligibility.loadTechShifts(db, { technicianIds: ids(), now: NOW });
      // The day's first clock-in, 7:52 AM, ten hours: not the 9:30 AM return, the voided 6:00 AM entry or
      // last evening's entry.
      expect(shiftOf(dayTech.id, TODAY)).toEqual({ startMin: 472, endMin: 1072, source: 'clock_in' });
      expect(shiftOf(dayTech.id, TOMORROW)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
      // Last evening's clock-in falls on yesterday's work date even though its UTC date is today.
      expect(shiftOf(lateTech.id, TODAY)).toEqual({ startMin: 600, endMin: 1200, source: 'roster' });
      expect(shiftOf(noHours.id, TODAY)).toBeNull();
    });

    test('gate on: the work date follows Eastern time across midnight UTC', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      // 03:00Z on 2031-03-05 is still 10:00 PM EST on 2031-03-04: today is the 4th.
      const shiftOf = await eligibility.loadTechShifts(db, { technicianIds: ids(), now: new Date('2031-03-05T03:00:00Z') });
      expect(shiftOf(dayTech.id, TODAY)).toEqual({ startMin: 472, endMin: 1072, source: 'clock_in' });
    });
  });
});
