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
// mockDb.failDayRead makes the merged-day read fail (loadDayRows builds its join predicate with raw('false')).
const mockDb = { failDayRead: false };
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => {
    if (key === 'raw' && mockDb.failDayRead) {
      return (sql, ...rest) => {
        if (sql === 'false') throw new Error('synthetic read failure');
        return mockPg.raw(sql, ...rest);
      };
    }
    return typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key];
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Stub mode (default): the send boundary is a stub. Real-boundary mode: the REAL sendCustomerMessage runs
// (validators, the shared slot guard appointmentSendHeld, audit rows) and only the provider call
// (TwilioService.sendSMS) is a stub.
const mockBoundary = { real: false, before: null };
jest.mock('../services/messaging/send-customer-message', () => {
  const actual = jest.requireActual('../services/messaging/send-customer-message');
  return {
    ...actual,
    sendCustomerMessage: jest.fn(async (input) => {
      if (!mockBoundary.real) return { sent: true };
      // A test hook that changes the world between the render and the handoff (once).
      const hook = mockBoundary.before;
      mockBoundary.before = null;
      if (hook) await hook();
      return actual.sendCustomerMessage(input);
    }),
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
// Email legs: stub mode (default) replaces the five senders. Real-email mode runs the REAL appointment-email
// senders (recipient resolution, sendTemplate and its moveHoldLive guard) and stubs only the provider call
// (EmailTemplateLibrary.sendTemplate, below), so nothing can reach a real mailbox.
const mockEmail = { real: false, failProvider: false };
jest.mock('../services/appointment-email', () => {
  const actual = jest.requireActual('../services/appointment-email');
  const names = ['sendAppointmentConfirmationEmail', 'sendAppointmentReminderEmail', 'sendAppointmentNoShowEmail', 'sendTechArrivedEmail', 'sendTechEnRouteEmail'];
  const stubs = {};
  for (const name of names) stubs[name] = jest.fn(async (...args) => (mockEmail.real ? actual[name](...args) : { ok: true }));
  return { ...actual, ...stubs };
});
// The library's dispatch contract: onQueued resolving false aborts before the provider call.
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(async (opts) => {
    if (typeof opts.onQueued === 'function' && (await opts.onQueued()) === false) return { aborted: true };
    if (mockEmail.failProvider) throw new Error('synthetic provider failure');
    return { sent: true, message: { provider_message_id: 'stub-email' } };
  }),
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
const EmailTemplateLibrary = require('../services/email-template-library');
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
    mockDb.failDayRead = false;
    mockEmail.real = false;
    mockEmail.failProvider = false;
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
      await mockPg('customer_interactions').whereIn('customer_id', created.customers).del().catch(() => {});
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
          expect(mine[0].renderedDay.map((t) => t.split('@')[0]).sort()).toEqual(f.rows.map((r) => r.id).sort());
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
    afterEach(() => { mockBoundary.real = false; mockBoundary.before = null; });

    const pair = (date, extra = {}) => fixture({ date, ...extra, specs: [
      { start: '10:00', end: '11:00', name: 'Lawn Care' }, // the LATER service is inserted first (rows[0])
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
    ] });

    // The scan query has no ORDER BY, so the rows of a day come back in heap order (a vacuum reshuffles it).
    // Updating the earlier service LAST puts its new tuple after the later one's, so an unordered scan meets
    // the later service first; the product must send from the earliest row either way.
    const makeLaterMetFirst = (f) => mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ updated_at: new Date() });

    test('24h, two armed rows: ONE merged reminder through the real guard, always sent by the earliest row, whatever order the scan returns', async () => {
      gateOn();
      const f = await pair(nextDate());
      await makeLaterMetFirst(f);
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].appointmentId).toBe(f.rows[1].id); // the 09:00 service sends, not the 10:00 one
      expect(calls[0][1]).toMatch(/between 9:00 AM and 11:00 AM/);
      expect(calls[0][1]).toMatch(/Lawn Care/);
      expect(calls[0][1]).toMatch(/Pest Control/);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(true);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
      // the 10:00 service (rows[0]) is the one covered by the 09:00 service's text
      expect(await auditFor(f.rows[0].id, 'reminder.one_text_per_day.covered')).toHaveLength(1);
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

    test('72h, two armed rows: one reminder through the real guard, always sent by the earliest row', async () => {
      gateOn();
      const f = await pair(nextDate(), { armed72: true });
      await makeLaterMetFirst(f);
      await runReminders(f.date, threeDaysBefore(f.date));
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].appointmentId).toBe(f.rows[1].id);
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
      const { loadDayRows, renderedDayToken } = require('../services/one-text-per-day');
      const f = await pair(nextDate());
      const [later, earlier] = f.rows;
      const ms = (hhmm) => parseETDateTime(`${f.date}T${hhmm}:00`).getTime();
      gateOn();
      const both = renderedDayToken(await loadDayRows(mockPg, later.id));
      expect(both).toHaveLength(2);
      delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
      // gate off: today's rule, with or without a token
      await expect(appointmentSendHeld(later.id, ms('09:00'))).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'))).resolves.toBe(false);
      gateOn();
      // no token (any other caller): a sibling's time is held exactly as before
      await expect(appointmentSendHeld(later.id, ms('09:00'))).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'))).resolves.toBe(false);
      // the merged reminder, named by its rendered members: accepted at the earliest arrival only
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(false);
      await expect(appointmentSendHeld(later.id, ms('08:00'), both)).resolves.toBe(true);
      // a token send is validated by the day alone: the sender's OWN arrival does not rescue it
      await expect(appointmentSendHeld(later.id, ms('10:00'), both)).resolves.toBe(true);
      // a token that is not this day's members is not a merged reminder for this day
      await expect(appointmentSendHeld(later.id, ms('09:00'), [`${later.id}@${ms('10:00')}`])).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), [both[0], `${randomUUID()}@${ms('09:00')}`])).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('09:00'), [...both, `${randomUUID()}@${ms('09:00')}`])).resolves.toBe(true);
      // a member at a different time than rendered is stale
      await expect(appointmentSendHeld(later.id, ms('09:00'), both.map((t) => t.replace(/@\d+$/, `@${ms('13:00')}`)))).resolves.toBe(true);
      // the earlier sibling moves to 08:00: the quoted 09:00 is stale
      await mockPg('scheduled_services').where({ id: earlier.id }).update({ window_start: '08:00', window_end: '09:00' });
      await expect(appointmentSendHeld(later.id, ms('09:00'), both)).resolves.toBe(true);
      // the earlier sibling is cancelled: the day is no longer the rendered one, and 10:00 (own) cannot rescue it
      await mockPg('scheduled_services').where({ id: earlier.id }).update({ status: 'cancelled' });
      await expect(appointmentSendHeld(later.id, ms('08:00'), both)).resolves.toBe(true);
      await expect(appointmentSendHeld(later.id, ms('10:00'), both)).resolves.toBe(true);
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

  describe('a merged reminder must be valid for every member at handoff, and holds are respected', () => {
    const providerCalls = (phone) => TwilioService.sendSMS.mock.calls.filter((c) => c[0] === phone);
    beforeEach(() => {
      mockBoundary.real = true;
      TwilioService.sendSMS.mockImplementation(async () => ({ success: true, sid: `SM${randomUUID().replaceAll('-', '')}`, deliveryOutcome: 'accepted' }));
    });
    afterEach(() => { mockBoundary.real = false; mockBoundary.before = null; });

    // The scan visits the earliest row first (scanOrder), so the 09:00 service is the sender of the merged text
    // and rows[1] (10:00) is the other service the hooks and holds act on, whatever the heap order is.
    const earlyFirst = (date) => fixture({ date, specs: [
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
      { start: '10:00', end: '11:00', name: 'Lawn Care' },
    ] });

    test('the other service is cancelled between render and handoff: nothing goes, the next scan sends a single-visit reminder', async () => {
      gateOn();
      const f = await earlyFirst(nextDate());
      mockBoundary.before = () => mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(0);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(false);
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatch(/Pest Control/);
      expect(calls[0][1]).not.toMatch(/Lawn Care/);
    });

    test('the other service is moved to another day between render and handoff: nothing goes, then a single-visit reminder', async () => {
      gateOn();
      const f = await earlyFirst(nextDate());
      // far from every other test's date (the cron scans every row), and not a multiple of four days away
      const later = etDateString(addETDays(parseETDateTime(`${f.date}T12:00:00`), 41));
      mockBoundary.before = () => mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ scheduled_date: later });
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(0);
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).not.toMatch(/Lawn Care/);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(false);
    });

    test('the other service gets a move hold between render and handoff: nothing goes, then a single-visit reminder', async () => {
      gateOn();
      const f = await earlyFirst(nextDate());
      mockBoundary.before = () => mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id })
        .update({ move_hold_until: new Date(Date.now() + 3600 * 1000) });
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(0);
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).not.toMatch(/Lawn Care/);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(false);
    });

    test('a sibling under a move hold is not named and not closed; it sends its own reminder once released', async () => {
      gateOn();
      const f = await earlyFirst(nextDate());
      const heldUntil = new Date(Date.now() + 365 * 86400000);
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ move_hold_until: heldUntil });
      await runReminders(f.date);
      let calls = providerCalls(f.phone);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatch(/Pest Control/);
      expect(calls[0][1]).not.toMatch(/Lawn Care/);
      expect(calls[0][1]).toMatch(/between 9:00 AM and 11:00 AM/);
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(false);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ move_hold_until: null });
      await runReminders(f.date);
      calls = providerCalls(f.phone);
      expect(calls).toHaveLength(2);
      // released: it now sends its own reminder (it names the whole live day, as any later reminder does)
      expect(calls[1][1]).toMatch(/Lawn Care/);
    });

    test('a sibling whose own confirmation is not yet sent is not a member of the merged day', async () => {
      const { loadDayRows } = require('../services/one-text-per-day');
      const f = await earlyFirst(nextDate());
      expect((await loadDayRows(mockPg, f.rows[0].id)).map((m) => m.scheduled_service_id).sort()).toEqual(f.rows.map((r) => r.id).sort());
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ confirmation_sent: false });
      expect((await loadDayRows(mockPg, f.rows[0].id)).map((m) => m.scheduled_service_id)).toEqual([f.rows[0].id]);
    });

    test('a queued (deferred-contact) copy of a merged reminder replays only while the day validator still accepts it', async () => {
      const { loadDayRows, renderedDayToken, recheckMergedDay } = require('../services/one-text-per-day');
      const f = await earlyFirst(nextDate());
      const ms = parseETDateTime(`${f.date}T09:00:00`).getTime();
      gateOn();
      const token = renderedDayToken(await loadDayRows(mockPg, f.rows[0].id));
      const meta = { scheduled_service_id: f.rows[0].id, rendered_day_members: token, rendered_slot_ms: ms };
      expect(await recheckMergedDay({ scheduled_service_id: f.rows[0].id })).toBeNull(); // not a merged reminder
      expect(await recheckMergedDay(meta)).toBeNull(); // still the rendered day
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      expect(await recheckMergedDay(meta)).toMatchObject({ eligible: false });
    });

    test('a sibling under a street-level address hold is not named and not closed; it sends its own reminder once confirmed', async () => {
      gateOn();
      const f = await earlyFirst(nextDate());
      const held = f.rows[1];
      await mockPg('scheduled_services').where({ id: held.id }).update({ customer_confirmed: false, source_action: 'voice_agent' });
      const [card] = await mockPg('triage_items').insert({
        category: 'booking', reason_code: 'outbound_booking_review', status: 'open',
        related_customer_id: f.customerId, related_scheduled_service_id: held.id,
        payload: JSON.stringify({ street_level_address: 'true', scheduled_service_id: held.id }),
      }).returning('id');
      try {
        await runReminders(f.date);
        let calls = providerCalls(f.phone);
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatch(/Pest Control/);
        expect(calls[0][1]).not.toMatch(/Lawn Care/);
        expect((await reminderOf(held.id)).reminder_24h_sent).toBe(false);
        expect(await auditFor(held.id, 'reminder.one_text_per_day.covered')).toHaveLength(0);
        // the office confirms the address: the hold ends and the service sends its own reminder
        await mockPg('scheduled_services').where({ id: held.id }).update({ customer_confirmed: true });
        await runReminders(f.date);
        calls = providerCalls(f.phone);
        expect(calls).toHaveLength(2);
        expect(calls[1][1]).toMatch(/Lawn Care/);
      } finally {
        await mockPg('triage_items').where({ id: card.id ?? card }).del();
      }
    });
  });

  // The rendered-day token (the members a merged reminder named, each at its rendered arrival) must reach the
  // day validator at EVERY provider boundary. The spy sits on the one guard both the SMS and the email boundary
  // call (visit-groups appointmentSendHeld), so a hop that drops the token fails here whatever the hop is.
  describe('the rendered-day token reaches every provider boundary (real SMS and email guards, only provider calls stubbed)', () => {
    const vg = require('../services/visit-groups');
    let guard;
    let lastSid;
    const providerCalls = (phone) => TwilioService.sendSMS.mock.calls.filter((c) => c[0] === phone);
    const tokenCalls = (serviceId) => guard.mock.calls.filter((c) => String(c[0]) === String(serviceId) && Array.isArray(c[2]));
    const plainCalls = (serviceId) => guard.mock.calls.filter((c) => String(c[0]) === String(serviceId) && c[2] === undefined);
    const emailsFor = (customerId) => EmailTemplateLibrary.sendTemplate.mock.calls.map((c) => c[0]).filter((o) => o.recipientId === customerId);
    const idsOf = (token) => token.map((t) => t.split('@')[0]).sort();
    const setChannel = (customerId, channel) => mockPg('notification_prefs').insert({ customer_id: customerId, service_reminder_24h_channel: channel });
    const failNextSms = (beforeFail) => TwilioService.sendSMS.mockImplementationOnce(async () => {
      if (beforeFail) await beforeFail();
      return { success: false, error: 'stub provider failure' };
    });

    beforeEach(() => {
      mockBoundary.real = true;
      mockEmail.real = true;
      guard = jest.spyOn(vg, 'appointmentSendHeld');
      TwilioService.sendSMS.mockImplementation(async () => {
        lastSid = `SM${randomUUID().replaceAll('-', '')}`;
        return { success: true, sid: lastSid, deliveryOutcome: 'accepted' };
      });
    });
    afterEach(() => {
      guard.mockRestore();
      mockBoundary.real = false;
      mockEmail.real = false;
      mockBoundary.before = null;
    });

    const armedPair = (date, armed72 = false) => fixture({ date, armed72, specs: [
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
      { start: '10:00', end: '11:00', name: 'Lawn Care' },
    ] });
    // The 09:00 service was already told; the 10:30 one is added later and is the SENDER of the merged reminder.
    const laterSender = async (date) => {
      const f = await fixture({ date, specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[0].id }).update({ reminder_24h_sent: true });
      const added = await addService(f, { start: '10:30', end: '11:30', name: 'Mosquito Control' });
      return { f, added };
    };

    test('SMS: the merged text reaches the guard with the token', async () => {
      gateOn();
      const f = await armedPair(nextDate());
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(1);
      const calls = tokenCalls(f.rows[0].id);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(idsOf(calls[0][2])).toEqual(f.rows.map((r) => r.id).sort());
      expect(plainCalls(f.rows[0].id)).toHaveLength(0);
    });

    test('reminder email: the merged email reaches the guard with the token, at both guard calls', async () => {
      gateOn();
      const f = await armedPair(nextDate());
      await setChannel(f.customerId, 'email');
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(0);
      const emails = emailsFor(f.customerId);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Pest Control/);
      expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
      const calls = tokenCalls(f.rows[0].id);
      expect(calls.length).toBeGreaterThanOrEqual(2); // before the provider call and inside the library's onQueued
      expect(plainCalls(f.rows[0].id)).toHaveLength(0);
      expect(idsOf(calls[0][2])).toEqual(f.rows.map((r) => r.id).sort());
    });

    test('night-skip email: outside the send window a both-channel reminder emails the merged day with the token', async () => {
      gateOn();
      const f = await armedPair(nextDate());
      await setChannel(f.customerId, 'both');
      const evening = parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${f.date}T12:00:00`), -1))}T21:00:00`);
      const windowWasOn = gates.smsSendWindow;
      gates.smsSendWindow = true; // the 8AM-8PM ET send window is what sends the notice down the night-skip email path
      try {
        await runReminders(f.date, evening);
      } finally {
        gates.smsSendWindow = windowWasOn;
      }
      expect(providerCalls(f.phone)).toHaveLength(0);
      const emails = emailsFor(f.customerId);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
      expect(tokenCalls(f.rows[0].id).length).toBeGreaterThanOrEqual(2);
      expect(plainCalls(f.rows[0].id)).toHaveLength(0);
    });

    test('SMS-failure email fallback (i): nothing changed, the fallback email goes with the merged label and the token', async () => {
      gateOn();
      const f = await armedPair(nextDate());
      failNextSms();
      await runReminders(f.date);
      expect(providerCalls(f.phone)).toHaveLength(1); // the one failed text
      const emails = emailsFor(f.customerId);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Pest Control/);
      expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
      expect(emails[0].payload.appointment_when).toMatch(/9:00 AM/);
      // the SMS attempt and the email (two guard calls) all carried the token
      expect(tokenCalls(f.rows[0].id).length).toBeGreaterThanOrEqual(3);
      expect(plainCalls(f.rows[0].id)).toHaveLength(0);
      // delivered by email: the other service is covered
      expect((await reminderOf(f.rows[1].id)).reminder_24h_sent).toBe(true);
      expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.covered')).toHaveLength(1);
    });

    test('SMS-failure email fallback (ii): the other service is cancelled before the fallback, so the email is held and nothing is sent', async () => {
      gateOn();
      const f = await armedPair(nextDate());
      failNextSms(() => mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' }));
      await runReminders(f.date);
      expect(emailsFor(f.customerId)).toHaveLength(0);
      expect((await reminderOf(f.rows[0].id)).reminder_24h_sent).toBe(false);
      // the next scan re-renders: a single-visit reminder for the remaining service, by text
      await runReminders(f.date);
      const calls = providerCalls(f.phone);
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toMatch(/Pest Control/);
      expect(calls[1][1]).not.toMatch(/Lawn Care/);
      expect(emailsFor(f.customerId)).toHaveLength(0);
    });

    test('SMS-failure email fallback (iii): the later row as sender quotes the earliest time and its fallback email is NOT held', async () => {
      gateOn();
      const { f, added } = await laterSender(nextDate());
      failNextSms();
      await runReminders(f.date);
      const emails = emailsFor(f.customerId);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Pest Control/);
      expect(emails[0].payload.service_type).toMatch(/Mosquito/);
      expect(emails[0].payload.appointment_when).toMatch(/9:00 AM/);
      expect(tokenCalls(added.id).length).toBeGreaterThanOrEqual(3);
      expect(plainCalls(added.id)).toHaveLength(0);
      expect((await reminderOf(added.id)).reminder_24h_sent).toBe(true);
    });

    // A merged reminder closes its siblings when the provider ACCEPTS the text. If that text then bounces, the
    // customer must still end up told about EVERY service it named: one email for the members still nameable
    // (validated by the same day validator through the token); every sibling that text closed and the email did
    // not cover is armed again to send its own reminder.
    describe('a merged text that was accepted and then bounced', () => {
      const bounce = async (date, f) => {
        guard.mockClear();
        EmailTemplateLibrary.sendTemplate.mockClear();
        freezeNow(dayBefore(date));
        try {
          await AppointmentReminders.handleUndeliveredSms({ sid: lastSid, status: 'undelivered', errorCode: '30003', to: f.phone });
        } finally {
          jest.useRealTimers();
        }
        return emailsFor(f.customerId);
      };
      const threeServices = (date, armed72 = false) => fixture({ date, armed72, specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
        { start: '11:00', end: '12:00', name: 'Mosquito Control' },
      ] });
      const sentFlag = async (id, tier) => (await reminderOf(id))[`reminder_${tier}_sent`];
      const lastAudit = () => mockPg('messaging_audit_log').where({ provider_message_id: lastSid }).first('metadata', 'purpose');

      test.each(['24h', '72h'])('%s: all named services end up covered by ONE delivered email (merged label, token validated), siblings stay closed', async (tier) => {
        gateOn();
        const f = await armedPair(nextDate(), tier === '72h');
        await runReminders(f.date, tier === '72h' ? threeDaysBefore(f.date) : dayBefore(f.date));
        expect(providerCalls(f.phone)).toHaveLength(1);
        expect(Array.isArray((await lastAudit()).metadata.rendered_day_members)).toBe(true); // what links the bounce to the text
        expect(await sentFlag(f.rows[1].id, tier)).toBe(true); // closed on provider accept
        const emails = await bounce(f.date, f);
        expect(emails).toHaveLength(1);
        expect(emails[0].payload.service_type).toMatch(/Pest Control/);
        expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
        expect(tokenCalls(f.rows[0].id).length).toBeGreaterThanOrEqual(2);
        expect(plainCalls(f.rows[0].id)).toHaveLength(0);
        expect(await sentFlag(f.rows[1].id, tier)).toBe(true); // informed by the email: not re-armed, no second message
        expect(providerCalls(f.phone)).toHaveLength(1);
        // a later scan sends nothing more for either service
        await runReminders(f.date, tier === '72h' ? threeDaysBefore(f.date) : dayBefore(f.date));
        expect(providerCalls(f.phone)).toHaveLength(1);
      });

      test('a sibling cancelled before the bounce is not named and nothing is re-armed for it', async () => {
        gateOn();
        const f = await armedPair(nextDate());
        await runReminders(f.date);
        await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
        const emails = await bounce(f.date, f);
        expect(emails).toHaveLength(1);
        expect(emails[0].payload.service_type).toMatch(/Pest Control/);
        expect(emails[0].payload.service_type).not.toMatch(/Lawn Care/);
        expect(await sentFlag(f.rows[1].id, '24h')).toBe(true); // not re-armed
      });

      test('three services, one cancelled before the bounce: the email names the two still live; the cancelled one is not re-armed', async () => {
        gateOn();
        const f = await threeServices(nextDate());
        await runReminders(f.date);
        expect(providerCalls(f.phone)).toHaveLength(1);
        await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
        const emails = await bounce(f.date, f);
        expect(emails).toHaveLength(1);
        expect(emails[0].payload.service_type).toMatch(/Pest Control/);
        expect(emails[0].payload.service_type).toMatch(/Mosquito/);
        expect(emails[0].payload.service_type).not.toMatch(/Lawn Care/);
        expect(await sentFlag(f.rows[1].id, '24h')).toBe(true);
        expect(await sentFlag(f.rows[2].id, '24h')).toBe(true);
      });

      test('the bounce email also fails: every sibling that text closed is armed again and sends its own reminder', async () => {
        gateOn();
        const f = await threeServices(nextDate());
        await runReminders(f.date);
        expect(providerCalls(f.phone)).toHaveLength(1);
        mockEmail.failProvider = true;
        const emails = await bounce(f.date, f);
        mockEmail.failProvider = false;
        expect(emails.length).toBeGreaterThanOrEqual(1); // attempted, none delivered
        expect(await sentFlag(f.rows[1].id, '24h')).toBe(false);
        expect(await sentFlag(f.rows[2].id, '24h')).toBe(false);
        expect(await auditFor(f.rows[1].id, 'reminder.one_text_per_day.reopened')).toHaveLength(1);
        await runReminders(f.date); // the next scan: the re-armed services text again
        expect(providerCalls(f.phone)).toHaveLength(2);
        expect(providerCalls(f.phone)[1][1]).toMatch(/Lawn Care/);
      });

      test('a day that cannot be read at the bounce: the sender gets its single-visit email and the siblings are armed again', async () => {
        gateOn();
        const f = await armedPair(nextDate());
        await runReminders(f.date);
        mockDb.failDayRead = true;
        const failing = { mockRestore: () => { mockDb.failDayRead = false; } };
        let emails;
        try {
          emails = await bounce(f.date, f);
        } finally {
          failing.mockRestore();
        }
        expect(emails).toHaveLength(1);
        expect(emails[0].payload.service_type).not.toMatch(/Lawn Care/);
        expect(await sentFlag(f.rows[1].id, '24h')).toBe(false);
      });

      test('a sibling whose service is no longer live (reminder row untouched) is not re-armed by the bounce', async () => {
        gateOn();
        const f = await armedPair(nextDate());
        await runReminders(f.date);
        await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'skipped' });
        await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ cancelled: false });
        await bounce(f.date, f);
        expect(await sentFlag(f.rows[1].id, '24h')).toBe(true);
      });

      test('a sibling moved to another time since the text is not re-armed by the bounce (the move owns it)', async () => {
        gateOn();
        const f = await armedPair(nextDate());
        await runReminders(f.date);
        const moved = parseETDateTime(`${f.date}T15:00:00`);
        await mockPg('appointment_reminders').where({ scheduled_service_id: f.rows[1].id }).update({ appointment_time: moved });
        await bounce(f.date, f);
        const row = await reminderOf(f.rows[1].id);
        expect(row.reminder_24h_sent).toBe(true);
      });
    });

    test('deferred replay: a queued copy carries the token and replays only while the day validator accepts it', async () => {
      const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
      gateOn();
      const f = await armedPair(nextDate());
      const { loadDayRows, renderedDayToken } = require('../services/one-text-per-day');
      const token = renderedDayToken(await loadDayRows(mockPg, f.rows[0].id));
      const ms = parseETDateTime(`${f.date}T09:00:00`).getTime();
      const customer = await mockPg('customers').where({ id: f.customerId }).first();
      await AppointmentReminders._internals.queueHeldNoticeContacts({
        customer,
        heldContacts: [{ contact: { phone: '+19415550123', role: 'service_contact' }, body: 'Synthetic held text', nextAllowedAt: new Date(Date.now() + 3600e3) }],
        messageType: 'reminder_72h',
        purpose: 'appointment_reminder_72h',
        metaExtra: { scheduled_service_id: f.rows[0].id, rendered_day_members: token, rendered_slot_ms: ms, templateKey: 'reminder_72h' },
      });
      const queued = await mockPg('sms_log').where({ customer_id: f.customerId, status: 'scheduled' }).first();
      const meta = typeof queued.metadata === 'string' ? JSON.parse(queued.metadata) : queued.metadata;
      expect(meta.rendered_day_members).toEqual(token);
      expect(meta.rendered_slot_ms).toBe(ms);
      const entry = 'appointment_notice_contact_deferred';
      const valid = await recheckDeferredReplay(entry, { ...meta, customer_id: f.customerId, to_phone: queued.to_phone });
      expect(valid && valid.reason).not.toBe('merged-day-changed');
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      const stale = await recheckDeferredReplay(entry, { ...meta, customer_id: f.customerId, to_phone: queued.to_phone });
      expect(stale).toMatchObject({ eligible: false, reason: 'merged-day-changed' });
    });
  });

  describe('named = covered (members, technicians)', () => {
    // A service with no reminder row yet (the self-heal sweep has not armed it) is not a member of the
    // merged day: it is not named, so it is not closed, and it sends its own reminder once armed.
    test('a service without a reminder row is not named; after the self-heal sweep arms it, it sends its own reminder (each named once)', async () => {
      gateOn();
      const f = await fixture({ date: nextDate(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      const second = await addService(f, { start: '10:00', end: '11:00', name: 'Lawn Care' });
      await mockPg('appointment_reminders').where({ scheduled_service_id: second.id }).del();
      const heal = jest.spyOn(AppointmentReminders, 'selfHealMissingReminderRows').mockResolvedValueOnce(0);
      await runReminders(f.date);
      heal.mockRestore();
      const first = textsTo(f.phone).map((a) => a.body);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(/Pest Control/);
      expect(first[0]).not.toMatch(/Lawn Care/);
      await runReminders(f.date); // the sweep now arms the second service
      const bodies = textsTo(f.phone).map((a) => a.body);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toMatch(/Lawn Care/);
    });

    test('loadDayRows lists only services that have a live reminder row', async () => {
      const { loadDayRows } = require('../services/one-text-per-day');
      const f = await fixture({ date: nextDate(), specs: [{ start: '09:00', end: '10:00', name: 'Quarterly Pest Control' }] });
      const second = await addService(f, { start: '10:00', end: '11:00', name: 'Lawn Care' });
      expect((await loadDayRows(mockPg, f.rows[0].id)).map((m) => m.scheduled_service_id).sort()).toEqual([f.rows[0].id, second.id].sort());
      await mockPg('appointment_reminders').where({ scheduled_service_id: second.id }).del();
      expect((await loadDayRows(mockPg, f.rows[0].id)).map((m) => m.scheduled_service_id)).toEqual([f.rows[0].id]);
    });

    const techEmail = async (kind, techs) => {
      gateOn();
      mockEmail.real = true;
      const f = await fixture({ date: nextDate(), armed72: kind === '72h', specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', tech: techs[0] },
        { start: '10:00', end: '11:00', name: 'Lawn Care', tech: techs[1] },
      ] });
      await mockPg('notification_prefs').insert({ customer_id: f.customerId, [kind === '72h' ? 'service_reminder_72h_channel' : 'service_reminder_24h_channel']: 'email' });
      await runReminders(f.date, kind === '72h' ? threeDaysBefore(f.date) : dayBefore(f.date));
      return EmailTemplateLibrary.sendTemplate.mock.calls.map((c) => c[0]).filter((o) => o.recipientId === f.customerId);
    };

    test.each(['24h', '72h'])('%s reminder email for a merged day with two technicians names no technician', async (kind) => {
      const emails = await techEmail(kind, [0, 1]);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
      expect(emails[0].payload.technician_name).toBe('');
    });

    test.each(['24h', '72h'])('%s reminder email for a merged day with one technician names that technician, as today', async (kind) => {
      const emails = await techEmail(kind, [0, 0]);
      expect(emails).toHaveLength(1);
      expect(emails[0].payload.service_type).toMatch(/Lawn Care/);
      expect(emails[0].payload.technician_name).toBe('Synthetic');
    });
  });

  // Read-error table (what each caller of the merged-day validator does when the day cannot be read):
  //   render (dayReminderRows)         -> null: the sender's own single-visit reminder, nothing closed
  //   live boundary (appointmentSendHeld via dayArrivalCandidates) -> held; the next scan re-renders
  //   queued early recheck / boundary recheck (recheckMergedDay)   -> retryable, never a terminal drop
  describe('queued merged reminders and read errors', () => {
    const registry = require('../services/messaging/deferred-replay-registry');
    const { loadDayRows, renderedDayToken } = require('../services/one-text-per-day');
    const ENTRY = 'appointment_notice_contact_deferred';
    const queuedMeta = async () => {
      const f = await armedPair(nextDate());
      gateOn();
      const token = renderedDayToken(await loadDayRows(mockPg, f.rows[0].id));
      const meta = {
        scheduled_service_id: f.rows[0].id, rendered_day_members: token,
        rendered_slot_ms: parseETDateTime(`${f.date}T09:00:00`).getTime(), customer_id: f.customerId,
      };
      return { f, meta };
    };
    const armedPair = (date) => fixture({ date, specs: [
      { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
      { start: '10:00', end: '11:00', name: 'Lawn Care' },
    ] });
    // The day read fails: loadDayRows' join builds its predicate with raw('false'); every other query is untouched.
    const failDayRead = () => { mockDb.failDayRead = true; return { mockRestore: () => { mockDb.failDayRead = false; } }; };

    test('a merged queued copy registers the provider-boundary recheck; any other queued row registers none', async () => {
      const { meta } = await queuedMeta();
      expect(typeof registry.deferredProviderPreSendCheck(ENTRY, meta)).toBe('function');
      expect(registry.deferredProviderPreSendCheck(ENTRY, { scheduled_service_id: meta.scheduled_service_id })).toBeUndefined();
    });

    test('a sibling cancelled between the early recheck and the handoff stops the queued text at the boundary (terminal)', async () => {
      const { f, meta } = await queuedMeta();
      expect(await registry.recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: true }); // the early recheck passes
      const boundary = registry.deferredProviderPreSendCheck(ENTRY, meta);
      expect(await boundary({})).toEqual({ ok: true });
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      expect(await boundary({})).toMatchObject({ ok: false, code: 'MERGED_DAY_CHANGED_AT_BOUNDARY', reason: 'merged-day-changed' });
    });

    test('through the scheduler\'s real replay block and the real registry: a sibling changed between the early recheck and the handoff stops the text', async () => {
      const { f, meta } = await queuedMeta();
      const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
      const start = source.indexOf('const sendReplay = () => {');
      const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
      expect(await registry.recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: true }); // the early recheck passes
      // Stands in for twilio.js dispatch(): after its own awaits it runs the caller's providerPreSendCheck; a not-ok
      // verdict is a refusal and the provider request is never made.
      const providerRequest = jest.fn();
      const sendCustomerMessageAtProvider = jest.fn(async (input) => {
        await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' }); // changes during those awaits
        const verdict = await input.providerPreSendCheck({ channel: 'sms', dbi: mockPg });
        if (!verdict || verdict.ok !== true) return { sent: false, blocked: true, code: verdict.code, retryable: verdict.retryable === true };
        providerRequest();
        return { sent: true };
      });
      const result = await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
        msg: { id: 'queue-row', customer_id: f.customerId, to_phone: '+19415550123', message_body: 'Frozen merged reminder', message_type: 'reminder_72h' },
        claimMeta: { ...meta, entry_point: ENTRY },
        toPhone: '+19415550123', purpose: 'appointment_reminder', replayConsentBasis: undefined,
        sendCustomerMessage: sendCustomerMessageAtProvider,
        dispatchScheduledSms: async (_msg, _meta, send) => send(),
        SCHEDULED_SMS_MAX_ATTEMPTS: 3,
        require: () => registry,
      });
      expect(sendCustomerMessageAtProvider).toHaveBeenCalledWith(expect.objectContaining({ providerPreSendCheck: expect.any(Function) }));
      expect(providerRequest).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: false, code: 'MERGED_DAY_CHANGED_AT_BOUNDARY', retryable: false });
    });

    test('a day that cannot be read is retryable, not a terminal drop, at the early recheck and at the boundary', async () => {
      const { meta } = await queuedMeta();
      const boundary = registry.deferredProviderPreSendCheck(ENTRY, meta);
      const failing = failDayRead();
      let early;
      let late;
      try {
        early = await require('../services/one-text-per-day').recheckMergedDay(meta);
        late = await boundary({});
      } finally {
        failing.mockRestore();
      }
      expect(early).toEqual({ eligible: false, retryable: true, reason: 'merged-day-unreadable' });
      expect(late).toMatchObject({ ok: false, retryable: true, code: 'MERGED_DAY_CHECK_FAILED_AT_BOUNDARY' });
      // and once the database answers again the same copy is valid
      expect(await require('../services/one-text-per-day').recheckMergedDay(meta)).toBeNull();
    });

    test('a proven changed day stays terminal (not retryable) at the early recheck', async () => {
      const { f, meta } = await queuedMeta();
      await mockPg('scheduled_services').where({ id: f.rows[1].id }).update({ status: 'cancelled' });
      expect(await registry.recheckDeferredReplay(ENTRY, meta)).toEqual({ eligible: false, reason: 'merged-day-changed' });
    });

    test('live boundary: a day that cannot be read HOLDS the merged send (nothing goes, nothing is dropped)', async () => {
      const { f, meta } = await queuedMeta();
      const vg = require('../services/visit-groups');
      const failing = failDayRead();
      let held;
      try {
        held = await vg.appointmentSendHeld(f.rows[0].id, meta.rendered_slot_ms, meta.rendered_day_members);
      } finally {
        failing.mockRestore();
      }
      expect(held).toBe(true);
      expect(await vg.appointmentSendHeld(f.rows[0].id, meta.rendered_slot_ms, meta.rendered_day_members)).toBe(false);
    });

    test('render: a day that cannot be read gives the sender its own single-visit reminder and closes nothing', async () => {
      const f = await armedPair(nextDate());
      gateOn();
      const failing = failDayRead();
      try {
        await runReminders(f.date);
      } finally {
        failing.mockRestore();
      }
      const bodies = textsTo(f.phone).map((a) => a.body);
      // nothing could be read, so nothing is "already told": each service texts for itself, naming only itself
      expect(bodies).toHaveLength(2);
      expect(bodies.filter((b) => /Pest Control/.test(b) && /Lawn Care/.test(b))).toHaveLength(0);
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

    // The arrived text names the technician who actually arrived (actingTechId), not the scheduled one.
    const arriveBy = (id, tech) => TrackTransitions.markOnProperty(id, { actingTechId: technicians[tech], allowFutureDate: true });
    const deliveredRow = (id, kind) => mockPg('audit_log').where({ resource_id: id, action: 'track.one_text_per_day.delivered' })
      .whereRaw("metadata->>'kind' = ?", [kind]).first();

    test('crew swap: two different people arrive for two visits both assigned to the same technician: two arrived texts', async () => {
      gateOn();
      const f = await twoVisits(); // both scheduled to technician 0
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      await arriveBy(f.rows[0].id, 0);
      await arriveBy(f.rows[1].id, 1);
      expect(texted(TwilioService.sendTechArrived)).toBe(2);
      expect(TwilioService.sendTechArrived.mock.calls.map((c) => c[1])).toEqual(['Synthetic Tech 1', 'Synthetic Tech 2']);
      expect((await deliveredRow(f.rows[0].id, 'arrived')).metadata.technician_id).toBe(technicians[0]);
      expect((await deliveredRow(f.rows[1].id, 'arrived')).metadata.technician_id).toBe(technicians[1]);
    });

    test('the same person arrives for both visits although the second is assigned to someone else: one arrived text', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control', tech: 0 },
        { start: '10:00', end: '11:00', name: 'Lawn Care', tech: 1 },
      ] });
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      await arriveBy(f.rows[0].id, 0);
      await arriveBy(f.rows[1].id, 0);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
      expect(await auditFor(f.rows[1].id, 'track.one_text_per_day.arrived')).toHaveLength(1);
    });

    test('the first visit is reassigned after its text was delivered: the comparison uses the recorded technician', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      await arriveBy(f.rows[0].id, 0);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ technician_id: technicians[1] });
      // technician 1 now arrives for the second visit: the delivered text named technician 0, so this person is texted
      await arriveBy(f.rows[1].id, 1);
      expect(texted(TwilioService.sendTechArrived)).toBe(2);
    });

    test('the first visit is reassigned after its text was delivered: the same recorded person on the second visit is still covered', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      await arriveBy(f.rows[0].id, 0);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ technician_id: technicians[1] });
      await arriveBy(f.rows[1].id, 0);
      expect(texted(TwilioService.sendTechArrived)).toBe(1);
    });

    test('on the way names the scheduled technician: recorded on the delivered row, and a reassignment of the first visit does not change the comparison', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      expect((await deliveredRow(f.rows[0].id, 'en_route')).metadata.technician_id).toBe(technicians[0]);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ technician_id: technicians[1] });
      await enRoute(f.rows[1].id); // scheduled to technician 0, the person the delivered text named
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
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

    test('gate on: a no-show sibling that was texted does not cover the live visit (its track state stays en_route)', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ status: 'no_show' });
      expect((await mockPg('scheduled_services').where({ id: f.rows[0].id }).first('track_state')).track_state).toBe('en_route');
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
    });

    test('gate on: a completed sibling that was texted still covers the live visit', async () => {
      gateOn();
      const f = await fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      await enRoute(f.rows[0].id);
      await mockPg('scheduled_services').where({ id: f.rows[0].id }).update({ status: 'completed', track_state: 'complete' });
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
    });

    // The proof row is the only evidence a text went out. Outcomes by failure point:
    //   1. the row's insert inside the send transaction fails: the row is written again outside it; this visit
    //      does not send twice and the next sibling is covered.
    //   2. that second write also fails: this visit still does not send twice; the next sibling sends (a
    //      possible duplicate, never silence).
    describe('delivery proof write failures', () => {
      const auditLog = require('../services/audit-log');
      const failProof = (times) => {
        const real = auditLog.recordAuditEvent;
        let left = times;
        const spy = jest.spyOn(auditLog, 'recordAuditEvent').mockImplementation(async (input) => {
          if (input.action !== 'track.one_text_per_day.delivered') return real(input);
          // a non-critical write swallows its own error: model that exactly (a lost row, no throw)
          if (left > 0) { left -= 1; if (input.critical !== true) return undefined; throw new Error('synthetic audit insert failure'); }
          return real(input);
        });
        return spy;
      };
      const pair = () => fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      const proofRows = (id) => auditFor(id, 'track.one_text_per_day.delivered');

      test('the proof insert fails once: the text went out once, the proof is written again, the next sibling is covered', async () => {
        gateOn();
        const spy = failProof(1);
        const f = await pair();
        await enRoute(f.rows[0].id);
        spy.mockRestore();
        expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
        expect(await proofRows(f.rows[0].id)).toHaveLength(1);
        await enRoute(f.rows[1].id);
        expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
      });

      test('the proof cannot be written at all: this visit never sends twice, and the next sibling sends (never silence)', async () => {
        gateOn();
        const spy = failProof(2);
        const f = await pair();
        await enRoute(f.rows[0].id);
        spy.mockRestore();
        expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
        expect(await proofRows(f.rows[0].id)).toHaveLength(0);
        await enRoute(f.rows[1].id);
        expect(texted(TwilioService.sendTechEnRoute)).toBe(2);
      });
    });
  });
});
