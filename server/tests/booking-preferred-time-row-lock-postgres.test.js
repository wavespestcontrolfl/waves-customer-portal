/**
 * The preferred-time submit and the abandoned-booking recovery worker meet on
 * ONE thing — the booking_intents ROW — proven against real PostgreSQL row
 * locks (skipped without DATABASE_URL, like the other *-postgres suites).
 *
 *   - worker first: SELECT ... FOR UPDATE held across the send; the submit's
 *     suppression UPDATE waits for it (the send counts as already happened);
 *   - submit first: the worker's FOR UPDATE waits for the submit's commit, then
 *     re-reads the row as suppressed and sends nothing;
 *   - one intent row per SESSION: a visitor who corrected phone A -> B is still
 *     found (the lock is on the row, not on a phone key);
 *   - the lead + its funnel row commit or roll back together, and the
 *     suppression rolls back with them (fail closed, nothing half-written);
 *   - a refresh of an open lead that staff closed in the meantime becomes a NEW
 *     lead instead of writing onto the closed one;
 *   - a refresh MERGES its request fields into extracted_data (first-touch keys
 *     survive, a staff-added key survives);
 *   - a booking that committed while the submit was in flight converts the
 *     just-filed lead post-commit (no bell);
 *   - a booking that already converted the lead (helper reports converted:0)
 *     leaves the bell silent; a callback visit is never reconciled as a win;
 *   - a refresh that changes the service reclassifies the linked funnel row.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/experimentation/growthbook', () => ({ assignBookingRecoveryExperiment: jest.fn() }));
jest.mock('../services/lead-source-resolver', () => ({ resolveLeadSource: jest.fn(async () => ({ leadSourceId: null })) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})) }));
const mockConvert = jest.fn();
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: (...a) => mockConvert(...a) }));
const mockStamp = jest.fn();
jest.mock('../services/lead-funnel-bridge', () => ({ stampLeadFunnelRow: (...a) => mockStamp(...a) }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('preferred-time submit vs recovery worker on PostgreSQL (intent row lock)', () => {
  const schema = `pt_rowlock_${randomUUID().replaceAll('-', '')}`;
  let database;
  let recordPreferredTimeRequest;
  let withLockedRecoveryIntent;

  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const settled = (p) => { const s = { done: false }; p.then(() => { s.done = true; }, () => { s.done = true; }); return s; };

  const value = (extra = {}) => ({
    firstName: 'Pat', lastName: 'Sample', phone: '9415550100', email: null, addressLine1: null, city: null, state: null, zip: null,
    preferredDate: '2099-01-05', secondDate: null, timeOfDay: 'morning', note: null, sessionId: null, attribution: null, ...extra,
  });
  const intent = async (over = {}) => {
    const id = randomUUID();
    await database('booking_intents').insert({ id, phone: '+19415550100', session_id: null, ...over });
    return { id, phone: '+19415550100', ...over };
  };
  const intentRow = (id) => database('booking_intents').where({ id }).first();

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 8 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.booking_intents (
      id uuid PRIMARY KEY, session_id text, phone text NOT NULL, suppressed boolean DEFAULT false,
      converted_at timestamptz, captured_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`, [schema]);
    await database.raw(`CREATE TABLE ??.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, last_name text, phone text, email text, address text, city text, zip text,
      lead_type text, service_interest text, first_contact_at timestamptz, first_contact_channel text, status text, is_residential boolean,
      transcript_summary text, extracted_data jsonb, lead_source_id uuid, gclid text, wbraid text, gbraid text, fbclid text, fbc text, fbp text,
      converted_at timestamptz, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`, [schema]);
    await database.raw('CREATE TABLE ??.funnel_rows (lead_id uuid PRIMARY KEY)', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY, phone text)', [schema]);
    await database.raw(`CREATE TABLE ??.self_booked_appointments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status text DEFAULT 'confirmed', created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw('CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), self_booking_id uuid, status text DEFAULT \'pending\', is_callback boolean DEFAULT false)', [schema]);
    await database.raw('CREATE TABLE ??.ad_service_attribution (lead_id uuid PRIMARY KEY, service_line text, specific_service text, service_bucket text, funnel_stage text DEFAULT \'lead\')', [schema]);
    ({ recordPreferredTimeRequest } = require('../services/booking-preferred-time'));
    ({ _internals: { withLockedRecoveryIntent } } = require('../services/booking-abandon-recovery'));
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  beforeEach(async () => {
    await database('leads').del();
    await database('booking_intents').del();
    await database('funnel_rows').del();
    await database('ad_service_attribution').del();
    await database('self_booked_appointments').del();
    await database('scheduled_services').del();
    await database('customers').del();
    mockConvert.mockReset();
    mockStamp.mockReset();
    mockStamp.mockImplementation(async (handle, lead) => { await handle('funnel_rows').insert({ lead_id: lead.id }); return lead.id; });
  });

  test('worker first: the submit waits for the send to finish, then suppresses (the send counts as already happened)', async () => {
    const it = await intent();
    const sendGate = gate();
    const sends = [];
    const worker = withLockedRecoveryIntent(database, it, async () => { sends.push('send'); await sendGate.p; return { sent: true }; });
    await tick();
    expect(sends).toEqual(['send']);
    const submit = recordPreferredTimeRequest(database, value(), { notify: false });
    const submitState = settled(submit);
    await tick();
    expect(submitState.done).toBe(false); // parked on the intent row
    sendGate.open();
    expect((await worker).skipped).toBeNull();
    await submit;
    expect((await intentRow(it.id)).suppressed).toBe(true);
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('submit first: the worker waits for the commit, re-reads the row suppressed, and never sends', async () => {
    const it = await intent();
    const slow = gate();
    // The submit is mid-transaction (intent already suppressed-but-uncommitted, lead written) while its funnel stamp is slow.
    mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
    const submit = recordPreferredTimeRequest(database, value(), { notify: false });
    await tick();
    let sent = false;
    const worker = withLockedRecoveryIntent(database, it, async () => { sent = true; return { sent: true }; });
    const workerState = settled(worker);
    await tick();
    expect(workerState.done).toBe(false); // parked on the row lock
    slow.open();
    await submit;
    const out = await worker;
    expect(out).toEqual({ skipped: 'closed' });
    expect(sent).toBe(false);
  });

  test('phone corrected A -> B in one session: the submit under phone B suppresses the SAME session row the worker holds', async () => {
    const it = await intent({ phone: '+19415550199', session_id: 'sess-1' }); // worker read phone A
    const sendGate = gate();
    const worker = withLockedRecoveryIntent(database, { ...it, phone: '+19415550199' }, async () => { await sendGate.p; return { sent: true }; });
    await tick();
    const submit = recordPreferredTimeRequest(database, value({ phone: '9415550100', sessionId: 'sess-1' }), { notify: false });
    const submitState = settled(submit);
    await tick();
    expect(submitState.done).toBe(false); // serialized on the row even though the phones differ
    sendGate.open();
    await worker;
    await submit;
    expect((await intentRow(it.id)).suppressed).toBe(true);
  });

  test('funnel-row failure rolls the whole submit back: no lead, and the intent is NOT suppressed', async () => {
    const it = await intent();
    mockStamp.mockRejectedValue(new Error('funnel insert failed'));
    await expect(recordPreferredTimeRequest(database, value(), { notify: false })).rejects.toThrow('funnel insert failed');
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '0' });
    expect((await intentRow(it.id)).suppressed).toBe(false);
  });

  test('lead and its funnel row commit together', async () => {
    const out = await recordPreferredTimeRequest(database, value(), { notify: false });
    expect(out.created).toBe(true);
    expect(await database('funnel_rows').where({ lead_id: out.leadId }).first()).toBeTruthy();
  });

  test('a refresh whose target staff closed since the lookup becomes a NEW lead; the closed one is untouched', async () => {
    const first = await recordPreferredTimeRequest(database, value({ firstName: 'Original' }), { notify: false });
    const staff = await database.transaction(async (trx) => {
      await trx('leads').where({ id: first.leadId }).update({ status: 'lost' });
      const second = recordPreferredTimeRequest(database, value({ firstName: 'Refreshed' }), { notify: false });
      const state = settled(second);
      await tick(300);
      expect(state.done).toBe(false); // its UPDATE is parked on the row staff is closing
      return { second };
    });
    const out = await staff.second;
    expect(out.created).toBe(true);
    expect(out.leadId).not.toBe(first.leadId);
    const closed = await database('leads').where({ id: first.leadId }).first();
    expect(closed).toMatchObject({ status: 'lost', first_name: 'Original' });
    expect(await database('leads').count('* as n').first()).toMatchObject({ n: '2' });
  });
  test('a refresh merges only its request fields: first-touch UTM / referrer / landing URL and a staff-added key survive', async () => {
    const attr = { utm: { source: 'google' }, referrer: 'https://www.google.com/', landing_url: 'https://portal.test/book?gclid=1' };
    const first = await recordPreferredTimeRequest(database, value({ note: 'first', attribution: attr }), { notify: false });
    await database('leads').where({ id: first.leadId }).update({
      extracted_data: database.raw("extracted_data || '{\"staff_flag\": true}'::jsonb"),
    });
    const again = await recordPreferredTimeRequest(database, value({
      note: 'second', addressLine2: 'Apt 4B',
      attribution: { utm: { source: 'direct' }, referrer: 'https://x.example/', landing_url: 'https://portal.test/book' },
    }), { notify: false });
    expect(again).toEqual({ created: false, leadId: first.leadId });
    const row = await database('leads').where({ id: first.leadId }).first();
    expect(row.extracted_data).toMatchObject({
      note: 'second', address_line2: 'Apt 4B', staff_flag: true,
      utm: { source: 'google' }, referrer: 'https://www.google.com/', landing_url: 'https://portal.test/book?gclid=1',
    });
  });

  test('a booking committed while the submit was in flight converts the just-filed lead after commit, and no bell rings', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    const slow = gate();
    mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
    mockConvert.mockResolvedValue({ converted: true });
    const submit = recordPreferredTimeRequest(database, value(), { notify: true });
    await tick();
    // /confirm commits its booking (and its own conversion finds no lead yet) while the submit is mid-transaction.
    await database('customers').insert({ id: cust, phone: '+19415550100' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    slow.open();
    const out = await submit;
    expect(out.created).toBe(true);
    expect(mockConvert).toHaveBeenCalledWith(expect.objectContaining({ source: 'preferred_time_booked', customerId: cust, leadId: out.leadId }));
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a booking made BEFORE the request began (beyond the skew slack) is not this request\'s to reconcile: the bell rings', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100' });
    await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() - 3600000) });
    await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(mockConvert).not.toHaveBeenCalled();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a concurrent booking that already converted the lead (the helper then reports converted:0) leaves the bell silent', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    // The booking's own conversion wins the lead just before our helper's write: our call reports nothing converted.
    mockConvert.mockImplementation(async ({ leadId }) => {
      await database('leads').where({ id: leadId }).update({ status: 'converted', converted_at: new Date() });
      return { converted: false };
    });
    const out = await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(out.created).toBe(true);
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a callback visit is not reconciled as a win: the lead stays open and rings; an older real booking still converts', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100' });
    const cb = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: cb[0].id, is_callback: true });
    mockConvert.mockResolvedValue({ converted: true });
    const out = await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(mockConvert).not.toHaveBeenCalled();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(out.created).toBe(true);

    // An older, real booking in the same window still reconciles (the callback is skipped, not the whole lookup).
    triggerNotification.mockClear();
    await database('leads').del();
    await database('self_booked_appointments').del();
    await database('scheduled_services').del();
    const real = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() - 20000) }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: real[0].id, is_callback: false });
    const cb2 = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: cb2[0].id, is_callback: true });
    await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(mockConvert).toHaveBeenCalledTimes(1);
    expect(mockConvert.mock.calls[0][0].booking).toMatchObject({ self_booking_id: real[0].id });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a refresh that changes the service reclassifies the linked funnel row (line + bucket), in the same transaction, and rolls back with it', async () => {
    mockStamp.mockImplementation(async (handle, lead) => {
      await handle('ad_service_attribution').insert({ lead_id: lead.id, service_line: 'pest', specific_service: 'general_pest', service_bucket: 'recurring_entry', funnel_stage: 'lead' });
    });
    const first = await recordPreferredTimeRequest(database, value(), { serviceLabel: 'Pest Control', notify: false });
    expect(await database('ad_service_attribution').where({ lead_id: first.leadId }).first()).toMatchObject({ service_line: 'pest' });
    const second = await recordPreferredTimeRequest(database, value(), { serviceLabel: 'Lawn Care', notify: false });
    expect(second).toMatchObject({ created: false, leadId: first.leadId });
    const row = await database('ad_service_attribution').where({ lead_id: first.leadId }).first();
    const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
    expect(row).toMatchObject({
      service_line: 'lawn',
      specific_service: inferSpecificService('Lawn Care'),
      service_bucket: inferServiceBucket('Lawn Care'),
      funnel_stage: 'lead',
    });
    expect(inferServiceLine('Lawn Care')).toBe('lawn');
  });
});
