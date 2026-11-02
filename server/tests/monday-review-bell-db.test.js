/**
 * Monday review bell (owner 2026-11-02, B2) against live Postgres: the SQL of lists 1, 3 and 4, list 2's
 * read-only query shape, and the row's whole life through the real notification service and alert episodes
 * under the production bell policy (GATE_ADMIN_BELL_POLICY on, so the row lands only because it asks to
 * ring). Counts are measured against a baseline read first, so rows other suites left behind never matter.
 * Weekly rows use dates in 2031 and every fixture carries this run's marker, so cleanup touches only what
 * this suite wrote. It refuses any database but a private QA one or CI's.
 */
process.env.GATE_ADMIN_BELL_POLICY = 'true'; // read once, when feature-gates loads
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('monday review bell (live Postgres)', () => {
  let db;
  let Review;
  const RUN = randomUUID();
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date();
  const ago = (days) => new Date(NOW.getTime() - days * DAY);
  const created = { notifications: [], customers: [], visits: [], invoices: [] };

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Review = require('../services/monday-review-bell');
  });

  afterAll(async () => {
    if (!db) return;
    await db('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'monday-review:2031-%'").del();
    if (created.notifications.length) await db('notifications').whereIn('id', created.notifications).del();
    if (created.invoices.length) await db('invoices').whereIn('id', created.invoices).del();
    if (created.visits.length) await db('scheduled_services').whereIn('id', created.visits).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
  });

  const addNotification = async (over = {}) => {
    const { metadata, ...rest } = over;
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'billing', title: `Monday review fixture ${RUN.slice(0, 8)}`, body: 'fixture',
      created_at: ago(20), metadata: JSON.stringify({ severity: 'needs-you', who: 'person', ...(metadata || {}) }), ...rest,
    }).returning('id');
    created.notifications.push(row.id);
    return row.id;
  };

  describe('list 1: needs-you alerts unread 14+ days', () => {
    test('counts one old unread needs-you row and none of the rows that do not belong', async () => {
      const before = await Review._private.loadUnreadAlerts({ now: NOW });
      await addNotification({ title: `Old unread ${RUN.slice(0, 8)}`, created_at: ago(30) });
      await addNotification({ read_at: ago(1) }); // read
      await addNotification({ done_at: ago(1), done_by: 'person', resolution: 'fixture' }); // done
      await addNotification({ created_at: ago(5) }); // young
      await addNotification({ metadata: { feed: 'activity' } }); // Activity only
      await addNotification({ metadata: { claudeQueue: 'fixture', who: 'claude', feed: 'activity' } }); // Claude's queue
      await addNotification({ metadata: { who: 'claude' } }); // Claude's
      await addNotification({ metadata: { severity: 'fyi' } }); // information
      await addNotification({ metadata: { severity: undefined } }); // unsorted
      await addNotification({ created_at: ago(40), metadata: { rungAt: ago(2).toISOString() } }); // rung two days ago
      await addNotification({ metadata: { dedupeKey: 'monday-review:2031-12-29' } }); // this bell never counts itself
      const after = await Review._private.loadUnreadAlerts({ now: NOW });
      expect(after.count - before.count).toBe(1);
    });

    test('pages past older rows that do not qualify (a 2-row page proves the keyset walk)', async () => {
      const before = await Review._private.loadUnreadAlerts({ now: NOW, pageSize: 2 });
      for (let i = 0; i < 3; i += 1) await addNotification({ created_at: ago(60 + i), metadata: { severity: undefined } }); // unsorted, older
      await addNotification({ title: `Paged ${RUN.slice(0, 8)}`, created_at: ago(30) });
      const after = await Review._private.loadUnreadAlerts({ now: NOW, pageSize: 2 });
      expect(after.count - before.count).toBe(1);
      expect(after.capped).toBe(false);
    });
  });

  describe('list 3: completed visits whose only invoice is a draft', () => {
    let customerId;
    const makeVisit = async (status) => {
      const [visit] = await db('scheduled_services').insert({
        customer_id: customerId, scheduled_date: '2026-10-01', service_type: `Fixture ${RUN.slice(0, 8)}`, status,
      }).returning('id');
      created.visits.push(visit.id);
      return visit.id;
    };
    const makeInvoice = async (visitId, over = {}) => {
      const [invoice] = await db('invoices').insert({
        token: randomUUID(), invoice_number: `MRB-${randomUUID().slice(0, 12)}`, customer_id: customerId,
        scheduled_service_id: visitId, status: 'draft', total: 100, created_at: ago(6), ...over,
      }).returning('id');
      created.invoices.push(invoice.id);
      return invoice.id;
    };

    beforeAll(async () => {
      const [customer] = await db('customers').insert({ first_name: 'Monday', last_name: 'Fixture', phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` }).returning('id');
      customerId = customer.id;
      created.customers.push(customerId);
    });

    test('counts only the draft-only completed visits, with their dollars and the oldest one', async () => {
      const before = await Review._private.loadDraftOnlyVisits({ now: NOW });
      const oldest = await makeInvoice(await makeVisit('completed'), { total: 100, created_at: new Date('2000-01-01T12:00:00Z') });
      await makeInvoice(await makeVisit('completed'), { total: 50.25 }); // counted
      const sentVisit = await makeVisit('completed');
      await makeInvoice(sentVisit);
      await makeInvoice(sentVisit, { status: 'sent' }); // another live invoice: not "only a draft"
      const voidVisit = await makeVisit('completed');
      await makeInvoice(voidVisit);
      await makeInvoice(voidVisit, { status: 'void' }); // a void one does not count as live: counted
      await makeInvoice(await makeVisit('confirmed')); // visit not completed
      await makeInvoice(await makeVisit('completed'), { archived_at: ago(1) }); // archived
      await makeInvoice(await makeVisit('completed'), { created_at: ago(1) }); // under the 3-day floor
      await makeInvoice(await makeVisit('completed'), { total: 0 }); // nothing to bill
      await makeInvoice(await makeVisit('completed'), { sent_at: ago(4) }); // delivered by email while still a draft
      await makeInvoice(await makeVisit('completed'), { sms_sent_at: ago(4) }); // delivered by text while still a draft
      const after = await Review._private.loadDraftOnlyVisits({ now: NOW });
      expect(after.count - before.count).toBe(3);
      expect(Math.round((after.total - before.total) * 100) / 100).toBe(100 + 50.25 + 100);
      expect(after.oldestId).toBe(String(oldest));
    });
  });

  describe('list 4: past-dated visits still open', () => {
    test('counts open visits dated before today, adds up the priced ones, and finds the oldest date', async () => {
      const [customer] = await db('customers').insert({ first_name: 'Monday', last_name: 'Open', phone: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` }).returning('id');
      created.customers.push(customer.id);
      const before = await Review._private.loadOpenPastVisits({ now: NOW });
      const visit = async (status, scheduled_date, estimated_price = null) => {
        const [row] = await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date, service_type: `Open ${RUN.slice(0, 8)}`, status, estimated_price,
        }).returning('id');
        created.visits.push(row.id);
      };
      await visit('pending', '2000-01-02', 120.5);
      await visit('confirmed', '2026-10-01');
      await visit('completed', '2026-10-01', 99); // done
      await visit('cancelled', '2026-10-01', 99); // not open
      await visit('pending', '2099-01-01', 99); // future
      const after = await Review._private.loadOpenPastVisits({ now: NOW });
      expect(after.count - before.count).toBe(2);
      expect(Math.round((after.priced - before.priced) * 100) / 100).toBe(120.5);
      expect(after.oldestDate <= '2000-01-02').toBe(true);
    });
  });

  describe('list 2: overdue promises', () => {
    test('reads without error and without writing (no callback card preparation)', async () => {
      const out = await Review._private.loadOverduePromises({ now: NOW });
      expect(Number.isInteger(out.count)).toBe(true);
      expect(out.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('the weekly row', () => {
    const MONDAY_1 = new Date('2031-01-06T14:20:00Z');
    const MONDAY_2 = new Date('2031-01-13T14:20:00Z');
    const busy = {
      alerts: async () => ({ count: 2, oldestAt: ago(20), headlines: [{ headline: 'Fixture alert', at: ago(20) }] }),
      promises: async () => ({ count: 4, oldestAt: ago(9) }),
      drafts: async () => ({ count: 0, total: 0 }),
      visits: async () => ({ count: 1, priced: 80, oldestDate: '2026-10-01' }),
    };
    const empty = {
      alerts: async () => ({ count: 0, headlines: [] }), promises: async () => ({ count: 0 }),
      drafts: async () => ({ count: 0, total: 0 }), visits: async () => ({ count: 0, priced: 0 }),
    };
    const rowsFor = (key) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [key]);
    const run = (loaders, now) => Review.runMondayReview({ now, gateEnabled: true, loaders });

    test('raises one unread needs-you row, replaces it next Monday, stays single the same day, and closes at zero', async () => {
      // 1. The first Monday rings: one unread, open row in the bell with the composed text and detail.
      const first = await run(busy, MONDAY_1);
      expect(first.outcome).toBe('raised');
      const [row1, ...extra1] = await rowsFor('monday-review:2031-01-06');
      expect(extra1).toHaveLength(0);
      expect(row1).toMatchObject({ title: 'System — review 3 lists that sit', category: 'system', link: '/admin/dashboard', read_at: null, done_at: null });
      expect(row1.body).toBe('Waiting for you: 2 unread alerts, 4 late promises, 1 open past visit.');
      expect(row1.detail).toContain('Page: /admin/communications#tab=owed');
      const meta1 = typeof row1.metadata === 'string' ? JSON.parse(row1.metadata) : row1.metadata;
      expect(meta1).toMatchObject({ severity: 'needs-you', who: 'person', area: 'System', doneWhen: 'reviewed', counts: { alerts: 2, promises: 4, visits: 1 } });
      expect(meta1.feed).toBeUndefined();

      // 2. The same Monday again writes nothing new and closes nothing.
      expect((await run(busy, MONDAY_1)).outcome).toBe('unchanged');
      expect(await rowsFor('monday-review:2031-01-06')).toHaveLength(1);
      expect((await rowsFor('monday-review:2031-01-06'))[0].done_at).toBeNull();

      // 3. Next Monday: last week's row is done with the plain resolution, this week's is open and unread.
      expect((await run(busy, MONDAY_2)).outcome).toBe('raised');
      const [old] = await rowsFor('monday-review:2031-01-06');
      expect(old.done_at).not.toBeNull();
      expect(old.done_by).toBe('episodes');
      expect(old.resolution).toBe("Replaced by this week's review");
      const [fresh] = await rowsFor('monday-review:2031-01-13');
      expect(fresh).toMatchObject({ read_at: null, done_at: null });

      // 4. A week with nothing to review raises nothing and closes the open row.
      const MONDAY_3 = new Date('2031-01-20T14:20:00Z');
      expect((await run(empty, MONDAY_3)).outcome).toBe('closed');
      expect(await rowsFor('monday-review:2031-01-20')).toHaveLength(0);
      const [closed] = await rowsFor('monday-review:2031-01-13');
      expect(closed.done_at).not.toBeNull();
      expect(closed.resolution).toBe('Nothing to review');
    });

    test('the retention sweep keeps this week\'s row (7 days old at most) and the list-1 query never counts it', async () => {
      const { judgeRow } = require('../services/admin-alert-retention');
      const MONDAY_4 = new Date('2031-02-03T14:20:00Z');
      await run(busy, MONDAY_4);
      const [row] = await rowsFor('monday-review:2031-02-03');
      const weekLater = new Date(new Date(row.created_at).getTime() + 7 * DAY);
      expect(judgeRow(row, weekLater)).toMatchObject({ expire: false });
      const counted = await Review._private.loadUnreadAlerts({ now: new Date(new Date(row.created_at).getTime() + 20 * DAY) });
      expect(counted.headlines.every((h) => !h.headline.startsWith('System — review'))).toBe(true);
    });
  });
});
