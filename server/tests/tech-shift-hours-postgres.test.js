/**
 * GATE_TECH_SHIFT_HOURS (owner 2026-11-19, ad budget rule v2 page item D4) against
 * REAL Postgres: technicians.shift_start / shift_end (migrations 20261120213000 and
 * 20261120220000), the time round trip, the two CHECKs, and loadTechShifts reading
 * the hours and today's clock-in from time_entries on the Staff work date. A mocked
 * knex proves none of the CHECKs, the time type or the Eastern work-date SQL.
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
    // Roster DDL (a rolled-back migration down, a renamed time_entries) and technician rows: only CI's own
    // database or a task-private QA database, never a shared one.
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
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
    // lateTech: last evening's clock-in, which is not today's, and one at 4:00 PM EST today, after NOW (10:00 AM).
    await clockIn(lateTech.id, '2031-03-04T01:30:00Z', 'completed');
    await clockIn(lateTech.id, '2031-03-04T21:00:00Z', 'active');
  });

  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });

  afterAll(async () => {
    if (made.entryIds.length) await db('time_entries').whereIn('id', made.entryIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    if (db) await db.destroy();
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

    // The second CHECK (migration 20261120220000): only what the editor can show. The first CHECK
    // passes each of these (both set, the end after the start).
    test.each([
      ['seconds on the start', '08:00:10', '17:00'],
      ['seconds on the end', '08:00', '17:00:30'],
      ['two times inside one minute', '08:00:10', '08:00:50'],
      ['a fraction of a second', '08:00', '17:00:00.5'],
      ['an end of 24:00', '08:00', '24:00'],
    ])('refuses %s: whole minutes below 24:00 only', async (_label, start, end) => {
      await expect(db('technicians').where({ id: noHours.id }).update({ shift_start: start, shift_end: end }))
        .rejects.toMatchObject({ code: '23514', constraint: 'technicians_shift_hours_minutes_check' });
      expect(await db('technicians').where({ id: noHours.id }).first('shift_start', 'shift_end'))
        .toEqual({ shift_start: null, shift_end: null });
    });

    test('the first and the last minute of the day are accepted', async () => {
      const edge = await makeTech('Synthetic Edge', ['00:00', '23:59']);
      expect(await db('technicians').where({ id: edge.id }).first('shift_start', 'shift_end'))
        .toEqual({ shift_start: '00:00:00', shift_end: '23:59:00' });
    });

    test('the whole-minutes migration is idempotent and its down removes only its own CHECK (rolled back here)', async () => {
      const migration = require('../models/migrations/20261120220000_technician_shift_hours_whole_minutes');
      const hasCheck = async (conn, name) => !!(await conn('pg_constraint').where({ conname: name }).first('conname'));
      await expect(migration.up(db)).resolves.toBeUndefined();
      expect(await hasCheck(db, 'technicians_shift_hours_minutes_check')).toBe(true);
      const marker = new Error('roll back the DDL');
      await expect(db.transaction(async (trx) => {
        await migration.down(trx);
        expect(await hasCheck(trx, 'technicians_shift_hours_minutes_check')).toBe(false);
        expect(await hasCheck(trx, 'technicians_shift_hours_check')).toBe(true);
        await migration.down(trx); // a second down is a no-op
        // Without it the columns take seconds again.
        await trx('technicians').where({ id: noHours.id }).update({ shift_start: '08:00:10', shift_end: '08:00:50' });
        throw marker;
      })).rejects.toBe(marker);
      expect(await hasCheck(db, 'technicians_shift_hours_minutes_check')).toBe(true);
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
      // Last evening's clock-in falls on yesterday's work date even though its UTC date is today, and at 10:00 AM
      // the 4:00 PM entry has not happened yet.
      expect(shiftOf(lateTech.id, TODAY)).toEqual({ startMin: 600, endMin: 1200, source: 'roster' });
      expect(shiftOf(noHours.id, TODAY)).toBeNull();
    });

    test('gate on, inside a transaction: a failed clock-in read keeps the set hours and the transaction usable', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const marker = new Error('roll back');
      await expect(db.transaction(async (trx) => {
        // The clock-in read fails inside the caller's transaction (the table is renamed; rolled back below).
        await trx.raw('ALTER TABLE time_entries RENAME TO time_entries_shift_hours_test');
        const shiftOf = await eligibility.loadTechShifts(trx, { technicianIds: ids(), now: NOW });
        expect(shiftOf(dayTech.id, TODAY)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
        // Without the savepoint every later statement would fail (25P02, transaction aborted).
        expect((await trx.raw('select 1 as ok')).rows).toEqual([{ ok: 1 }]);
        throw marker;
      })).rejects.toBe(marker);
      expect(await db.schema.hasTable('time_entries')).toBe(true);
    });

    test('gate on: the work date follows Eastern time across midnight UTC', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      // 03:00Z on 2031-03-05 is still 10:00 PM EST on 2031-03-04: today is the 4th.
      const shiftOf = await eligibility.loadTechShifts(db, { technicianIds: ids(), now: new Date('2031-03-05T03:00:00Z') });
      expect(shiftOf(dayTech.id, TODAY)).toEqual({ startMin: 472, endMin: 1072, source: 'clock_in' });
      // By 10:00 PM the 4:00 PM clock-in has happened; ten hours from it would pass midnight.
      expect(shiftOf(lateTech.id, TODAY)).toEqual({ startMin: 960, endMin: 1440, source: 'clock_in' });
    });
  });
});
