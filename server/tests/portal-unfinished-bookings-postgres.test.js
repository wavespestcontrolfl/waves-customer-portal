/**
 * Unfinished bookings against live Postgres (GATE_PORTAL_BOOKING_ITEMS), the SQL as the sweep runs it:
 *   - portal-unfinished-bookings.js: a booking-page visitor quiet for an hour, or an estimate whose card step was
 *     opened and left, gets ONE admin bell; never inside the quiet hour, never past the 14-day window, never for a
 *     converted or suppressed intent, an accepted estimate, a customer who booked a visit after the drop-off, or a
 *     drop-off a person already followed up; never a second bell for one key, even after the first was marked Done.
 *   - portal-inbox.js: the Communications Portal tab lists the bell as a booking item whose version the bell's
 *     Done accepts.
 *   - admin-alert-relevance.js: the bell closes on a person's text after it, and when the booking was finished.
 *   - the day's cap: past MAX_BELLS_PER_DAY the rest are held and one summary bell rings, once a day. Each test
 *     removes the bells it raised, so the next one starts the day's count from zero.
 * Every row is synthetic and removed after the run. It refuses any database but a private QA one or CI's.
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
  const made = { sms_log: [], scheduled_services: [], estimate_checkout_events: [], booking_intents: [], estimates: [], customers: [], notifications: [] };
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

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    mod = require('../services/portal-unfinished-bookings');
    portalInbox = require('../services/portal-inbox');
    relevance = require('../services/admin-alert-relevance');
    NotificationService = require('../services/notification-service');
  });
  const burstKey = (at = new Date()) => `${mod.BURST_KEY_PREFIX}${require('../utils/datetime-et').etDateString(at)}`;
  // This run's bells only: one per synthetic intent or estimate, and today's summary bell.
  const removeBells = async () => {
    const keys = [
      ...made.booking_intents.map((id) => `${mod.BOOKING_KEY_PREFIX}${id}`),
      ...made.estimates.map((id) => `${mod.CHECKOUT_KEY_PREFIX}${id}`),
      burstKey(),
    ];
    await db('notifications').whereIn(db.raw("metadata->>'dedupeKey'"), keys).del();
  };
  beforeEach(() => { process.env.GATE_PORTAL_BOOKING_ITEMS = 'true'; });
  afterEach(async () => {
    for (const key of ['GATE_PORTAL_BOOKING_ITEMS', 'GATE_PORTAL_INBOX', 'GATE_ALERT_CONTACT_CLOSE']) delete process.env[key];
    if (db) await removeBells();
  });
  afterAll(async () => {
    if (!db) return;
    await removeBells();
    for (const table of ['notifications', 'sms_log', 'scheduled_services', 'estimate_checkout_events', 'booking_intents', 'estimates', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
  }, 120000);

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
  const visit = (c, at) => insert('scheduled_services', {
    customer_id: c.id, scheduled_date: '2026-11-20', service_type: 'Monthly Mosquito Control Service', status: 'pending', created_at: at,
  });

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

  test('past the day\'s cap the rest are held and one summary bell rings, once a day', async () => {
    const now = new Date();
    const intents = [];
    for (let k = 0; k < mod.MAX_BELLS_PER_DAY + 2; k += 1) {
      intents.push(await intent(await customer(), { captured_at: ago(120 + k), last_activity_at: ago(90 + k) }));
    }
    expect(await run(now)).toEqual(expect.objectContaining({ raised: mod.MAX_BELLS_PER_DAY, held: 2 }));
    let rung = 0;
    for (const i of intents) rung += (await bellsFor(intentKey(i))).length;
    expect(rung).toBe(mod.MAX_BELLS_PER_DAY);
    const [summary] = await bellsFor(burstKey(now));
    expect(summary).toEqual(expect.objectContaining({ category: 'alert', link: '/admin/communications#tab=portal' }));
    // The summary is not a booking item, and a later run that holds again rings no second one.
    process.env.GATE_PORTAL_INBOX = 'true';
    expect((await portalInbox.list()).items.some((row) => row.id === summary.id)).toBe(false);
    expect(await run(now)).toEqual(expect.objectContaining({ raised: 0, held: 2 }));
    expect(await bellsFor(burstKey(now))).toHaveLength(1);
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
    expect(meta(rows[0])).toEqual(expect.objectContaining({ customerId: c.id, checkoutEstimateId: open.id, source: 'estimate_card' }));
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
    expect(item.version).toMatch(/^[0-9a-f]{32}$/);
    expect(listed.older).toHaveProperty('bookings');
    // Gate off: the kind is not listed at all.
    delete process.env.GATE_PORTAL_BOOKING_ITEMS;
    expect((await portalInbox.list()).items.some((row) => row.id === bell.id)).toBe(false);
    process.env.GATE_PORTAL_BOOKING_ITEMS = 'true';
    // The version the list served is the one the Done route checks.
    expect(await NotificationService.markAdminDone([bell.id], { by: 'portal-unfinished-bookings-test', role: 'admin', expectedVersion: item.version })).toBe(1);
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
