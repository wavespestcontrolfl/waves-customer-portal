/**
 * GATE_TECH_SHIFT_HOURS (D4): the Quick Move sheet's target check says which later
 * stops a "rest of route" move would land outside the route technician's shift
 * (services/rain-out.js, routeShiftRows), on REAL Postgres rows: the DATE and TIME
 * columns as pg reads them back, the real reader of the rest of the route, the real
 * readers of the hours and of the work days.
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

  test('a day move: each stop is judged on the window it keeps', async () => {
    const { anchor } = await makeRoute({ shift_end: '12:00' });
    const result = await check(anchor, laterDay, '09:00', '10:00');
    expect(result.routeShiftConflicts).toEqual([
      { windowStart: '11:30', windowEnd: '12:00' },
      { windowStart: '12:00', windowEnd: '13:00' },
    ]);
  });

  test('a day the technician does not work gives the office no row', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const weekday = new Date(`${laterDay}T12:00:00Z`).getUTCDay();
    const { anchor, technicianId } = await makeRoute({ shift_end: '12:00', work_days: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== weekday) });
    expect(await check(anchor, laterDay, '09:00', '10:00')).not.toHaveProperty('routeShiftConflicts');
    await db('technicians').where({ id: technicianId }).update({ work_days: [weekday] });
    expect((await check(anchor, laterDay, '09:00', '10:00')).routeShiftConflicts).toHaveLength(2);
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
