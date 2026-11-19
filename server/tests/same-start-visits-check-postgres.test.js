// Same-start visits check on real Postgres (owner 2026-11-19, "build check"): the finder's SQL
// against the migrated schema, and one bell's whole life through the schedule-integrity
// watchdog (raise, a new day rings, a fixed day is quiet, the split closes it, a comeback
// rings again). Real migrated PostgreSQL and the REAL notification service, synthetic records,
// rolled back after every test (same harness as prepay-coverage-bell-refresh-postgres.test.js).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// Each lifecycle step runs the whole watchdog against Postgres: well past the 5 s default on a loaded runner.
jest.setTimeout(60000);
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []), findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));
// The real combined-booking check, which one test tells to report a spent budget for one run.
jest.mock('../services/combined-booking-check', () => {
  const actual = jest.requireActual('../services/combined-booking-check');
  return { ...actual, runCombinedBookingCheck: jest.fn((...args) => actual.runCombinedBookingCheck(...args)) };
});
const { randomUUID } = require('node:crypto');

postgres('same-start visits check on Postgres', () => {
  let database;
  let trx;
  const TODAY = '2040-01-10';
  const now = new Date('2040-01-10T16:00:00Z');

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const customer = async (overrides = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer', ...overrides });
    return id;
  };
  const technician = async () => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name: 'Sample Tech' });
    return id;
  };
  // Priced, one-hour, non-recurring visits, so no other watchdog class has a finding about them.
  const visit = async (customerId, overrides = {}) => (await trx('scheduled_services').insert({ id: randomUUID(),
    customer_id: customerId, service_type: 'Lawn Care Service', status: 'pending', scheduled_date: '2040-01-15',
    window_start: '10:00', window_end: '11:00', estimated_price: 100, is_recurring: false, ...overrides }).returning('*'))[0];
  // Two visits of one customer on one day: a lawn visit (`shared`), and a pest visit (`shared` + `second`).
  const pair = async (customerId, shared = {}, second = {}) => [
    await visit(customerId, shared),
    await visit(customerId, { ...shared, service_type: 'Pest Control Service', ...second }),
  ];
  const ids = (rows) => rows.map((r) => String(r.id)).sort();

  test('the finder: one customer, one day after today, one start, live, one technician or one unassigned', async () => {
    const { _findSameStartVisits, sameStartVisitAlerts, SAME_START_PREFIX } = require('../services/same-start-visits-check');
    const techA = await technician();
    const techB = await technician();
    const live = await customer();
    const inactive = await customer({ active: false });
    const deleted = await customer({ deleted_at: new Date('2040-01-01T12:00:00Z') });
    // Churned out of band, still flagged active: the churned-live-work class says to cancel its visits.
    const churned = await customer({ pipeline_stage: 'churned' });
    const counted = [
      // The same technician; pending and confirmed both count. A booked visit with a
      // leftover hold stamp still counts: a hold has no customer (slot-reservation.js).
      ...(await pair(live, { scheduled_date: '2040-01-15', technician_id: techA }, { status: 'confirmed', reservation_expires_at: new Date('2040-01-10T15:00:00Z') })),
      // One of the two has no technician yet.
      ...(await pair(live, { scheduled_date: '2040-01-16', window_start: '09:00', window_end: '10:00', technician_id: techA }, { technician_id: null })),
      // Three at one start: each visit is one row, not one row per partner.
      ...(await pair(live, { scheduled_date: '2040-01-23' })),
      await visit(live, { scheduled_date: '2040-01-23', service_type: 'Mosquito Service' }),
      // Two technicians' pairs at one start: all four count, as two groups.
      ...(await pair(live, { scheduled_date: '2040-01-24', technician_id: techA })),
      ...(await pair(live, { scheduled_date: '2040-01-24', technician_id: techB })),
    ];
    // One visit each for two technicians plus one unassigned at one start: the finder
    // returns all three (each has a partner), but the unassigned visit's partner is
    // not known until it gets a technician, so they make no group and no day.
    const foundNoGroup = [
      ...(await pair(live, { scheduled_date: '2040-01-28', technician_id: techA }, { technician_id: techB })),
      await visit(live, { scheduled_date: '2040-01-28', service_type: 'Mosquito Service', technician_id: null }),
    ];
    await pair(live, { scheduled_date: '2040-01-17', technician_id: techA }, { technician_id: techB }); // two people working at once
    await pair(live, { scheduled_date: '2040-01-18' }, { status: 'cancelled' });
    await pair(live, { scheduled_date: '2040-01-19' }, { status: 'completed' });
    await pair(live, { scheduled_date: '2040-01-20' }, { window_start: '11:00', window_end: '12:00' }); // already back to back
    await pair(live, { scheduled_date: TODAY }); // today: its route is set and its day-before text has gone
    await pair(live, { scheduled_date: '2040-01-09' });
    await pair(live, { scheduled_date: '2040-01-21', window_start: null, window_end: null }); // no arrival time
    // The tracker leads `status`: a visit it reads cancelled or complete is not live, whatever its status says.
    await pair(live, { scheduled_date: '2040-01-25' }, { track_state: 'cancelled' });
    await pair(live, { scheduled_date: '2040-01-26', track_state: 'complete' }, { track_state: 'scheduled' });
    await pair(inactive, { scheduled_date: '2040-01-15' });
    await pair(deleted, { scheduled_date: '2040-01-15' });
    await pair(churned, { scheduled_date: '2040-01-15' });

    const mine = new Set([live, inactive, deleted, churned]);
    const rows = (await _findSameStartVisits(TODAY)).filter((r) => mine.has(String(r.customer_id)));
    expect(ids(rows)).toEqual(ids([...counted, ...foundNoGroup]));

    // The pg DATE and TIME values read back as the calendar day and the wall-clock start.
    const { alerts, failed } = await sameStartVisitAlerts(TODAY);
    expect(failed).toBe(false);
    const ours = alerts.filter((a) => mine.has(String(a[3].customer_id)));
    expect(ours.map((a) => a[0])).toEqual([`${SAME_START_PREFIX}${live}`]);
    expect(ours[0][3]).toMatchObject({
      first_date: '2040-01-15', day_count: 4, itemKeys: ['2040-01-15', '2040-01-16', '2040-01-23', '2040-01-24'],
    });
    expect(ours[0][2]).toBe('4 days have visits at the same time, first Jan 15 at 10 AM; split each so they run back to back.');
    expect(ours[0][4].detail).toBe('Jan 15 at 10 AM: Lawn Care Service and Pest Control Service.'
      + ' Jan 16 at 9 AM: Lawn Care Service and Pest Control Service.'
      + ' Jan 23 at 10 AM: Lawn Care Service, Mosquito Service and Pest Control Service.'
      + ' Jan 24 at 10 AM: Lawn Care Service and Pest Control Service; at 10 AM, another technician: Lawn Care Service and Pest Control Service.');
  });

  test('a legacy visit group never counts: its services pair neither with each other nor with a separate visit at its start', async () => {
    const { _findSameStartVisits, sameStartVisitAlerts } = require('../services/same-start-visits-check');
    const stop = async (customerId, date) => {
      const id = randomUUID();
      await trx('service_visits').insert({ id, customer_id: customerId, scheduled_date: date, stop_base_key: `fixture-${id}`, created_by: 'test' });
      return id;
    };
    const alone = await customer();
    const beside = await customer();
    await pair(alone, { scheduled_date: '2040-01-15', visit_id: await stop(alone, '2040-01-15') });
    await pair(beside, { scheduled_date: '2040-01-15', visit_id: await stop(beside, '2040-01-15') });
    const separate = await visit(beside, { scheduled_date: '2040-01-15', service_type: 'Mosquito Service' });

    // visit-groups.js owns a group's stop, technician and time (none is live; creation retired 2026-10-22).
    const mine = new Set([alone, beside]);
    expect((await _findSameStartVisits(TODAY)).filter((r) => mine.has(String(r.customer_id)))).toEqual([]);
    expect((await sameStartVisitAlerts(TODAY)).alerts.filter((a) => mine.has(String(a[3].customer_id)))).toEqual([]);
    // The separate visit still pairs with another separate visit at that start.
    const second = await visit(beside, { scheduled_date: '2040-01-15', service_type: 'Tree & Shrub Care Service' });
    const rows = (await _findSameStartVisits(TODAY)).filter((r) => mine.has(String(r.customer_id)));
    expect(ids(rows)).toEqual(ids([separate, second]));
  });

  test('one bell through the watchdog: raised, a new day rings, a fixed day is quiet, the split closes it, a comeback rings', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const tech = await technician();
    const customerId = await customer();
    const key = `same-start-visits:${customerId}`;
    const bells = () => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]);
    const markRead = async (at) => { await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]).update({ read_at: at }); };
    const [, jan15Pest] = await pair(customerId, { scheduled_date: '2040-01-15', technician_id: tech });

    // 1. Raised.
    const first = await runInner({ now });
    expect(first.sameStartCheckFailed).toBe(false);
    const [raised, ...extra] = await bells();
    expect(extra).toHaveLength(0);
    expect(raised.title).toBe("Schedule — split Synthetic Fixture's visits at the same time");
    expect(raised.body).toBe('2 visits start at 10 AM on Jan 15; split them so they run back to back.');
    expect(raised.detail).toBe('Jan 15 at 10 AM: Lawn Care Service and Pest Control Service.');
    expect(raised.link).toBe(`/admin/dispatch?tab=schedule&date=2040-01-15&appointment=${jan15Pest.id}`);
    expect(raised.read_at).toBeNull();
    expect(raised.metadata).toMatchObject({
      dedupeKey: key, customer_id: customerId, itemKeys: ['2040-01-15'], area: 'Schedule', severity: 'needs-you',
      subject: { type: 'customer', id: customerId }, doneWhen: 'visits_start_apart', who: 'person',
    });

    // 2. A day the bell did not list joins: the same row rings again.
    await markRead(new Date('2040-01-10T17:00:00Z'));
    const [jan22Lawn, jan22Pest] = await pair(customerId, { scheduled_date: '2040-01-22', window_start: '11:00', window_end: '12:00', technician_id: tech });
    await runInner({ now });
    const [rang, ...extra2] = await bells();
    expect(extra2).toHaveLength(0);
    expect(rang.id).toBe(raised.id);
    expect(rang.read_at).toBeNull();
    expect(rang.body).toBe('2 days have visits at the same time, first Jan 15 at 10 AM; split each so they run back to back.');
    expect(rang.metadata.itemKeys).toEqual(['2040-01-15', '2040-01-22']);

    // 3. One day is split: the bell updates quietly (read state and last ring kept).
    const readAt = new Date('2040-01-10T18:00:00Z');
    await markRead(readAt);
    await trx('scheduled_services').where({ id: jan15Pest.id }).update({ window_start: '11:00', window_end: '12:00' });
    await runInner({ now });
    const [quiet] = await bells();
    expect(quiet.id).toBe(raised.id);
    expect(quiet.body).toBe('2 visits start at 11 AM on Jan 22; split them so they run back to back.');
    expect(quiet.link).toBe(`/admin/dispatch?tab=schedule&date=2040-01-22&appointment=${jan22Pest.id}`);
    expect(new Date(quiet.read_at).toISOString()).toBe(readAt.toISOString());
    expect(quiet.metadata.rungAt).toBe(rang.metadata.rungAt);
    expect(quiet.metadata.itemKeys).toEqual(['2040-01-22']);
    expect(quiet.done_at).toBeNull();

    // 3b. A visit on the listed day is replaced (cancelled, the same service booked again at that
    // start): only the visits change (itemSetHash), and the bell updates them quietly.
    await trx('scheduled_services').where({ id: jan22Lawn.id }).update({ status: 'cancelled' });
    const jan22LawnAgain = await visit(customerId, { scheduled_date: '2040-01-22', window_start: '11:00', window_end: '12:00', technician_id: tech });
    await runInner({ now });
    const [replaced, ...extra3] = await bells();
    expect(extra3).toHaveLength(0);
    expect(replaced.id).toBe(raised.id);
    expect([replaced.body, replaced.link, replaced.detail]).toEqual([quiet.body, quiet.link, quiet.detail]);
    expect(replaced.metadata.visit_ids).toEqual([String(jan22LawnAgain.id), String(jan22Pest.id)]);
    expect(replaced.metadata.itemSetHash).not.toBe(quiet.metadata.itemSetHash);
    expect(new Date(replaced.read_at).toISOString()).toBe(readAt.toISOString());
    expect(replaced.metadata.rungAt).toBe(rang.metadata.rungAt);

    // 4. The last day is split: the bell closes itself.
    await trx('scheduled_services').where({ id: jan22Pest.id }).update({ window_start: '12:00', window_end: '13:00' });
    await runInner({ now });
    const [closed] = await bells();
    expect(closed.id).toBe(raised.id);
    expect(closed.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'no upcoming visits at the same time' });
    expect(closed.done_at).not.toBeNull();

    // 5. The pair comes back: the same row rings again, unread and not done.
    await trx('scheduled_services').where({ id: jan22Pest.id }).update({ window_start: '11:00', window_end: '12:00' });
    await runInner({ now });
    const [back, ...extra5] = await bells();
    expect(extra5).toHaveLength(0);
    expect(back.id).toBe(raised.id);
    expect(back.read_at).toBeNull();
    expect(back.done_at).toBeNull();
    expect(back.metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1 });
  });

  test('a pair tomorrow that a spent budget holds is on one quiet standing count; the next day it is gone and the count closes', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const { runCombinedBookingCheck } = require('../services/combined-booking-check');
    const NotificationService = require('../services/notification-service');
    const tech = await technician();
    const customerId = await customer();
    const [, pest] = await pair(customerId, { scheduled_date: '2040-01-11', technician_id: tech });
    const rows = (prefix) => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("starts_with(metadata->>'dedupeKey', ?)", [prefix]);
    const bellUnread = () => NotificationService.getAdminUnreadCount({ fullAccess: true }, trx);
    const unreadBefore = await bellUnread();

    // Day 1: the combined-booking check spent all ten rings, so no bell is left for the pair.
    runCombinedBookingCheck.mockResolvedValueOnce({ candidates: 0, checked: 10, ok: 0, problems: 10, deferred: 0, skipped: 0, failed: 0, closed: 0, held: 0, rings: 10 });
    const first = await runInner({ now });
    expect(first).toMatchObject({ sameStartVisits: 1, sameStartHeld: 1, alerted: 0 });
    expect(await rows(`same-start-visits:${customerId}`)).toHaveLength(0);
    const [count, ...extra] = await rows('same-start-visits-held:');
    expect(extra).toHaveLength(0);
    expect(count.title).toBe('Schedule — split same-time visits for 1 customer');
    expect(count.body).toBe('1 customer has visits at the same time, first Jan 11; the bell limit held them.');
    expect(count.detail).toBe('Synthetic Fixture — Jan 11 at 10 AM: Lawn Care Service and Pest Control Service.');
    expect(count.link).toBe(`/admin/dispatch?tab=schedule&date=2040-01-11&appointment=${pest.id}`);
    expect(count.metadata).toMatchObject({
      feed: 'activity', quiet: true, count: 1, itemKeys: [`${customerId}:2040-01-11`], doneWhen: 'count_zero', severity: 'needs-you',
    });
    expect(count.done_at).toBeNull();
    // Activity only: the bell's unread count does not move.
    expect(await bellUnread()).toBe(unreadBefore);

    // The same day again: the count is rewritten in place, never a second row.
    runCombinedBookingCheck.mockResolvedValueOnce({ candidates: 0, checked: 10, ok: 0, problems: 10, deferred: 0, skipped: 0, failed: 0, closed: 0, held: 0, rings: 10 });
    await runInner({ now });
    const again = await rows('same-start-visits-held:');
    expect(again.map((r) => r.id)).toEqual([count.id]);

    // Day 2: that pair is today's (the finder leaves today out), so nothing waits and the count closes at zero.
    const next = await runInner({ now: new Date('2040-01-11T16:00:00Z') });
    expect(next).toMatchObject({ sameStartVisits: 0, sameStartHeld: 0 });
    const [closed, ...extra2] = await rows('same-start-visits-held:');
    expect(extra2).toHaveLength(0);
    expect(closed.id).toBe(count.id);
    expect(closed.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'count_zero' });
    expect(closed.done_at).not.toBeNull();
  });

  test('a count someone closed stays closed while it lists every pair that waits; a new pair starts a new quiet row', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const { runCombinedBookingCheck } = require('../services/combined-booking-check');
    const spent = () => runCombinedBookingCheck.mockResolvedValueOnce({ candidates: 0, checked: 10, ok: 0, problems: 10, deferred: 0, skipped: 0, failed: 0, closed: 0, held: 0, rings: 10 });
    const counts = () => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("starts_with(metadata->>'dedupeKey', ?)", ['same-start-visits-held:']);
    const tech = await technician();
    const first = await customer();
    await pair(first, { scheduled_date: '2040-01-11', technician_id: tech });
    spent();
    await runInner({ now });
    const [count] = await counts();

    // A person marks it done: the next run, with the same pair still held, leaves it closed.
    await trx('notifications').where({ id: count.id }).update({ done_at: new Date('2040-01-10T17:00:00Z'), done_by: randomUUID() });
    spent();
    expect(await runInner({ now })).toMatchObject({ sameStartHeld: 1 });
    expect((await counts()).map((r) => r.id)).toEqual([count.id]);

    // A second customer's pair is held too: a new quiet row lists both; the closed row stays closed.
    const second = await customer();
    await pair(second, { scheduled_date: '2040-01-12', technician_id: tech });
    spent();
    expect(await runInner({ now })).toMatchObject({ sameStartHeld: 2 });
    const all = await counts();
    expect(all).toHaveLength(2);
    const kept = all.find((r) => r.id === count.id);
    const fresh = all.find((r) => r.id !== count.id);
    expect(kept.done_at).not.toBeNull();
    expect(fresh.metadata.dedupeKey).not.toBe(count.metadata.dedupeKey);
    expect(fresh.metadata).toMatchObject({ count: 2, feed: 'activity', quiet: true, itemKeys: [`${first}:2040-01-11`, `${second}:2040-01-12`].sort() });
    expect(fresh.done_at).toBeNull();
  });

  test('a day past the ten listed still counts: moving it rings the bell again; a second start on a listed day is quiet', async () => {
    const { runInner } = require('../services/schedule-integrity-watchdog');
    const tech = await technician();
    const customerId = await customer();
    const key = `same-start-visits:${customerId}`;
    const bell = async () => (await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]))[0];
    const markRead = (at) => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]).update({ read_at: at });
    const dates = Array.from({ length: 11 }, (_, i) => `2040-01-${String(15 + i).padStart(2, '0')}`);
    const pairs = [];
    for (const date of dates) pairs.push(await pair(customerId, { scheduled_date: date, technician_id: tech }));

    await runInner({ now });
    const raised = await bell();
    expect(raised.body).toBe('11 days have visits at the same time, first Jan 15 at 10 AM; split each so they run back to back.');
    expect(raised.detail).toMatch(/ Jan 24 at 10 AM: Lawn Care Service and Pest Control Service\. And 1 more day\.$/);
    expect(raised.metadata.itemKeys).toEqual(dates);

    // The eleventh day (not in the detail) moves to another day: the why, detail and link read the same, the bell rings.
    await markRead(new Date('2040-01-10T17:00:00Z'));
    await trx('scheduled_services').whereIn('id', pairs[10].map((v) => v.id)).update({ scheduled_date: '2040-02-01' });
    await runInner({ now });
    const moved = await bell();
    expect(moved.id).toBe(raised.id);
    expect([moved.body, moved.detail, moved.link]).toEqual([raised.body, raised.detail, raised.link]);
    expect(moved.metadata.itemKeys).toEqual([...dates.slice(0, 10), '2040-02-01']);
    expect(moved.read_at).toBeNull();

    // A second pair at another start on a day already listed: the detail grows, the bell stays read.
    const readAt = new Date('2040-01-10T18:00:00Z');
    await markRead(readAt);
    await pair(customerId, { scheduled_date: '2040-01-15', window_start: '13:00', window_end: '14:00', technician_id: tech });
    await runInner({ now });
    const grown = await bell();
    expect(grown.id).toBe(raised.id);
    expect(grown.detail).toMatch(/^Jan 15 at 10 AM: Lawn Care Service and Pest Control Service; at 1 PM: Lawn Care Service and Pest Control Service\. /);
    expect(new Date(grown.read_at).toISOString()).toBe(readAt.toISOString());
    expect(grown.metadata.rungAt).toBe(moved.metadata.rungAt);
  });
});
