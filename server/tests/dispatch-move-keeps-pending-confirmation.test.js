/**
 * AUDIT REPRO r2-reschedule-move-engine-reminders-1 — a NON-notifying dispatch
 * move (Day-grid duration resize / bulk move / "no text" drag) on a visit whose
 * creation confirmation is still pending (appointment_reminders
 * .confirmation_sent=false — every admin manual booking defers it, and the
 * 8AM-8PM send-window hold leaves it unmarked overnight) permanently claims
 * that confirmation: POST /api/admin/dispatch/:id/reschedule →
 * syncRescheduleReminder({ willNotify:false }) → handleReschedule({
 * sendNotification:false, coverDueWindows:false }) with NO
 * keepPendingConfirmation and NO re-arm afterwards.
 *
 * Asserts the EXPECTED behaviour — what the sibling silent paths already do
 * (admin-schedule.js bulk reschedule re-arms; auto-dispatch/apply.js re-arms;
 * visit-groups.js passes keepPendingConfirmation): after a silent move the
 * pending confirmation is STILL pending so the deferred send / stranded sweep
 * delivers it with the new time. FAILS on current code if the bug is real.
 *
 * Real Postgres (DATABASE_URL = private clone of waves_audit_tpl), real
 * router, real appointment-reminders service. The rebooker is mocked to apply
 * the window edit to the scheduled_services row (what the real one persists)
 * and report success; board broadcasts are stubbed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-jwt-secret';
jest.setTimeout(30000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../services/dispatch-assignment', () => {
  const actual = jest.requireActual('../services/dispatch-assignment');
  return { ...actual, emitDispatchJobUpdate: jest.fn(async () => {}), flushDispatchQualityDates: jest.fn(async () => {}) };
});
jest.mock('../routes/admin-schedule', () => ({
  sendRescheduleNoticeForVisit: jest.fn(async () => ({ sent: true, error: null })),
}));
// The rebooker persists the move; the reminder sync under test runs AFTER it
// in the route. Mock it to write exactly the date/window the route resolved.
jest.mock('../services/rebooker', () => {
  const actual = jest.requireActual('../services/rebooker');
  const db = require('../models/db');
  return {
    ...actual,
    reschedule: jest.fn(async (serviceId, newDate, window) => {
      const win = typeof window === 'string'
        ? { start: window.split('-')[0], end: window.split('-')[1] }
        : window;
      await db('scheduled_services').where({ id: serviceId }).update({
        scheduled_date: String(newDate).split('T')[0],
        window_start: win.start,
        window_end: win.end,
      });
      return { success: true };
    }),
    rescheduleSeries: jest.fn(),
    previewSeriesMove: jest.fn(),
    collectiveMoveGateOn: () => false,
  };
});

const http = require('http');
const express = require('express');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

describeOrSkip('r2-reschedule-move-engine-reminders-1: silent dispatch move must leave a pending creation confirmation pending', () => {
  let db, server, baseUrl, AppointmentReminders;
  let cust;

  beforeAll(async () => {
    db = require('../models/db');
    AppointmentReminders = require('../services/appointment-reminders');
    const router = require('../routes/admin-dispatch');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/dispatch', router);
     
    app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [cust] = await db('customers').insert({
      first_name: 'Audit', last_name: 'Pending', phone: '9415550199',
      email: `audit-r2-rsched-${Date.now()}@local.test`,
      address_line1: '9 Silent Ct', city: 'Sarasota', state: 'FL', zip: '34231', monthly_rate: 99,
    }).returning('*');
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.destroy();
  });

  // A visit `daysOut` days ahead at 10:00-11:00 whose admin-manual creation
  // confirmation is still pending (deferred / held outside the send window).
  async function seedPendingVisit(daysOut) {
    const date = etDateString(addETDays(new Date(), daysOut));
    const [svc] = await db('scheduled_services').insert({
      customer_id: cust.id, scheduled_date: date, service_type: 'Quarterly Pest Control',
      status: 'pending', window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60,
    }).returning('*');
    const [rem] = await db('appointment_reminders').insert({
      scheduled_service_id: svc.id, customer_id: cust.id,
      appointment_time: parseETDateTime(`${date}T10:00`),
      service_type: 'Quarterly Pest Control', source: 'admin_manual',
      confirmation_sent: false, confirmation_sent_at: null,
      reminder_72h_sent: false, reminder_24h_sent: false, cancelled: false,
    }).returning('*');
    expect(rem.confirmation_sent).toBe(false);
    expect(rem.suppressed_by_sibling).toBe(false);
    expect(rem.windows_preclosed).toBe(false);
    return { svc, rem, date };
  }

  async function reschedule(serviceId, body) {
    const res = await fetch(`${baseUrl}/api/admin/dispatch/${serviceId}/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  test('Day-grid duration resize (same start, notifyCustomer:false) keeps confirmation_sent=false and leaves a deferred 72h reminder armed', async () => {
    const { svc, date } = await seedPendingVisit(2); // ~48h out: inside the 72h band, outside the 24h band
    const { status, body } = await reschedule(svc.id, {
      newDate: date, newWindow: '10:00-12:00', notifyCustomer: false, reasonCode: 'dispatch_resize',
    });
    expect(status).toBe(200);
    expect(body.notificationSent).not.toBe(true);

    const after = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
     
    console.log('[r2-reschedule-move-engine-reminders-1] after silent resize:', JSON.stringify({
      confirmation_sent: after.confirmation_sent, confirmation_sent_at: after.confirmation_sent_at,
      reminder_72h_sent: after.reminder_72h_sent, reminder_24h_sent: after.reminder_24h_sent, cancelled: after.cancelled,
    }));
    // EXPECTED: nobody texted the customer, so the creation confirmation is still owed.
    expect(after.confirmation_sent).toBe(false);
    expect(after.confirmation_sent_at).toBeNull();
    // EXPECTED: no text went out, so the (send-window-deferred) 72h reminder stays armed.
    expect(after.reminder_72h_sent).toBe(false);
    // Sanity: the deferred sendConfirmation would still deliver it (it skips confirmation_sent rows).
    expect(await db('appointment_reminders').where({ id: after.id, cancelled: false, confirmation_sent: false, windows_preclosed: false }).first('id')).toBeTruthy();
  });

  test('Day-grid bulk move to another day (notifyCustomer:false) keeps confirmation_sent=false', async () => {
    const { svc } = await seedPendingVisit(2);
    const newDate = etDateString(addETDays(new Date(), 5));
    const { status } = await reschedule(svc.id, {
      newDate, newWindow: '10:00-11:00', notifyCustomer: false, reasonCode: 'dispatch_bulk_move',
    });
    expect(status).toBe(200);

    const after = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
     
    console.log('[r2-reschedule-move-engine-reminders-1] after silent day move:', JSON.stringify({
      confirmation_sent: after.confirmation_sent, appointment_time: after.appointment_time,
    }));
    expect(after.confirmation_sent).toBe(false);
    expect(after.confirmation_sent_at).toBeNull();
  });

  test('CONTROL: the sibling bulk-reschedule pattern (handleReschedule then re-arm) leaves the confirmation pending', async () => {
    const { svc, date } = await seedPendingVisit(2);
    const before = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first('id', 'confirmation_sent');
    await AppointmentReminders.handleReschedule(svc.id, `${date}T10:00`, { sendNotification: false, coverDueWindows: false });
    const mid = await db('appointment_reminders').where({ id: before.id }).first('confirmation_sent');
    // handleReschedule itself claims it (documented: "A reschedule supersedes a still-pending creation confirmation")…
    expect(mid.confirmation_sent).toBe(true);
    // …which is exactly why admin-schedule.js:8884-8888 / auto-dispatch/apply.js:427-431 re-arm afterwards.
    if (!before.confirmation_sent) {
      await db('appointment_reminders').where({ id: before.id }).update({ confirmation_sent: false, confirmation_sent_at: null });
    }
    const after = await db('appointment_reminders').where({ id: before.id }).first('confirmation_sent');
    expect(after.confirmation_sent).toBe(false);
  });
});
