/**
 * The admin bell's daily ring budget against live Postgres (GATE_ALERT_RING_BUDGET): the day count across Eastern midnight
 * and the fall-back day, the 11th row held out of the bell list, the one count row (first write rings, later writes are
 * quiet), a held row's refresh, a write on a caller's transaction, and the Activity feed's held source. The exemption
 * lists and the decision rules are in alert-ring-budget.test.js (no database).
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('daily ring budget (live Postgres)', () => {
  let db;
  let NotificationService;
  let budget;
  let activity;
  let etDateString;
  const RUN = `ring-budget-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const made = [];
  const FAR_DAY_PREFIX = '2031-';

  const bellRows = (ids) => NotificationService._private.excludeActivityOnlyFromBell(
    db('notifications').where({ recipient_type: 'admin' }).whereIn('id', ids));
  const get = (id) => db('notifications').where({ id }).first();
  const write = async (name, over = {}) => {
    const row = await NotificationService.create({
      recipientType: 'admin', category: 'inventory', title: `${RUN} ${name}`, body: 'Fixture body.', link: '/admin/inventory', metadata: { fixture: RUN }, ...over,
    });
    if (row?.id) made.push(row.id);
    return row;
  };
  const countRow = (day) => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${day}`]).first();
  const clearToday = async () => {
    const day = etDateString();
    await db('notifications').where({ recipient_type: 'admin' })
      .where((q) => q.whereRaw("metadata->>'ringBudgetDay' = ?", [day]).orWhereRaw("metadata->>'ringBudgetHeld' = ?", [day]).orWhereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${day}`]))
      .del();
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("starts_with(metadata->>'ringBudgetDay', ?)", [FAR_DAY_PREFIX]).del();
  };
  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(() => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    budget = require('../services/alert-ring-budget');
    activity = require('../services/agent-activity');
    ({ etDateString } = require('../utils/datetime-et'));
  });
  beforeEach(async () => {
    process.env.GATE_ALERT_RING_BUDGET = 'true';
    await clearToday();
  });
  afterAll(async () => {
    delete process.env.GATE_ALERT_RING_BUDGET;
    await db('notifications').whereIn('id', made).del();
    await clearToday();
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'fixture' = ?", [RUN]).del();
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("starts_with(metadata->>'ringBudgetDay', ?)", [FAR_DAY_PREFIX]).del();
    await db.destroy();
  });

  test('the day count follows Eastern midnight: 11:59 PM and 12:00 AM are different days, and the 25-hour fall-back day is one day', async () => {
    // 2031-11-02 is the fall-back Sunday: 12:00 AM EDT = 04:00Z, 1:30 AM happens twice, 12:00 AM EST on the 3rd = 05:00Z on the 3rd.
    const instants = [
      '2031-11-02T04:00:30Z', '2031-11-02T05:30:00Z', '2031-11-02T06:30:00Z', '2031-11-02T12:00:00Z',
      '2031-11-02T18:00:00Z', '2031-11-02T22:00:00Z', '2031-11-03T01:00:00Z', '2031-11-03T02:00:00Z',
      '2031-11-03T03:00:00Z', '2031-11-03T04:30:00Z',
    ];
    const ids = [];
    for (const iso of instants) {
      const verdict = await budget.applyBudget({ connection: db, category: 'inventory', metadata: { fixture: RUN }, now: new Date(iso) });
      expect(verdict).toMatchObject({ outcome: 'ring', day: '2031-11-02' });
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'inventory', title: `${RUN} far day`, body: 'x', metadata: JSON.stringify(verdict.metadata),
      }).returning('id');
      ids.push(row.id);
      made.push(row.id);
    }
    // Ten rings on the fall-back day: one minute before Eastern midnight is still that day, and is held.
    const late = await budget.applyBudget({ connection: db, category: 'inventory', metadata: { fixture: RUN }, now: new Date('2031-11-03T04:59:30Z') });
    expect(late).toMatchObject({ outcome: 'hold', day: '2031-11-02' });
    // One minute after midnight is the next day, with its own budget.
    const next = await budget.applyBudget({ connection: db, category: 'inventory', metadata: { fixture: RUN }, now: new Date('2031-11-03T05:00:30Z') });
    expect(next).toMatchObject({ outcome: 'ring', day: '2031-11-03', metadata: { ringBudgetDay: '2031-11-03' } });
  });

  test('the 11th non-customer row is held out of the bell list; the bell shows ten rings and the one count row', async () => {
    const rows = [];
    for (let i = 0; i < 12; i += 1) rows.push(await write(`row ${i}`, { metadata: { fixture: RUN, n: i } }));
    const day = etDateString();
    const stored = await Promise.all(rows.map((r) => get(r.id)));
    expect(stored.slice(0, 10).every((r) => r.metadata.ringBudgetDay === day && !r.metadata.feed)).toBe(true);
    expect(stored.slice(10).every((r) => r.metadata.ringBudgetHeld === day && r.metadata.feed === 'activity' && r.metadata.quiet === true && !r.metadata.ringBudgetDay)).toBe(true);

    const count = await waitFor(() => countRow(day));
    expect(count).toBeTruthy();
    made.push(count.id);
    const ids = rows.map((r) => r.id).concat(count.id);
    const inBell = (await bellRows(ids).select('id')).map((r) => r.id);
    expect(inBell.sort()).toEqual(rows.slice(0, 10).map((r) => r.id).concat(count.id).sort());
    // The list the bell shows never carries a held row.
    const listed = (await NotificationService.getAdminNotifications(500, 0, {})).map((r) => r.id);
    expect(listed).toEqual(expect.arrayContaining(rows.slice(0, 10).map((r) => r.id).concat(count.id)));
    for (const held of rows.slice(10)) expect(listed).not.toContain(held.id);
  });

  test('the count row: one per day, rings once, then refreshes its count and list quietly; it is never counted', async () => {
    const day = etDateString();
    const rows = [];
    for (let i = 0; i < 11; i += 1) rows.push(await write(`row ${i}`));
    let count = await waitFor(() => countRow(day));
    made.push(count.id);
    expect(count).toMatchObject({ category: 'system', title: 'System — 1 more alert held today', link: '/admin/agents?tab=activity', read_at: null, done_at: null });
    expect(count.metadata).toMatchObject({ ringBudget: 'count', severity: 'fyi', who: 'person', area: 'System', heldCount: 1 });
    expect(count.metadata).not.toHaveProperty('ringBudgetDay');
    expect(count.metadata.feed).toBeUndefined();
    expect(count.detail.split('\n')).toHaveLength(1);
    expect(count.detail).toContain(`${RUN} row 10`);

    // The owner reads it; two more held alerts must not ring it again.
    await db('notifications').where({ id: count.id }).update({ read_at: db.fn.now() });
    rows.push(await write('row 11'));
    rows.push(await write('row 12'));
    count = await waitFor(async () => {
      const row = await countRow(day);
      return row.title === 'System — 3 more alerts held today' ? row : null;
    });
    expect(count).toBeTruthy();
    expect(count.read_at).not.toBeNull();
    expect(count.detail.split('\n')).toHaveLength(3);
    expect(count.metadata.heldCount).toBe(3);
    expect(count.metadata.rungAt).toBeUndefined();
    const all = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${day}`]);
    expect(all).toHaveLength(1);
    // Not counted against the budget: ten stamped rings, none of them the count row.
    const stamped = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'ringBudgetDay' = ?", [day]).count('* as n').first();
    expect(Number(stamped.n)).toBe(10);
  });

  test('customer contact, a promise and a dispatch notice past the budget still ring, unstamped', async () => {
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    const sms = await write('text', { category: 'inbound_sms', metadata: { fixture: RUN } });
    const promise = await write('promise', { category: 'alert', metadata: { fixture: RUN, promise: true } });
    const dispatch = await write('dispatch', { category: 'schedule_conflict', metadata: { fixture: RUN, dedupeKey: `auto-dispatch-needs-person:${RUN}:2031-01-01` } });
    for (const row of [sms, promise, dispatch]) {
      const stored = await get(row.id);
      expect(stored.metadata.feed).toBeUndefined();
      expect(stored.metadata.ringBudgetDay).toBeUndefined();
      expect(stored.metadata.ringBudgetHeld).toBeUndefined();
    }
  });

  test('time-critical field work after ten rings still rings, also when a quiet held row of the same key becomes urgent', async () => {
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    const urgent = await write('urgent', { category: 'alert', metadata: { fixture: RUN, opsKey: 'combined-booking-check', timeCritical: true } });
    const stored = await get(urgent.id);
    expect(stored.metadata.feed).toBeUndefined();
    expect(stored.metadata.ringBudgetHeld).toBeUndefined();
    expect(stored.metadata.ringBudgetDay).toBeUndefined();

    // A non-urgent row of one key is held; the next emission is urgent: it rings into the bell and loses the held stamp.
    const key = `${RUN}:cbc`;
    const opts = (metadata) => ({ link: '/admin/inventory', dedupeKey: key, refreshOnDedupe: true, metadata: { fixture: RUN, ...metadata }, bell: true });
    const held = await NotificationService.notifyAdmin('alert', `${RUN} cbc`, 'Later.', opts({}));
    made.push(held.id);
    expect((await get(held.id)).metadata.ringBudgetHeld).toBe(etDateString());
    const again = await NotificationService.notifyAdmin('alert', `${RUN} cbc`, 'Now due today.', opts({ timeCritical: true }));
    expect(again).toMatchObject({ refreshed: true, rung: true });
    const after = await get(held.id);
    expect(after.metadata.ringBudgetHeld).toBeUndefined();
    expect(after.metadata.feed).toBeNull();
    expect(await bellRows([held.id]).select('id')).toHaveLength(1);
  });

  test('a held keyed row refreshes quietly the same day: its words change in Activity, it never rings into the bell', async () => {
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    const key = `${RUN}:keyed`;
    const first = await NotificationService.notifyAdmin('inventory', `${RUN} keyed`, 'First words.', {
      link: '/admin/inventory', dedupeKey: key, refreshOnDedupe: true, metadata: { fixture: RUN },
    });
    made.push(first.id);
    expect((await get(first.id)).metadata.ringBudgetHeld).toBe(etDateString());
    const second = await NotificationService.notifyAdmin('inventory', `${RUN} keyed`, 'Second words.', {
      link: '/admin/inventory', dedupeKey: key, refreshOnDedupe: true, metadata: { fixture: RUN },
    });
    expect(second).toMatchObject({ refreshed: true, rung: false });
    const stored = await get(first.id);
    expect(stored.body).toBe('Second words.');
    expect(stored.read_at).toBeNull();
    expect(stored.metadata).toMatchObject({ feed: 'activity', quiet: true, ringBudgetHeld: etDateString() });
    expect(budget.isHeld(second)).toBe(true);
    expect(await bellRows([first.id]).select('id')).toHaveLength(0);
    // The first write ran on notifyAdmin's own transaction, so its count row came after the commit.
    const count = await waitFor(() => countRow(etDateString()));
    expect(count).toBeTruthy();
    made.push(count.id);
  });

  test('a write on a caller\'s transaction: the count row waits for the commit; a rollback leaves none', async () => {
    const day = etDateString();
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    await expect(db.transaction(async (trx) => {
      const row = await NotificationService.create({
        recipientType: 'admin', category: 'inventory', title: `${RUN} rolled back`, body: 'x', metadata: { fixture: RUN }, connection: trx,
      });
      expect(budget.isHeld(row)).toBe(true);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await new Promise((r) => setTimeout(r, 150));
    expect(await countRow(day)).toBeUndefined();

    let heldId;
    await db.transaction(async (trx) => {
      const row = await NotificationService.create({
        recipientType: 'admin', category: 'inventory', title: `${RUN} committed`, body: 'x', metadata: { fixture: RUN }, connection: trx,
      });
      heldId = row.id;
      made.push(row.id);
      expect(await countRow(day)).toBeUndefined();
    });
    const count = await waitFor(() => countRow(day));
    expect(count).toBeTruthy();
    made.push(count.id);
    expect(count.title).toBe('System — 1 more alert held today');
    expect(heldId).toBeTruthy();
  });

  test('gate off: nothing is stamped or held, however many rows', async () => {
    process.env.GATE_ALERT_RING_BUDGET = '';
    const rows = [];
    for (let i = 0; i < 13; i += 1) rows.push(await write(`row ${i}`));
    for (const row of rows) {
      const stored = await get(row.id);
      expect(stored.metadata).toEqual({ fixture: RUN });
    }
    expect(await countRow(etDateString())).toBeUndefined();
  });

  test('the Activity feed lists held alerts and leaves out the count row, ops digests and Claude\'s queue', async () => {
    const day = etDateString();
    const rows = [];
    for (let i = 0; i < 12; i += 1) rows.push(await write(`row ${i}`));
    const count = await waitFor(() => countRow(day));
    made.push(count.id);
    const since = new Date(Date.now() - 3600 * 1000);
    const loaded = await activity._private.loadHeldRows(db, since, null, true);
    const ids = loaded.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(rows.slice(10).map((r) => r.id)));
    expect(ids).not.toContain(count.id);
    for (const row of rows.slice(0, 10)) expect(ids).not.toContain(row.id);
    const feed = activity.buildActivity({ held: loaded.filter((r) => rows.slice(10).some((h) => h.id === r.id)) });
    expect(feed.items.map((i) => i.agent)).toEqual(['Held alerts', 'Held alerts']);
    expect(feed.items[0].subtitle).toMatch(/held past the daily limit/);
  });
});
