/**
 * admin-alert-relevance.js against live Postgres: the re-arm pass's SQL as
 * the sweep runs it — this module's stamp and its window, the put-back fenced
 * on the version read (a millisecond read_at compared exactly), and the jsonb
 * key removal that puts a row quieted at ring time onto the bell. The rules
 * themselves are covered by admin-alert-relevance.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('alert relevance re-arm (live Postgres)', () => {
  let db;
  let relevance;
  const made = { notifications: [], scheduled_services: [], leads: [], customers: [] };

  beforeAll(() => {
    db = require('../models/db');
    relevance = require('../services/admin-alert-relevance');
  });
  afterAll(async () => {
    for (const table of ['notifications', 'scheduled_services', 'leads', 'customers']) {
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

  test('puts back what it retired or quieted in the window once the subject is relevant again; older retirements are final', async () => {
    const now = new Date();
    // Millisecond-exact, as the sweep writes it.
    const readAt = new Date(now.getTime() - 60 * 60 * 1000);
    const customer = await insert('customers', { first_name: 'Rearm', phone: '+15555557001' });
    const visit = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: '2026-12-01', service_type: 'General Pest Control', status: 'pending',
    });
    const lead = await insert('leads', { first_name: 'Rearm', phone: '+15555557001', status: 'new' });

    // A stale-visit bell the sweep retired whose visit is open again.
    const reopened = await bell({ category: 'alert', read_at: readAt,
      metadata: { dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id, ...stamp('Visit is no longer open', new Date(now.getTime() - DAY)) } });
    // The same, retired before the window: final.
    const final = await bell({ category: 'alert', read_at: readAt,
      metadata: { dedupeKey: `stale-visit:${visit.id}:old`, scheduled_service_id: visit.id, ...stamp('Visit is no longer open', new Date(now.getTime() - 20 * DAY)) } });
    // A new-lead bell quieted at ring time whose lead is new again.
    const quieted = await bell({ category: 'new_lead', link: `/admin/leads?lead=${lead.id}`,
      metadata: { triggerKey: 'new_lead', payload: { leadId: lead.id }, quiet: true, feed: 'activity', ...stamp('Lead is duplicate', new Date(now.getTime() - DAY)) } });

    const result = await relevance.runAdminAlertRelevanceSweep({ now });
    expect(result.rearmed).toBeGreaterThanOrEqual(2);
    // Unread again, and the retire pass right after left it: the visit is open.
    const back = await get(reopened.id);
    expect(back.read_at).toBeNull();
    expect(back.metadata).toEqual({ dedupeKey: `stale-visit:${visit.id}`, scheduled_service_id: visit.id });
    expect((await get(quieted.id)).metadata).toEqual({ triggerKey: 'new_lead', payload: { leadId: lead.id } });
    const kept = await get(final.id);
    expect(kept.read_at).toEqual(readAt);
    expect(kept.metadata.retired).toMatchObject({ by: 'alert-relevance' });

    // Moved on again: the next sweep retires the bell once more.
    await db('scheduled_services').where({ id: visit.id }).update({ status: 'completed' });
    await relevance.runAdminAlertRelevanceSweep({ now: new Date() });
    const again = await get(reopened.id);
    expect(again.read_at).toBeInstanceOf(Date);
    expect(again.metadata.retired).toMatchObject({ by: 'alert-relevance', reason: 'Visit is no longer open' });
  });
});
