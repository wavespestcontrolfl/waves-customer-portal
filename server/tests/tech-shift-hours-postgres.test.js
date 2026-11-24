/**
 * GATE_TECH_SHIFT_HOURS (owner 2026-11-19, ad budget rule v2 page item D4) against
 * REAL Postgres: technicians.shift_start / shift_end (migrations 20261120213000 and
 * 20261120220000), the time round trip, the two CHECKs, and loadTechShifts reading
 * the hours and today's clock-in from time_entries on the Staff work date. A mocked
 * knex proves none of the CHECKs, the time type or the Eastern work-date SQL.
 * The last block runs the booking offers (the slot finders and the estimate page's
 * filter) over the same rows: each one reads the hours through that reader.
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
  const made = { techIds: [], entryIds: [], serviceIds: [], customerIds: [] };
  let dayTech;
  let lateTech;
  let earlyTech;
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
    earlyTech = await makeTech('Synthetic Early', ['07:00', '13:00']);
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
    if (made.serviceIds.length) await db('scheduled_services').whereIn('id', made.serviceIds).del();
    if (made.customerIds.length) await db('customers').whereIn('id', made.customerIds).del();
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

    test.each([
      // 2031-03-09: 2:00 AM EST becomes 3:00 AM EDT. 05:30Z = 12:30 AM EST; ten hours later is 11:30 AM EDT.
      ['spring forward', '2031-03-09', '2031-03-09T05:30:00Z', '2031-03-09T16:00:00Z', 690],
      // 2031-11-02: 2:00 AM EDT becomes 1:00 AM EST. 04:30Z = 12:30 AM EDT; ten hours later is 9:30 AM EST.
      ['fall back', '2031-11-02', '2031-11-02T04:30:00Z', '2031-11-02T15:00:00Z', 570],
    ])('gate on, %s: a clock-in before the change is that day\'s entry and keeps ten elapsed hours', async (_label, day, at, now, endMin) => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      await clockIn(dayTech.id, at, 'completed');
      const shiftOf = await eligibility.loadTechShifts(db, { technicianIds: ids(), now: new Date(now) });
      expect(shiftOf(dayTech.id, day)).toEqual({ startMin: 30, endMin, source: 'clock_in' });
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

  // Owner 2026-11-19, page item D4: "offers and confirmations allow only jobs that end by that
  // tech's shift end". The three technicians have empty days on TOMORROW, so the technician
  // without set hours shows each path's own day, and a shift may only take hours away from it.
  describe('the booking offers obey the shift', () => {
    const PIN = { lat: 27.42, lng: -82.4 };
    const startsOf = (result, techId) => result.slots
      .filter((slot) => slot.technician.id === techId && slot.date === TOMORROW)
      .map((slot) => slot.start_time)
      .sort();
    const endsBy = (limit) => (start) => Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + 60 <= limit;
    const savedArrival = process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    // The finders read the clock (which dates are past, and the same-day lead), so it is pinned to NOW:
    // on the real 2031-03-05 these hours would start to go. Date only: pg keeps its real timers.
    beforeAll(() => {
      jest.useFakeTimers({
        now: NOW,
        doNotFake: ['setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick',
          'queueMicrotask', 'performance', 'hrtime'],
      });
    });
    afterAll(() => { jest.useRealTimers(); });
    afterEach(() => {
      if (savedArrival === undefined) delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
      else process.env.GATE_ADMIN_ARRIVAL_WINDOWS = savedArrival;
    });

    test('the hour finder (the customer path): 07:00 to 13:00 ends the day at 13:00, 10:00 to 20:00 opens it at 10:00', async () => {
      const { findAvailableSlots } = require('../services/scheduling/find-time');
      const everyHour = (technicianId) => findAvailableSlots({
        ...PIN, durationMinutes: 60, dateFrom: TOMORROW, dateTo: TOMORROW, technicianId, topN: 50, slotStepMinutes: 60, everyStepStart: true, dayEndHour: 18,
      });
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const open = startsOf(await everyHour(noHours.id), noHours.id);
      // The path's own day reaches both sides of the two shifts.
      expect(open[0] < '10:00').toBe(true);
      expect(open.at(-1) > '12:00').toBe(true);
      expect(startsOf(await everyHour(earlyTech.id), earlyTech.id)).toEqual(open.filter(endsBy(13 * 60)));
      expect(startsOf(await everyHour(lateTech.id), lateTech.id)).toEqual(open.filter((start) => start >= '10:00'));
      // 08:00 to 18:00 is no narrower than the path's own day.
      expect(startsOf(await everyHour(dayTech.id), dayTech.id)).toEqual(open);
      delete process.env.GATE_TECH_SHIFT_HOURS;
      expect(startsOf(await everyHour(earlyTech.id), earlyTech.id)).toEqual(open);
      expect(startsOf(await everyHour(lateTech.id), lateTech.id)).toEqual(open);
    });

    test('the staff picker (the route engine on real rows): a new visit is offered only inside the shift', async () => {
      const { findAvailableSlots } = require('../services/scheduling/find-time');
      process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
      const windows = (technicianId) => findAvailableSlots({
        ...PIN, durationMinutes: 60, dateFrom: TOMORROW, dateTo: TOMORROW, technicianId, topN: 50,
        arrivalWindow: { prospective: { ...PIN, estimated_duration_minutes: 60, service_type: 'Pest Control' } },
      });
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const open = startsOf(await windows(noHours.id), noHours.id);
      expect(open[0] < '10:00').toBe(true);
      expect(open.at(-1) > '12:00').toBe(true);
      expect(startsOf(await windows(earlyTech.id), earlyTech.id)).toEqual(open.filter(endsBy(13 * 60)));
      expect(startsOf(await windows(lateTech.id), lateTech.id)).toEqual(open.filter((start) => start >= '10:00'));
      delete process.env.GATE_TECH_SHIFT_HOURS;
      expect(startsOf(await windows(earlyTech.id), earlyTech.id)).toEqual(open);
    });

    test('the staff picker, a late arrival: an hour the route would finish after the shift end is not offered', async () => {
      const { findAvailableSlots } = require('../services/scheduling/find-time');
      process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
      // One stop on the 07:00 to 13:00 technician's day, 11:00 to 12:00, north of the address searched for
      // (23 minutes away on the drive model).
      const customerId = randomUUID();
      const stopId = randomUUID();
      made.customerIds.push(customerId);
      made.serviceIds.push(stopId);
      await db('customers').insert({
        id: customerId, first_name: 'Synthetic', last_name: 'Stop', phone: '+19415550142', email: `${customerId}@example.invalid`,
        latitude: PIN.lat + 0.1, longitude: PIN.lng,
      });
      await db('scheduled_services').insert({
        id: stopId, customer_id: customerId, technician_id: earlyTech.id, scheduled_date: TOMORROW, service_type: 'Pest Control',
        status: 'confirmed', window_start: '11:00', window_end: '12:00', estimated_duration_minutes: 60, lat: PIN.lat + 0.1, lng: PIN.lng,
      });
      const windows = () => findAvailableSlots({
        ...PIN, durationMinutes: 60, dateFrom: TOMORROW, dateTo: TOMORROW, technicianId: earlyTech.id, topN: 50,
        arrivalWindow: { prospective: { ...PIN, estimated_duration_minutes: 60, service_type: 'Pest Control' } },
      });
      // When the route finishes the visit being placed (the engine's own row for it).
      const ownEnd = (slot) => slot.route_arrivals.find((row) => row.id === '__candidate__').departure;
      try {
        // Gate off: the route certifies 12:00. It leaves the stop at 12:00, so it reaches the visit late
        // and finishes it after 13:00.
        const open = await windows();
        const noon = open.slots.find((slot) => slot.start_time === '12:00');
        expect(noon.arrival_delay_minutes).toBeGreaterThan(0);
        expect(ownEnd(noon) > '13:00').toBe(true);
        // Gate on: 12:00 to 13:00 is inside the hours, but no stop order ends the visit by 13:00.
        process.env.GATE_TECH_SHIFT_HOURS = 'true';
        const held = await windows();
        const starts = startsOf(held, earlyTech.id);
        expect(starts).not.toContain('12:00');
        expect(starts).toContain('10:00');
        // Every hour still offered is one the route finishes by 13:00, and the shift added none.
        expect(held.slots.every((slot) => ownEnd(slot) <= '13:00')).toBe(true);
        expect(startsOf(open, earlyTech.id).filter(endsBy(13 * 60))).toEqual(expect.arrayContaining(starts));
        expect(held.rejections_by_date[TOMORROW].shift_end).toBeGreaterThanOrEqual(1);
      } finally {
        await db('scheduled_services').where({ id: stopId }).del();
        await db('customers').where({ id: customerId }).del();
      }
    });

    test('the estimate page filter inside a transaction: the hours are read there and the transaction stays usable', async () => {
      const { filterCollidingSlots } = require('../services/estimate-slot-availability')._internals;
      const windowAt = (start, techId) => ({
        slotId: `${TOMORROW}_${start}_${techId}`, date: TOMORROW, windowStart: start,
        windowEnd: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, durationMinutes: 60, techId,
      });
      const slots = [earlyTech.id, lateTech.id, noHours.id]
        .flatMap((techId) => ['09:00', '12:00', '13:00', '17:00'].map((start) => windowAt(start, techId)));
      const keptFor = (kept, techId) => kept.filter((slot) => slot.techId === techId).map((slot) => slot.windowStart);
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const marker = new Error('roll back');
      await expect(db.transaction(async (trx) => {
        // Hours set inside this transaction only: the filter must read them on the caller's connection.
        await trx('technicians').where({ id: noHours.id }).update({ shift_start: '09:00', shift_end: '10:00' });
        const kept = await filterCollidingSlots(slots, { dateFrom: TOMORROW, dateTo: TOMORROW, conn: trx });
        expect(keptFor(kept, earlyTech.id)).toEqual(['09:00', '12:00']);
        expect(keptFor(kept, lateTech.id)).toEqual(['12:00', '13:00', '17:00']);
        expect(keptFor(kept, noHours.id)).toEqual(['09:00']);
        // The clock-in read ran in a savepoint of this transaction, which still answers.
        expect((await trx.raw('select 1 as ok')).rows).toEqual([{ ok: 1 }]);
        throw marker;
      })).rejects.toBe(marker);
      delete process.env.GATE_TECH_SHIFT_HOURS;
      expect(await filterCollidingSlots(slots, { dateFrom: TOMORROW, dateTo: TOMORROW })).toHaveLength(12);
    });
  });
});
