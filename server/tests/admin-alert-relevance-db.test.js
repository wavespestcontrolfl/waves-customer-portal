/**
 * admin-alert-relevance.js against live Postgres, the SQL as the sweep runs
 * it: the re-arm pass (this module's stamp and its window, the put-back fenced
 * on the version read — a millisecond done_at compared exactly) and a new
 * lead's booking evidence (after the bell, never a visit that did not run).
 * The rules themselves are covered by admin-alert-relevance.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const { etDateString } = require('../utils/datetime-et');

const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('alert relevance re-arm (live Postgres)', () => {
  let db;
  let relevance;
  const made = { notifications: [], scheduled_services: [], estimates: [], leads: [], customers: [] };

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
  });
  afterAll(async () => {
    for (const table of ['notifications', 'scheduled_services', 'leads', 'estimates', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  });

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const bell = (row) => insert('notifications', { recipient_type: 'admin', title: 'Fixture alert', ...row, metadata: JSON.stringify(row.metadata) });
  const stamp = (reason, at) => ({ retired: { by: 'alert-relevance', reason, at: at.toISOString() } });
  const get = (id) => db('notifications').where({ id }).first();

  test('takes over a person\'s Done once its subject moved on (no Reopen), fenced on that exact close; one still relevant stays theirs', async () => {
    const now = new Date();
    const customer = await insert('customers', { first_name: 'Takeover', phone: '+15555557009' });
    const pastDay = etDateString(new Date(now.getTime() - 3 * DAY));
    const done = await insert('scheduled_services', { customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'completed' });
    const stuck = await insert('scheduled_services', { customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'on_site' });
    const person = '0b1f6c1e-3c64-4f8e-9d7a-5a2f3e9b1c10';
    const at = new Date(now.getTime() - 60 * 60 * 1000);
    const movedOn = await bell({ category: 'alert', read_at: at, done_at: at, done_by: person, resolution: 'Called the tech',
      metadata: { dedupeKey: `stale-visit:${done.id}:takeover`, scheduled_service_id: done.id } });
    const stillStale = await bell({ category: 'alert', read_at: at, done_at: at, done_by: person, resolution: 'On it',
      metadata: { dedupeKey: `stale-visit:${stuck.id}:takeover`, scheduled_service_id: stuck.id } });

    await relevance.runAdminAlertRelevanceSweep({ now });

    const a = await get(movedOn.id);
    expect(a.done_by).toBe('relevance');
    expect([a.done_at.getTime(), a.resolution, a.read_at.getTime()]).toEqual([at.getTime(), 'Called the tech', at.getTime()]);
    expect(JSON.parse(JSON.stringify(a.metadata)).retired).toBeUndefined();
    const NotificationService = require('../services/notification-service');
    const token = (await db('notifications').where({ id: movedOn.id }).first(db.raw('done_at::text AS t'))).t;
    expect(await NotificationService.reopenAdminDone(movedOn.id, { expectedDoneAt: token })).toBe('not_reopenable');
    expect((await get(stillStale.id)).done_by).toBe(person);
  });

  test('puts back what it retired in the window once the subject is relevant again (keeping a person\'s read); older retirements, and a person\'s own reopen, are final', async () => {
    const now = new Date();
    // As the sweep writes it: millisecond-exact, and the stamp's `at` is that same done_at (and, on an unread row, read_at).
    const recent = new Date(now.getTime() - DAY);
    const old = new Date(now.getTime() - 20 * DAY);
    const customer = await insert('customers', { first_name: 'Rearm', phone: '+15555557001' });
    // Stale again: from before today (ET), back in on_site.
    const pastDay = etDateString(new Date(now.getTime() - 3 * DAY));
    const visit = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: pastDay, service_type: 'General Pest Control', status: 'on_site',
    });

    // A stale-visit bell the sweep retired whose visit is stuck in progress again.
    const reopened = await bell({ category: 'alert', read_at: recent,
      done_at: recent, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });
    // The same, retired before the window: final.
    const final = await bell({ category: 'alert', read_at: old, done_at: old, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}:old`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', old) } });
    // Retired in the window, then READ by a person (a later read_at than the stamp's): read is not done,
    // so the put-back reopens it, and their read stands.
    const personRead = new Date(now.getTime() - 60 * 60 * 1000);
    const readByPerson = await bell({ category: 'alert', read_at: personRead, done_at: recent, done_by: 'relevance', resolution: 'Visit is no longer in progress',
      metadata: { dedupeKey: `stale-visit:${visit.id}:read`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });
    // Retired in the window, then REOPENED by a person (done cleared, the stamp survives): theirs, never put back or re-retired.
    const reopenedByPerson = await bell({ category: 'alert', read_at: recent,
      metadata: { dedupeKey: `stale-visit:${visit.id}:reopened`, scheduled_service_id: visit.id, ...stamp('Visit is no longer in progress', recent) } });

    const result = await relevance.runAdminAlertRelevanceSweep({ now });
    expect(result.rearmed).toBeGreaterThanOrEqual(1);
    // Unread again, and the retire pass right after left it: the visit is still stale.
    const back = await get(reopened.id);
    expect(back.read_at).toBeNull();
    // A put-back returns the row to the bell: the done fields clear with the read.
    expect([back.done_at, back.done_by, back.resolution]).toEqual([null, null, null]);
    expect(back.metadata).toEqual({ dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id });
    const kept = await get(final.id);
    expect(kept.read_at).toEqual(old);
    expect(kept.done_at).toEqual(old);
    expect(kept.metadata.retired).toMatchObject({ by: 'alert-relevance' });
    const read = await get(readByPerson.id);
    expect(read.read_at).toEqual(personRead);
    expect([read.done_at, read.done_by, read.resolution]).toEqual([null, null, null]);
    expect(read.metadata.retired).toBeUndefined();
    const theirReopen = await get(reopenedByPerson.id);
    expect(theirReopen.done_at).toBeNull();
    expect(theirReopen.read_at).toEqual(recent);
    expect(theirReopen.metadata.retired).toMatchObject({ by: 'alert-relevance' });

    // Moved on again: the next sweep retires the bell once more.
    await db('scheduled_services').where({ id: visit.id }).update({ status: 'completed' });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    const again = await get(reopened.id);
    expect(again.read_at).toBeInstanceOf(Date);
    expect(again.done_at).toBeInstanceOf(Date);
    expect([again.done_by, again.resolution]).toEqual(['relevance', 'Visit is no longer in progress']);
    expect(again.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'Visit is no longer in progress' });
  });

  test('a new-lead bell is judged only by what happened after it: an earlier estimate, a conversion or a booking that never ran does not count, a live booking does', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const customer = await insert('customers', { first_name: 'Lead', phone: '+15555557002' });
    const estimate = await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: new Date(bellAt.getTime() - DAY) });
    // Converted by a booking after the bell — that visit was then a no-show (below).
    const lead = await insert('leads', { first_name: 'Lead', phone: '+15555557002', status: 'estimate_sent', customer_id: customer.id, estimate_id: estimate.id,
      converted_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });
    const leadBell = await bell({ category: 'new_lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
      metadata: { triggerKey: 'new_lead', payload: { leadId: lead.id } } });
    const booked = (status) => insert('scheduled_services', { customer_id: customer.id, scheduled_date: etDateString(new Date(now.getTime() + 7 * DAY)),
      service_type: 'General Pest Control', status, created_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });

    // A status and an estimate from before the bell, a conversion after it, and the visit booked after it a no-show: still relevant.
    await booked('no_show');
    await relevance.runAdminAlertRelevanceSweep({ now });
    const open = await get(leadBell.id);
    expect([open.read_at, open.done_at]).toEqual([null, null]);
    // A live visit booked after the bell: moved on.
    await booked('confirmed');
    await relevance.runAdminAlertRelevanceSweep({ now });
    const retired = await get(leadBell.id);
    expect(retired.read_at).toBeInstanceOf(Date);
    expect(retired.done_at).toBeInstanceOf(Date);
    expect(retired.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'A visit was booked' });
  });

  test('a quote sent to the lead\'s customer after the bell keeps its bell retired when a newer draft takes over the lead\'s estimate pointer', async () => {
    const now = new Date();
    const bellAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const customer = await insert('customers', { first_name: 'Quoted', phone: '+15555557003' });
    const sent = await insert('estimates', { status: 'sent', customer_id: customer.id, sent_at: new Date(bellAt.getTime() + 60 * 60 * 1000) });
    const lead = await insert('leads', { first_name: 'Quoted', phone: '+15555557003', status: 'new', customer_id: customer.id, estimate_id: sent.id });
    const leadBell = await bell({ category: 'new_lead', link: `/admin/leads?lead=${lead.id}`, created_at: bellAt,
      metadata: { triggerKey: 'new_lead', payload: { leadId: lead.id } } });
    await relevance.runAdminAlertRelevanceSweep({ now });
    const retired = await get(leadBell.id);
    expect(retired.metadata.retired).toMatchObject({ reason: 'Estimate was sent' });
    // A newer draft takes over leads.estimate_id; the next run's re-arm pass keeps the retirement.
    const draft = await insert('estimates', { status: 'draft', customer_id: customer.id });
    await db('leads').where({ id: lead.id }).update({ estimate_id: draft.id });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    const kept = await get(leadBell.id);
    expect([kept.read_at, kept.done_at]).toEqual([retired.read_at, retired.done_at]);
  });
});
