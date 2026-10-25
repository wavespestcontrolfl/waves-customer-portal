/**
 * Auto lunch (GATE_AUTO_LUNCH) on real PostgreSQL: the unpaid meal comes off
 * paid hours, the weekly regular/overtime split uses paid minutes, the payroll
 * export and earnings endpoint report them, the rollout audit stays clean, and
 * the two "no lunch" endpoints recompute under the staff week lock and refuse
 * an approved day or week.
 *
 * DB-gated like the other migrated-database suites: skips without
 * DATABASE_URL, runs in CI against the migrated database. Every row is
 * synthetic, keyed to technicians this suite creates, and removed afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const timeTracking = require('../services/time-tracking');
const approval = require('../services/timesheet-approval');
const { checks, runCheck } = require('../scripts/audit-staff-rollout-readiness');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const { staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const adminRouter = SKIP ? null : require('../routes/admin-timetracking');
const techRouter = SKIP ? null : require('../routes/tech-timetracking');

function routeHandler(router, method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(handler, { params = {}, query = {}, body = {}, technicianId } = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let error;
  await handler({ params, query, body, technicianId }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

// Fixed ET weeks far in the past: Monday 2020-01-06 and 2020-02-03.
const WEEK_A = '2020-01-06';
const WEEK_B = '2020-02-03';
const WEEK_C = '2020-03-02';
const WEEK_D = '2020-04-06';
const dayOf = (monday, offset) => {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const at = (ymd, hhmm) => parseETDateTime(`${ymd}T${hhmm}`);

describeDb('auto lunch on PostgreSQL (GATE_AUTO_LUNCH)', () => {
  const run = randomUUID().slice(0, 8);
  const techA = randomUUID();
  const techB = randomUUID();
  const techC = randomUUID();
  const techD = randomUUID();
  const techToday = randomUUID();
  const techIds = [techA, techB, techC, techD, techToday];
  const priorGate = process.env.GATE_AUTO_LUNCH;

  const insertEntry = (technicianId, entryType, start, end) => db('time_entries').insert({
    id: randomUUID(),
    technician_id: technicianId,
    entry_type: entryType,
    status: 'completed',
    clock_in: start,
    clock_out: end,
    duration_minutes: Math.round(((end - start) / 60000) * 100) / 100,
  });
  // Mon..Thu, 07:30 to 18:00 ET: 10.5 hours on the clock each day.
  const insertFourTens = async (technicianId, monday) => {
    for (let i = 0; i < 4; i += 1) {
      await insertEntry(technicianId, 'shift', at(dayOf(monday, i), '07:30'), at(dayOf(monday, i), '18:00'));
    }
  };
  const recomputeWeek = async (technicianId, monday) => {
    for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(technicianId, dayOf(monday, i));
    return timeTracking.computeWeeklySummary(technicianId, monday);
  };
  const daily = (technicianId, workDate) => db('time_entry_daily_summary')
    .where({ technician_id: technicianId, work_date: workDate }).first();
  const weekly = (technicianId, monday) => db('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: monday }).first();
  const num = (value) => Number(value);

  beforeAll(async () => {
    process.env.GATE_AUTO_LUNCH = 'true';
    await db('technicians').insert(techIds.map((id, index) => ({
      id,
      name: `QA Lunch ${run} ${index}`,
      email: `qa-lunch-${run}-${index}@example.invalid`,
      role: 'technician',
      active: true,
    })));
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_AUTO_LUNCH;
    else process.env.GATE_AUTO_LUNCH = priorGate;
    await db('time_entries').whereIn('technician_id', techIds).del();
    await db('time_entry_daily_summary').whereIn('technician_id', techIds).del();
    await db('time_weekly_summary').whereIn('technician_id', techIds).del();
    await db('technicians').whereIn('id', techIds).del();
    await db.destroy();
  });

  test('a 10.5-hour day pays 10 hours and keeps shift minutes for utilization', async () => {
    await insertEntry(techA, 'shift', at(dayOf(WEEK_A, 0), '07:30'), at(dayOf(WEEK_A, 0), '18:00'));
    const summary = await timeTracking.computeDailySummary(techA, dayOf(WEEK_A, 0));
    expect(num(summary.total_shift_minutes)).toBe(630);
    expect(num(summary.unpaid_meal_minutes)).toBe(30);
    expect(summary.no_lunch).toBe(false);
    const week = await timeTracking.computeWeeklySummary(techA, WEEK_A);
    expect(num(week.total_shift_minutes)).toBe(630);
    expect(num(week.unpaid_meal_minutes)).toBe(30);
    expect(num(week.regular_minutes)).toBe(600);
    expect(num(week.overtime_minutes)).toBe(0);
  });

  test('a 4x10.5 week is 40 regular hours and no overtime', async () => {
    await db('time_entries').where({ technician_id: techA }).del();
    await db('time_entry_daily_summary').where({ technician_id: techA }).del();
    await db('time_weekly_summary').where({ technician_id: techA }).del();
    await insertFourTens(techA, WEEK_A);
    const week = await recomputeWeek(techA, WEEK_A);
    expect(num(week.total_shift_minutes)).toBe(2520);
    expect(num(week.unpaid_meal_minutes)).toBe(120);
    expect(num(week.regular_minutes)).toBe(2400);
    expect(num(week.overtime_minutes)).toBe(0);
    for (let i = 0; i < 4; i += 1) {
      const day = await daily(techA, dayOf(WEEK_A, i));
      expect(num(day.unpaid_meal_minutes)).toBe(30);
      expect(num(day.overtime_minutes)).toBe(0);
    }
  });

  test('gate off: the same week reads 42 shift hours, 2 overtime, and no unpaid meal', async () => {
    process.env.GATE_AUTO_LUNCH = 'false';
    try {
      const week = await recomputeWeek(techA, WEEK_A);
      expect(num(week.unpaid_meal_minutes)).toBe(0);
      expect(num(week.regular_minutes)).toBe(2400);
      expect(num(week.overtime_minutes)).toBe(120);
      expect(num((await daily(techA, dayOf(WEEK_A, 3))).overtime_minutes)).toBe(120);
    } finally {
      process.env.GATE_AUTO_LUNCH = 'true';
    }
    const week = await recomputeWeek(techA, WEEK_A);
    expect(num(week.overtime_minutes)).toBe(0);
  });

  test('a recorded 45-minute break is the unpaid meal and a 20-minute break stays paid', async () => {
    const tuesday = dayOf(WEEK_A, 1);
    await insertEntry(techA, 'break', at(tuesday, '12:00'), at(tuesday, '12:45'));
    expect(num((await timeTracking.computeDailySummary(techA, tuesday)).unpaid_meal_minutes)).toBe(45);
    await db('time_entries').where({ technician_id: techA, entry_type: 'break' }).del();
    await insertEntry(techA, 'break', at(tuesday, '12:00'), at(tuesday, '12:20'));
    expect(num((await timeTracking.computeDailySummary(techA, tuesday)).unpaid_meal_minutes)).toBe(30);
    await db('time_entries').where({ technician_id: techA, entry_type: 'break' }).del();
    await recomputeWeek(techA, WEEK_A);
  });

  test('admin no-lunch: needs edit_reason, keeps the day paid in full, records who and why', async () => {
    const handler = routeHandler(adminRouter, 'put', '/daily/:technicianId/:workDate/no-lunch');
    const workDate = dayOf(WEEK_A, 0);
    const params = { technicianId: techA, workDate };
    const adminId = randomUUID();

    expect((await call(handler, { params, body: { noLunch: true }, technicianId: adminId })).statusCode).toBe(400);
    expect((await call(handler, { params, body: { noLunch: 'yes', edit_reason: 'x' }, technicianId: adminId })).statusCode).toBe(400);

    const res = await call(handler, {
      params, body: { noLunch: true, edit_reason: 'worked through lunch' }, technicianId: adminId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.noLunch).toBe(true);
    const day = await daily(techA, workDate);
    expect(day.no_lunch).toBe(true);
    expect(num(day.unpaid_meal_minutes)).toBe(0);
    expect(day.notes).toContain(adminId);
    expect(day.notes).toContain('worked through lunch');
    const week = await weekly(techA, WEEK_A);
    expect(num(week.unpaid_meal_minutes)).toBe(90);
    expect(num(week.regular_minutes)).toBe(2400);
    expect(num(week.overtime_minutes)).toBe(30);

    // A recompute never overwrites the flag.
    await timeTracking.computeDailySummary(techA, workDate);
    expect((await daily(techA, workDate)).no_lunch).toBe(true);

    const undo = await call(handler, {
      params, body: { noLunch: false, edit_reason: 'took lunch after all' }, technicianId: adminId,
    });
    expect(undo.statusCode).toBe(200);
    expect(num((await daily(techA, workDate)).unpaid_meal_minutes)).toBe(30);
    expect(num((await weekly(techA, WEEK_A)).overtime_minutes)).toBe(0);
  });

  test('admin no-lunch is refused on an approved day and on an approved week', async () => {
    const handler = routeHandler(adminRouter, 'put', '/daily/:technicianId/:workDate/no-lunch');
    await insertFourTens(techB, WEEK_B);
    await recomputeWeek(techB, WEEK_B);
    const body = { noLunch: true, edit_reason: 'late fix' };
    const workDate = dayOf(WEEK_B, 0);

    await db('time_entry_daily_summary').where({ technician_id: techB, work_date: workDate }).update({ status: 'approved' });
    const dayRefused = await call(handler, { params: { technicianId: techB, workDate }, body, technicianId: randomUUID() });
    expect(dayRefused.statusCode).toBe(409);
    await db('time_entry_daily_summary').where({ technician_id: techB, work_date: workDate }).update({ status: 'pending' });

    // A fully approved week: entries, days and the weekly snapshot.
    await db('time_entries').where({ technician_id: techB }).update({ approval_status: 'approved' });
    await db('time_entry_daily_summary').where({ technician_id: techB }).update({ status: 'approved' });
    await db('time_weekly_summary').where({ technician_id: techB, week_start: WEEK_B }).update({ status: 'approved' });
    const weekRefused = await call(handler, { params: { technicianId: techB, workDate: dayOf(WEEK_B, 1) }, body, technicianId: randomUUID() });
    expect(weekRefused.statusCode).toBe(409);
    expect((await daily(techB, dayOf(WEEK_B, 1))).no_lunch).toBe(false);
    expect(num((await weekly(techB, WEEK_B)).unpaid_meal_minutes)).toBe(120);
  });

  test('tech no-lunch: own current ET day only, boolean required, refused when approved', async () => {
    const handler = routeHandler(techRouter, 'post', '/no-lunch');
    const today = etDateString(new Date());
    await insertEntry(techToday, 'shift', at(today, '07:30'), at(today, '18:00'));
    await timeTracking.computeDailySummary(techToday, today);
    expect(num((await daily(techToday, today)).unpaid_meal_minutes)).toBe(30);

    expect((await call(handler, { body: { noLunch: 'true' }, technicianId: techToday })).statusCode).toBe(400);

    const on = await call(handler, { body: { noLunch: true }, technicianId: techToday });
    expect(on.statusCode).toBe(200);
    expect(on.body).toMatchObject({ workDate: today, noLunch: true });
    expect(num((await daily(techToday, today)).unpaid_meal_minutes)).toBe(0);
    expect(num((await weekly(techToday, staffWeekStartForWorkDate(today))).unpaid_meal_minutes)).toBe(0);

    const off = await call(handler, { body: { noLunch: false }, technicianId: techToday });
    expect(off.body.noLunch).toBe(false);
    expect(num((await daily(techToday, today)).unpaid_meal_minutes)).toBe(30);

    await db('time_entry_daily_summary').where({ technician_id: techToday, work_date: today }).update({ status: 'approved' });
    const refused = await call(handler, { body: { noLunch: true }, technicianId: techToday });
    expect(refused.statusCode).toBe(409);
    expect((await daily(techToday, today)).no_lunch).toBe(false);
  });

  test('the time clock status reports the gate and today\'s no-lunch flag', async () => {
    const today = etDateString(new Date());
    await db('time_entry_daily_summary').where({ technician_id: techToday, work_date: today }).update({ status: 'pending', no_lunch: true });
    expect((await timeTracking.getStatus(techToday)).autoLunch).toEqual({ enabled: true, noLunch: true });
    await db('time_entry_daily_summary').where({ technician_id: techToday, work_date: today }).update({ no_lunch: false });
    expect((await timeTracking.getStatus(techToday)).autoLunch).toEqual({ enabled: true, noLunch: false });
    process.env.GATE_AUTO_LUNCH = 'false';
    try {
      expect((await timeTracking.getStatus(techToday)).autoLunch).toEqual({ enabled: false, noLunch: false });
    } finally {
      process.env.GATE_AUTO_LUNCH = 'true';
    }
  });

  test('tech no-lunch before the first clock-out creates the day and keeps the flag', async () => {
    const handler = routeHandler(techRouter, 'post', '/no-lunch');
    const lonely = randomUUID();
    await db('technicians').insert({ id: lonely, name: `QA Lunch ${run} lonely`, email: `qa-lunch-${run}-lonely@example.invalid`, role: 'technician', active: true });
    techIds.push(lonely);
    const today = etDateString(new Date());
    const res = await call(handler, { body: { noLunch: true }, technicianId: lonely });
    expect(res.statusCode).toBe(200);
    expect((await daily(lonely, today)).no_lunch).toBe(true);
    // The 10.5-hour shift that closes later is paid in full.
    await insertEntry(lonely, 'shift', at(today, '07:30'), at(today, '18:00'));
    const summary = await timeTracking.computeDailySummary(lonely, today);
    expect(num(summary.unpaid_meal_minutes)).toBe(0);
    expect(summary.no_lunch).toBe(true);
  });

  test('the payroll export adds Unpaid Lunch Hours after Total Hours and reports paid hours', async () => {
    // techB's week is approved from the refusal test; export needs every worked tech approved.
    const csv = await approval.generateWeeklyPayrollExport(WEEK_B, new Date('2020-02-20T12:00:00Z'));
    const [header, ...rows] = csv.split('\n');
    expect(header).toBe('Tech,Week Start,Regular Hours,OT Hours,Total Hours,Unpaid Lunch Hours,Jobs,Revenue,RPMH,Utilization %,Status');
    const row = rows.find((line) => line.startsWith(`QA Lunch ${run} 1,`));
    expect(row).toBeDefined();
    expect(row.split(',').slice(0, 6)).toEqual([`QA Lunch ${run} 1`, WEEK_B, '40.00', '0.00', '40.00', '2.00']);
  });

  test('the earnings endpoint pays on paid minutes', async () => {
    const handler = routeHandler(adminRouter, 'get', '/technicians/:id/earnings');
    await insertFourTens(techC, WEEK_C);
    for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(techC, dayOf(WEEK_C, i));
    const res = await call(handler, { params: { id: techC }, query: { from: WEEK_C, to: dayOf(WEEK_C, 6) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      totalMinutes: 2520,
      unpaidMealMinutes: 120,
      regularMinutes: 2400,
      overtimeMinutes: 0,
      regularPay: 1400,
      overtimePay: 0,
      grossPay: 1400,
    });
    // Gate off: the same days pay 40 regular and 2 overtime hours.
    process.env.GATE_AUTO_LUNCH = 'false';
    try {
      for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(techC, dayOf(WEEK_C, i));
      const off = await call(handler, { params: { id: techC }, query: { from: WEEK_C, to: dayOf(WEEK_C, 6) } });
      expect(off.body).toMatchObject({ unpaidMealMinutes: 0, regularMinutes: 2400, overtimeMinutes: 120 });
    } finally {
      process.env.GATE_AUTO_LUNCH = 'true';
    }
    for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(techC, dayOf(WEEK_C, i));
    await timeTracking.computeWeeklySummary(techC, WEEK_C);
  });

  test('a gate flip refreshes open days through the weekly and earnings paths, approved days keep their snapshot', async () => {
    const earnings = routeHandler(adminRouter, 'get', '/technicians/:id/earnings');
    const query = { from: WEEK_D, to: dayOf(WEEK_D, 6) };
    await insertFourTens(techD, WEEK_D);

    // Off -> on: days written with the gate off carry no deduction; the weekly
    // path (no hand-rebuilt days) derives it from the entries.
    process.env.GATE_AUTO_LUNCH = 'false';
    try {
      await recomputeWeek(techD, WEEK_D);
      expect(num((await weekly(techD, WEEK_D)).overtime_minutes)).toBe(120);
      expect(num((await daily(techD, dayOf(WEEK_D, 0))).unpaid_meal_minutes)).toBe(0);
    } finally {
      process.env.GATE_AUTO_LUNCH = 'true';
    }
    const on = await timeTracking.computeWeeklySummary(techD, WEEK_D);
    expect(num(on.unpaid_meal_minutes)).toBe(120);
    expect(num(on.regular_minutes)).toBe(2400);
    expect(num(on.overtime_minutes)).toBe(0);
    expect(num((await daily(techD, dayOf(WEEK_D, 3))).unpaid_meal_minutes)).toBe(30);
    expect(num((await daily(techD, dayOf(WEEK_D, 3))).overtime_minutes)).toBe(0);

    // No-lunch days are respected by the refresh (flag read from the day row).
    await db('time_entry_daily_summary').where({ technician_id: techD, work_date: dayOf(WEEK_D, 1) }).update({ no_lunch: true });
    expect(num((await timeTracking.computeWeeklySummary(techD, WEEK_D)).unpaid_meal_minutes)).toBe(90);
    await db('time_entry_daily_summary').where({ technician_id: techD, work_date: dayOf(WEEK_D, 1) }).update({ no_lunch: false });
    expect(num((await timeTracking.computeWeeklySummary(techD, WEEK_D)).unpaid_meal_minutes)).toBe(120);

    // On -> off through the earnings endpoint, with one approved day.
    await db('time_entry_daily_summary').where({ technician_id: techD, work_date: dayOf(WEEK_D, 0) }).update({ status: 'approved' });
    process.env.GATE_AUTO_LUNCH = 'false';
    try {
      const off = await call(earnings, { params: { id: techD }, query });
      expect(off.body).toMatchObject({ totalMinutes: 2520, unpaidMealMinutes: 30, regularMinutes: 2400, overtimeMinutes: 90 });
      expect(num((await daily(techD, dayOf(WEEK_D, 0))).unpaid_meal_minutes)).toBe(30);
      expect(num((await daily(techD, dayOf(WEEK_D, 1))).unpaid_meal_minutes)).toBe(0);
      expect(num((await weekly(techD, WEEK_D)).unpaid_meal_minutes)).toBe(30);
    } finally {
      process.env.GATE_AUTO_LUNCH = 'true';
    }

    // Back on: open days are refreshed again; the approved day is unchanged.
    const back = await call(earnings, { params: { id: techD }, query });
    expect(back.body).toMatchObject({ unpaidMealMinutes: 120, regularMinutes: 2400, overtimeMinutes: 0 });
    expect(num((await daily(techD, dayOf(WEEK_D, 0))).unpaid_meal_minutes)).toBe(30);
  });

  test('the rollout audit stays clean for these technicians (gate on)', async () => {
    const keys = [
      'staff_time_schema_columns',
      'daily_summary_total_mismatch',
      'weekly_overtime_payroll_mismatch',
      'approved_week_total_mismatch',
    ];
    for (const key of keys) {
      const check = checks.find((candidate) => candidate.key === key);
      const result = await db.transaction((trx) => runCheck(trx, check));
      const ours = result.rows.filter((row) => techIds.includes(row.technician_id));
      expect({ key, ours }).toEqual({ key, ours: [] });
    }
    expect((await runCheck(db, checks.find((c) => c.key === 'staff_time_schema_columns'))).count).toBe(0);
  });

  test('the audit flags a week whose stored unpaid meal disagrees with its days', async () => {
    await db('time_weekly_summary').where({ technician_id: techC, week_start: WEEK_C }).update({ unpaid_meal_minutes: 5 });
    const check = checks.find((candidate) => candidate.key === 'weekly_overtime_payroll_mismatch');
    const result = await db.transaction((trx) => runCheck(trx, check));
    expect(result.rows.some((row) => row.technician_id === techC)).toBe(true);
    await timeTracking.computeWeeklySummary(techC, WEEK_C);
  });
});
