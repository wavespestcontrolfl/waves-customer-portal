/**
 * Admin adds a missed shift (POST /api/admin/timetracking/entries) on real
 * PostgreSQL: the row lands as an edited, pending shift with the editor and
 * reason, the day and week summaries recompute, and an overlapping shift or an
 * approved week is refused with nothing written.
 *
 * DB-gated like the other migrated-database suites: skips without
 * DATABASE_URL, runs in CI against the migrated database. Every row is
 * synthetic, keyed to technicians this suite creates, and removed afterwards.
 * Nothing is sent.
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
const { parseETDateTime } = require('../utils/datetime-et');

const adminRouter = SKIP ? null : require('../routes/admin-timetracking');

function routeHandler(router, method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function post(body, technicianId) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let error;
  await routeHandler(adminRouter, 'post', '/entries')({ params: {}, query: {}, body, technicianId }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

// A Monday far in the past, so no other suite shares the week.
const WEEK = '2019-04-01';
const DAY = '2019-04-02';
const at = (hhmm, ymd = DAY) => parseETDateTime(`${ymd}T${hhmm}`).toISOString();

describeDb('admin adds a missed shift on PostgreSQL', () => {
  const run = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const techIds = [adminId];

  const makeTech = async (label, active = true) => {
    const id = randomUUID();
    techIds.push(id);
    await db('technicians').insert({
      id,
      name: `QA Missed ${run} ${label}`,
      email: `qa-missed-${run}-${label}@example.invalid`,
      role: 'technician',
      active,
    });
    return id;
  };
  const rows = (technicianId) => db('time_entries').where({ technician_id: technicianId });

  beforeAll(async () => {
    await db('technicians').insert({
      id: adminId,
      name: `QA Missed ${run} admin`,
      email: `qa-missed-${run}-admin@example.invalid`,
      role: 'admin',
      active: true,
    });
  });

  afterAll(async () => {
    await db('audit_log').where({ action: 'payroll.time_entry_added' }).whereIn('actor_id', techIds).del();
    await db('time_entries').whereIn('technician_id', techIds).del();
    await db('time_entry_daily_summary').whereIn('technician_id', techIds).del();
    await db('time_weekly_summary').whereIn('technician_id', techIds).del();
    await db('technicians').whereIn('id', techIds).del();
    await db.destroy();
  });

  test('writes an edited pending shift, audits it and recomputes the day and week', async () => {
    const tech = await makeTech('happy');
    const body = {
      technician_id: tech, clock_in: at('08:00'), clock_out: at('16:30'), notes: 'Never tapped', edit_reason: 'Tech worked, no clock-in',
    };
    const res = await post(body, adminId);

    expect(res.body).toMatchObject({
      technician_id: tech,
      entry_type: 'shift',
      status: 'edited',
      approval_status: 'pending',
      source: 'admin_added',
      edit_reason: 'Tech worked, no clock-in',
      edited_by: adminId,
    });
    expect(res.body.duration_minutes).toBe('510.00');
    expect(res.body.original_clock_in).toBeNull();

    const daily = await db('time_entry_daily_summary').where({ technician_id: tech, work_date: DAY }).first();
    expect(Number(daily.total_shift_minutes)).toBe(510);
    const weekly = await db('time_weekly_summary').where({ technician_id: tech, week_start: WEEK }).first();
    expect(Number(weekly.total_shift_minutes)).toBe(510);
    const audit = await db('audit_log').where({ action: 'payroll.time_entry_added', resource_id: res.body.id }).first();
    expect(audit).toMatchObject({ actor_type: 'admin', actor_id: adminId });
  });

  test('refuses a shift that overlaps one already on the technician, and writes nothing', async () => {
    const tech = await makeTech('overlap');
    await post({ technician_id: tech, clock_in: at('08:00'), clock_out: at('12:00'), edit_reason: 'First half' }, adminId);

    await expect(post({ technician_id: tech, clock_in: at('11:00'), clock_out: at('15:00'), edit_reason: 'Overlap' }, adminId))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/overlaps a shift/) });
    expect(await rows(tech)).toHaveLength(1);

    // Back to back is fine.
    await post({ technician_id: tech, clock_in: at('12:00'), clock_out: at('15:00'), edit_reason: 'Second half' }, adminId);
    expect(await rows(tech)).toHaveLength(2);
  });

  test('refuses a week an admin has approved, and an inactive technician', async () => {
    const tech = await makeTech('approved');
    await db('time_weekly_summary').insert({ technician_id: tech, week_start: WEEK, week_end: '2019-04-07', status: 'approved' });
    await expect(post({ technician_id: tech, clock_in: at('08:00'), clock_out: at('16:00'), edit_reason: 'Late' }, adminId))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Unlock the approved week/) });
    expect(await rows(tech)).toHaveLength(0);

    const gone = await makeTech('inactive', false);
    await expect(post({ technician_id: gone, clock_in: at('08:00'), clock_out: at('16:00'), edit_reason: 'Late' }, adminId))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/inactive/) });
  });
});
