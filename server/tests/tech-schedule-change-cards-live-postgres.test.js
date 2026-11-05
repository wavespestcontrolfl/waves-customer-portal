/**
 * Schedule-change cards read against the visit as it is now (owner
 * 2026-11-04), against REAL Postgres: the Today read (GET /schedule-changes),
 * the main feed (GET /), Got it and Clear all over tech_notifications +
 * scheduled_services + reschedule_log (routes/tech-notifications.js,
 * services/tech-visit-notifications.js hiddenVisitCardSql / refreshVisitCards).
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test
 * database) or a local scratch Postgres migrated with `knex migrate:latest`;
 * it skips without one. Fixtures are fictitious. Every row it makes is removed
 * in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('schedule-change cards read against the live visit (real Postgres)', () => {
  let db;
  let router;
  let et;
  let today;
  let tomorrow;
  let yesterday;
  let farOut;
  const made = { techIds: [], customerIds: [], visitIds: [] };

  function handler(path, method) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  async function call(path, method, req) {
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    let failure = null;
    await handler(path, method)(req, res, (err) => { failure = err; });
    if (failure) throw failure;
    return res.json.mock.calls[0][0];
  }

  async function makeTech(name) {
    const [row] = await db('technicians')
      .insert({ name: `${name} ${randomUUID().slice(0, 8)}`, role: 'technician', employment_status: 'active', field_dispatchable: true, active: true })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  async function makeCustomer(lastName) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Fixture', last_name: lastName, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    });
    made.customerIds.push(id);
    return id;
  }

  async function makeVisit(tech, lastName, date, windowStart, windowEnd, extra = {}) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: await makeCustomer(lastName), technician_id: tech.id, scheduled_date: date, status: 'confirmed',
      service_type: 'Fixture Quarterly Pest Control Service', window_start: windowStart, window_end: windowEnd, ...extra,
    });
    made.visitIds.push(id);
    return id;
  }

  async function card(tech, visitId, type, payload, createdAt) {
    const [row] = await db('tech_notifications').insert({
      technician_id: tech.id, type, message: 'fixture', read: false,
      payload: JSON.stringify({ visit_id: visitId, service_type: 'Fixture Quarterly Pest Control Service', ...payload }),
      created_at: createdAt, updated_at: createdAt,
    }).returning(['id']);
    return row.id;
  }

  async function moved(visitId, initiatedBy, at, newDate) {
    const visit = await db('scheduled_services').where({ id: visitId }).first('customer_id');
    await db('reschedule_log').insert({
      scheduled_service_id: visitId, customer_id: visit.customer_id, original_date: newDate, new_date: newDate,
      initiated_by: initiatedBy, reason_code: initiatedBy, created_at: at,
    });
  }

  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const firstNameOf = (tech) => String(tech.name).split(' ')[0];

  beforeAll(async () => {
    db = require('../models/db');
    router = require('../routes/tech-notifications');
    et = require('../utils/datetime-et');
    today = et.etDateString();
    tomorrow = et.etDateString(et.addETDays(new Date(), 1));
    yesterday = et.etDateString(et.addETDays(new Date(), -1));
    farOut = et.etDateString(et.addETDays(new Date(), 30));
  });

  afterAll(async () => {
    if (made.visitIds.length) await db('reschedule_log').whereIn('scheduled_service_id', made.visitIds).del();
    if (made.techIds.length) await db('tech_notifications').whereIn('technician_id', made.techIds).del();
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    if (made.customerIds.length) await db('customers').whereIn('id', made.customerIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  test('the Today read: one card per visit, none for a reached or past visit, each in its visit\'s current day and time, in visit order', async () => {
    const tech = await makeTech('Fixture Tech');
    const other = await makeTech('Otherfixture Hire');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const said = (date, s, e) => formatWhen(date, s, e);

    // Re-timed by an office move after its card: shows the time it has now.
    const retimed = await makeVisit(tech, 'Retimed', tomorrow, '13:00', '14:00');
    await card(tech, retimed, 'visit_rescheduled', { date: tomorrow, previous_date: farOut, when: said(tomorrow, '11:00', '12:00'), previous_when: said(farOut, '13:00', '14:00'), actor: 'by auto-dispatch', customer_name: 'Retimed' }, daysAgo(10));
    await moved(retimed, 'admin', daysAgo(1), tomorrow);
    // Moved onto tomorrow with no card of its own: its old card comes up.
    const pulledIn = await makeVisit(tech, 'Pulledin', tomorrow, '08:00', '09:00');
    await card(tech, pulledIn, 'visit_assigned', { date: farOut, when: said(farOut, '16:00', '17:00'), actor: 'by the customer online', customer_name: 'Pulledin' }, daysAgo(5));
    // Two open cards for one visit: only the newer one.
    const twice = await makeVisit(tech, 'Twice', tomorrow, '10:00', '11:00');
    await card(tech, twice, 'visit_assigned', { date: tomorrow, when: said(tomorrow, '09:00', '10:00'), actor: 'by the office', customer_name: 'Twice' }, daysAgo(8));
    const twiceNewer = await card(tech, twice, 'visit_rescheduled', { date: tomorrow, previous_date: tomorrow, when: said(tomorrow, '10:00', '11:00'), previous_when: said(tomorrow, '09:00', '10:00'), actor: 'by the office', customer_name: 'Twice' }, daysAgo(2));
    // Reached (arrived) and finished visits: no card left to show.
    const arrived = await makeVisit(tech, 'Arrived', today, '14:00', '15:00', { status: 'on_site', arrived_at: new Date() });
    await card(tech, arrived, 'visit_assigned', { date: today, when: said(today, '15:00', '16:00'), actor: 'by the office', customer_name: 'Arrived' }, daysAgo(7));
    const done = await makeVisit(tech, 'Done', today, '08:00', '09:00', { status: 'completed' });
    await card(tech, done, 'visit_rescheduled', { date: today, previous_date: tomorrow, when: said(today, '08:00', '09:00'), actor: 'by auto-dispatch', customer_name: 'Done' }, daysAgo(30));
    // A visit whose day has passed, still open: its card goes too.
    const past = await makeVisit(tech, 'Pastday', yesterday, '14:00', '15:00', { status: 'pending' });
    await card(tech, past, 'visit_rescheduled', { date: yesterday, previous_date: today, when: said(yesterday, '14:00', '15:00'), actor: 'by auto-dispatch', customer_name: 'Pastday' }, daysAgo(20));
    // Now another tech's visit; and a cancelled one.
    const handedOver = await makeVisit(other, 'Handedover', tomorrow, '15:00', '16:00');
    await card(tech, handedOver, 'visit_assigned', { date: tomorrow, when: said(tomorrow, '15:00', '16:00'), actor: 'by the office', customer_name: 'Handedover' }, daysAgo(3));
    const cancelled = await makeVisit(tech, 'Cancelled', tomorrow, '16:00', '17:00', { status: 'cancelled', cancelled_at: daysAgo(1) });
    await card(tech, cancelled, 'visit_assigned', { date: tomorrow, when: said(tomorrow, '16:00', '17:00'), actor: 'by the office', customer_name: 'Cancelled' }, daysAgo(4));
    // A phone-call booking (its card written with the visit), today, unchanged.
    const phoned = await makeVisit(tech, 'Phoned', today, '17:00', '18:00', { source_action: 'ai_call_pipeline' });
    const phonedVisit = await db('scheduled_services').where({ id: phoned }).first('created_at');
    await card(tech, phoned, 'visit_assigned', { date: today, when: said(today, '17:00', '18:00'), actor: 'by the office', customer_name: 'Phoned' }, new Date(phonedVisit.created_at));
    // Far out and unchanged: folded, and counted.
    const later = await makeVisit(tech, 'Later', farOut, '09:00', '10:00');
    await card(tech, later, 'visit_assigned', { date: farOut, when: said(farOut, '09:00', '10:00'), actor: 'by the office', customer_name: 'Later' }, daysAgo(1));

    const body = await call('/schedule-changes', 'get', { technicianId: tech.id });
    const byName = new Map(body.changes.map((c) => [c.payload.customer_name, c]));

    expect([...byName.keys()].sort()).toEqual(['Cancelled', 'Handedover', 'Later', 'Phoned', 'Pulledin', 'Retimed', 'Twice']);
    // Soon cards in visit order: today first, then tomorrow by its hour.
    expect(body.changes.filter((c) => c.soon).map((c) => c.payload.customer_name))
      .toEqual(['Phoned', 'Pulledin', 'Twice', 'Retimed', 'Handedover', 'Cancelled']);
    expect(body.later_total).toBe(1);

    expect(byName.get('Retimed')).toMatchObject({
      type: 'visit_rescheduled',
      payload: { when: said(tomorrow, '13:00', '14:00'), previous_when: said(tomorrow, '11:00', '12:00'), changed_again: true, actor: 'by the office', date: tomorrow },
    });
    expect(byName.get('Retimed').payload.changed_at).toEqual(expect.any(String));
    // An assignment card whose visit moved since reads as a move, its old time struck.
    expect(byName.get('Pulledin')).toMatchObject({
      type: 'visit_rescheduled', soon: true,
      payload: { when: said(tomorrow, '08:00', '09:00'), previous_when: said(farOut, '16:00', '17:00'), changed_again: true, actor: null },
    });
    expect(byName.get('Twice').id).toBe(twiceNewer);
    expect(byName.get('Handedover')).toMatchObject({ type: 'visit_unassigned', payload: { headline: 'Moved off your route', now_with: 'Otherfixture', ended: null } });
    expect(byName.get('Cancelled')).toMatchObject({ type: 'visit_cancelled', payload: { headline: 'Visit cancelled', actor: null } });
    expect(byName.get('Phoned')).toMatchObject({ type: 'visit_assigned', payload: { actor_line: 'Booked from a phone call (AI)' } });
    expect(byName.get('Later')).toMatchObject({ type: 'visit_assigned', soon: false });
    expect(byName.get('Later').payload.changed_again).toBeUndefined();

    // The main feed hides the same cards and reads the rest the same way.
    const feed = await call('/', 'get', { technicianId: tech.id, query: {} });
    const feedNames = feed.notifications.map((n) => n.payload.customer_name).sort();
    expect(feedNames).toEqual(['Cancelled', 'Handedover', 'Later', 'Phoned', 'Pulledin', 'Retimed', 'Twice']);
    expect(feed.notifications.find((n) => n.payload.customer_name === 'Retimed').payload.when).toBe(said(tomorrow, '13:00', '14:00'));
  });

  test('a visit moved off today, then again, keeps one card on top that names today\'s slot; Clear all leaves it', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const nextWeek = et.etDateString(et.addETDays(new Date(), 7));
    const visit = await makeVisit(tech, 'Twomoves', farOut, '09:00', '10:00');
    const offToday = await card(tech, visit, 'visit_rescheduled', { date: nextWeek, previous_date: today, when: formatWhen(nextWeek, '09:00', '10:00'), previous_when: formatWhen(today, '09:00', '10:00'), actor: 'by auto-dispatch', customer_name: 'Twomoves' }, daysAgo(3));
    const later = await card(tech, visit, 'visit_rescheduled', { date: farOut, previous_date: nextWeek, when: formatWhen(farOut, '09:00', '10:00'), previous_when: formatWhen(nextWeek, '09:00', '10:00'), actor: 'by auto-dispatch', customer_name: 'Twomoves' }, daysAgo(2));

    const read = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(read.later_total).toBe(0);
    expect(read.changes).toHaveLength(1);
    expect(read.changes[0]).toMatchObject({
      id: later, soon: true, type: 'visit_rescheduled',
      payload: { previous_when: formatWhen(today, '09:00', '10:00'), when: formatWhen(farOut, '09:00', '10:00') },
    });
    expect(read.changes[0]).not.toHaveProperty('visit_soon_when');

    const result = await call('/dismiss-batch', 'post', { technicianId: tech.id, body: { as_of: read.as_of } });
    expect(result).toEqual({ success: true, dismissed: 0 });
    const stillOpen = await db('tech_notifications').where({ technician_id: tech.id }).whereNull('dismissed_at').pluck('id');
    expect(stillOpen.sort()).toEqual([offToday, later].sort());
  });

  test('a card that took the visit off today, then a move with no card: still on top, "Was" today\'s slot', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const nextWeek = et.etDateString(et.addETDays(new Date(), 7));
    const visit = await makeVisit(tech, 'Silentagain', farOut, '09:00', '10:00');
    await card(tech, visit, 'visit_rescheduled', { date: nextWeek, previous_date: today, when: formatWhen(nextWeek, '09:00', '10:00'), previous_when: formatWhen(today, '09:00', '10:00'), actor: 'by auto-dispatch', customer_name: 'Silentagain' }, daysAgo(3));

    const read = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(read.changes).toHaveLength(1);
    expect(read.changes[0]).toMatchObject({
      soon: true, type: 'visit_rescheduled',
      payload: { previous_when: formatWhen(today, '09:00', '10:00'), when: formatWhen(farOut, '09:00', '10:00'), changed_again: true },
    });
  });

  test('a moved-off card follows its visit: back on this route with no card of its own, or with a new holder', async () => {
    const tech = await makeTech('Fixture Tech');
    const first = await makeTech('Firstholder Hire');
    const second = await makeTech('Secondholder Hire');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const back = await makeVisit(tech, 'Cameback', tomorrow, '11:00', '12:00');
    await card(tech, back, 'visit_unassigned', { date: tomorrow, when: formatWhen(tomorrow, '11:00', '12:00'), headline: 'Moved off your route', now_with: 'Firstholder', actor: 'by the office', customer_name: 'Cameback' }, daysAgo(2));
    const away = await makeVisit(second, 'Stillaway', tomorrow, '12:00', '13:00');
    await card(tech, away, 'visit_unassigned', { date: tomorrow, when: formatWhen(tomorrow, '12:00', '13:00'), headline: 'Moved off your route', now_with: firstNameOf(first), actor: 'by the office', customer_name: 'Stillaway' }, daysAgo(2));
    // Back on this route and already reached: nothing left to say.
    const reached = await makeVisit(tech, 'Reachedback', today, '09:00', '10:00', { status: 'on_site', arrived_at: new Date() });
    await card(tech, reached, 'visit_unassigned', { date: today, when: formatWhen(today, '09:00', '10:00'), headline: 'Moved off your route', now_with: 'Firstholder', actor: 'by the office', customer_name: 'Reachedback' }, daysAgo(2));

    const body = await call('/schedule-changes', 'get', { technicianId: tech.id });
    const byName = new Map(body.changes.map((c) => [c.payload.customer_name, c]));
    expect([...byName.keys()].sort()).toEqual(['Cameback', 'Stillaway']);
    expect(byName.get('Cameback')).toMatchObject({ type: 'visit_assigned', payload: { headline: 'Back on your route', now_with: null } });
    expect(byName.get('Stillaway')).toMatchObject({ type: 'visit_unassigned', payload: { now_with: 'Secondholder' } });
  });

  test('Clear all never takes a card the read showed on its own, even after a move took its visit off today', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    // A far-dated card whose visit moved onto today with no card: shown on top.
    const visit = await makeVisit(tech, 'Ontoday', today, '15:00', '16:00');
    const shownOnTop = await card(tech, visit, 'visit_assigned', { date: farOut, when: formatWhen(farOut, '15:00', '16:00'), actor: 'by the office', customer_name: 'Ontoday' }, daysAgo(4));
    const read = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(read.changes.map((c) => [c.id, c.soon])).toEqual([[shownOnTop, true]]);

    // Another quiet move takes it off today before the tap.
    await db('scheduled_services').where({ id: visit }).update({ scheduled_date: farOut });
    const result = await call('/dismiss-batch', 'post', { technicianId: tech.id, body: { as_of: read.as_of, keep_ids: [shownOnTop] } });
    expect(result).toEqual({ success: true, dismissed: 0 });
    const stillOpen = await db('tech_notifications').where({ technician_id: tech.id }).whereNull('dismissed_at').pluck('id');
    expect(stillOpen).toEqual([shownOnTop]);
  });

  test('a plan pause\'s skip keeps its cancellation card on the tech\'s route until it is acknowledged', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const visit = await makeVisit(tech, 'Paused', tomorrow, '10:00', '11:00', { status: 'skipped' });
    await card(tech, visit, 'visit_assigned', { date: tomorrow, when: formatWhen(tomorrow, '10:00', '11:00'), actor: 'by the office', customer_name: 'Paused' }, daysAgo(9));
    const skipCard = await card(tech, visit, 'visit_cancelled', { date: tomorrow, when: formatWhen(tomorrow, '10:00', '11:00'), headline: 'Visit cancelled', actor: 'by the customer online', customer_name: 'Paused' }, daysAgo(1));

    const read = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(read.changes).toHaveLength(1);
    expect(read.changes[0]).toMatchObject({ id: skipCard, soon: true, type: 'visit_cancelled', payload: { headline: 'Visit cancelled', actor: 'by the customer online' } });
    const feed = await call('/', 'get', { technicianId: tech.id, query: {} });
    expect(feed.notifications.map((n) => n.id)).toEqual([skipCard]);
  });

  test('Got it clears the visit\'s older open cards too, so none takes its place', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const visit = await makeVisit(tech, 'Gotit', tomorrow, '10:00', '11:00');
    await card(tech, visit, 'visit_assigned', { date: tomorrow, when: formatWhen(tomorrow, '09:00', '10:00'), actor: 'by the office', customer_name: 'Gotit' }, daysAgo(6));
    const newest = await card(tech, visit, 'visit_rescheduled', { date: tomorrow, when: formatWhen(tomorrow, '10:00', '11:00'), actor: 'by the office', customer_name: 'Gotit' }, daysAgo(1));

    await call(`/:id/dismiss`, 'post', { technicianId: tech.id, params: { id: newest } });

    const open = await db('tech_notifications').where({ technician_id: tech.id }).whereNull('dismissed_at').count('* as n');
    expect(Number(open[0].n)).toBe(0);
    const body = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(body.changes).toEqual([]);
  });

  test('Clear all clears the folded cards it showed and their visits\' older cards; today/tomorrow cards stay', async () => {
    const tech = await makeTech('Fixture Tech');
    const { formatWhen } = require('../services/tech-visit-notifications');
    const far = await makeVisit(tech, 'Farvisit', farOut, '09:00', '10:00');
    const olderFar = await card(tech, far, 'visit_assigned', { date: farOut, when: formatWhen(farOut, '08:00', '09:00'), actor: 'by the office', customer_name: 'Farvisit' }, daysAgo(9));
    await card(tech, far, 'visit_rescheduled', { date: farOut, when: formatWhen(farOut, '09:00', '10:00'), actor: 'by the office', customer_name: 'Farvisit' }, daysAgo(3));
    const near = await makeVisit(tech, 'Nearvisit', tomorrow, '09:00', '10:00');
    const nearCard = await card(tech, near, 'visit_assigned', { date: tomorrow, when: formatWhen(tomorrow, '09:00', '10:00'), actor: 'by the office', customer_name: 'Nearvisit' }, daysAgo(2));

    const read = await call('/schedule-changes', 'get', { technicianId: tech.id });
    expect(read.later_total).toBe(1);
    const result = await call('/dismiss-batch', 'post', { technicianId: tech.id, body: { as_of: read.as_of } });

    expect(result).toEqual({ success: true, dismissed: 2 });
    const stillOpen = await db('tech_notifications').where({ technician_id: tech.id }).whereNull('dismissed_at').pluck('id');
    expect(stillOpen).toEqual([nearCard]);
    expect(stillOpen).not.toContain(olderFar);
  });
});
