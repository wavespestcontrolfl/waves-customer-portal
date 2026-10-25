/**
 * Shift close review (GATE_SHIFT_CLOSE_REVIEW, census H8 + M7) on real
 * PostgreSQL: a shift the system closes for a technician who forgot to clock
 * out ends at the last real activity and is flagged for an admin; an edit of
 * the clock-out or a Confirm clears the flag; the approvals list shows it; and
 * the 9 PM / 11 PM texts go to the owner as an internal text and to every
 * other technician as a Today card + push (never a customer-thread SMS).
 * Gate off is today's behavior. The payroll hold is covered in
 * payroll-runs-postgres.test.js.
 *
 * DB-gated like the other migrated-database suites: skips without
 * DATABASE_URL, runs in CI against the migrated database. Every row is
 * synthetic, keyed to technicians this suite creates, and removed afterwards.
 * Twilio and push are mocked: nothing is ever sent.
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

const OWNER_PHONE = '+19415550143';
const mockJobs = [];
jest.mock('../utils/scheduled-cron', () => ({
  schedule: (expr, fn) => { mockJobs.push({ expr, fn }); },
  isScheduledTick: () => true,
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: async (_name, fn) => fn() }));
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn().mockResolvedValue({ deliveryOutcome: 'accepted' }),
  isKnownOwnerPhone: jest.fn((phone) => phone === '+19415550143'),
}));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUser: jest.fn().mockResolvedValue({}),
}));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const PushService = require('../services/push-notifications');
const timeTracking = require('../services/time-tracking');
const approval = require('../services/timesheet-approval');
const { ACTIVE_WRITE_GENERATION } = require('../constants/staff-time');
const { parseETDateTime } = require('../utils/datetime-et');
const { initTimeTrackingCrons } = require('../services/time-tracking-crons');

const adminRouter = SKIP ? null : require('../routes/admin-timetracking');

function routeHandler(router, method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(handler, { params = {}, body = {}, technicianId } = {}) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let error;
  await handler({ params, query: {}, body, technicianId }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

// A Monday far in the past, so no other suite shares the week.
const WEEK = '2019-03-04';
const DAY = '2019-03-05';
const at = (hhmm, ymd = DAY) => parseETDateTime(`${ymd}T${hhmm}`);

describeDb('shift close review on PostgreSQL (GATE_SHIFT_CLOSE_REVIEW)', () => {
  const run = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const techIds = [adminId];
  const priorGate = process.env.GATE_SHIFT_CLOSE_REVIEW;
  const priorAdam = process.env.ADAM_PHONE;

  const makeTech = async (label, phone = null) => {
    const id = randomUUID();
    techIds.push(id);
    await db('technicians').insert({
      id,
      name: `QA Close ${run} ${label}`,
      email: `qa-close-${run}-${label}@example.invalid`,
      role: 'technician',
      active: true,
      phone,
    });
    return id;
  };
  const openShift = async (technicianId, clockIn) => {
    const [row] = await db('time_entries').insert({
      technician_id: technicianId,
      entry_type: 'shift',
      status: 'active',
      clock_in: clockIn,
      source: 'app',
      staff_write_generation: ACTIVE_WRITE_GENERATION,
    }).returning('*');
    return row;
  };
  const child = (technicianId, entryType, start, end) => db('time_entries').insert({
    id: randomUUID(),
    technician_id: technicianId,
    entry_type: entryType,
    status: end ? 'completed' : 'active',
    clock_in: start,
    clock_out: end || null,
    duration_minutes: end ? Math.round(((end - start) / 60000) * 100) / 100 : null,
    staff_write_generation: ACTIVE_WRITE_GENERATION,
  }).returning('*').then(([row]) => row);
  const completedVisit = (technicianId, completedAt) => db('scheduled_services').insert({
    id: randomUUID(),
    technician_id: technicianId,
    scheduled_date: DAY,
    service_type: 'Fixture General Pest Control',
    status: 'completed',
    completed_at: completedAt,
  });
  const entry = (id) => db('time_entries').where({ id }).first();
  const close = (technicianId, shiftId, options = {}) => timeTracking.closeActiveShiftAtomically(technicianId, {
    shiftId,
    now: at('23:00'),
    shiftNote: 'AUTO CLOCK-OUT: 11 PM cron',
    childNoteSuffix: ' [auto-closed 11PM]',
    autoCloseReason: 'cron_11pm',
    ...options,
  });

  beforeAll(async () => {
    process.env.GATE_SHIFT_CLOSE_REVIEW = 'true';
    process.env.ADAM_PHONE = OWNER_PHONE;
    await db('technicians').insert({
      id: adminId, name: `QA Close ${run} admin`, email: `qa-close-${run}-admin@example.invalid`, role: 'admin', active: true,
    });
    initTimeTrackingCrons();
  });

  beforeEach(() => {
    process.env.GATE_SHIFT_CLOSE_REVIEW = 'true';
    TwilioService.sendSMS.mockClear();
    PushService.sendToAdminUser.mockClear();
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_SHIFT_CLOSE_REVIEW;
    else process.env.GATE_SHIFT_CLOSE_REVIEW = priorGate;
    if (priorAdam === undefined) delete process.env.ADAM_PHONE;
    else process.env.ADAM_PHONE = priorAdam;
    await db('tech_notifications').whereIn('technician_id', techIds).del();
    await db('scheduled_services').whereIn('technician_id', techIds).del();
    await db('time_entries').whereIn('technician_id', techIds).del();
    await db('time_entry_daily_summary').whereIn('technician_id', techIds).del();
    await db('time_weekly_summary').whereIn('technician_id', techIds).del();
    await db('technicians').whereIn('id', techIds).del();
    await db.destroy();
  });

  describe('a forced close pays only real time', () => {
    test('ends at the latest completed visit, marks the shift, and keeps the forced time on record', async () => {
      const tech = await makeTech('visit');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('12:10'));
      await completedVisit(tech, at('17:05'));
      const closed = await close(tech, shift.id);
      expect(closed).toMatchObject({ autoClosed: true, trimmed: true, duration: 575 });
      expect(closed.closedAt.toISOString()).toBe(at('17:05').toISOString());
      expect(closed.forcedAt.toISOString()).toBe(at('23:00').toISOString());
      const saved = await entry(shift.id);
      expect(saved.status).toBe('completed');
      expect(saved.clock_out.toISOString()).toBe(at('17:05').toISOString());
      expect(Number(saved.duration_minutes)).toBe(575);
      expect(saved.auto_closed_at.toISOString()).toBe(at('23:00').toISOString());
      expect(saved.auto_close_reason).toBe('cron_11pm');
      expect(saved.auto_close_reviewed_at).toBeNull();
      expect(saved.notes).toMatch(/AUTO CLOCK-OUT: 11 PM cron, ended at last recorded activity/);
    });

    test('a later finished job, drive, break or admin entry counts as activity; a visit of another technician does not', async () => {
      const tech = await makeTech('entry');
      const other = await makeTech('other');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('16:00'));
      await completedVisit(other, at('21:30'));
      await child(tech, 'job', at('15:00'), at('16:00'));
      await child(tech, 'drive', at('16:00'), at('16:40'));
      await child(tech, 'admin_time', at('16:40'), at('18:20'));
      const closed = await close(tech, shift.id);
      expect(closed.closedAt.toISOString()).toBe(at('18:20').toISOString());
      expect(Number((await entry(shift.id)).duration_minutes)).toBe(650);
    });

    test('no activity after clock-in keeps the forced time, and the shift is still flagged', async () => {
      const tech = await makeTech('none');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('06:00')); // before the shift: not activity
      const closed = await close(tech, shift.id);
      expect(closed).toMatchObject({ autoClosed: true, trimmed: false });
      const saved = await entry(shift.id);
      expect(saved.clock_out.toISOString()).toBe(at('23:00').toISOString());
      expect(saved.auto_closed_at).not.toBeNull();
      expect(saved.notes).toBe('AUTO CLOCK-OUT: 11 PM cron');
    });

    test('a running timer is closed at the last activity, and one that began after it is voided', async () => {
      const tech = await makeTech('running');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('17:00'));
      const job = await child(tech, 'job', at('16:00'), null);
      const drive = await child(tech, 'drive', at('17:30'), null);
      await close(tech, shift.id);
      const savedJob = await entry(job.id);
      expect(savedJob.status).toBe('completed');
      expect(savedJob.clock_out.toISOString()).toBe(at('17:00').toISOString());
      expect(Number(savedJob.duration_minutes)).toBe(60);
      expect((await entry(drive.id)).status).toBe('voided');
    });

    test('gate off: clock_out is the forced time, nothing is flagged, and the note is unchanged', async () => {
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'false';
      const tech = await makeTech('off');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('17:05'));
      const job = await child(tech, 'job', at('16:00'), null);
      const closed = await close(tech, shift.id);
      expect(closed).toMatchObject({ autoClosed: false, trimmed: false, duration: 930 });
      const saved = await entry(shift.id);
      expect(saved.clock_out.toISOString()).toBe(at('23:00').toISOString());
      expect(saved.auto_closed_at).toBeNull();
      expect(saved.auto_close_reason).toBeNull();
      expect(saved.notes).toBe('AUTO CLOCK-OUT: 11 PM cron');
      expect((await entry(job.id)).clock_out.toISOString()).toBe(at('23:00').toISOString());
    });

    test('a technician who clocks out is never flagged or trimmed', async () => {
      const tech = await makeTech('person');
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('12:00'));
      const closed = await timeTracking.closeActiveShiftAtomically(tech, { shiftId: shift.id, now: at('18:00') });
      expect(closed).toMatchObject({ autoClosed: false, trimmed: false });
      const saved = await entry(shift.id);
      expect(saved.clock_out.toISOString()).toBe(at('18:00').toISOString());
      expect(saved.auto_closed_at).toBeNull();
    });
  });

  describe('an admin clears the flag', () => {
    const flaggedShift = async (label) => {
      const tech = await makeTech(label);
      const shift = await openShift(tech, at('07:30'));
      await completedVisit(tech, at('17:00'));
      await close(tech, shift.id);
      return { tech, shift };
    };

    test('the approvals list counts it until it is cleared; a notes-only edit does not clear it', async () => {
      const { tech, shift } = await flaggedShift('list');
      await timeTracking.computeDailySummary(tech, DAY);
      const listed = async () => (await approval.getPendingWeeks(WEEK)).find((row) => row.technician_id === tech);
      expect(await listed()).toMatchObject({ auto_close_pending: 1 });
      await timeTracking.adminEditEntry(shift.id, { notes: 'checked by office', edit_reason: 'note', edited_by: adminId });
      expect((await entry(shift.id)).auto_close_reviewed_at).toBeNull();
      await timeTracking.confirmAutoClose(shift.id, { reviewed_by: adminId });
      expect(await listed()).not.toHaveProperty('auto_close_pending');
    });

    test('editing the clock-out clears it and records who', async () => {
      const { shift } = await flaggedShift('edit');
      const saved = await timeTracking.adminEditEntry(shift.id, {
        clock_out: at('17:30'), edit_reason: 'tech said he left at 5:30', edited_by: adminId,
      });
      expect(saved.clock_out.toISOString()).toBe(at('17:30').toISOString());
      expect(saved.auto_close_reviewed_at).not.toBeNull();
      expect(saved.auto_close_reviewed_by).toBe(adminId);
      expect(saved.auto_closed_at).not.toBeNull();
    });

    test('Confirm clears it without moving the time; a second Confirm and an unflagged shift answer 409', async () => {
      const { shift } = await flaggedShift('confirm');
      const handler = routeHandler(adminRouter, 'post', '/entries/:id/confirm-auto-close');
      const res = await call(handler, { params: { id: shift.id }, technicianId: adminId });
      expect(res.body.success).toBe(true);
      const saved = await entry(shift.id);
      expect(saved.auto_close_reviewed_at).not.toBeNull();
      expect(saved.auto_close_reviewed_by).toBe(adminId);
      expect(saved.clock_out.toISOString()).toBe(at('17:00').toISOString());
      await expect(call(handler, { params: { id: shift.id }, technicianId: adminId })).rejects.toMatchObject({ statusCode: 409 });

      const tech = await makeTech('plain');
      const plain = await openShift(tech, at('07:30'));
      await timeTracking.closeActiveShiftAtomically(tech, { shiftId: plain.id, now: at('17:00') });
      await expect(call(handler, { params: { id: plain.id }, technicianId: adminId })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('the 9 PM reminder and 11 PM notice (M7)', () => {
    const job = (expr) => mockJobs.find((candidate) => candidate.expr === expr).fn;
    const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);
    const smsTo = (phone) => TwilioService.sendSMS.mock.calls.filter(([to]) => to === phone);
    const cards = (technicianId, type) => db('tech_notifications').where({ technician_id: technicianId, type });

    test('gate off: the reminder is the old text to the technician phone, with no message type and no card', async () => {
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'false';
      const phone = '+19415550101';
      const tech = await makeTech('off-remind', phone);
      await openShift(tech, hoursAgo(10));
      await job('0 21 * * *')();
      const sent = smsTo(phone);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(2);
      expect(sent[0][1]).toMatch(/you've been clocked in for 10 hours/);
      expect(await cards(tech, 'tech_clock_out_reminder')).toHaveLength(0);
      expect(PushService.sendToAdminUser).not.toHaveBeenCalled();
    });

    test('gate on, another technician: a Today card and a push, no text, one card for a repeat run', async () => {
      const phone = '+19415550102';
      const tech = await makeTech('card-remind', phone);
      await openShift(tech, hoursAgo(10));
      await job('0 21 * * *')();
      await job('0 21 * * *')();
      expect(smsTo(phone)).toHaveLength(0);
      const rows = await cards(tech, 'tech_clock_out_reminder');
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toMatch(/you've been clocked in for 10 hours/);
      expect(rows[0].read).toBe(false);
      expect(rows[0].dismissed_at).toBeNull();
      expect(JSON.parse(JSON.stringify(rows[0].payload))).toMatchObject({ headline: 'Clock out when you are done' });
      expect(PushService.sendToAdminUser.mock.calls.filter(([id]) => id === tech)).toHaveLength(1);
    });

    test('gate on, the owner: an internal text to the owner cell, no card', async () => {
      const tech = await makeTech('owner-remind', OWNER_PHONE);
      await openShift(tech, hoursAgo(9));
      await job('0 21 * * *')();
      const sent = smsTo(OWNER_PHONE);
      expect(sent).toHaveLength(1);
      expect(sent[0][2]).toEqual({ messageType: 'internal_alert', allowOwnerSms: true });
      expect(await cards(tech, 'tech_clock_out_reminder')).toHaveLength(0);
    });

    test('a shift under 8 hours gets no reminder on either channel', async () => {
      const phone = '+19415550103';
      const tech = await makeTech('short', phone);
      await openShift(tech, hoursAgo(5));
      await job('0 21 * * *')();
      expect(smsTo(phone)).toHaveLength(0);
      expect(await cards(tech, 'tech_clock_out_reminder')).toHaveLength(0);
    });

    test('gate on, 11 PM: the shift ends at the last activity and the notice is a card, not a text', async () => {
      const phone = '+19415550104';
      const tech = await makeTech('card-close', phone);
      const shift = await openShift(tech, hoursAgo(12));
      const jobEnd = hoursAgo(3);
      await child(tech, 'job', hoursAgo(4), jobEnd);
      await job('0 23 * * *')();
      const saved = await entry(shift.id);
      expect(saved.status).toBe('completed');
      expect(Math.abs(saved.clock_out - jobEnd)).toBeLessThan(1000);
      expect(saved.auto_closed_at).not.toBeNull();
      expect(smsTo(phone)).toHaveLength(0);
      const rows = await cards(tech, 'tech_auto_clock_out');
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toMatch(/closed automatically at .*your last recorded activity/);
      expect(rows[0].message).toMatch(/The office will review it/);
    });

    test('gate on, 11 PM, the owner: an internal text to the owner cell', async () => {
      const tech = await makeTech('owner-close', OWNER_PHONE);
      await openShift(tech, hoursAgo(12));
      TwilioService.sendSMS.mockClear();
      await job('0 23 * * *')();
      const sent = smsTo(OWNER_PHONE);
      expect(sent).toHaveLength(1);
      expect(sent[0][1]).toMatch(/automatically closed at 11 PM/);
      expect(sent[0][2]).toEqual({ messageType: 'internal_alert', allowOwnerSms: true });
      expect(await cards(tech, 'tech_auto_clock_out')).toHaveLength(0);
    });

    test('gate off, 11 PM: the old text to the technician phone, closed at the forced time, no flag', async () => {
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'false';
      const phone = '+19415550105';
      const tech = await makeTech('off-close', phone);
      const shift = await openShift(tech, hoursAgo(12));
      await child(tech, 'job', hoursAgo(4), hoursAgo(3));
      await job('0 23 * * *')();
      const saved = await entry(shift.id);
      expect(Math.abs(saved.clock_out - new Date())).toBeLessThan(60000);
      expect(saved.auto_closed_at).toBeNull();
      const sent = smsTo(phone);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(2);
      expect(sent[0][1]).toMatch(/automatically closed at 11 PM/);
      expect(await cards(tech, 'tech_auto_clock_out')).toHaveLength(0);
    });
  });
});
