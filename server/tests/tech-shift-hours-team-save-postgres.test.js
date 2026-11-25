/**
 * GATE_TECH_SHIFT_HOURS (D4): a Team save of the shift hours lists the technician's
 * coming visits the new hours do not hold (routes/admin-timetracking.js,
 * outsideNewShiftReply), on REAL Postgres rows: the DATE and TIME columns as pg reads
 * them back, the real save (its lock, its update), the real readers of the hours and
 * of the work days.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a
 * local scratch Postgres; it skips without one. Fixtures are fictitious. Every row it
 * makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// The save lists the visits from today (ET) forward, so the days follow the clock: the first Monday
// three weeks or more from now, and the Tuesday, Wednesday and Friday after it.
const monday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 21));
monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7));
const [MON, TUE, WED, FRI] = [0, 1, 2, 4].map((later) => new Date(monday.getTime() + later * 86400000).toISOString().slice(0, 10));

postgres('a Team save of the shift hours lists the visits the new hours do not hold (real Postgres)', () => {
  let db;
  let updateTechnician;
  const made = { techIds: [], visitIds: [], customerId: randomUUID() };

  async function makeTech(over) {
    const tag = randomUUID().slice(0, 8);
    const [row] = await db('technicians')
      .insert({
        name: `Synthetic Hours ${tag}`, role: 'technician', email: `synthetic-hours-${tag}@example.invalid`,
        employment_status: 'active', field_dispatchable: true, active: true, ...over,
      })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }
  // One visit, 09:00 to 10:00 for sixty minutes on a Monday unless `over` says otherwise.
  async function makeVisit(technician, over) {
    const row = {
      id: randomUUID(), customer_id: made.customerId, technician_id: technician.id, service_type: 'Quarterly Pest Control', status: 'pending',
      scheduled_date: MON, window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, ...over,
    };
    await db('scheduled_services').insert(row);
    made.visitIds.push(row.id);
    return row.id;
  }
  // One Team save of `technician`, as the admin's Edit sends it.
  async function save(technician, body) {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(sent) { this.body = sent; return this; } };
    const next = jest.fn();
    await updateTechnician({ params: { id: technician.id }, body, technicianId: technician.id, technician: { id: technician.id, role: 'admin' } }, res, next);
    if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
    expect(res.statusCode).toBe(200);
    return res.body;
  }
  const hours = (start, end) => ({ shiftHours: { start, end } });
  const ids = (body) => body.outsideShiftVisits.map((visit) => visit.id);
  const storedHours = async (technician) => {
    const row = await db('technicians').where({ id: technician.id }).first('shift_start', 'shift_end');
    return [row.shift_start, row.shift_end];
  };

  beforeAll(async () => {
    db = require('../models/db');
    ({ updateTechnician } = require('../routes/admin-timetracking')._handlers);
    await db('customers').insert({
      id: made.customerId, first_name: 'Synthetic', last_name: 'Hours', active: true,
      email: `synthetic-hours-${made.customerId}@example.invalid`, phone: `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`,
    });
  });

  beforeEach(() => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    process.env.GATE_TECH_WORK_DAYS = 'true';
  });
  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; delete process.env.GATE_TECH_WORK_DAYS; });

  afterAll(async () => {
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    await db('customers').where({ id: made.customerId }).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  test('new hours: the coming visits they do not hold, in date order, and only those', async () => {
    const tech = await makeTech();
    const other = await makeTech();
    await makeVisit(tech); // 09:00 to 10:00: the hours hold it
    const startsEarly = await makeVisit(tech, { scheduled_date: TUE, window_start: '07:00', window_end: '08:00' });
    const endsLate = await makeVisit(tech, { window_start: '11:30', window_end: '12:30' });
    // The window ends in the hours; the stored length does not.
    const long = await makeVisit(tech, { scheduled_date: WED, window_start: '11:00', window_end: '11:30', estimated_duration_minutes: 90 });
    await makeVisit(tech, { window_start: '13:00', window_end: '14:00', status: 'completed' });
    await makeVisit(tech, { window_start: '13:00', window_end: '14:00', scheduled_date: '2020-01-06' }); // a past day
    await makeVisit(tech, { window_start: null, window_end: null }); // no time to judge
    await makeVisit(other, { window_start: '13:00', window_end: '14:00' }); // another technician's
    // An estimate's slot hold (no customer, a reservation stamp): nobody has booked it.
    await makeVisit(tech, { scheduled_date: TUE, window_start: '15:00', window_end: '16:00', customer_id: null, reservation_expires_at: db.raw("NOW() + INTERVAL '15 minutes'") });
    // A hold the office booked keeps its stamp and has a customer: a visit.
    const bookedHold = await makeVisit(tech, { scheduled_date: FRI, window_start: '15:00', window_end: '16:00', reservation_expires_at: db.raw("NOW() + INTERVAL '15 minutes'") });

    const body = await save(tech, hours('08:00', '12:00'));
    expect(await storedHours(tech)).toEqual(['08:00:00', '12:00:00']);
    expect(ids(body)).toEqual([endsLate, startsEarly, long, bookedHold]);
    expect(body.outsideShiftVisits[0]).toEqual({
      id: endsLate, scheduledDate: expect.anything(), serviceType: 'Quarterly Pest Control', customerName: 'Synthetic Hours',
    });
    // The visits stay as they were, and the technician stays in the pool.
    expect(body.futureAssignedVisits).toEqual([]);
    expect((await db('scheduled_services').where({ id: endsLate }).first('technician_id')).technician_id).toBe(tech.id);

    // A later end alone is new hours (a visit may end at the shift's end), and so is an earlier start alone.
    expect(ids(await save(tech, hours('08:00', '12:30')))).toEqual([startsEarly, bookedHold]);
    expect(ids(await save(tech, hours('07:00', '12:30')))).toEqual([bookedHold]);
    expect(ids(await save(tech, hours('07:00', '16:00')))).toEqual([]);
    expect(ids(await save(tech, hours('07:00', '12:29')))).toEqual([endsLate, long, bookedHold]);
  });

  test('a day the technician does not work is not listed: the shift is not that day\'s', async () => {
    const tech = await makeTech({ work_days: [1, 2, 3, 4] });
    const monday = await makeVisit(tech, { window_start: '13:00', window_end: '14:00' });
    const friday = await makeVisit(tech, { scheduled_date: FRI, window_start: '13:00', window_end: '14:00' });
    expect(ids(await save(tech, hours('08:00', '12:00')))).toEqual([monday]);
    // With the work-days gate off every day is a work day.
    delete process.env.GATE_TECH_WORK_DAYS;
    expect(ids(await save(tech, hours('08:00', '11:00')))).toEqual([monday, friday]);
  });

  test('the same hours again, hours cleared, another field: no list', async () => {
    const tech = await makeTech({ shift_start: '08:00', shift_end: '12:00' });
    await makeVisit(tech, { window_start: '13:00', window_end: '14:00' });
    expect(await save(tech, hours('08:00', '12:00'))).not.toHaveProperty('outsideShiftVisits');
    expect(await save(tech, { phone: '+19415550100' })).not.toHaveProperty('outsideShiftVisits');
    expect(await save(tech, { shiftHours: null })).not.toHaveProperty('outsideShiftVisits');
    expect(await storedHours(tech)).toEqual([null, null]);
    // Hours set where there were none are new hours.
    expect((await save(tech, hours('08:00', '12:00'))).outsideShiftVisits).toHaveLength(1);
  });

  test('GATE_TECH_SHIFT_HOURS off: the hours are not written and nothing is listed', async () => {
    const tech = await makeTech({ shift_start: '08:00', shift_end: '18:00' });
    await makeVisit(tech, { window_start: '13:00', window_end: '14:00' });
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const body = await save(tech, hours('08:00', '12:00'));
    expect(body).not.toHaveProperty('outsideShiftVisits');
    expect(await storedHours(tech)).toEqual(['08:00:00', '18:00:00']);
  });
});
