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
 *   - a booking that committed while the submit was in flight closes the
 *     just-filed lead post-commit as 'handled' (owner ruling 2026-10-01: closed,
 *     neither won nor lost; never converted), writes ONE audit row, sends ONE
 *     admin FYI and rings no new_lead bell; the close is deduped per (lead,
 *     visit), and a callback visit neither closes nor silences the bell;
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
const mockNotifyAdmin = jest.fn(async () => ({ id: 'n-1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockStamp = jest.fn();
jest.mock('../services/lead-funnel-bridge', () => {
  const { CLICK_ID_COLUMNS, PAID_CLICK_ID_COLUMNS } = jest.requireActual('../services/lead-funnel-bridge');
  return { CLICK_ID_COLUMNS, PAID_CLICK_ID_COLUMNS, stampLeadFunnelRow: (...a) => mockStamp(...a) };
});

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
      converted_at timestamptz, deleted_at timestamptz, customer_id uuid, estimate_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`, [schema]);
    await database.raw('CREATE TABLE ??.funnel_rows (lead_id uuid PRIMARY KEY)', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY, phone text, first_name text, last_name text, email text)', [schema]);
    await database.raw(`CREATE TABLE ??.self_booked_appointments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status text DEFAULT 'confirmed', created_at timestamptz DEFAULT now())`, [schema]);
    await database.raw('CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), self_booking_id uuid, status text DEFAULT \'pending\', is_callback boolean DEFAULT false, service_type text DEFAULT \'Pest Control\', scheduled_date date DEFAULT \'2099-01-08\')', [schema]);
    await database.raw('CREATE TABLE ??.lead_activities (id serial PRIMARY KEY, lead_id uuid NOT NULL, activity_type text, description text, performed_by text, metadata jsonb, created_at timestamptz DEFAULT now())', [schema]);
    await database.raw('CREATE TABLE ??.ad_service_attribution (id serial PRIMARY KEY, lead_id uuid UNIQUE, customer_id uuid, self_booked_appointment_id uuid UNIQUE, lead_source text DEFAULT \'google_ads\', lead_source_detail text, lead_date date, fbp text, gclid text, wbraid text, gbraid text, fbclid text, fbc text, utm_campaign text, utm_term text, is_paid boolean, service_line text, specific_service text, service_bucket text, updated_at timestamptz DEFAULT now(), funnel_stage text DEFAULT \'lead\')', [schema]);
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
    await database('lead_activities').del();
    mockStamp.mockReset();
    mockNotifyAdmin.mockClear();
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

  const closeRows = () => database('lead_activities').where({ activity_type: 'status_change' });

  test('a booking committed while the submit was in flight: the just-filed lead closes as handled after commit with ONE audit row and ONE admin FYI, is NOT converted, and no new_lead bell rings', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    const slow = gate();
    mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
    const submit = recordPreferredTimeRequest(database, value(), { notify: true });
    await tick();
    // /confirm commits its booking (and its own note step finds no lead yet) while the submit is mid-transaction.
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    const visit = await database('scheduled_services').insert({ self_booking_id: sba[0].id }).returning('id');
    slow.open();
    const out = await submit;
    expect(out.created).toBe(true);
    const notes = await closeRows();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ lead_id: out.leadId, performed_by: 'system' });
    expect(notes[0].description).toContain('Closed automatically');
    expect(notes[0].description).toContain(`(visit ${visit[0].id}) on /book`);
    expect(notes[0].metadata).toMatchObject({ reason: 'booking_on_preferred_request', visit_id: String(visit[0].id), previous_status: 'new', status: 'handled' });
    // Closed, neither won nor lost: never converted, funnel row untouched.
    expect(await database('leads').where({ id: out.leadId }).first()).toMatchObject({ status: 'handled', converted_at: null });
    expect(await database('ad_service_attribution').where({ lead_id: out.leadId })).toHaveLength(0);
    // One notification identity: the in-run retry reuses the persistent dedupe key (codex #5477 r5), a no-op in notifyAdmin.
    expect(new Set(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey))).toEqual(new Set([`preferred-time-auto-close:${out.leadId}:${visit[0].id}`]));
    expect(mockNotifyAdmin.mock.calls[0][3]).toMatchObject({ link: `/admin/leads?lead=${out.leadId}`, dedupeKey: `preferred-time-auto-close:${out.leadId}:${visit[0].id}` });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  // The booking path's own sequence (routes/booking.js): close -> the REAL attributeSelfBooking -> drop the request's row
  // only when the booking attributed.
  describe('the closed request\'s funnel row is dropped only once the booking\'s own row exists (codex #5477 r1 P1, pre-push P1)', () => {
    const { closeBookedPreferredLeads, dropSupersededPreferredFunnelRows, reconcileBookingSince } = require('../services/booking-preferred-time');
    const { attributeSelfBooking } = require('../services/lead-estimate-link');
    const flow = async ({ attribution, bookingSource = null, customerCreated = false, stage = 'lead' }) => {
      const cust = randomUUID();
      await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
      const req = await recordPreferredTimeRequest(database, value(), { notify: false });
      await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: stage });
      const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at']);
      await database('scheduled_services').insert({ self_booking_id: sba[0].id });
      const closed = await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
      expect(closed.closed).toBe(1);
      const attributed = await attributeSelfBooking({
        customerId: cust, attribution, serviceInterest: 'Pest Control', customerCreated, selfBookedAppointmentId: sba[0].id, bookingSource, leadConverted: false, database,
      });
      if (attributed?.attributed) await dropSupersededPreferredFunnelRows(database, { booking: sba[0] });
      return { leadId: req.leadId, sbaId: sba[0].id, attributed };
    };
    const requestRow = (leadId) => database('ad_service_attribution').where({ lead_id: leadId });
    const bookingRows = (sbaId) => database('ad_service_attribution').where({ self_booked_appointment_id: sbaId });
    const setupRequestAndBooking = async () => {
      const cust = randomUUID();
      await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
      const req = await recordPreferredTimeRequest(database, value(), { notify: false });
      await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: 'lead' });
      const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at', 'customer_id']);
      await database('scheduled_services').insert({ self_booking_id: sba[0].id });
      return { cust, req, booking: sba[0] };
    };
    const attribute = (cust, booking) => attributeSelfBooking({
      customerId: cust, attribution: captured, serviceInterest: 'Pest Control', customerCreated: false, selfBookedAppointmentId: booking.id, bookingSource: null, leadConverted: false, database,
    });
    const captured = { utm: { source: 'newsletter', medium: 'email' }, landing_url: 'https://example.test/book', referrer: 'https://example.test/' };

    test('a captured organic booking: the request row is deleted and the booking has exactly one booked row (the funnels count one lead reaching booked)', async () => {
      const { buildLeadFunnel } = require('../services/lead-funnel');
      const out = await flow({ attribution: captured });
      expect(out.attributed.attributed).toBe(true);
      expect(await requestRow(out.leadId)).toHaveLength(0);
      const booked = await bookingRows(out.sbaId);
      expect(booked).toHaveLength(1);
      expect(booked[0].funnel_stage).toBe('booked');
      const rows = await database('ad_service_attribution').select('lead_source', 'funnel_stage').count('* as n').groupBy('lead_source', 'funnel_stage');
      expect(buildLeadFunnel(rows).totals).toMatchObject({ leads: 1, booked: 1 });
    });

    test('a paid-click repeat booker is recorded too, so the request row goes', async () => {
      const out = await flow({ attribution: { ...captured, gclid: 'g-1' } });
      expect(out.attributed).toMatchObject({ attributed: true, repeatPaid: true });
      expect(await requestRow(out.leadId)).toHaveLength(0);
      expect(await bookingRows(out.sbaId)).toHaveLength(1);
    });

    describe('first touch keeps the credit (owner ruling 2026-10-01, codex #5477 r8)', () => {
      // a closed request whose row came in on a paid click, and a booking row of its own
      const setupPaid = async ({ bookingTouch }) => {
        const cust = randomUUID();
        await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
        const req = await recordPreferredTimeRequest(database, value(), { notify: false });
        await database('ad_service_attribution').insert({
          lead_id: req.leadId, funnel_stage: 'lead', lead_source: 'google_ads', lead_source_detail: 'brand', lead_date: '2026-09-20',
          gclid: 'g-first', utm_campaign: 'fall-pest', utm_term: 'pest control', is_paid: true,
        });
        const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at']);
        await database('scheduled_services').insert({ self_booking_id: sba[0].id });
        await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
        await database('ad_service_attribution').insert({ lead_id: null, self_booked_appointment_id: sba[0].id, funnel_stage: 'booked', lead_date: '2026-10-01', ...bookingTouch });
        expect(await dropSupersededPreferredFunnelRows(database, { booking: sba[0] })).toBe(1);
        return { req, sbaId: sba[0].id };
      };

      test('a paid request and a booking that came back direct: the booking row takes the paid touch, the request row goes (one paid lead)', async () => {
        const { req, sbaId } = await setupPaid({ bookingTouch: { lead_source: 'website', is_paid: false } });
        expect(await requestRow(req.leadId)).toHaveLength(0);
        const rows = await bookingRows(sbaId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          funnel_stage: 'booked', lead_source: 'google_ads', lead_source_detail: 'brand', gclid: 'g-first', utm_campaign: 'fall-pest', utm_term: 'pest control', is_paid: true,
        });
        expect(String(rows[0].lead_date instanceof Date ? rows[0].lead_date.toISOString() : rows[0].lead_date)).toMatch(/^2026-09-20/);
      });

      test('a booking with paid UTMs but no click id of its own takes the request\'s click', async () => {
        const { sbaId } = await setupPaid({ bookingTouch: { lead_source: 'google_ads', utm_campaign: 'cpc-utm-only', is_paid: true } });
        expect((await bookingRows(sbaId))[0]).toMatchObject({ gclid: 'g-first', utm_campaign: 'fall-pest', is_paid: true });
      });

      test('a booking with a paid click of its own keeps it even with a NULL is_paid (the new-customer mint leaves it unset)', async () => {
        const { sbaId } = await setupPaid({ bookingTouch: { lead_source: 'google_ads', gclid: 'g-own', is_paid: null } });
        expect((await bookingRows(sbaId))[0]).toMatchObject({ lead_source: 'google_ads', gclid: 'g-own', utm_campaign: null });
      });

      test('a booking with a paid click of its own keeps it', async () => {
        const { sbaId } = await setupPaid({ bookingTouch: { lead_source: 'facebook_ads', fbclid: 'f-own', is_paid: true } });
        expect((await bookingRows(sbaId))[0]).toMatchObject({ lead_source: 'facebook_ads', fbclid: 'f-own', gclid: null });
      });
    });

    test.each([
      ['no attribution capture', { attribution: {} }],
      ['a recovery rebooking', { attribution: captured, bookingSource: 'booking_recovery' }],
      ['an estimate-originated booking', { attribution: captured, bookingSource: 'estimate-accept' }],
    ])('%s: the booking records no row, so the request row is KEPT as the journey\'s only funnel entry', async (_label, args) => {
      const out = await flow(args);
      expect(out.attributed.attributed).toBe(false);
      expect(await requestRow(out.leadId)).toHaveLength(1);
      expect(await bookingRows(out.sbaId)).toHaveLength(0);
    });

    test('the cleanup verifies the replacement itself: with no row for this booking nothing is deleted even if called; a row already at completed is never removed', async () => {
      const cust = randomUUID();
      await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
      const req = await recordPreferredTimeRequest(database, value(), { notify: false });
      await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: 'lead' });
      const sba = await database('self_booked_appointments').insert({ customer_id: cust }).returning(['id']);
      // an audit row for THIS booking marks the request as closed by it
      await database('scheduled_services').insert({ self_booking_id: sba[0].id });
      await closeBookedPreferredLeads(database, { customerId: cust, booking: { ...sba[0], created_at: new Date() } });
      expect(await dropSupersededPreferredFunnelRows(database, { booking: sba[0] })).toBe(0);
      expect(await requestRow(req.leadId)).toHaveLength(1);
      await database('ad_service_attribution').insert({ lead_id: null, self_booked_appointment_id: sba[0].id, funnel_stage: 'booked' });
      await database('ad_service_attribution').where({ lead_id: req.leadId }).update({ funnel_stage: 'completed' });
      expect(await dropSupersededPreferredFunnelRows(database, { booking: sba[0] })).toBe(0);
      expect(await requestRow(req.leadId)).toHaveLength(1);
    });

    describe('either closer may run first: whichever runs SECOND deletes (reconcile vs the booking\'s own close + attribution)', () => {
      const { reconcileBookingSince } = require('../services/booking-preferred-time');
      const setup = async () => {
        const cust = randomUUID();
        await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
        const req = await recordPreferredTimeRequest(database, value(), { notify: false });
        await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: 'lead' });
        const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at']);
        await database('scheduled_services').insert({ self_booking_id: sba[0].id });
        return { cust, req, booking: sba[0] };
      };

      test('reconcile closes the request FIRST (booking close finds nothing), then the booking row lands: the booking path drops the request row -> one row', async () => {
        const { cust, req, booking } = await setup();
        await reconcileBookingSince(database, { phone: '9415550100', since: new Date(Date.now() - 60000) });
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'handled' });
        expect(await requestRow(req.leadId)).toHaveLength(1); // no booking row yet: kept
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(0); // reconcile won the close
        const attributed = await attribute(cust, booking);
        expect(attributed.attributed).toBe(true);
        if (attributed.attributed) await dropSupersededPreferredFunnelRows(database, { booking });
        expect(await requestRow(req.leadId)).toHaveLength(0);
        expect(await bookingRows(booking.id)).toHaveLength(1);
        expect(await database('ad_service_attribution').count('* as n').first()).toMatchObject({ n: '1' });
      });

      test('the booking row lands FIRST, then reconcile closes the request: the reconcile drops the request row -> one row', async () => {
        const { cust, req, booking } = await setup();
        const attributed = await attribute(cust, booking);
        expect(attributed.attributed).toBe(true);
        // booking's own close did not run (it lost / has not run yet); nothing to drop and the request is still open
        await dropSupersededPreferredFunnelRows(database, { booking });
        expect(await requestRow(req.leadId)).toHaveLength(1);
        await reconcileBookingSince(database, { phone: '9415550100', since: new Date(Date.now() - 60000) });
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'handled' });
        expect(await requestRow(req.leadId)).toHaveLength(0);
        expect(await bookingRows(booking.id)).toHaveLength(1);
      });

      test('a replay (first attempt attributed, then died before its close) closes and drops; running it twice changes nothing more', async () => {
        const { cust, req, booking } = await setup();
        await attribute(cust, booking);
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(1);
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(0);
        expect(await bookingRows(booking.id)).toHaveLength(1);
      });

      test('a request staff reopened (no longer handled) keeps its funnel row', async () => {
        const { cust, req, booking } = await setup();
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        await attribute(cust, booking);
        await database('leads').where({ id: req.leadId }).update({ status: 'new' });
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(1);
      });
    });

    describe('a booking that converted a genuine lead instead: lineage is the booking\'s own (codex #5477 r2 P1, pre-push P1)', () => {
      // The booking path: close (persisting the converted ids on its audit row), then attributeSelfBooking
      // (leadConverted: records nothing), then the cleanup with the same ids.
      const setupConverted = async ({ stage = 'booked' } = {}) => {
        const { cust, req, booking } = await setupRequestAndBooking();
        const genuine = await database('leads').insert({ first_name: 'Pat', last_name: 'Sample', phone: '+19415550100', status: 'won', lead_type: 'web_form', customer_id: cust }).returning('id');
        await database('ad_service_attribution').insert({ lead_id: genuine[0].id, customer_id: cust, funnel_stage: stage });
        return { cust, req, booking, genuineId: genuine[0].id };
      };
      const attributeConverted = async (cust, booking) => {
        const attributed = await attributeSelfBooking({
          customerId: cust, attribution: captured, serviceInterest: 'Pest Control', customerCreated: false, selfBookedAppointmentId: booking.id, bookingSource: null, leadConverted: true, database,
        });
        expect(attributed).toMatchObject({ attributed: false, reason: 'lead_converted' });
        expect(await bookingRows(booking.id)).toHaveLength(0);
      };

      test('via the ids the booking path passes: the converted lead\'s booked row is the replacement, the request row goes, the genuine row stays', async () => {
        const { cust, req, booking, genuineId } = await setupConverted();
        await closeBookedPreferredLeads(database, { customerId: cust, booking, convertedLeadIds: [genuineId] });
        await attributeConverted(cust, booking);
        expect(await dropSupersededPreferredFunnelRows(database, { booking, convertedLeadIds: [genuineId] })).toBe(1);
        expect(await requestRow(req.leadId)).toHaveLength(0);
        expect(await requestRow(genuineId)).toHaveLength(1);
      });

      test('via the ids persisted on the close audit row: a later closer (replay / reconcile) with no ids finds them', async () => {
        const { cust, req, booking, genuineId } = await setupConverted({ stage: 'completed' });
        await closeBookedPreferredLeads(database, { customerId: cust, booking, convertedLeadIds: [genuineId] });
        const audit = await closeRows();
        expect(audit[0].metadata.converted_lead_ids).toEqual([genuineId]);
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(1);
        expect(await requestRow(req.leadId)).toHaveLength(0);
      });

      test('reconcile closes FIRST (its audit row carries no ids, nothing is dropped); the booking path then passes its ids and deletes', async () => {
        const { cust, req, booking, genuineId } = await setupConverted();
        await reconcileBookingSince(database, { phone: '9415550100', since: new Date(Date.now() - 60000) });
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'handled' });
        expect((await closeRows())[0].metadata.converted_lead_ids).toBeUndefined();
        expect(await requestRow(req.leadId)).toHaveLength(1); // no replacement known to the reconcile
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking, convertedLeadIds: [genuineId] })).closed).toBe(0);
        await attributeConverted(cust, booking);
        await dropSupersededPreferredFunnelRows(database, { booking, convertedLeadIds: [genuineId] });
        expect(await requestRow(req.leadId)).toHaveLength(0);
      });

      test('an unrelated, recently updated completed row for the same customer is NOT a replacement (no lineage to this booking)', async () => {
        const { cust, req, booking, genuineId } = await setupConverted({ stage: 'completed' });
        await database('ad_service_attribution').where({ lead_id: genuineId }).update({ updated_at: new Date() });
        await closeBookedPreferredLeads(database, { customerId: cust, booking }); // this booking converted nothing
        await attributeConverted(cust, booking);
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(1);
        // another booking's persisted ids never count for this one
        await database('lead_activities').insert({ lead_id: req.leadId, activity_type: 'status_change', performed_by: 'system', metadata: JSON.stringify({ reason: 'booking_on_preferred_request', booking_id: randomUUID(), converted_lead_ids: [genuineId] }) });
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(1);
      });

      test('lineage persisted AT the conversion (won_booking_id): a replay with no in-memory ids and no audit ids still finds the genuine lead (crash between conversion and close)', async () => {
        const { cust, req, booking, genuineId } = await setupConverted();
        await database('leads').where({ id: genuineId }).update({ extracted_data: JSON.stringify({ won_booking_id: booking.id }) });
        await closeBookedPreferredLeads(database, { customerId: cust, booking }); // the replay's close: no ids
        expect((await closeRows())[0].metadata.converted_lead_ids).toBeUndefined();
        await attributeConverted(cust, booking);
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(1);
        expect(await requestRow(req.leadId)).toHaveLength(0);
        expect(await requestRow(genuineId)).toHaveLength(1);
      });

      test('won_booking_id of ANOTHER booking, or a lead that is no longer won, is not lineage for this one', async () => {
        const { cust, req, booking, genuineId } = await setupConverted();
        await database('leads').where({ id: genuineId }).update({ extracted_data: JSON.stringify({ won_booking_id: randomUUID() }) });
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        await attributeConverted(cust, booking);
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        await database('leads').where({ id: genuineId }).update({ extracted_data: JSON.stringify({ won_booking_id: booking.id }), status: 'lost' });
        expect(await dropSupersededPreferredFunnelRows(database, { booking })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(1);
      });

      test('converted ids whose funnel row is still at an open stage are not a replacement', async () => {
        const { cust, req, booking, genuineId } = await setupConverted({ stage: 'contacted' });
        await closeBookedPreferredLeads(database, { customerId: cust, booking, convertedLeadIds: [genuineId] });
        await attributeConverted(cust, booking);
        expect(await dropSupersededPreferredFunnelRows(database, { booking, convertedLeadIds: [genuineId] })).toBe(0);
        expect(await requestRow(req.leadId)).toHaveLength(1);
      });
    });

    describe('a phone alone is not an identity (codex #5477 r2 P1)', () => {
      const requestFor = async (phoneOwner) => {
        const cust = randomUUID();
        await database('customers').insert({ id: cust, phone: '+19415550100', ...phoneOwner });
        const req = await recordPreferredTimeRequest(database, value({ firstName: 'Robin', lastName: 'Other' }), { notify: false });
        await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: 'lead' });
        const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at']);
        await database('scheduled_services').insert({ self_booking_id: sba[0].id });
        return { cust, req, booking: sba[0] };
      };

      test('a different person on the shared phone: the request stays open, keeps its funnel row, and no FYI goes out', async () => {
        const { cust, req, booking } = await requestFor({ first_name: 'Pat', last_name: 'Sample', email: 'pat@example.test' });
        expect(await closeBookedPreferredLeads(database, { customerId: cust, booking })).toMatchObject({ live: true, closed: 0 });
        await attribute(cust, booking);
        await dropSupersededPreferredFunnelRows(database, { booking });
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'new' });
        expect(await requestRow(req.leadId)).toHaveLength(1);
        expect(await closeRows()).toHaveLength(0);
        expect(mockNotifyAdmin).not.toHaveBeenCalled();
      });

      test('the submit\'s reconcile does not silence the new_lead bell for it', async () => {
        const cust = randomUUID();
        await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
        const { triggerNotification } = require('../services/notification-triggers');
        triggerNotification.mockClear();
        const slow = gate();
        mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
        const submit = recordPreferredTimeRequest(database, value({ firstName: 'Robin', lastName: 'Other' }), { notify: true });
        await tick();
        // the booking commits while the submit is in flight (the reconcile sees it)
        const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id']);
        await database('scheduled_services').insert({ self_booking_id: sba[0].id });
        slow.open();
        const out = await submit;
        expect(await database('leads').where({ id: out.leadId }).first()).toMatchObject({ status: 'new' });
        expect(triggerNotification).toHaveBeenCalledTimes(1);
      });

      test('the bell is judged on the SUBMITTED request: an older request of the booker is closed by the reconcile, the new non-corroborated one stays open and rings', async () => {
        const cust = randomUUID();
        await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
        // the booker's own earlier request (same person, linked by name)
        const older = await recordPreferredTimeRequest(database, value({ firstName: 'Pat', lastName: 'Sample' }), { notify: false });
        await database('leads').where({ id: older.leadId }).update({ status: 'new', created_at: new Date(Date.now() - 3 * 86400000), extracted_data: JSON.stringify({ last_requested_at: new Date(Date.now() - 3 * 86400000).toISOString() }) });
        const { triggerNotification } = require('../services/notification-triggers');
        triggerNotification.mockClear();
        const slow = gate();
        mockStamp.mockImplementation(async (handle, lead) => { await slow.p; await handle('funnel_rows').insert({ lead_id: lead.id }); });
        const submit = recordPreferredTimeRequest(database, value({ firstName: 'Robin', lastName: 'Other' }), { notify: true });
        await tick();
        const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id']);
        await database('scheduled_services').insert({ self_booking_id: sba[0].id });
        slow.open();
        const fresh = await submit;
        // the reconcile closed the booker's OLDER request, yet the submitted one is still open and rings
        expect(await database('leads').where({ id: older.leadId }).first()).toMatchObject({ status: 'handled' });
        expect(await database('leads').where({ id: fresh.leadId }).first()).toMatchObject({ status: 'new' });
        expect(triggerNotification).toHaveBeenCalledTimes(1);
      });

      test.each([
        ['linked to the booked customer', { first_name: 'Someone', last_name: 'Else' }, (cust) => ({ customer_id: cust })],
        ['same email', { first_name: 'Someone', last_name: 'Else', email: 'robin@example.test' }, () => ({ email: 'ROBIN@example.test ' })],
        ['same first and last name', { first_name: 'Robin', last_name: 'Other' }, () => ({ updated_at: new Date() })],
      ])('corroborated by %s: closed', async (_label, customerFields, leadFields) => {
        const { cust, req, booking } = await requestFor(customerFields);
        await database('leads').where({ id: req.leadId }).update(leadFields(cust));
        expect(await closeBookedPreferredLeads(database, { customerId: cust, booking })).toMatchObject({ live: true, closed: 1 });
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'handled' });
      });
    });

    describe('the close FYI is retryable from the persisted audit rows (codex #5477 r4 P2)', () => {
      // The admin alert helper dedupes on a persistent key; emulate that here (one delivered row per key).
      let delivered;
      let failTimes;
      beforeEach(() => {
        delivered = new Set();
        failTimes = 0;
        mockNotifyAdmin.mockImplementation(async (_c, _t, _w, opts) => {
          if (delivered.has(opts.dedupeKey)) return { deduped: true };
          if (failTimes > 0) { failTimes -= 1; throw new Error('bell down'); }
          delivered.add(opts.dedupeKey);
          return { id: 'n' };
        });
      });
      afterEach(() => { mockNotifyAdmin.mockImplementation(async () => ({ id: 'n-1' })); });

      test('the FYI fails right after the status commit: the same run retries it (codex #5477 r5): exactly one FYI', async () => {
        const { cust, booking } = await setupRequestAndBooking();
        failTimes = 1;
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(1);
        expect(delivered.size).toBe(1);
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(0); // replay: nothing new
        expect(delivered.size).toBe(1);
        expect(new Set(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).size).toBe(1);
      });

      test('the FYI fails on every attempt of the first run, then the replay finds the lead already handled and still delivers it: exactly one FYI', async () => {
        const { cust, booking } = await setupRequestAndBooking();
        failTimes = 2;
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(1);
        expect(delivered.size).toBe(0);
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(0); // replay: nothing left to close
        expect(delivered.size).toBe(1);
        const keys = new Set(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey));
        expect(keys.size).toBe(1);
      });

      test('a normal double run (and a reconcile) never rings twice', async () => {
        const { cust, booking } = await setupRequestAndBooking();
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        await reconcileBookingSince(database, { phone: '9415550100', since: new Date(Date.now() - 60000) });
        expect(delivered.size).toBe(1);
      });

      test('a request staff attached an estimate to is never closed as handled (codex #5477 r6): it stays open for the estimate tier or the office', async () => {
        const { cust, req, booking } = await setupRequestAndBooking();
        await database('leads').where({ id: req.leadId }).update({ estimate_id: randomUUID() });
        expect((await closeBookedPreferredLeads(database, { customerId: cust, booking })).closed).toBe(0);
        expect(await database('leads').where({ id: req.leadId }).first()).toMatchObject({ status: 'new', converted_at: null });
        expect(await database('lead_activities').where({ lead_id: req.leadId })).toHaveLength(0);
        expect(delivered.size).toBe(0);
      });

      test('a request staff reopened is not announced again by a retry', async () => {
        const { cust, req, booking } = await setupRequestAndBooking();
        failTimes = 2; // the close and its in-run retry both fail
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        expect(delivered.size).toBe(0);
        await database('leads').where({ id: req.leadId }).update({ status: 'new' });
        await closeBookedPreferredLeads(database, { customerId: cust, booking });
        expect(delivered.size).toBe(0);
      });
    });

    test('concurrent reopen vs cleanup (pre-push P1): staff reopens the request holding the lead lock; the cleanup waits, re-checks handled under the lock, and deletes nothing', async () => {
      const { cust, req, booking } = await setupRequestAndBooking();
      await closeBookedPreferredLeads(database, { customerId: cust, booking });
      await attribute(cust, booking); // the booking's own row exists: the cleanup WOULD delete the request row
      let release;
      const hold = new Promise((r) => { release = r; });
      const staff = database.transaction(async (trx) => {
        await trx('leads').where({ id: req.leadId }).forUpdate().first('id');
        await hold;
        await trx('leads').where({ id: req.leadId }).update({ status: 'new' });
      });
      await tick();
      const cleanup = dropSupersededPreferredFunnelRows(database, { booking });
      const state = settled(cleanup);
      await tick(250);
      expect(state.done).toBe(false); // parked on the lead row lock
      release();
      await staff;
      expect(await cleanup).toBe(0);
      expect(await requestRow(req.leadId)).toHaveLength(1);
    });

    test('the close itself never touches the request\'s funnel row (the reconcile path, which has no attributeSelfBooking, leaves it)', async () => {
      const cust = randomUUID();
      await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
      const req = await recordPreferredTimeRequest(database, value(), { notify: false });
      await database('ad_service_attribution').insert({ lead_id: req.leadId, funnel_stage: 'lead' });
      const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date() }).returning(['id', 'created_at']);
      await database('scheduled_services').insert({ self_booking_id: sba[0].id });
      expect((await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] })).closed).toBe(1);
      expect(await requestRow(req.leadId)).toHaveLength(1);
    });
  });

  test('the close is written once per (lead, visit): the booking path and the reconcile racing for the same visit write one row and one FYI', async () => {
    const { closeBookedPreferredLeads } = require('../services/booking-preferred-time');
    const first = await recordPreferredTimeRequest(database, value(), { notify: false });
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() + 5000) }).returning(['id', 'created_at']);
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    const runs = await Promise.all([1, 2, 3].map(() => closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] })));
    expect(runs.reduce((n, r) => n + r.closed, 0)).toBe(1);
    // one FYI identity: retries re-send the SAME deduped key (the alert helper dedupes it persistently), never a second one
    expect(new Set(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).size).toBe(1);
    expect(await database('leads').where({ id: first.leadId }).first()).toMatchObject({ status: 'handled', converted_at: null });
    expect(await closeRows()).toHaveLength(1);
    expect((await closeRows())[0].lead_id).toBe(first.leadId);
    // a request filed AFTER the booking is new work: not closed
    await database('leads').where({ id: first.leadId }).update({ status: 'lost' });
    const later = await recordPreferredTimeRequest(database, value(), { notify: false });
    // (the submit's own reconcile saw this booking as already placed and closed it; reopen it and make its request newer than the booking)
    await database('lead_activities').where({ lead_id: later.leadId }).del();
    await database('leads').where({ id: later.leadId }).update({
      status: 'new',
      extracted_data: database.raw("extracted_data || ?::jsonb", [JSON.stringify({ last_requested_at: new Date(Date.now() + 600000).toISOString() })]),
    });
    mockNotifyAdmin.mockClear();
    const before = (await closeRows()).length;
    await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    expect((await closeRows()).length).toBe(before);
    expect(await database('leads').where({ id: later.leadId }).first()).toMatchObject({ status: 'new' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('the lead is revalidated under its row lock (codex #5399 r14): staff reassigning or closing it after the open-lead query means it is not closed', async () => {
    const { closeBookedPreferredLeads } = require('../services/booking-preferred-time');
    const first = await recordPreferredTimeRequest(database, value(), { notify: false });
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() + 5000) }).returning(['id', 'created_at']);
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    // Staff holds the lead row mid-edit (reassigning its phone) while the note runs: the note parks on the row lock,
    // then re-reads the committed state and writes nothing.
    const edit = gate();
    const staff = database.transaction(async (trx) => {
      await trx('leads').where({ id: first.leadId }).forUpdate().first('id');
      await edit.p;
      await trx('leads').where({ id: first.leadId }).update({ phone: '+19415559999' });
    });
    await tick();
    const note = closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    const noteState = settled(note);
    await tick();
    expect(noteState.done).toBe(false); // parked on the lead row
    edit.open();
    await staff;
    expect(await note).toMatchObject({ live: true, closed: 0 });
    expect(await closeRows()).toHaveLength(0);
    // linked to another customer: no note
    await database('leads').where({ id: first.leadId }).update({ phone: '+19415550100', customer_id: randomUUID() });
    await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    expect(await closeRows()).toHaveLength(0);
    // closed: no note
    await database('leads').where({ id: first.leadId }).update({ customer_id: null, status: 'lost' });
    await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    expect(await closeRows()).toHaveLength(0);
    // already handled (staff closed it by hand first): not closed again, no FYI
    await database('leads').where({ id: first.leadId }).update({ status: 'handled' });
    await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    expect(await closeRows()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    // unchanged (reopened, same phone): closed once
    await database('leads').where({ id: first.leadId }).update({ status: 'new' });
    expect((await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] })).closed).toBe(1);
    expect(await closeRows()).toHaveLength(1);
    const fyiKeys = () => new Set(mockNotifyAdmin.mock.calls.map((c) => c[3].dedupeKey));
    expect(fyiKeys().size).toBe(1);
    const callsBeforeReplay = mockNotifyAdmin.mock.calls.length;
    // staff reopen it and the same booking replays: the audit row for this visit stands, nothing closes twice, no second FYI
    await database('leads').where({ id: first.leadId }).update({ status: 'new' });
    expect(await closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] })).toMatchObject({ live: true, closed: 0 });
    expect(await closeRows()).toHaveLength(1);
    expect(mockNotifyAdmin.mock.calls.length).toBe(callsBeforeReplay); // a reopened request is not re-announced
    expect(await database('leads').where({ id: first.leadId }).first()).toMatchObject({ status: 'new' });
  });

  test('a customer refresh landing between the candidate query and the row lock (a request newer than the booking) is NOT closed (pre-push P1)', async () => {
    const { closeBookedPreferredLeads } = require('../services/booking-preferred-time');
    const first = await recordPreferredTimeRequest(database, value(), { notify: false });
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() + 5000) }).returning(['id', 'created_at']);
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    await database('lead_activities').del();
    mockNotifyAdmin.mockClear();
    // The submit's refresh holds the lead row and stamps a request time past the booking + 60 s while the closer's
    // candidate query (a plain read) has already passed: the closer parks on the row lock, then re-reads the newer stamp.
    const refresh = gate();
    const customer = database.transaction(async (trx) => {
      await trx('leads').where({ id: first.leadId }).forUpdate().first('id');
      await refresh.p;
      await trx('leads').where({ id: first.leadId }).update({
        extracted_data: trx.raw("extracted_data || ?::jsonb", [JSON.stringify({ last_requested_at: new Date(Date.now() + 600000).toISOString() })]),
      });
    });
    await tick();
    const closing = closeBookedPreferredLeads(database, { customerId: cust, booking: sba[0] });
    const closingState = settled(closing);
    await tick();
    expect(closingState.done).toBe(false); // parked on the lead row
    refresh.open();
    await customer;
    expect(await closing).toMatchObject({ live: true, closed: 0 });
    expect(await database('leads').where({ id: first.leadId }).first()).toMatchObject({ status: 'new' });
    expect(await closeRows()).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a booking made BEFORE the request began (beyond the skew slack) is not this request\'s to reconcile: not closed, the bell rings', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const sba = await database('self_booked_appointments').insert({ customer_id: cust, created_at: new Date(Date.now() - 3600000) }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: sba[0].id });
    await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(await closeRows()).toHaveLength(0);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a callback visit neither closes the lead nor silences the bell; an older real booking in the same window still closes it and silences the bell', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    triggerNotification.mockClear();
    const cust = randomUUID();
    await database('customers').insert({ id: cust, phone: '+19415550100', first_name: 'Pat', last_name: 'Sample' });
    const cb = await database('self_booked_appointments').insert({ customer_id: cust }).returning('id');
    await database('scheduled_services').insert({ self_booking_id: cb[0].id, is_callback: true });
    const out = await recordPreferredTimeRequest(database, value(), { notify: true });
    expect(await closeRows()).toHaveLength(0);
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
    const again = await recordPreferredTimeRequest(database, value(), { notify: true });
    const notes = await closeRows();
    expect(notes).toHaveLength(1);
    expect(notes[0].lead_id).toBe(again.leadId);
    expect(await database('leads').where({ id: again.leadId }).first()).toMatchObject({ status: 'handled' });
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
