/**
 * AUDIT REPRO r2-reschedule-move-engine-reminders-1 — a NON-notifying
 * POST /api/admin/dispatch/:id/reschedule (Day-grid resize / bulk move send
 * notifyCustomer:false) permanently claims a still-pending creation
 * confirmation: syncRescheduleReminder(willNotify:false) →
 * handleReschedule({ sendNotification:false, coverDueWindows:false }) flips
 * confirmation_sent=true (appointment-reminders.js ~4026) and the route never
 * re-arms it (unlike admin-schedule bulk ~8884 and auto-dispatch/apply ~427).
 *
 * Asserts the EXPECTED behaviour (confirmation stays pending so the deferred
 * send / stranded sweep delivers it with the new window). FAILS on current
 * code if the bug is real.
 *
 * Real Postgres (DATABASE_URL = private clone of waves_audit_tpl), real
 * router, real adminAuthenticate with a signed admin access token.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-jwt-secret';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ sid: 'mock' })) }));

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

function tomorrowET() {
  const d = new Date(Date.now() + 36 * 3600000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // YYYY-MM-DD
}

describeOrSkip('r2-reschedule-move-engine-reminders-1: silent dispatch move keeps a pending confirmation pending', () => {
  let db, server, baseUrl, admin, cust;
  const DATE = tomorrowET();

  beforeAll(async () => {
    db = require('../models/db');
    const router = require('../routes/admin-dispatch');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/dispatch', router);
     
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    [admin] = await db('technicians').insert({ name: 'Audit Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    [cust] = await db('customers').insert({ first_name: 'Pending', last_name: 'Confirm', phone: '9415550101', email: `audit-pc-${Date.now()}@local.test`, address_line1: '1 A St', city: 'Sarasota', state: 'FL', zip: '34231', monthly_rate: 99 }).returning('*');
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.destroy();
  });

  const token = () => jwt.sign({ technicianId: admin.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
  const post = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  async function seedPending(windowStart, windowEnd) {
    const [svc] = await db('scheduled_services').insert({
      customer_id: cust.id, technician_id: admin.id, scheduled_date: DATE, service_type: 'Quarterly Pest Control',
      status: 'confirmed', window_start: windowStart, window_end: windowEnd, estimated_duration_minutes: 60,
    }).returning('*');
    // What registerAppointment(deferConfirmation) leaves behind for an admin
    // manual booking whose confirmation has not gone out yet (send-window hold).
    const [rem] = await db('appointment_reminders').insert({
      scheduled_service_id: svc.id, customer_id: cust.id,
      appointment_time: db.raw(`((?::date + ?::time)::timestamp AT TIME ZONE 'America/New_York')`, [DATE, windowStart]),
      service_type: 'Quarterly Pest Control', source: 'admin_manual',
      confirmation_sent: false, reminder_72h_sent: false, reminder_24h_sent: false, cancelled: false,
    }).returning('*');
    return { svc, rem };
  }

  test('route: Day-grid resize (same start, notifyCustomer:false) must leave confirmation_sent=false', async () => {
    const { svc } = await seedPending('10:00', '11:00');
    const before = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
    expect(before.confirmation_sent).toBe(false);
    const r = await post(`/api/admin/dispatch/${svc.id}/reschedule`, {
      newDate: DATE, newWindow: '10:00-12:00', reasonCode: 'dispatch_resize',
      reasonText: 'Duration changed via drag-resize on Day grid', notifyCustomer: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.notificationSent).not.toBe(true);
    const after = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
    // Nothing was texted — the pending creation confirmation must survive so the
    // deferred sendConfirmation / stranded sweep delivers it (with the new window).
    expect(after.confirmation_sent).toBe(false);
  });

  test('route: Day-grid silent move to a new start also must leave confirmation_sent=false', async () => {
    const { svc } = await seedPending('13:00', '14:00');
    const r = await post(`/api/admin/dispatch/${svc.id}/reschedule`, {
      newDate: DATE, newWindow: '15:00-16:00', reasonCode: 'dispatch_bulk',
      reasonText: 'Bulk reschedule (1 items) via Day grid', notifyCustomer: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.notificationSent).not.toBe(true);
    const after = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
    expect(after.confirmation_sent).toBe(false);
  });

  test('CONTROL: handleReschedule with the OLD option set (no keepPendingConfirmation) still claims the confirmation', async () => {
    // This is exactly what syncRescheduleReminder used to pass before the
    // fix — confirms handleReschedule's own default is unchanged (it still
    // supersedes a pending confirmation absent an explicit opt-out), which
    // is why the fix adds keepPendingConfirmation at the ROUTE call site
    // (below) rather than changing this shared service's default for every
    // one of its other callers.
    const { svc } = await seedPending('09:00', '10:00');
    const AppointmentReminders = require('../services/appointment-reminders');
    await AppointmentReminders.handleReschedule(svc.id, `${DATE}T09:00`, { sendNotification: false, coverDueWindows: false });
    const after = await db('appointment_reminders').where({ scheduled_service_id: svc.id }).first();
    expect(after.confirmation_sent).toBe(true);
  });

  test('source: the dispatch route now passes keepPendingConfirmation on the willNotify:false path', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-dispatch'), 'utf8');
    expect(src.includes('keepPendingConfirmation')).toBe(true);
  });
});
