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
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
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
  const nextDate = () => dateOut(dayCursor++);
  // 10:30 ET the day before the visit day: the 24h tier, inside the send window.
  const dayBefore = (date) => parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${date}T12:00:00`), -1))}T10:30:00`);
  const textsTo = (phone) => sendCustomerMessage.mock.calls.map((c) => c[0]).filter((a) => a.to === phone);
  const reminderOf = (id) => mockPg('appointment_reminders').where({ scheduled_service_id: id }).first();
  const auditFor = (id, action) => mockPg('audit_log').where({ resource_id: id, action }).select('metadata');

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
