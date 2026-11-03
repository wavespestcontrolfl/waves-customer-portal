/**
 * Unfinished bookings against live Postgres (GATE_PORTAL_BOOKING_ITEMS), the SQL as the sweep runs it:
 *   - portal-unfinished-bookings.js: the card step of an estimate our office sent (made by staff, or drafted by the
 *     call and text estimator), opened and left, gets ONE admin bell; never a website estimate, a source-less
 *     estimate or a booking-page start (owner 2026-11-02, "A"); never inside the quiet hour, never past the 14-day
 *     window, never for an accepted, declined or archived estimate, a customer who booked a visit after the drop-off,
 *     or a drop-off a person already followed up; never a second bell for one estimate, even after the first was
 *     marked Done.
 *   - portal-inbox.js: the Communications Portal tab lists the bell as a booking item whose version the bell's
 *     Done accepts.
 *   - admin-alert-relevance.js: the bell closes on a person's contact or a booked visit after the drop-off, and when
 *     the estimate is accepted, declined or archived.
 * Each test removes everything it made and every bell its sweeps raised (Codex #7489 r2). Every row is synthetic.
 * It refuses any database but a private QA one or CI's.
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
  // The bells this module raised since the file started (any drop-off key, so a sweep's bell for a row another
  // suite left is gone too), and every fixture the test made.
  const dropOffBells = (q) => q.where({ recipient_type: 'admin' })
    .whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [mod.KEY_PREFIX.length, mod.KEY_PREFIX]);
  const cleanUp = async () => {
    await dropOffBells(db('notifications')).where('created_at', '>=', fileStart).del();
    for (const table of ['sms_log', 'scheduled_services', 'estimate_checkout_events', 'booking_intents', 'estimates', 'technicians', 'customers']) {
      const ids = made[table].splice(0);
      if (ids.length) await db(table).whereIn('id', ids).del();
    }
  };
  beforeEach(() => { process.env.GATE_PORTAL_BOOKING_ITEMS = 'true'; });
  afterEach(async () => {
    for (const key of ['GATE_PORTAL_BOOKING_ITEMS', 'GATE_PORTAL_INBOX', 'GATE_ALERT_CONTACT_CLOSE', 'GATE_PORTAL_ASK_PUSH']) delete process.env[key];
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
  // An open estimate (no customer: the visitor's name and phone on the row) with the given source.
  const estimate = (c, over = {}) => insert('estimates', {
    customer_id: c ? c.id : null, status: 'viewed', service_interest: 'Quarterly Pest Control',
    customer_name: c ? null : `Jordan Fixture${RUN}`, customer_phone: c ? null : phone(), created_at: ago(3 * 24 * 60), ...over,
  });
  // An estimate our office sent: drafted by the call and text estimator (no maker row needed).
  const officeEstimate = (c, over = {}) => estimate(c, { source: 'estimator_engine', ...over });
  // Its card step opened (one event per kind: the table is unique on estimate + kind).
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
    customer_id: c.id, scheduled_date: '2026-11-20', service_type: 'Quarterly Pest Control Service', status, created_at: at,
  });

  const run = (now = new Date(), pageSize = undefined) => mod.runPortalUnfinishedBookings({ now, ...(pageSize ? { pageSize } : {}) });
  const bellsFor = (key) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]);
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
  const estimateKey = (e) => `${mod.CHECKOUT_KEY_PREFIX}${e.id}`;

  test('an office estimate whose card step was left gets one bell, however many card events, and only one', async () => {
    const c = await customer();
    const e = await officeEstimate(c);
    await cardStep(e, ago(100), 'recurring_card');
    await cardStep(e, ago(80), 'card_hold');
    await run();
    const rows = await bellsFor(estimateKey(e));
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('alert');
    expect(rows[0].done_at).toBeNull();
    expect(meta(rows[0])).toEqual(expect.objectContaining({ customerId: c.id, checkoutEstimateId: e.id, source: 'estimate_card' }));
    expect(rows[0].link).toBe(`/admin/customers?customerId=${c.id}`);
    await run();
    expect(await bellsFor(estimateKey(e))).toHaveLength(1);
  });

  test('only an estimate our office sent rings: never a website estimate, a source-less one or a booking-page start', async () => {
    const tech = await insert('technicians', { name: `Synthetic Tech ${RUN}` });
    const staffMade = await estimate(await customer(), { created_by_technician_id: tech.id });
    const drafted = await officeEstimate(await customer());
    const website = await estimate(await customer(), { source: 'quote_wizard' });
    // Source 'manual' is the column's default: without a maker on the row it proves nothing.
    const sourceless = await estimate(await customer());
    for (const e of [staffMade, drafted, website, sourceless]) await cardStep(e, ago(90));
    const start = await insert('booking_intents', {
      phone: '9415560101', first_name: 'Pat', last_name: `Synthetic${RUN}`, service_type: 'Mosquito Control', source: 'direct',
      slot_date: '2026-11-24', slot_start: '13:00', slot_end: '14:00', captured_at: ago(120), last_activity_at: ago(90),
    });
    await run();
    expect(await bellsFor(estimateKey(staffMade))).toHaveLength(1);
    expect(await bellsFor(estimateKey(drafted))).toHaveLength(1);
    expect(await bellsFor(estimateKey(website))).toHaveLength(0);
    expect(await bellsFor(estimateKey(sourceless))).toHaveLength(0);
    const startBells = await dropOffBells(db('notifications')).whereRaw("metadata::text LIKE ?", [`%${start.id}%`]);
    expect(startBells).toHaveLength(0);
  });

  test('the quiet hour, an ended estimate and the 14-day window keep the bell from ringing', async () => {
    const c = await customer();
    const fresh = await officeEstimate(c);
    await cardStep(fresh, ago(30));
    const accepted = await officeEstimate(c, { status: 'accepted', accepted_at: ago(70) });
    const declined = await officeEstimate(c, { status: 'declined' });
    const archived = await officeEstimate(c, { archived_at: ago(70) });
    for (const e of [accepted, declined, archived]) await cardStep(e, ago(90));
    const old = await officeEstimate(c);
    await cardStep(old, ago(15 * 24 * 60));
    await run();
    for (const e of [fresh, accepted, declined, archived, old]) expect(await bellsFor(estimateKey(e))).toHaveLength(0);
  });

  test('a person who already followed up stops the bell; an automated text does not', async () => {
    const reached = await customer();
    const reachedEstimate = await officeEstimate(reached);
    await cardStep(reachedEstimate, ago(90));
    await staffText(reached, ago(60));
    const reminded = await customer();
    const remindedEstimate = await officeEstimate(reminded);
    await cardStep(remindedEstimate, ago(90));
    await automatedText(reminded, ago(60));
    await run();
    expect(await bellsFor(estimateKey(reachedEstimate))).toHaveLength(0);
    expect(await bellsFor(estimateKey(remindedEstimate))).toHaveLength(1);
  });

  test('an older unanswered drop-off behind newer contacted ones still rings: the sweep pages past them', async () => {
    const contacted = [];
    for (let k = 0; k < 3; k += 1) {
      const c = await customer();
      const e = await officeEstimate(c);
      await cardStep(e, ago(70 - k));
      await staffText(c, ago(65 - k));
      contacted.push(e);
    }
    const older = await officeEstimate(await customer());
    await cardStep(older, ago(190));
    await run(new Date(), 2);
    expect(await bellsFor(estimateKey(older))).toHaveLength(1);
    for (const e of contacted) expect(await bellsFor(estimateKey(e))).toHaveLength(0);
  });

  test('a visit booked after the drop-off stops the bell', async () => {
    const c = await customer();
    const e = await officeEstimate(c);
    await cardStep(e, ago(90));
    await visit(c, ago(60));
    await run();
    expect(await bellsFor(estimateKey(e))).toHaveLength(0);
  });

  test('an office estimate with no customer still rings, linked to the estimate, with the name and phone on it', async () => {
    const e = await officeEstimate(null);
    await cardStep(e, ago(90));
    await run();
    const rows = await bellsFor(estimateKey(e));
    expect(rows).toHaveLength(1);
    expect(rows[0].link).toBe(`/admin/estimates?estimateId=${e.id}`);
    expect(meta(rows[0])).toEqual(expect.objectContaining({ checkoutEstimateId: e.id, contactPhone: e.customer_phone }));
    expect(meta(rows[0]).customerId).toBeUndefined();
  });

  // GATE_PORTAL_ASK_PUSH (portal-ask-push.js): the page is spied, so nothing reaches a device.
  describe('the phone page', () => {
    let push;
    beforeEach(() => { push = jest.spyOn(require('../services/portal-ask-push'), 'pushPortalAsk').mockResolvedValue({ sent: true }); });
    afterEach(() => { push.mockRestore(); });
    const pagesFor = (...estimates) => push.mock.calls.map(([page]) => page)
      .filter((page) => estimates.some((e) => page.itemKey === estimateKey(e)));

    test('a new bell pages the admin phones once, first name and last initial; the next run does not page again', async () => {
      process.env.GATE_PORTAL_ASK_PUSH = 'true';
      const c = await customer();
      const linked = await officeEstimate(c);
      const visitor = await officeEstimate(null);
      await cardStep(linked, ago(90));
      await cardStep(visitor, ago(90));
      await run();
      const [bell] = await bellsFor(estimateKey(linked));
      const words = (who) => `${who} opened the card step on a ${meta(bell).service} estimate and did not finish`;
      expect(pagesFor(linked)).toEqual([{
        itemKey: estimateKey(linked), title: 'Booking not finished', body: words('Pat S.'),
        link: `/admin/customers?customerId=${c.id}`, customerId: c.id,
      }]);
      expect(pagesFor(visitor)).toEqual([{
        itemKey: estimateKey(visitor), title: 'Booking not finished', body: words('Jordan F.'),
        link: `/admin/estimates?estimateId=${visitor.id}`, customerId: null,
      }]);
      await run();
      expect(pagesFor(linked, visitor)).toHaveLength(2);
    });

    test('push gate off: the bell rings and no phone is paged', async () => {
      const e = await officeEstimate(await customer());
      await cardStep(e, ago(90));
      await run();
      expect(await bellsFor(estimateKey(e))).toHaveLength(1);
      expect(pagesFor(e)).toEqual([]);
    });
  });

  test('a bell a person marked Done never rings again for the same drop-off', async () => {
    const e = await officeEstimate(await customer());
    await cardStep(e, ago(90));
    await run();
    const [bell] = await bellsFor(estimateKey(e));
    expect(await NotificationService.markAdminDone([bell.id], { by: 'portal-unfinished-bookings-test', role: 'admin' })).toBe(1);
    await run();
    const rows = await bellsFor(estimateKey(e));
    expect(rows).toHaveLength(1);
    expect(rows[0].done_at).not.toBeNull();
  });

  test('the Portal tab lists the bell as a booking item whose version the bell\'s Done accepts', async () => {
    process.env.GATE_PORTAL_INBOX = 'true';
    const c = await customer();
    const e = await officeEstimate(c);
    await cardStep(e, ago(90));
    await run();
    const [bell] = await bellsFor(estimateKey(e));
    const listed = await portalInbox.list();
    const item = listed.items.find((row) => row.kind === 'booking' && row.id === bell.id);
    expect(item).toEqual(expect.objectContaining({ estimateId: e.id }));
    expect(item.service).toBeTruthy();
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

  test('a reply or a visit between the drop-off and the bell still closes it: the boundary is the drop-off', async () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    const texted = await customer();
    const textedEstimate = await officeEstimate(texted);
    await cardStep(textedEstimate, ago(90));
    const visited = await customer();
    const visitedEstimate = await officeEstimate(visited);
    await cardStep(visitedEstimate, ago(90));
    await run();
    expect(await bellsFor(estimateKey(textedEstimate))).toHaveLength(1);
    expect(await bellsFor(estimateKey(visitedEstimate))).toHaveLength(1);
    // Both land after the drop-off but before the bell's insert: the race between the detection read and the insert.
    await staffText(texted, ago(30));
    await visit(visited, ago(30));
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    expect((await bellsFor(estimateKey(textedEstimate)))[0].done_at).not.toBeNull();
    const [visitedAfter] = await bellsFor(estimateKey(visitedEstimate));
    expect(visitedAfter.done_at).not.toBeNull();
    expect(visitedAfter.resolution).toBe('A visit was booked');
  });

  test('a card-step bell closes when its estimate is accepted, declined or archived', async () => {
    const accepted = await officeEstimate(await customer());
    const declined = await officeEstimate(await customer());
    const archived = await officeEstimate(await customer());
    for (const e of [accepted, declined, archived]) await cardStep(e, ago(90));
    await run();
    for (const e of [accepted, declined, archived]) expect(await bellsFor(estimateKey(e))).toHaveLength(1);
    await db('estimates').where({ id: accepted.id }).update({ status: 'accepted', accepted_at: ago(5) });
    await db('estimates').where({ id: declined.id }).update({ status: 'declined' });
    await db('estimates').where({ id: archived.id }).update({ archived_at: ago(5) });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    for (const [e, reason] of [[accepted, 'Estimate was accepted'], [declined, 'Estimate was declined'], [archived, 'Estimate was archived']]) {
      const [after] = await bellsFor(estimateKey(e));
      expect(after.done_at).not.toBeNull();
      expect(after.resolution).toBe(reason);
    }
  });

  test('the sweep closes the bell on a person\'s text after the drop-off', async () => {
    process.env.GATE_ALERT_CONTACT_CLOSE = 'true';
    const c = await customer();
    const e = await officeEstimate(c);
    await cardStep(e, ago(90));
    await run();
    const [bell] = await bellsFor(estimateKey(e));
    await staffText(c, plus(bell.created_at, 1));
    await relevance.runAdminAlertRelevanceSweep({ now: plus(bell.created_at, 5) });
    expect((await bellsFor(estimateKey(e)))[0].done_at).not.toBeNull();
  });
});
