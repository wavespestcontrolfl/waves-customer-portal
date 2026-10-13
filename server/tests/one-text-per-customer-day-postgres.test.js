/**
 * One text per customer, address and day (GATE_ONE_TEXT_PER_CUSTOMER_DAY)
 * against a real migrated schema. Runs when DATABASE_URL is set (CI's
 * "DB-gated suites" step: `waves_test` with CI=true; locally: a private clone
 * named `waves_invoiced_fast_test`) and reports skipped otherwise. The senders
 * (sendCustomerMessage, the tracker SMS functions) are stubs: nothing here can
 * reach a real customer. Customers, addresses and phone numbers are synthetic.
 *
 * Isolation: no truncate. The suite inserts its own synthetic technicians,
 * customers, properties, services and reminder rows and deletes exactly those in
 * afterAll, so it neither depends on nor removes another suite's rows.
 * checkAndSendReminders() scans every reminder row in the database; the fake
 * clock puts "now" two to three months out, where no other suite keeps live rows.
 *
 * Real path: AppointmentReminders.checkAndSendReminders() for the 24h and 72h
 * reminders and markEnRoute / markOnProperty for the tracker texts, over real
 * scheduled_services / appointment_reminders rows.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Stub mode (default): the send boundary is a stub. Real-boundary mode: the REAL sendCustomerMessage runs
// (validators, the shared slot guard appointmentSendHeld, audit rows) and only the provider call
// (TwilioService.sendSMS) is a stub.
const mockBoundary = { real: false };
jest.mock('../services/messaging/send-customer-message', () => {
  const actual = jest.requireActual('../services/messaging/send-customer-message');
  return {
    ...actual,
    sendCustomerMessage: jest.fn(async (input) => (mockBoundary.real ? actual.sendCustomerMessage(input) : { sent: true })),
  };
});
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(),
  sendTechEnRoute: jest.fn(async () => ({ success: true })),
  sendTechArrived: jest.fn(async () => ({ success: true })),
}));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn(async () => {}),
  clearTechCurrentJob: jest.fn(async () => {}),
}));
// No email provider call can happen: the email legs are stubs too.
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentNoShowEmail: jest.fn(async () => ({ ok: true })),
  sendTechArrivedEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn(async () => null) }));
jest.mock('../sockets', () => ({ getIo: () => null }));
jest.mock('../services/recurring-app-intro-email', () => ({ maybeSendOnEnRoute: jest.fn(async () => {}) }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');

// Verified private clone only. The literal `const SKIP = !process.env.DATABASE_URL` line is the marker the CI
// "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;
if (connection) {
  const url = new URL(connection);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_invoiced_fast_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('One-text-per-day Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(120000);

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const TwilioService = require('../services/twilio');
const { gates } = require('../config/feature-gates');

postgres('one text per customer, address and day', () => {
  let AppointmentReminders;
  let TrackTransitions;
  const technicians = [];
  const created = { customers: [], properties: [], rows: [] };
  let groupableServices = [];
  let dayCursor = 60; // each test uses its own future date

  beforeAll(async () => {
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    for (let i = 0; i < 2; i += 1) {
      const id = randomUUID();
      await mockPg('technicians').insert({
        id, name: `Synthetic Tech ${i + 1}`, email: `${id}@example.invalid`,
        password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
        employment_status: 'active', field_dispatchable: true,
      });
      technicians.push(id);
    }
    groupableServices = await mockPg('services').where({ groupable: true, group_family: 'recurring_property_service' })
      .orderBy('id').limit(2).select('id', 'name');
    AppointmentReminders = require('../services/appointment-reminders');
    TrackTransitions = require('../services/track-transitions');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
    gates.visitGroups = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
    gates.visitGroups = false;
  });

  afterAll(async () => {
    if (!mockPg) return;
    const ids = created.rows;
    if (ids.length) {
      await mockPg('audit_log').whereIn('resource_id', ids).del();
      await mockPg('messaging_audit_log').whereIn('customer_id', created.customers).del();
      await mockPg('sms_log').whereIn('customer_id', created.customers).del().catch(() => {});
      await mockPg('short_codes').whereIn('entity_id', ids).del();
      await mockPg('scheduled_services').whereIn('id', ids).update({ visit_id: null });
      await mockPg('service_visits').whereIn('customer_id', created.customers).del();
      await mockPg('appointment_reminders').whereIn('scheduled_service_id', ids).del();
      await mockPg('scheduled_services').whereIn('id', ids).del();
    }
    await mockPg('notification_prefs').whereIn('customer_id', created.customers).del().catch(() => {});
    await mockPg('customer_properties').whereIn('id', created.properties).del();
    await mockPg('customers').whereIn('id', created.customers).del();
    await mockPg('technicians').whereIn('id', technicians).del();
    await mockPg.destroy();
  });

  const gateOn = () => { process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true'; };
  // The fake clock moves Date only; pg timers stay real.
  const freezeNow = (instant) => jest.useFakeTimers({
    now: instant,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'],
  });

  async function makeCustomer() {
    const customerId = randomUUID();
    const phone = `+1941555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await mockPg('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'OneText',
      email: `${customerId}@example.invalid`, phone, active: true,
      property_type: 'residential', address_line1: '1 Example Court', city: 'Parrish',
      state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: false,
      line_type: 'mobile',
    });
    created.customers.push(customerId);
    return { customerId, phone };
  }

  async function makeProperty(customerId, n) {
    const id = randomUUID();
    await mockPg('customer_properties').insert({
      id, customer_id: customerId, is_primary: n === 1, active: true,
      address_line1: `${n} Example Court`, city: 'Parrish', state: 'FL', zip: '34219', source: 'manual',
    });
    created.properties.push(id);
    return id;
  }

  /**
   * Two (or more) services of one customer. specs: { start, end, name, tech?,
   * propertyIndex? (0 = first address, 1 = second), reminder? }. Reminder rows
   * are armed for the 24h tier only (72h and confirmation already closed).
   */
  async function fixture({ date, specs, trackState = 'scheduled', armed72 = false }) {
    const { customerId, phone } = await makeCustomer();
    const props = [await makeProperty(customerId, 1)];
    if (specs.some((s) => s.propertyIndex === 1)) props.push(await makeProperty(customerId, 2));
    const rows = [];
    for (const spec of specs) {
      const [row] = await mockPg('scheduled_services').insert({
        customer_id: customerId, property_id: props[spec.propertyIndex || 0],
        technician_id: technicians[spec.tech || 0], service_type: spec.name,
        ...(spec.serviceIndex !== undefined ? { service_id: groupableServices[spec.serviceIndex].id } : {}),
        scheduled_date: date, window_start: spec.start, window_end: spec.end,
        status: 'confirmed', estimated_duration_minutes: 60, track_state: trackState,
        track_view_token: randomUUID(),
      }).returning('*');
      created.rows.push(row.id);
      const apptTime = parseETDateTime(`${date}T${spec.start}:00`);
      const [reminder] = await mockPg('appointment_reminders').insert({
        scheduled_service_id: row.id, customer_id: customerId, appointment_time: apptTime,
        service_type: spec.name, source: 'system_seed',
        confirmation_sent: true, reminder_72h_sent: !armed72, reminder_24h_sent: false,
        created_at: new Date(Date.now() - 10 * 86400000),
      }).returning('*');
      rows.push({ ...row, reminder });
    }
    return { customerId, phone, rows, date };
  }

  const dateOut = (n) => etDateString(addETDays(new Date(), n));
  // Four days apart: the reminder cron scans every row, so one test's rows (a day or two wide) must sit outside
  // the 24h and 72h bands of the next test's fake clock.
  const nextDate = () => { const d = dateOut(dayCursor); dayCursor += 4; return d; };
  // 10:30 ET the day before the visit day: the 24h tier, inside the send window.
  const dayBefore = (date) => parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${date}T12:00:00`), -1))}T10:30:00`);
  const textsTo = (phone) => sendCustomerMessage.mock.calls.map((c) => c[0]).filter((a) => a.to === phone);
  const reminderOf = (id) => mockPg('appointment_reminders').where({ scheduled_service_id: id }).first();
  const auditFor = (id, action) => mockPg('audit_log').where({ resource_id: id, action }).select('metadata');

  // A service added to an existing fixture later (same customer, address and technician), with an armed reminder row.
  async function addService(f, { start, end, name, armed72 = false }) {
    const [row] = await mockPg('scheduled_services').insert({
      customer_id: f.customerId, property_id: f.rows[0].property_id, technician_id: technicians[0],
      service_type: name, scheduled_date: f.date, window_start: start, window_end: end,
      status: 'confirmed', estimated_duration_minutes: 60,
    }).returning('*');
    created.rows.push(row.id);
    await mockPg('appointment_reminders').insert({
      scheduled_service_id: row.id, customer_id: f.customerId, appointment_time: parseETDateTime(`${f.date}T${start}:00`),
      service_type: name, source: 'system_seed', confirmation_sent: true,
      reminder_72h_sent: !armed72, reminder_24h_sent: false, created_at: new Date(Date.now() - 10 * 86400000),
    });
    return row;
  }

  // 10:30 ET three days before the visit day: the 72h tier.
  const threeDaysBefore = (date) => parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${date}T12:00:00`), -3))}T10:30:00`);

  async function runReminders(date, at = dayBefore(date)) {
    freezeNow(at);
    await AppointmentReminders.checkAndSendReminders();
    jest.useRealTimers();
  }

  describe('24h reminder', () => {
    test('gate on: two back-to-back services get ONE reminder with the merged label and the earlier window', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await runReminders(f.date);
      const sent = textsTo(f.phone);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toMatch(/Pest Control/);
      expect(sent[0].body).toMatch(/Lawn Care/);
      // the earliest arrival (9:00) opens the window, not the 10:00 one
      expect(sent[0].body).toMatch(/between 9:00 AM and 11:00 AM/);
      // both rows are closed; the second one left an audit trace
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(true);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
      const trace = await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered');
      expect(trace).toHaveLength(1);
      expect(trace[0].metadata).toMatchObject({ tier: '24h', covered_by_scheduled_service_id: f.rows[0].id });
    });

    test('gate on: the 72h reminder is ONE text for two back-to-back services; gate off it is two', async () => {
      gateOn();
      const on = await fixture({ date: nextDate(), armed72: true, specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await runReminders(on.date, threeDaysBefore(on.date));
      const sentOn = textsTo(on.phone);
      expect(sentOn).toHaveLength(1);
      expect(sentOn[0].purpose).toBe('appointment_reminder_72h');
      expect(sentOn[0].body).toMatch(/Pest Control/);
      expect(sentOn[0].body).toMatch(/Lawn Care/);
      delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
      const off = await fixture({ date: nextDate(), armed72: true, specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await runReminders(off.date, threeDaysBefore(off.date));
      expect(textsTo(off.phone)).toHaveLength(2);
    });

    test('gate off: the same two services get TWO reminders, as today', async () => {
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(2);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
    });

    test('gate on, email channel: the one reminder email carries the rendered day token and names every service; gate off sends no token', async () => {
      const AppointmentEmail = require('../services/appointment-email');
      for (const on of [true, false]) {
        if (on) gateOn(); else delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
        AppointmentEmail.sendAppointmentReminderEmail.mockClear();
        const f = await fixture({ date: nextDate(), specs: [
          { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
          { start: '10:00', end: '11:00', name: 'Lawn Care' },
        ] });
        await mockPg('notification_prefs').insert({ customer_id: f.customerId, service_reminder_24h_channel: 'email' });
        await runReminders(f.date);
        const mine = AppointmentEmail.sendAppointmentReminderEmail.mock.calls.map((c) => c[0]).filter((a) => a.customerId === f.customerId);
        expect(textsTo(f.phone)).toHaveLength(0);
        if (on) {
          expect(mine).toHaveLength(1);
          expect([...mine[0].renderedDay].sort()).toEqual(f.rows.map((r) => r.id).sort());
          expect(mine[0].serviceLabel).toMatch(/Pest Control/);
          expect(mine[0].serviceLabel).toMatch(/Lawn Care/);
          expect(mine[0].appointmentTime.getTime()).toBe(parseETDateTime(`${f.date}T09:00:00`).getTime());
        } else {
          expect(mine).toHaveLength(2);
          expect(mine.every((a) => a.renderedDay === undefined)).toBe(true);
        }
      }
    });

    test('gate on: two different saved addresses stay TWO reminders', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', propertyIndex: 0 },
        { start: '10:00', end: '11:00', name: 'Lawn Care', propertyIndex: 1 },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(2);
    });

    test('gate on: two armed rows with the same start time are ONE reminder', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '09:00', end: '10:00', name: 'Lawn Care' },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
    });

    test('gate on: two technicians still get ONE reminder (the reminder names no technician)', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', tech: 0 },
        { start: '10:00', end: '11:00', name: 'Lawn Care', tech: 1 },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
    });

    test('gate on: the only visit of the day is never suppressed', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
    });

    test('gate on: a grouped stop still sends exactly ONE reminder (the visit claim and the day rule never both send)', async () => {
      gateOn();
      gates.visitGroups = true;
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', serviceIndex: 0 },
        { start: '09:30', end: '10:30', name: 'Lawn Care', serviceIndex: 1 },
      ] });
      const { maybeGroupRow } = require('../services/visit-groups');
      await maybeGroupRow(f.rows[0].id);
      await maybeGroupRow(f.rows[1].id);
      const grouped = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).select('visit_id');
      expect(grouped[0].visit_id).toBeTruthy();
      expect(grouped[0].visit_id).toBe(grouped[1].visit_id);
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
    });

    test('gate on: the second service cancelled before the reminder leaves a reminder for the remaining one only', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ cancelled: true });
      await runReminders(f.date);
      const sent = textsTo(f.phone);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toMatch(/Pest Control/);
      expect(sent[0].body).not.toMatch(/Lawn Care/);
    });

    test('gate on: the second service cancelled AFTER the reminder adds no text and the remaining visit stays covered', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ cancelled: true });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(true);
    });

    test('gate on: a service added after the day\'s reminder went keeps its own reminder (it was not covered)', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
      ] });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
      const [added] = await mockPg('scheduled_services').insert({
        customer_id: f.customerId, property_id: f.rows[0].property_id, technician_id: technicians[0],
        service_type: 'Mosquito Control', scheduled_date: f.date, window_start: '10:30', window_end: '11:30',
        status: 'confirmed', estimated_duration_minutes: 60,
      }).returning('*');
      created.rows.push(added.id);
      await mockPg('appointment_reminders').insert({
        scheduled_service_id: added.id, customer_id: f.customerId, appointment_time: parseETDateTime(`${f.date}T10:30:00`),
        service_type: 'Mosquito Control', source: 'system_seed', confirmation_sent: true,
        reminder_72h_sent: true, reminder_24h_sent: false, created_at: new Date(Date.now() - 10 * 86400000),
      });
      await runReminders(f.date);
      const sent = textsTo(f.phone);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toMatch(/Mosquito/);
    });

    test('gate on: a failed delivery closes nothing, so the other service still texts (never silent)', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      // the text and its email fallback both fail for the first row
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'PROVIDER_ERROR', retryable: true });
      require('../services/appointment-email').sendAppointmentReminderEmail.mockResolvedValueOnce({ ok: false, error: 'stub failure' });
      await runReminders(f.date);
      // the first attempt failed, so it covered nothing: the second row still
      // sent its own text (two provider calls, one delivered)
      expect(textsTo(f.phone)).toHaveLength(2);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
    });
  });

  describe('reminder through the real send boundary (only the provider call is stubbed)', () => {
    const { appointmentSendHeld } = require('../services/visit-groups');
    const providerCalls = (phone) => TwilioService.sendSMS.mock.calls.filter((c) => c[0] === phone);

    beforeEach(() => {
      mockBoundary.real = true;
      TwilioService.sendSMS.mockImplementation(async () => ({ success: true, sid: `SM${randomUUID().replaceAll('-', '')}`, deliveryOutcome: 'accepted' }));
    });
    afterEach(() => { mockBoundary.real = false; });

    const pair = (date, extra = {}) => fixture({ date, ...extra, specs: [
      { start: '10:00', end: '11:00', name: 'Lawn Care' }, // the LATER service is inserted first, so the cron meets it first
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
    ] });

    test('24h, later row scanned first: the later row sends the earliest arrival through the real guard and covers the other', async () => {
      gateOn();
      const f = await pair(nextDate());
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].appointmentId).toBe(f.rows[0].id); // the later service was scanned and sent first
      expect(calls[0][1]).toMatch(/between 9:00 AM and 11:00 AM/);
      expect(calls[0][1]).toMatch(/Lawn Care/);
      expect(calls[0][1]).toMatch(/Pest Control/);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(true);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(1);
    });

    test('24h, a service added after the first reminder sends its own reminder through the real guard', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(1);
      await addService(f, { start: '10:30', end: '11:30', name: 'Mosquito Control' });
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toMatch(/Mosquito/);
      expect(calls[1][1]).toMatch(/Pest Control/);
    });

    test('72h, later row scanned first: one reminder through the real guard', async () => {
      gateOn();
      const f = await pair(nextDate(), { armed72: true });
      await runReminders(f.date, threeDaysBefore(f.date));
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].appointmentId).toBe(f.rows[0].id); // the later service was scanned and sent first
      expect(calls[0][1]).toMatch(/9:00 AM/);
      expect((await reminderOf(f.rows[0].id)).reminder_72h_sent).toBe(true);
      expect((await reminderOf(f.rows[1].id)).reminder_72h_sent).toBe(true);
    });

    test('72h, a service added after the first reminder sends its own reminder through the real guard', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), armed72: true, specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      await runReminders(f.date, threeDaysBefore(f.date));
      expect(providerCalls(f.phone)).toHaveLength(1);
      await addService(f, { start: '10:00', end: '11:00', name: 'Mosquito Control', armed72: true });
      await runReminders(f.date, threeDaysBefore(f.date));
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toMatch(/Mosquito/);
    });

    test('the validator accepts the earliest arrival only for the merged reminder that named the day, and nothing stale', async () => {
      const f = await pair(nextDate());
      const [later, earlier] = f.rows;
      const both = [later.id, earlier.id];
      const ms = (hhmm) => parseETDateTime(`${f.date}T${hhmm}:00`).getTime();
      // gate off: today's rule, with or without a token
      await expect(appointmentSendHeld(later.id, ms('09:00'))).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'))).resolves.toBe(false);
      gateOn();
      // no token (any other caller): a sibling's time is held exactly as before
      await expect(appointmentSendHeld(later.id, ms('09:00'))).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'))).resolves.toBe(false);
      // the merged reminder, named by its rendered members: accepted
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(false);
      await expect(appointmentSendHeld(later.id, ms('08:00'), both)).resolves.toBe(true);
      // a token that is not this day's members is not a merged reminder for this day
      await expect(appointmentSendHeld(later.id, ms('09:00'), [later.id])).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), [earlier.id, randomUUID()])).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), [...both, randomUUID()])).resolves.toBe(true);
      // the earlier sibling moves to 08:00: the quoted 09:00 is stale
      await mockPg('scheduled_services').where({ id: earlier.id }).update({ window_start: '08:00', window_end: '09:00' });
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('08:00'), both)).resolves.toBe(false);
      // the earlier sibling is cancelled: the day is no longer the rendered one
      await mockPg('scheduled_services').where({ id: earlier.id }).update({ status: 'cancelled' });
      await expect(appointmentSendHeld(later.id, ms('08:00'), both)).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'))).resolves.toBe(false);
    });

    test('gate on: a confirmation or reschedule notice quoting an obsolete sibling time is HELD at the real boundary; its own time is sent', async () => {
      gateOn();
      // 09:00 and 10:00 services; the 09:00 one then moved to 10:00-ish, so 09:00 is only the sibling's time now
      const f = await pair(nextDate());
      const moved = f.rows[0]; // started 10:00
      const sibling = f.rows[1]; // stays 09:00
      freezeNow(dayBefore(f.date));
      const ms = (hhmm) => parseETDateTime(`${f.date}T${hhmm}:00`).getTime();
      const send = (extra, renderedSlotMs) => sendCustomerMessage({
        to: f.phone, body: 'Synthetic notice', channel: 'sms', audience: 'customer', customerId: f.customerId,
        identityTrustLevel: 'phone_matches_customer', appointmentId: moved.id, renderedSlotMs, ...extra,
      });
      const confirmation = { purpose: 'appointment_confirmation' };
      const reschedule = { purpose: 'appointment', enforceMoveHold: true, conversationalContext: true };
      expect(sibling.window_start).toBeTruthy();
      for (const extra of [confirmation, reschedule]) {
        TwilioService.sendSMS.mockClear();
        const stale = await send(extra, ms('09:00'));
        expect(stale.code).toBe('MOVE_HOLD');
        expect(providerCalls(f.phone)).toHaveLength(0);
        const own = await send(extra, ms('10:00'));
        expect(own.code).not.toBe('MOVE_HOLD');
      }
      jest.useRealTimers();
    });
  });

  describe('reminder closure covers only what the text named', () => {
    test('sender moved while the send was in flight: the new day\'s reminders stay armed', async () => {
      gateOn();
      const date = nextDate();
      const f = await fixture({ date, specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      const nextDay = etDateString(addETDays(parseETDateTime(`${date}T12:00:00`), 1));
      // a service of the same customer and address on the day the sender is about to move to
      const [later] = await mockPg('scheduled_services').insert({
        customer_id: f.customerId, property_id: f.rows[0].property_id, technician_id: technicians[0],
        service_type: 'Mosquito Control', scheduled_date: nextDay, window_start: '11:00', window_end: '12:00',
        status: 'confirmed', estimated_duration_minutes: 60,
      }).returning('*');
      created.rows.push(later.id);
      await mockPg('appointment_reminders').insert({
        scheduled_service_id: later.id, customer_id: f.customerId, appointment_time: parseETDateTime(`${nextDay}T11:00:00`),
        service_type: 'Mosquito Control', source: 'system_seed', confirmation_sent: true,
        reminder_72h_sent: true, reminder_24h_sent: false, created_at: new Date(Date.now() - 10 * 86400000),
      });
      sendCustomerMessage.mockImplementationOnce(async () => {
        await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ scheduled_date: nextDay, window_start: '09:00', window_end: '10:00' });
        return { sent: true };
      });
      await runReminders(date);
      expect(textsTo(f.phone)).toHaveLength(1);
      // the customer was told the old day: its other service is covered, the new day's reminders are not
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
      const untouched = await reminderOf(later.id);
      expect(untouched.reminder_24h_sent).toBe(false);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(false); // the moved sender is re-armed for its new day
    });

    test('a member whose label cannot be resolved drops the day coverage: own label, own arrival, nothing else closed', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      // the add-on lookup (part of every member's label) is down for the whole run
      const real = mockPg;
      mockPg = new Proxy(real, {
        apply: (target, thisArg, args) => {
          if (args[0] === 'scheduled_service_addons') throw new Error('add-on lookup down');
          return target(...args);
        },
        get: (target, key) => (typeof target[key] === 'function' ? target[key].bind(target) : target[key]),
      });
      try {
        await runReminders(f.date);
      } finally {
        mockPg = real;
      }
      const sent = textsTo(f.phone);
      // no day text was possible: each service sent its own reminder, with its own label and its own arrival
      expect(sent).toHaveLength(2);
      expect(sent[0].body).toMatch(/Pest Control/);
      expect(sent[0].body).not.toMatch(/Lawn Care/);
      expect(sent[0].body).toMatch(/between 9:00 AM and 11:00 AM/);
      expect(sent[1].body).toMatch(/Lawn Care/);
      expect(sent[1].body).not.toMatch(/Pest Control/);
      expect(sent[1].body).toMatch(/between 10:00 AM and 12:00 PM/);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
    });

    test('a member with no usable service name drops the day coverage too', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ service_type: '' });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(2);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
    });

    test('a service added while the send was in flight stays armed and sends its own reminder', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      let added;
      sendCustomerMessage.mockImplementationOnce(async () => {
        added = await addService(f, { start: '10:30', end: '11:30', name: 'Mosquito Control' });
        return { sent: true };
      });
      await runReminders(f.date);
      expect(textsTo(f.phone)).toHaveLength(1);
      expect((await reminderOf(added.id)).reminder_24h_sent).toBe(false);
      await runReminders(f.date);
      const sent = textsTo(f.phone);
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toMatch(/Mosquito/);
    });
  });

  describe('on the way and arrived texts', () => {
    const enRoute = (id) => TrackTransitions.markEnRoute(id, { allowFutureDate: true, actorType: 'tech', actorId: technicians[0] });
    const onSite = (id) => TrackTransitions.markOnProperty(id, { actingTechId: technicians[0], allowFutureDate: true });
    const texted = (fn) => fn.mock.calls.length;
    beforeEach(() => { gates.techArrivedSms = true; });
    afterEach(() => { gates.techArrivedSms = false; });

    test('gate on: the second back-to-back visit sends no second on-the-way text and leaves an audit trace', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      const second = await mockPg('scheduled_services').where({ id: f.rows[1].id }).first('track_state', 'track_sms_sent_at');
      expect(second.track_state).toBe('en_route');
      expect(second.track_sms_sent_at).not.toBeNull();
      expect(await auditFor(f.rows[1].id, 'track.one_text_per_day.en_route')).toHaveLength(1);
    });

    test('gate off: two on-the-way texts, as today', async () => {
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });

    test('gate on: the second visit sends no second arrived text', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      await onSite(f.rows[0].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
      await enRoute(f.rows[1].id);
      await onSite(f.rows[1].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
      const second = await mockPg('scheduled_services').where({ id: f.rows[1].id }).first('track_state', 'arrival_sms_sent_at');
      expect(second.track_state).toBe('on_property');
      expect(second.arrival_sms_sent_at).not.toBeNull();
      expect(await auditFor(f.rows[1].id, 'track.one_text_per_day.arrived')).toHaveLength(1);
    });

    test('gate on: a grouped stop still sends exactly ONE on-the-way text (the visit claim decides; the day rule adds nothing)', async () => {
      gateOn();
      gates.visitGroups = true;
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', serviceIndex: 0 },
        { start: '09:30', end: '10:30', name: 'Lawn Care', serviceIndex: 1 },
      ] });
      const { maybeGroupRow } = require('../services/visit-groups');
      await maybeGroupRow(f.rows[0].id);
      await maybeGroupRow(f.rows[1].id);
      const grouped = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).select('visit_id');
      expect(grouped[0].visit_id).toBeTruthy();
      expect(grouped[0].visit_id).toBe(grouped[1].visit_id);
      await enRoute(f.rows[0].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
    });

    test('gate on: two addresses get their own on-the-way texts', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', propertyIndex: 0 },
        { start: '10:00', end: '11:00', name: 'Lawn Care', propertyIndex: 1 },
      ] });
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });

    test('gate on: a different technician on the second visit still gets an on-the-way text (the text names who is coming)', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', tech: 0 },
        { start: '10:00', end: '11:00', name: 'Lawn Care', tech: 1 },
      ] });
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });

    test('gate on: the only visit of the day is never suppressed', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      await enRoute(f.rows[0].id);
      await onSite(f.rows[0].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
    });

    // A sender that takes a while, so two taps are both in flight together.
    const slow = (value, ms = 300) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return value;
    };
    const twoVisits = () => fixture({ date: etDateString(), specs: [
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
      { start: '10:00', end: '11:00', name: 'Lawn Care' },
    ] });

    test('gate on, two on-the-way taps in flight together: exactly one text, never zero', async () => {
      gateOn();
      const f = await twoVisits();
      TwilioService.sendTechEnRoute.mockImplementationOnce(slow({ success: true }));
      await Promise.all([enRoute(f.rows[0].id), enRoute(f.rows[1].id)]);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      expect(await mockPg('audit_log').whereIn('resource_id', f.rows.map((r) => r.id)).where({ action: 'track.one_text_per_day.delivered' })).toHaveLength(1);
    });

    test('gate on, two arrivals in flight together: exactly one arrived text, never zero', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      TwilioService.sendTechArrived.mockImplementationOnce(slow({ success: true }));
      await Promise.all([onSite(f.rows[0].id), onSite(f.rows[1].id)]);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
      const guards = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).select('arrival_sms_sent_at');
      expect(guards.every((g) => g.arrival_sms_sent_at !== null)).toBe(true);
    });

    test('gate on, the first arrival send fails while the second waits: the second still sends (never zero)', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      TwilioService.sendTechArrived.mockImplementationOnce(slow({ success: false }, 200));
      await Promise.all([onSite(f.rows[0].id), onSite(f.rows[1].id)]);
      expect(texted(TwilioService.sendTechArrived)).toBe(2);
      expect(await mockPg('audit_log').whereIn('resource_id', f.rows.map((r) => r.id))
        .where({ action: 'track.one_text_per_day.delivered' }).whereRaw("metadata->>'kind' = 'arrived'")).toHaveLength(1);
    });

    test('gate on, arrival texts disabled: a stamped sibling whose text never went does not cover the next visit', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      gates.techArrivedSms = false;
      await onSite(f.rows[0].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(0);
      expect((await mockPg('scheduled_services').where({ id: f.rows[0].id }).first('arrival_sms_sent_at')).arrival_sms_sent_at).not.toBeNull();
      gates.techArrivedSms = true;
      await onSite(f.rows[1].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
    });

    test('gate on: a sibling whose arrived text was suppressed (opt-out) or failed does not cover the next visit', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      TwilioService.sendTechArrived.mockImplementationOnce(async () => ({ success: false, suppressed: true, reason: 'opt_out' }));
      await onSite(f.rows[0].id);
      await onSite(f.rows[1].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(2);
    });

    test('gate on: a first on-the-way text that was not delivered does not cover the second visit', async () => {
      gateOn();
      const f = await twoVisits();
      TwilioService.sendTechEnRoute.mockImplementationOnce(async () => ({ success: false }));
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });

    test('gate on: a cancelled sibling that was texted does not cover the live visit', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ status: 'cancelled' });
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });
  });
});
