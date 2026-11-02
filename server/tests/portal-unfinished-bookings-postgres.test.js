/**
 * Unfinished bookings against live Postgres (GATE_PORTAL_BOOKING_ITEMS), the SQL as the sweep runs it:
 *   - portal-unfinished-bookings.js: a booking-page visitor quiet for an hour, or an estimate whose card step was
 *     opened and left, gets ONE admin bell; never inside the quiet hour, never past the 14-day window, never for a
 *     converted or suppressed intent, an accepted estimate, a customer who booked a visit after the drop-off, or a
 *     drop-off a person already followed up; never a second bell for one key, even after the first was marked Done.
 *   - portal-inbox.js: the Communications Portal tab lists the bell as a booking item whose version the bell's
 *     Done accepts.
 *   - admin-alert-relevance.js: the bell closes on a person's text after it, and when the booking was finished.
 *   - the day's cap per tier caps the ringing, never the record: an unverified drop-off past its room still gets its
 *     row, quietly (the activity feed), listed on the Portal tab, and one summary bell a day rings; an established one
 *     (the card step of an estimate our office sent) still rings with that room full. A typed phone that matches a
 *     customer we have served is still unverified.
 * Each test removes everything it made and every bell its sweeps raised, so the next test starts with no drop-off
 * and the day's count at zero (Codex #7489 r2). Every row is synthetic. It refuses any database but a private QA
 * one or CI's.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.setTimeout(60000);

const MIN = 60 * 1000;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('unfinished bookings reach a person (live Postgres)', () => {
  const RUN = randomUUID().slice(0, 8);
  const BIZ = '+15555559300';
  const made = { sms_log: [], scheduled_services: [], estimate_checkout_events: [], booking_intents: [], estimates: [], technicians: [], customers: [] };
  let db;
  let mod;
  let portalInbox;
  let relevance;
  let NotificationService;
  let n = 0;
  const sid = (prefix) => `${prefix}${RUN}${String((n += 1)).padStart(6, '0')}`;
  const phone = () => `+1941556${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const ago = (minutes) => new Date(Date.now() - minutes * MIN);
  const plus = (at, minutes) => new Date(new Date(at).getTime() + minutes * MIN);

  let fileStart;
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    mod = require('../services/portal-unfinished-bookings');
    portalInbox = require('../services/portal-inbox');
    relevance = require('../services/admin-alert-relevance');
    NotificationService = require('../services/notification-service');
    fileStart = (await db.raw("select now() - interval '1 second' as at")).rows[0].at;
  });
  const burstKey = (at = new Date()) => `${mod.BURST_KEY_PREFIX}${require('../utils/datetime-et').etDateString(at)}`;
  // The bells this module raised since the file started (any drop-off key, so a sweep's bell for a row another
  // suite left is gone too), today's summary bell, and every fixture the test made.
  const dropOffBells = (q) => q.where({ recipient_type: 'admin' })
    .whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [mod.KEY_PREFIX.length, mod.KEY_PREFIX]);
  const cleanUp = async () => {
    await dropOffBells(db('notifications')).where('created_at', '>=', fileStart).del();
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [burstKey()]).del();
    for (const table of ['sms_log', 'scheduled_services', 'estimate_checkout_events', 'booking_intents', 'estimates', 'technicians', 'customers']) {
      const ids = made[table].splice(0);
      if (ids.length) await db(table).whereIn('id', ids).del();
    }
  };
  beforeEach(() => { process.env.GATE_PORTAL_BOOKING_ITEMS = 'true'; });
  afterEach(async () => {
    for (const key of ['GATE_PORTAL_BOOKING_ITEMS', 'GATE_PORTAL_INBOX', 'GATE_ALERT_CONTACT_CLOSE']) delete process.env[key];
    if (db) await cleanUp();
  }, 120000);
  afterAll(async () => { if (db) await cleanUp(); }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const customer = () => insert('customers', {
    first_name: 'Pat', last_name: `Synthetic${RUN}`, phone: phone(), email: `unfinished-${RUN}-${(n += 1)}@example.invalid`,
  });
  // A booking-page visitor who picked a time 2 hours ago and was last active 90 minutes ago.
  const intent = (c, over = {}) => insert('booking_intents', {
    phone: c ? c.phone.replace(/^\+1/, '') : phone().replace(/^\+1/, ''), customer_id: c ? c.id : null,
    first_name: 'Pat', last_name: `Synthetic${RUN}`, service_type: 'Mosquito Control', service_id: 'mosquito',
    slot_date: '2026-11-24', slot_start: '13:00', slot_end: '14:00', source: 'direct',
    captured_at: ago(120), last_activity_at: ago(90), ...over,
  });
  // An open estimate, and its card step opened (one event per kind: the table is unique on estimate + kind).
  const estimate = (c, over = {}) => insert('estimates', {
    customer_id: c ? c.id : null, status: 'viewed', service_interest: 'Quarterly Pest Control',
    customer_name: c ? null : `Jordan Fixture${RUN}`, customer_phone: c ? null : phone(), created_at: ago(3 * 24 * 60), ...over,
  });
  const cardStep = (e, at, kind = 'recurring_card') => insert('estimate_checkout_events', {
    estimate_id: e.id, kind, setup_intent_id: sid('seti_'), created_at: at, updated_at: at,
  });
  const staffText = (c, at) => insert('sms_log', {
    direction: 'outbound', from_phone: BIZ, to_phone: c.phone, customer_id: c.id, message_body: 'Want help finishing your booking?',
    message_type: 'manual', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({ human_authored: true }), created_at: at,
  });
  // A text the system sent on its own (a reminder): no person wrote it, so it follows up nothing.
  const automatedText = (c, at) => insert('sms_log', {
    direction: 'outbound', from_phone: BIZ, to_phone: c.phone, customer_id: c.id, message_body: 'Reminder',
    message_type: 'appointment_reminder', status: 'delivered', twilio_sid: sid('SMO'), metadata: JSON.stringify({}), created_at: at,
  });
  const visit = (c, at, status = 'pending') => insert('scheduled_services', {
    customer_id: c.id, scheduled_date: '2026-11-20', service_type: 'Monthly Mosquito Control Service', status, created_at: at,
  });
  // A customer we have served: a completed visit a month before any drop-off.
  const servedCustomer = async () => {
    const c = await customer();
    await visit(c, ago(30 * 24 * 60), 'completed');
    return c;
  };

  const run = (now = new Date(), pageSize = undefined) => mod.runPortalUnfinishedBookings({ now, ...(pageSize ? { pageSize } : {}) });
  const bellsFor = (key) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]);
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
  const intentKey = (i) => `${mod.BOOKING_KEY_PREFIX}${i.id}`;
  const estimateKey = (e) => `${mod.CHECKOUT_KEY_PREFIX}${e.id}`;

  test('a booking-page visitor quiet for an hour gets one bell, and only one', async () => {
    const c = await customer();
    const i = await intent(c);
    await run();
    const rows = await bellsFor(intentKey(i));
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('alert');
    expect(rows[0].done_at).toBeNull();
    expect(meta(rows[0])).toEqual(expect.objectContaining({
      customerId: c.id, bookingIntentId: i.id, source: 'booking_page', service: 'Mosquito Control', slotDate: '2026-11-24', slotStart: '13:00', slotEnd: '14:00',
    }));
    expect(rows[0].link).toBe(`/admin/customers?customerId=${c.id}`);
    await run();
    expect(await bellsFor(intentKey(i))).toHaveLength(1);
  });

  test('the quiet hour, a converted or suppressed intent and the 14-day window keep the bell from ringing', async () => {
    const c = await customer();
    const fresh = await intent(c, { captured_at: ago(40), last_activity_at: ago(30) });
    const converted = await intent(c, { converted_at: ago(60) });
    const suppressed = await intent(c, { suppressed: true });
    const old = await intent(c, { captured_at: ago(16 * 24 * 60), last_activity_at: ago(15 * 24 * 60) });
    await run();
    for (const i of [fresh, converted, suppressed, old]) expect(await bellsFor(intentKey(i))).toHaveLength(0);
  });

  test('a person who already followed up stops the bell; an automated text does not', async () => {
    const reached = await customer();
    const reachedIntent = await intent(reached);
    await staffText(reached, ago(60));
    const reminded = await customer();
    const remindedIntent = await intent(reminded);
    await automatedText(reminded, ago(60));
    await run();
    expect(await bellsFor(intentKey(reachedIntent))).toHaveLength(0);
    expect(await bellsFor(intentKey(remindedIntent))).toHaveLength(1);
  });

  test('an older unanswered drop-off behind newer contacted ones still rings: the sweep pages past them', async () => {
    const contacted = [];
    for (let k = 0; k < 3; k += 1) {
      const c = await customer();
      contacted.push(await intent(c, { captured_at: ago(80 - k), last_activity_at: ago(70 - k) }));
      await staffText(c, ago(65 - k));
    }
    const older = await intent(await customer(), { captured_at: ago(200), last_activity_at: ago(190) });
    await run(new Date(), 2);
    expect(await bellsFor(intentKey(older))).toHaveLength(1);
    for (const i of contacted) expect(await bellsFor(intentKey(i))).toHaveLength(0);
  });

  test('past the unverified room every drop-off still gets its row, quietly, on the Portal tab; one summary bell a day', async () => {
    const now = new Date();
    const room = mod.MAX_BELLS_PER_DAY[mod.UNVERIFIED];
    const intents = [];
    for (let k = 0; k < room + 4; k += 1) {
      intents.push(await intent(await customer(), { captured_at: ago(120 + k), last_activity_at: ago(90 + k) }));
    }
    // Totals, not which drop-offs: a row another suite left could take a place under the cap.
    const first = await run(now);
    expect(first.raised).toBe(room);
    expect(first.held).toBeGreaterThanOrEqual(4);
    const quietRows = [];
    for (const i of intents) {
      const rows = await bellsFor(intentKey(i));
      expect(rows).toHaveLength(1);
      if (meta(rows[0]).feed === 'activity') quietRows.push(rows[0]);
    }
    expect(quietRows.length).toBeGreaterThanOrEqual(4);
    const { etDateString, parseETDateTime } = require('../utils/datetime-et');
    const ringing = await dropOffBells(db('notifications')).where('created_at', '>=', parseETDateTime(`${etDateString(now)}T00:00`))
      .whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'").whereRaw("metadata->>'trust' = ?", [mod.UNVERIFIED]).count({ n: '*' }).first();
    expect(Number(ringing.n)).toBe(room);
    const [summary] = await bellsFor(burstKey(now));
    expect(summary).toEqual(expect.objectContaining({ category: 'alert', link: '/admin/communications#tab=portal' }));
    // Every drop-off, rung or quiet, is a Portal item; the summary is not one.
    process.env.GATE_PORTAL_INBOX = 'true';
    const listed = new Set((await portalInbox.list()).items.map((row) => row.id));
    for (const row of quietRows) expect(listed.has(row.id)).toBe(true);
    expect(listed.has(summary.id)).toBe(false);
    // A later run finds nothing new and rings no second summary.
    expect(await run(now)).toEqual(expect.objectContaining({ raised: 0, held: 0 }));
    expect(await bellsFor(burstKey(now))).toHaveLength(1);
  });

  test('an office estimate still rings after the day\'s unverified room is full; its bell says so', async () => {
    for (let k = 0; k <= mod.MAX_BELLS_PER_DAY[mod.UNVERIFIED]; k += 1) await intent(await customer(), { last_activity_at: ago(90 + k) });
    expect((await run()).held).toBeGreaterThanOrEqual(1);
    const tech = await insert('technicians', { name: `Synthetic Tech ${RUN}` });
    const e = await estimate(await customer(), { created_by_technician_id: tech.id });
    await cardStep(e, ago(90));
    await run();
    const rows = await bellsFor(estimateKey(e));
    expect(rows).toHaveLength(1);
    expect(meta(rows[0]).trust).toBe(mod.ESTABLISHED);
    expect(meta(rows[0]).feed).not.toBe('activity');
  });

  test('only an estimate our office sent is established; a typed phone that matches a served customer is not', async () => {
    const tech = await insert('technicians', { name: `Synthetic Tech ${RUN}` });
    const staffMade = await estimate(await customer(), { created_by_technician_id: tech.id });
    const drafted = await estimate(await customer(), { source: 'estimator_engine' });
    const website = await estimate(await servedCustomer(), { source: 'quote_wizard' });
    for (const e of [staffMade, drafted, website]) await cardStep(e, ago(90));
    const typed = await intent(await servedCustomer());
    await run();
    const trust = async (key) => meta((await bellsFor(key))[0]).trust;
    expect(await trust(estimateKey(staffMade))).toBe(mod.ESTABLISHED);
    expect(await trust(estimateKey(drafted))).toBe(mod.ESTABLISHED);
    expect(await trust(estimateKey(website))).toBe(mod.UNVERIFIED);
    expect(await trust(intentKey(typed))).toBe(mod.UNVERIFIED);
  });

  test('a visit booked before the latest attempt does not hide it (the intent was reused)', async () => {
    const c = await customer();
    const i = await intent(c, { captured_at: ago(5 * 24 * 60), last_activity_at: ago(90) });
    await visit(c, ago(3 * 24 * 60));
    await run();
    expect(await bellsFor(intentKey(i))).toHaveLength(1);
  });

  test('a visit booked after the drop-off stops the bell', async () => {
    const c = await customer();
    const i = await intent(c);
    await visit(c, ago(60));
    await run();
    expect(await bellsFor(intentKey(i))).toHaveLength(0);
  });

  test('an estimate whose card step was left gets one bell, however many card events; an accepted one gets none', async () => {
    const c = await customer();
    const open = await estimate(c);
    await cardStep(open, ago(100), 'recurring_card');
    await cardStep(open, ago(80), 'card_hold');
    const accepted = await estimate(c, { status: 'accepted', accepted_at: ago(70) });
    await cardStep(accepted, ago(90));
    await run();
    const rows = await bellsFor(estimateKey(open));
    expect(rows).toHaveLength(1);
    expect(meta(rows[0])).toEqual(expect.objectContaining({ customerId: c.id, checkoutEstimateId: open.id, source: 'estimate_card', trust: mod.UNVERIFIED }));
    expect(await bellsFor(estimateKey(accepted))).toHaveLength(0);
  });



  test('an estimate with no customer still rings, linked to the estimate, with the visitor\'s name and phone', async () => {
    const e = await estimate(null);
    await cardStep(e, ago(90));
    await run();
    const rows = await bellsFor(estimateKey(e));
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe(`/admin/estimates?estimateId=${e.id}`);
    expect(meta(rows[0])).toEqual(expect.objectContaining({ checkoutEstimateId: e.id, contactPhone: e.customer_phone }));
    expect(meta(rows[0]).customerId).toBeUndefined();
  });

  test('a bell a person marked Done never rings again for the same drop-off', async () => {
    const c = await customer();
    const i = await intent(c);
    await run();
    const [bell] = await bellsFor(intentKey(i));
    expect(await NotificationService.markAdminDone([bell.id], { by: 'portal-unfinished-bookings-test', role: 'admin' })).toBe(1);
    await run();
    const rows = await bellsFor(intentKey(i));
    expect(rows).toHaveLength(1);
    expect(rows[0].done_at).not.toBeNull();
  });

  test('the Portal tab lists the bell as a booking item whose version the bell\'s Done accepts', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const c = await customer();
    const i = await intent(c);
    await run();
    const [bell] = await bellsFor(intentKey(i));
    const listed = await portalInbox.list();
    const item = listed.items.find((row) => row.kind === 'booking' && row.id === bell.id);
    expect(item).toEqual(expect.objectContaining({
      source: 'booking_page', service: 'Mosquito Control', slot: { date: '2026-11-24', start: '13:00', end: '14:00' },
    }));
    expect(item.customer.id).toBe(c.id);
    expect(item.verified).toBe(false);
    expect(item.version).toMatch(/^[0-9a-f]{32}$/);
    expect(listed.older).toHaveProperty('bookings');
    // Gate off: the kind is not listed at all.
    delete process.env.GATE_PORTAL_BOOKING_ITEMS;
    expect((await portalInbox.list()).items.some((row) => row.id === bell.id)).toBe(false);
    process.env.GATE_PORTAL_BOOKING_ITEMS = 'true';
    // The version the list served is the one the Done route checks.
    expect(await NotificationService.markAdminDone([bell.id], { by: 'portal-unfinished-bookings-test', role: 'admin', expectedVersion: item.version })).toBe(1);
  });

  test('a reply or a visit between the drop-off and the bell still closes it: the boundary is the drop-off', async () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    const texted = await customer();
    const textedIntent = await intent(texted, { last_activity_at: ago(90) });
    const visited = await customer();
    const visitedIntent = await intent(visited, { last_activity_at: ago(90) });
    await run();
    expect(await bellsFor(intentKey(textedIntent))).toHaveLength(1);
    expect(await bellsFor(intentKey(visitedIntent))).toHaveLength(1);
    // Both land after the drop-off but before the bell's insert: the race between the detection read and the insert.
    await staffText(texted, ago(30));
    await visit(visited, ago(30));
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    expect((await bellsFor(intentKey(textedIntent)))[0].done_at).not.toBeNull();
    const [visitedAfter] = await bellsFor(intentKey(visitedIntent));
    expect(visitedAfter.done_at).not.toBeNull();
    expect(visitedAfter.resolution).toBe('A visit was booked');
  });

  test('the sweep closes the bell on a person\'s text after it, and when the booking was finished', async () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    const texted = await customer();
    const textedIntent = await intent(texted);
    const finished = await customer();
    const finishedIntent = await intent(finished);
    await run();
    const [textedBell] = await bellsFor(intentKey(textedIntent));
    const [finishedBell] = await bellsFor(intentKey(finishedIntent));
    await staffText(texted, plus(textedBell.created_at, 1));
    await db('booking_intents').where({ id: finishedIntent.id }).update({ converted_at: plus(finishedBell.created_at, 1) });
    await relevance.runAdminAlertRelevanceSweep({ now: plus(textedBell.created_at, 5) });
    const [textedAfter] = await bellsFor(intentKey(textedIntent));
    const [finishedAfter] = await bellsFor(intentKey(finishedIntent));
    expect(textedAfter.done_at).not.toBeNull();
    expect(finishedAfter.done_at).not.toBeNull();
    expect(finishedAfter.resolution).toBe('Booking was finished');
  });
});
