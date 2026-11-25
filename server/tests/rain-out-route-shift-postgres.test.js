/**
 * GATE_TECH_SHIFT_HOURS (D4): the Quick Move sheet's target check says which later
 * stops a "rest of route" move would land outside the route technician's shift
 * (services/rain-out.js, routeShiftRows), on REAL Postgres rows: the DATE and TIME
 * columns as pg reads them back, the real reader of the rest of the route, the real
 * readers of the hours and of the work days. The same rows prove the office's shift
 * line for a picked hour (pickedShiftLine): the tapped stop's own hour on that sheet,
 * and a picked slot on the pickers' check (checkSlots).
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a
 * local scratch Postgres; it skips without one. Fixtures are fictitious. Every row it
 * makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('the stops a rest-of-route move would land outside the shift (real Postgres)', () => {
  let db;
  let RainOut;
  let today;
  let laterDay;
  const made = { techIds: [], visitIds: [], customerId: randomUUID() };

  async function makeTech(over) {
    const tag = randomUUID().slice(0, 8);
    const [row] = await db('technicians')
      .insert({
        name: `Synthetic Route ${tag}`, role: 'technician', email: `synthetic-route-${tag}@example.invalid`,
        employment_status: 'active', field_dispatchable: true, active: true, shift_start: '08:00', shift_end: '17:00', ...over,
      })
      .returning(['id']);
    made.techIds.push(row.id);
    return row.id;
  }
  // One stop of today's route, sixty minutes long unless `over` says otherwise.
  async function makeStop(technicianId, start, end, over) {
    const row = {
      id: randomUUID(), customer_id: made.customerId, technician_id: technicianId, service_type: 'Quarterly Pest Control', status: 'confirmed',
      scheduled_date: today, window_start: start, window_end: end, estimated_duration_minutes: 60, ...over,
    };
    await db('scheduled_services').insert(row);
    made.visitIds.push(row.id);
    return row.id;
  }
  // A technician and a route today: the tapped stop at 09:00, then 10:00, 11:30 (thirty minutes of
  // window, ninety of work) and 12:00.
  async function makeRoute(over) {
    const technicianId = await makeTech(over);
    const anchor = await makeStop(technicianId, '09:00', '10:00');
    await makeStop(technicianId, '10:00', '11:00');
    await makeStop(technicianId, '12:00', '13:00');
    await makeStop(technicianId, '11:30', '12:00', { estimated_duration_minutes: 90 });
    return { technicianId, anchor };
  }
  const check = (anchor, date, start, end) => RainOut.checkTarget({
    serviceId: anchor, caller: { isAdmin: true, technicianId: null }, target: { date, window: { start, end } },
  });

  beforeAll(async () => {
    db = require('../models/db');
    RainOut = require('../services/rain-out');
    const { etDateString, addETDays } = require('../utils/datetime-et');
    today = etDateString();
    laterDay = etDateString(addETDays(new Date(), 21));
    await db('customers').insert({
      id: made.customerId, first_name: 'Synthetic', last_name: 'Route', active: true,
      email: `synthetic-route-${made.customerId}@example.invalid`, phone: `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`,
    });
  });

  beforeEach(() => { process.env.GATE_TECH_SHIFT_HOURS = 'true'; });
  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; delete process.env.GATE_TECH_WORK_DAYS; });

  afterAll(async () => {
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    await db('customers').where({ id: made.customerId }).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  test('a push today: the stops that land after the shift end, in route order, with the window they land on', async () => {
    const { anchor } = await makeRoute();
    // 09:00 to 14:00 is five hours. 10:00 lands 15:00 to 16:00: held. 11:30 lands 16:30 and works
    // ninety minutes. 12:00 lands 17:00 to 18:00.
    const result = await check(anchor, today, '14:00', '15:00');
    expect(result.ok).toBe(true);
    expect(result.routeShiftConflicts).toEqual([
      { windowStart: '16:30', windowEnd: '17:00' },
      { windowStart: '17:00', windowEnd: '18:00' },
    ]);
    // A push of one hour: every stop is done by 14:00.
    expect(await check(anchor, today, '10:00', '11:00')).not.toHaveProperty('routeShiftConflicts');
  });

  test('a day move: each stop is judged on the hours it keeps, a stop with no stored end on its length', async () => {
    const { anchor, technicianId } = await makeRoute({ shift_end: '12:00' });
    // A start and no end, ninety minutes of work: done at 12:15. The same start with thirty minutes is held.
    await makeStop(technicianId, '10:45', null, { estimated_duration_minutes: 90 });
    await makeStop(technicianId, '10:50', null, { estimated_duration_minutes: 30 });
    const rows = [
      { windowStart: '10:45', windowEnd: null },
      { windowStart: '11:30', windowEnd: '12:00' },
      { windowStart: '12:00', windowEnd: '13:00' },
    ];
    expect((await check(anchor, laterDay, '09:00', '10:00')).routeShiftConflicts).toEqual(rows);
    // A stored 24:00 start (PostgreSQL keeps it) is no start the office's line reads: no row for the office.
    const midnight = await makeStop(technicianId, '24:00', null);
    expect((await db('scheduled_services').where({ id: midnight }).first('window_start')).window_start).toBe('24:00:00');
    expect((await check(anchor, laterDay, '09:00', '10:00')).routeShiftConflicts).toEqual(rows);
    await db('scheduled_services').where({ id: midnight }).del();
    // The occupancy check's switch is not the shift's.
    process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
    try {
      expect((await check(anchor, laterDay, '09:00', '10:00')).routeShiftConflicts).toEqual(rows);
    } finally {
      delete process.env.REBOOKER_NULL_END_OCCUPANCY;
    }
  });

  test('a target that leaves the later stops on their own hours today judges none of them', async () => {
    const { anchor, technicianId } = await makeRoute({ shift_end: '12:00' });
    // The tapped stop keeps its 09:00 start: no push, and no stop's hours are written.
    expect(await check(anchor, today, '09:00', '09:30')).not.toHaveProperty('routeShiftConflicts');
    // A stored time with seconds is rewritten to the minute, so the mover judges that stop.
    const seconds = await makeStop(technicianId, '12:30:30', '13:30:00');
    expect((await check(anchor, today, '09:00', '09:30')).routeShiftConflicts).toEqual([{ windowStart: '12:30', windowEnd: '13:30' }]);
    await db('scheduled_services').where({ id: seconds }).del();
    expect((await check(anchor, today, '09:01', '10:01')).routeShiftConflicts).toEqual([
      { windowStart: '11:31', windowEnd: '12:01' },
      { windowStart: '12:01', windowEnd: '13:01' },
    ]);
  });

  test('a tapped stop from another day, moved to today: a stop that keeps its day and its hours is not judged', async () => {
    const technicianId = await makeTech({ shift_end: '12:00' });
    const { etDateString, addETDays } = require('../utils/datetime-et');
    // An overdue visit, and two stops today: one the shift holds, one the office put after 12:00.
    const overdue = await makeStop(technicianId, '09:00', '10:00', { scheduled_date: etDateString(addETDays(new Date(), -1)) });
    await makeStop(technicianId, '10:00', '11:00');
    await makeStop(technicianId, '12:00', '13:00');
    expect(await check(overdue, today, '09:00', '10:00')).not.toHaveProperty('routeShiftConflicts');
    // To another day, today's stops change day: the one after 12:00 is judged.
    expect((await check(overdue, laterDay, '09:00', '10:00')).routeShiftConflicts).toEqual([{ windowStart: '12:00', windowEnd: '13:00' }]);
  });

  test('a day the technician does not work gives the office no row', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const weekday = new Date(`${laterDay}T12:00:00Z`).getUTCDay();
    const { anchor, technicianId } = await makeRoute({ shift_end: '12:00', work_days: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== weekday) });
    expect(await check(anchor, laterDay, '09:00', '10:00')).not.toHaveProperty('routeShiftConflicts');
    await db('technicians').where({ id: technicianId }).update({ work_days: [weekday] });
    expect((await check(anchor, laterDay, '09:00', '10:00')).routeShiftConflicts).toHaveLength(2);
  });

  // The office's shift line for the hour it picked, asked before the save (pickedShiftLine).
  describe('the office\'s shift line for a picked hour', () => {
    const lineOf = async (technicianId, end = '5:00 PM') => {
      const { name } = await db('technicians').where({ id: technicianId }).first('name');
      return `${name}'s shift is 8:00 AM to ${end}. This visit is outside those hours.`;
    };
    // The pickers' check. The overlap answer reads every technician's visits on the day, so only the line is read here.
    const slotLines = async (targets) => (await RainOut.checkSlots({ targets, caller: { isAdmin: true, technicianId: null } }))
      .results.map((result) => result.shiftWarning ?? null);
    const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
    const allDaysBut = (weekday) => [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== weekday);

    test('the tapped stop: the hour the office picks, with the visit\'s stored length, on the target\'s day', async () => {
      const technicianId = await makeTech();
      const line = await lineOf(technicianId);
      const anchor = await makeStop(technicianId, '09:00', '10:00');
      // A visit may start at the shift's start and end at its end.
      expect(await check(anchor, laterDay, '08:00', '09:00')).not.toHaveProperty('shiftWarning');
      expect(await check(anchor, laterDay, '16:00', '17:00')).not.toHaveProperty('shiftWarning');
      expect((await check(anchor, laterDay, '16:30', '17:30')).shiftWarning).toBe(line);
      expect((await check(anchor, laterDay, '07:30', '08:30')).shiftWarning).toBe(line);
      // A later hour today is the same question.
      expect((await check(anchor, today, '16:30', '17:30')).shiftWarning).toBe(line);
      // The picked window ends in the hours; the visit's stored ninety minutes do not.
      await db('scheduled_services').where({ id: anchor }).update({ estimated_duration_minutes: 90 });
      expect((await check(anchor, laterDay, '16:00', '16:30')).shiftWarning).toBe(line);
      expect(await check(anchor, laterDay, '15:00', '15:30')).not.toHaveProperty('shiftWarning');
    });

    test('the tapped stop: no line on a day the technician does not work, with no set hours, or with the gate off', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const weekday = weekdayOf(laterDay);
      const technicianId = await makeTech({ work_days: allDaysBut(weekday) });
      const line = await lineOf(technicianId);
      const anchor = await makeStop(technicianId, '09:00', '10:00');
      const late = () => check(anchor, laterDay, '16:30', '17:30');
      // The shift is not an off day's: the move itself is told the day-off line.
      expect(await late()).not.toHaveProperty('shiftWarning');
      await db('technicians').where({ id: technicianId }).update({ work_days: [weekday] });
      expect((await late()).shiftWarning).toBe(line);
      delete process.env.GATE_TECH_SHIFT_HOURS;
      expect(await late()).not.toHaveProperty('shiftWarning');
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      await db('technicians').where({ id: technicianId }).update({ shift_start: null, shift_end: null });
      expect(await late()).not.toHaveProperty('shiftWarning');
    });

    test('a picked slot: each slot that names a technician gets that technician\'s line, on the picked window and the length sent', async () => {
      const technicianId = await makeTech({ shift_end: '12:00' });
      const noHours = await makeTech({ shift_start: null, shift_end: null });
      const line = await lineOf(technicianId, '12:00 PM');
      const slot = (start, end, extra) => ({ date: laterDay, window: { start, end }, technicianId, ...extra });
      expect(await slotLines([
        slot('11:00', '12:00'), // ends at the shift's end
        slot('11:30', '12:30'),
        slot('07:30', '08:30'),
        slot('11:00', '11:30', { durationMinutes: 90 }), // the window ends in the hours; the length does not
        slot('11:00', '11:30', { durationMinutes: 30 }),
        slot('11:30', '12:30', { technicianId: undefined }), // no technician chosen
        slot('11:30', '12:30', { technicianId: noHours }),
        slot('11:30', '12:30', { technicianId: randomUUID() }), // no such technician
      ])).toEqual([null, line, line, line, null, null, null, null]);
    });

    test('a picked slot: no line on a day the technician does not work, and none with the gate off', async () => {
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const weekday = weekdayOf(laterDay);
      const technicianId = await makeTech({ shift_end: '12:00', work_days: allDaysBut(weekday) });
      const line = await lineOf(technicianId, '12:00 PM');
      const late = () => slotLines([{ date: laterDay, window: { start: '11:30', end: '12:30' }, technicianId }]);
      expect(await late()).toEqual([null]);
      // With the work-days gate off every day is a work day.
      delete process.env.GATE_TECH_WORK_DAYS;
      expect(await late()).toEqual([line]);
      delete process.env.GATE_TECH_SHIFT_HOURS;
      expect(await late()).toEqual([null]);
    });
  });

  test('no set hours, and GATE_TECH_SHIFT_HOURS off: no key', async () => {
    const { anchor, technicianId } = await makeRoute();
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const off = await check(anchor, today, '14:00', '15:00');
    expect(off.ok).toBe(true);
    expect(off).not.toHaveProperty('routeShiftConflicts');
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    expect((await check(anchor, today, '14:00', '15:00')).routeShiftConflicts).toHaveLength(2);
    await db('technicians').where({ id: technicianId }).update({ shift_start: null, shift_end: null });
    expect(await check(anchor, today, '14:00', '15:00')).not.toHaveProperty('routeShiftConflicts');
  });
});
