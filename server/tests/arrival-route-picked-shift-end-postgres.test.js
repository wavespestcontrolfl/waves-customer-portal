/**
 * GATE_TECH_SHIFT_HOURS (D4): the route check holds a PICKED block to its technician's shift
 * end (arrival-route.js checkArrivalPlacement, pickedShiftEnd), on REAL Postgres rows: the
 * real route loader, the real engine and the real readers of the set hours.
 *
 * The route: one stop 11:00 to 12:00, about 14 miles north of the visit that is placed at
 * 12:00. The technician reaches the visit after 12:00, so its sixty minutes end after 13:00.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a local
 * scratch Postgres; it skips without one. Fixtures are fictitious and removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

const GATES = ['GATE_TECH_SHIFT_HOURS', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM'];

postgres('the route check holds a picked block to the shift end (real Postgres)', () => {
  let db;
  let route;
  let occupancy;
  let day;
  let otherDay;
  let routes = 0;
  const saved = {};
  const made = { techIds: [], visitIds: [], customerId: randomUUID() };
  const HQ = { lat: 27.4, lng: -82.4 };

  async function makeTech(shiftEnd) {
    const tag = randomUUID().slice(0, 8);
    const [row] = await db('technicians').insert({
      name: `Synthetic Shift End ${tag}`, role: 'technician', email: `synthetic-shift-end-${tag}@example.invalid`,
      employment_status: 'active', field_dispatchable: true, active: true, shift_start: '08:00', shift_end: shiftEnd,
    }).returning(['id']);
    made.techIds.push(row.id);
    return row.id;
  }
  async function makeStop(technicianId, date, start, end, lat) {
    const row = {
      id: randomUUID(), customer_id: made.customerId, technician_id: technicianId, service_type: 'Quarterly Pest Control', status: 'confirmed',
      scheduled_date: date, window_start: start, window_end: end, estimated_duration_minutes: 60, lat, lng: HQ.lng,
    };
    await db('scheduled_services').insert(row);
    made.visitIds.push(row.id);
    return row.id;
  }
  // A technician whose shift ends at `shiftEnd`, the 11:00 stop on `day`, and the visit, saved on another day.
  // Each route has its own day: without GATE_MULTI_TECH_CONFIRM another technician's stop is a fixed block.
  async function makeRoute(shiftEnd) {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    routes += 1;
    day = etDateString(addETDays(new Date(), 400 + routes * 3));
    otherDay = etDateString(addETDays(new Date(), 399 + routes * 3));
    const technicianId = await makeTech(shiftEnd);
    await makeStop(technicianId, day, '11:00', '12:00', HQ.lat + 0.3);
    const visit = await makeStop(technicianId, otherDay, '12:00', '13:00', HQ.lat + 0.1);
    return { technicianId, visit };
  }
  const check = ({ technicianId, visit }, start = '12:00', end = '13:00', extra = {}) => route.checkArrivalPlacement({
    conn: db, serviceId: visit, date: day, technicianId, excludeServiceIds: [visit],
    changes: { scheduled_date: day, window_start: start, window_end: end },
    windowStart: start, windowEnd: end, durationMinutes: 60, ...extra,
  });

  beforeAll(async () => {
    for (const key of GATES) saved[key] = process.env[key];
    db = require('../models/db');
    route = require('../services/scheduling/arrival-route');
    occupancy = require('../services/scheduling/occupancy');
    await db('customers').insert({
      id: made.customerId, first_name: 'Synthetic', last_name: 'ShiftEnd', active: true,
      email: `synthetic-shift-end-${made.customerId}@example.invalid`, phone: `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`,
    });
  });

  beforeEach(() => {
    for (const key of GATES) delete process.env[key];
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
  });

  afterAll(async () => {
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    await db('customers').where({ id: made.customerId }).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  test('a visit the shift holds on the clock, reached late: shift_end with the gate on, a fit with it off', async () => {
    const made13 = await makeRoute('13:00');
    const held = await check(made13);
    expect(held).toMatchObject({ feasible: false, reason: 'shift_end' });
    expect(held.warning).toBe(`With this visit the modeled route ends a stop after the technician's shift end on ${day}.`);
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const free = await check(made13);
    expect(free.feasible).toBe(true);
    // The visit is reached after 12:00, so it ends after 13:00: this is what the shift end refused.
    const visitRow = free.arrivals.find((row) => row.id === made13.visit);
    expect(visitRow.departure > '13:00').toBe(true);
    // A caller that may not learn this technician's hours: they are not read, and the answer is the one with the gate off.
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    const blind = await check(made13, '12:00', '13:00', { shiftHours: false });
    expect({ feasible: blind.feasible, arrivals: blind.arrivals }).toEqual({ feasible: true, arrivals: free.arrivals });
    expect(await check(made13, '12:00', '13:00', { shiftHours: true })).toMatchObject({ feasible: false, reason: 'shift_end' });
    delete process.env.GATE_TECH_SHIFT_HOURS;
    // A caller's own shift end stands with the gate off (the finders pass theirs).
    expect(await check(made13, '12:00', '13:00', { shiftEndMin: 13 * 60 })).toMatchObject({ feasible: false, reason: 'shift_end' });
  });

  test('a shift that ends after the visit does, and a technician with no set hours, change nothing', async () => {
    const long = await makeRoute('15:00');
    expect((await check(long)).feasible).toBe(true);
    await db('technicians').where({ id: long.technicianId }).update({ shift_start: null, shift_end: null });
    expect((await check(long)).feasible).toBe(true);
  });

  test('a block the shift does not hold on the clock gets no route limit: the answer is the one with the gate off', async () => {
    const made13 = await makeRoute('13:00');
    // 12:30 to 13:30 ends after the 13:00 shift end: the picked-hour rule's case, not the route's.
    const on = await check(made13, '12:30', '13:30');
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const off = await check(made13, '12:30', '13:30');
    expect(on.reason).not.toBe('shift_end');
    expect({ feasible: on.feasible, reason: on.reason }).toEqual({ feasible: off.feasible, reason: off.reason });
  });

  test('a save\'s route check carries it as a warning row, inside the save\'s transaction, and the transaction stays usable', async () => {
    // The 13:00 shift end is written inside the save's transaction only: the read must be the transaction's own.
    const made13 = await makeRoute('15:00');
    await db.transaction(async (trx) => {
      await trx('technicians').where({ id: made13.technicianId }).update({ shift_end: '13:00' });
      const rows = await occupancy.findConflictingVisits({
        db: trx, date: day, windowStart: '12:00', windowEnd: '13:00', excludeServiceIds: [made13.visit],
        arrivalWindow: { serviceId: made13.visit, technicianId: made13.technicianId, changes: { scheduled_date: day, window_start: '12:00', window_end: '13:00' }, roads: 'cache' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: made13.visit, conflict_reason: 'shift_end' });
      expect(rows[0].warning).toMatch(/shift end/);
      expect(await trx('technicians').where({ id: made13.technicianId }).first('id')).toBeTruthy();
    });
  });
});
