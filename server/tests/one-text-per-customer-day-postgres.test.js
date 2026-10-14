/**
 * One on-the-way text and one arrived text per customer, service address and day
 * (GATE_ONE_TEXT_PER_CUSTOMER_DAY) against a real migrated schema. Runs when DATABASE_URL is set
 * (CI's "DB-gated suites" step: `waves_test` with CI=true; locally: a private clone named
 * `waves_invoiced_fast_test`) and reports skipped otherwise. The senders (the tracker SMS functions)
 * are stubs: nothing here can reach a real customer. Customers, addresses and phone numbers are synthetic.
 *
 * Isolation: no truncate. The suite inserts its own synthetic technicians, customers, properties and
 * services and deletes exactly those in afterAll, so it neither depends on nor removes another suite's rows.
 *
 * Real path: TrackTransitions.markEnRoute / markOnProperty over real scheduled_services rows.
 */
// mockDb.override: a different knex instance the code under test uses instead (the one-connection pool test).
// mockDb.onTechnicians: runs once, awaited, just before the technician lookup that sits between the arrival claim
// and the send (to change the visit while an attempt is in flight).
const mockDb = { override: null, onTechnicians: null };
jest.mock('../models/db', () => new Proxy((...args) => {
  const target = mockDb.override || mockPg;
  if (args[0] === 'technicians' && mockDb.onTechnicians) {
    const hook = mockDb.onTechnicians;
    mockDb.onTechnicians = null;
    return { where: (...w) => ({ first: async (...c) => { await hook(); return target('technicians').where(...w).first(...c); } }) };
  }
  return target(...args);
}, {
  get: (_, key) => {
    const target = mockDb.override || mockPg;
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(),
  sendTechEnRoute: jest.fn(async () => ({ success: true })),
  sendTechArrived: jest.fn(async () => ({ success: true })),
}));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn(async () => {}),
  clearTechCurrentJob: jest.fn(async () => {}),
}));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn(async () => null) }));
jest.mock('../sockets', () => ({ getIo: () => null }));
jest.mock('../services/recurring-app-intro-email', () => ({ maybeSendOnEnRoute: jest.fn(async () => {}) }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { etDateString } = require('../utils/datetime-et');

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

const TwilioService = require('../services/twilio');
const { gates } = require('../config/feature-gates');

postgres('one text per customer, address and day', () => {
  let TrackTransitions;
  const technicians = [];
  const created = { customers: [], properties: [], rows: [] };
  let groupableServices = [];

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
    TrackTransitions = require('../services/track-transitions');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
    gates.visitGroups = false;
  });

  afterEach(() => {
    mockDb.override = null;
    mockDb.onTechnicians = null;
    delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
    gates.visitGroups = false;
  });

  afterAll(async () => {
    if (!mockPg) return;
    const ids = created.rows;
    if (ids.length) {
      await mockPg('audit_log').whereIn('resource_id', ids).del();
      await mockPg('sms_log').whereIn('customer_id', created.customers).del().catch(() => {});
      await mockPg('scheduled_services').whereIn('id', ids).update({ visit_id: null });
      await mockPg('service_visits').whereIn('customer_id', created.customers).del();
      await mockPg('appointment_reminders').whereIn('scheduled_service_id', ids).del();
      await mockPg('scheduled_services').whereIn('id', ids).del();
    }
    await mockPg('customer_properties').whereIn('id', created.properties).del();
    await mockPg('customers').whereIn('id', created.customers).del();
    await mockPg('technicians').whereIn('id', technicians).del();
    await mockPg.destroy();
  });

  const gateOn = () => { process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true'; };

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
  async function fixture({ date, specs, trackState = 'scheduled' }) {
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
      rows.push({ ...row });
    }
    return { customerId, phone, rows, date };
  }

  const auditFor = (id, action) => mockPg('audit_log').where({ resource_id: id, action }).select('metadata');

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

    // No lock is held across the send: two taps at the same instant may both send (a duplicate, which is what the gate
    // off does), but never zero, and whichever sent has a proof row. Standing down needs a delivered row only a
    // completed send writes.
    const deliveredKinds = async (f, kind) => mockPg('audit_log').whereIn('resource_id', f.rows.map((r) => r.id))
      .where({ action: 'track.one_text_per_day.delivered' }).whereRaw("metadata->>'kind' = ?", [kind]);

    test('gate on, two on-the-way taps in flight together: at least one and at most two texts, never zero, each with a proof', async () => {
      gateOn();
      const f = await twoVisits();
      TwilioService.sendTechEnRoute.mockImplementationOnce(slow({ success: true }));
      await Promise.all([enRoute(f.rows[0].id), enRoute(f.rows[1].id)]);
      const sent = texted(TwilioService.sendTechEnRoute);
      expect(sent).toBeGreaterThanOrEqual(1);
      expect(sent).toBeLessThanOrEqual(2);
      expect(await deliveredKinds(f, 'en_route')).toHaveLength(sent);
    });

    test('gate on, two arrivals in flight together: at least one and at most two texts, never zero, each with a proof', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      TwilioService.sendTechArrived.mockImplementationOnce(slow({ success: true }));
      await Promise.all([onSite(f.rows[0].id), onSite(f.rows[1].id)]);
      const sent = texted(TwilioService.sendTechArrived);
      expect(sent).toBeGreaterThanOrEqual(1);
      expect(sent).toBeLessThanOrEqual(2);
      expect(await deliveredKinds(f, 'arrived')).toHaveLength(sent);
      const guards = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).select('arrival_sms_sent_at');
      expect(guards.every((g) => g.arrival_sms_sent_at !== null)).toBe(true);
    });

    test('sequential taps: exactly one text, the second visit is covered by the recorded delivery', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
    });

    test('the rule holds NO database connection during the send: it completes on a one-connection pool whose sender queries the database', async () => {
      gateOn();
      const f = await twoVisits();
      const tiny = knex({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 4000 });
      mockDb.override = tiny;
      const { sendTrackTextOnce } = require('../services/one-text-per-day');
      const sender = jest.fn(async () => {
        // the real senders query the same pool (customer, template, link lookups)
        await tiny('scheduled_services').where({ id: f.rows[0].id }).first('id');
        return { success: true };
      });
      const started = Date.now();
      try {
        const out = await sendTrackTextOnce(f.rows[0], 'en_route', sender, { technicianId: technicians[0] });
        expect(out).toEqual({ success: true });
      } finally {
        mockDb.override = null;
        await tiny.destroy();
      }
      expect(Date.now() - started).toBeLessThan(3500); // under the old lock-and-transaction design this waits out the acquire timeout
      expect(sender).toHaveBeenCalledTimes(1);
      expect(await deliveredKinds(f, 'en_route')).toHaveLength(1);
    });

    test('an arrival attempt whose visit was re-armed and arrived again while it was in flight records no proof, and a later visit still texts', async () => {
      gateOn();
      const f = await twoVisits();
      await enRoute(f.rows[0].id);
      await enRoute(f.rows[1].id);
      // between the arrival claim and the send, the first visit is re-armed and arrives again (a new arrival, a new claim)
      mockDb.onTechnicians = () => mockPg('scheduled_services').where({ id: f.rows[0].id })
        .update({ arrived_at: new Date(Date.now() + 5000), arrival_sms_sent_at: new Date(Date.now() + 5000) });
      await onSite(f.rows[0].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(1); // the stale attempt still goes out, as without the rule
      expect(await deliveredKinds(f, 'arrived')).toHaveLength(0); // ... and is recorded as proof for nothing
      await onSite(f.rows[1].id);
      expect(texted(TwilioService.sendTechArrived)).toBe(2); // the later visit is not suppressed by the stale attempt
    });

    test('gate on, the first arrival send fails while the second is in flight: the second still sends (never zero)', async () => {
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
          if (left > 0) {
            left -= 1;
            if (input.critical !== true) return undefined;
            throw new Error('synthetic audit insert failure');
          }
          return real(input);
        });
        return spy;
      };
      const pair = () => fixture({ date: etDateString(), specs: [
        { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
        { start: '10:00', end: '11:00', name: 'Lawn Care' },
      ] });
      const proofRows = (id) => auditFor(id, 'track.one_text_per_day.delivered');

      test('the proof insert fails once: the text went out once, the write is retried, the next sibling is covered', async () => {
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

    // The delivered row is the whole truth of who was told, where, on which day, by whom.
    describe('coverage is decided from the recorded delivery', () => {
      const todayPlus = (n) => etDateString(new Date(Date.now() + n * 86400000));
      const proofRows = (id) => auditFor(id, 'track.one_text_per_day.delivered');

      test('a visit moved to another day while its attempt was in flight records no proof for the new day, and a later visit there still texts', async () => {
        gateOn();
        const day2 = todayPlus(3);
        const f = await fixture({ date: etDateString(), specs: [
          { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
          { start: '10:00', end: '11:00', name: 'Lawn Care' },
        ] });
        const [moved, later] = f.rows;
        const { sendTrackTextOnce } = require('../services/one-text-per-day');
        const staleFence = { id: moved.id, scheduled_date: moved.scheduled_date };
        await mockPg('scheduled_services').where({ id: moved.id }).update({ scheduled_date: day2 }); // force-rescheduled during the awaits
        await mockPg('scheduled_services').where({ id: later.id }).update({ scheduled_date: day2 });
        const stale = jest.fn(async () => ({ success: true }));
        expect(await sendTrackTextOnce(moved, 'en_route', stale, { fence: staleFence, technicianId: technicians[0] })).toEqual({ success: true });
        expect(stale).toHaveBeenCalledTimes(1); // the stale attempt still goes out, as it would without the rule
        expect(await proofRows(moved.id)).toHaveLength(0); // ... and is recorded as proof for nothing
        await enRoute(later.id); // a legitimate visit on the new day
        expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
        expect(await proofRows(later.id)).toHaveLength(1);
      });

      test('a first visit whose address changed after its text does not cover a later visit at the new address; one at the original address is still covered', async () => {
        gateOn();
        const f = await fixture({ date: etDateString(), specs: [
          { start: '09:00', end: '10:00', name: 'Quarterly Pest Control' },
          { start: '10:00', end: '11:00', name: 'Lawn Care', propertyIndex: 1 },
          { start: '11:00', end: '12:00', name: 'Mosquito Control' },
        ] });
        const [first, newAddress, original] = f.rows;
        await enRoute(first.id);
        expect(texted(TwilioService.sendTechEnRoute)).toBe(1);
        await mockPg('scheduled_services').where({ id: first.id }).update({ property_id: newAddress.property_id });
        await enRoute(newAddress.id);
        expect(texted(TwilioService.sendTechEnRoute)).toBe(2); // not covered: the text went to the ORIGINAL address
        await enRoute(original.id);
        expect(texted(TwilioService.sendTechEnRoute)).toBe(2); // covered by the recorded delivery at its address
        expect(await auditFor(original.id, 'track.one_text_per_day.en_route')).toHaveLength(1);
      });
    });
  });
});
