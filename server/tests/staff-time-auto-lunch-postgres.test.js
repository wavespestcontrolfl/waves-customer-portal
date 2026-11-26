/**
 * No unpaid lunch on real PostgreSQL (owner 2026-11-22: every clocked minute is
 * paid). The daily and weekly summaries take no meal off paid hours, a recorded
 * break of any length stays paid, the weekly regular/overtime split runs on the
 * full shift minutes (a 4x10.5 week is 40 regular and 2 overtime hours), the
 * payroll export and earnings endpoint report them, the "no lunch" endpoints
 * are gone, and the rollout audit stays clean.
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

// Fixed ET weeks far in the past: Monday 2020-01-06, 2020-02-03 and 2020-03-02.
const WEEK_A = '2020-01-06';
const WEEK_B = '2020-02-03';
const WEEK_C = '2020-03-02';
const dayOf = (monday, offset) => {
  const d = new Date(`${monday}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const at = (ymd, hhmm) => parseETDateTime(`${ymd}T${hhmm}`);

describeDb('no unpaid lunch on PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  const techA = randomUUID();
  const techB = randomUUID();
  const techC = randomUUID();
  const techToday = randomUUID();
  const techIds = [techA, techB, techC, techToday];

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
  const num = (value) => Number(value);

  beforeAll(async () => {
    await db('technicians').insert(techIds.map((id, index) => ({
      id,
      name: `QA Lunch ${run} ${index}`,
      email: `qa-lunch-${run}-${index}@example.invalid`,
      role: 'technician',
      active: true,
    })));
  });

  afterAll(async () => {
    await db('time_entries').whereIn('technician_id', techIds).del();
    await db('time_entry_daily_summary').whereIn('technician_id', techIds).del();
    await db('time_weekly_summary').whereIn('technician_id', techIds).del();
    await db('technicians').whereIn('id', techIds).del();
    await db.destroy();
  });

  test('a 10.5-hour day pays all 10.5 hours: no unpaid meal is taken off', async () => {
    await insertEntry(techA, 'shift', at(dayOf(WEEK_A, 0), '07:30'), at(dayOf(WEEK_A, 0), '18:00'));
    const summary = await timeTracking.computeDailySummary(techA, dayOf(WEEK_A, 0));
    expect(num(summary.total_shift_minutes)).toBe(630);
    expect(num(summary.unpaid_meal_minutes)).toBe(0);
    expect(summary.no_lunch).toBe(false);
    const week = await timeTracking.computeWeeklySummary(techA, WEEK_A);
    expect(num(week.total_shift_minutes)).toBe(630);
    expect(num(week.unpaid_meal_minutes)).toBe(0);
    expect(num(week.regular_minutes)).toBe(630);
    expect(num(week.overtime_minutes)).toBe(0);
  });

  test('a 4x10.5 week is 40 regular hours and 2 overtime hours, all of it paid', async () => {
    await db('time_entries').where({ technician_id: techA }).del();
    await db('time_entry_daily_summary').where({ technician_id: techA }).del();
    await db('time_weekly_summary').where({ technician_id: techA }).del();
    await insertFourTens(techA, WEEK_A);
    const week = await recomputeWeek(techA, WEEK_A);
    expect(num(week.total_shift_minutes)).toBe(2520);
    expect(num(week.unpaid_meal_minutes)).toBe(0);
    expect(num(week.regular_minutes)).toBe(2400);
    expect(num(week.overtime_minutes)).toBe(120);
    for (let i = 0; i < 4; i += 1) {
      const day = await daily(techA, dayOf(WEEK_A, i));
      expect(num(day.unpaid_meal_minutes)).toBe(0);
      expect(num(day.overtime_minutes)).toBe(i === 3 ? 120 : 0);
    }
  });

  test('a recorded break of any length stays paid', async () => {
    const tuesday = dayOf(WEEK_A, 1);
    await insertEntry(techA, 'break', at(tuesday, '12:00'), at(tuesday, '12:45'));
    expect(num((await timeTracking.computeDailySummary(techA, tuesday)).unpaid_meal_minutes)).toBe(0);
    await db('time_entries').where({ technician_id: techA, entry_type: 'break' }).del();
    await insertEntry(techA, 'break', at(tuesday, '12:00'), at(tuesday, '12:20'));
    expect(num((await timeTracking.computeDailySummary(techA, tuesday)).unpaid_meal_minutes)).toBe(0);
    await db('time_entries').where({ technician_id: techA, entry_type: 'break' }).del();
    const week = await recomputeWeek(techA, WEEK_A);
    expect(num(week.unpaid_meal_minutes)).toBe(0);
    expect(num(week.overtime_minutes)).toBe(120);
  });

  test('the no-lunch endpoints are gone and the time clock status carries no lunch field', async () => {
    expect(adminRouter.stack.some((layer) => String(layer.route?.path || '').endsWith('/no-lunch'))).toBe(false);
    expect(techRouter.stack.some((layer) => String(layer.route?.path || '').endsWith('/no-lunch'))).toBe(false);
    const today = etDateString(new Date());
    await insertEntry(techToday, 'shift', at(today, '07:30'), at(today, '18:00'));
    const status = await timeTracking.getStatus(techToday);
    expect(JSON.stringify(status)).not.toMatch(/lunch/i);
    const summary = await timeTracking.computeDailySummary(techToday, today);
    expect(num(summary.unpaid_meal_minutes)).toBe(0);
  });

  test('the payroll export reports the full paid hours and a zero Unpaid Lunch Hours column', async () => {
    await insertFourTens(techB, WEEK_B);
    await recomputeWeek(techB, WEEK_B);
    // A fully approved week: entries, days and the weekly snapshot.
    await db('time_entries').where({ technician_id: techB }).update({ approval_status: 'approved' });
    await db('time_entry_daily_summary').where({ technician_id: techB }).update({ status: 'approved' });
    await db('time_weekly_summary').where({ technician_id: techB, week_start: WEEK_B }).update({ status: 'approved' });
    // The export needs every worked tech approved.
    const csv = await approval.generateWeeklyPayrollExport(WEEK_B, new Date('2020-02-20T12:00:00Z'));
    const [header, ...rows] = csv.split('\n');
    expect(header).toBe('Tech,Week Start,Regular Hours,OT Hours,Total Hours,Unpaid Lunch Hours,Jobs,Revenue,RPMH,Utilization %,Status');
    const row = rows.find((line) => line.startsWith(`QA Lunch ${run} 1,`));
    expect(row).toBeDefined();
    expect(row.split(',').slice(0, 6)).toEqual([`QA Lunch ${run} 1`, WEEK_B, '40.00', '2.00', '42.00', '0.00']);
  });

  test('the earnings endpoint pays every clocked minute', async () => {
    const handler = routeHandler(adminRouter, 'get', '/technicians/:id/earnings');
    await insertFourTens(techC, WEEK_C);
    for (let i = 0; i < 7; i += 1) await timeTracking.computeDailySummary(techC, dayOf(WEEK_C, i));
    const res = await call(handler, { params: { id: techC }, query: { from: WEEK_C, to: dayOf(WEEK_C, 6) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      totalMinutes: 2520,
      unpaidMealMinutes: 0,
      regularMinutes: 2400,
      overtimeMinutes: 120,
      regularPay: 1400,
    });
    expect(res.body.overtimePay).toBeGreaterThan(0);
    await timeTracking.computeWeeklySummary(techC, WEEK_C);
  });

  test('the rollout audit stays clean for these technicians', async () => {
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
