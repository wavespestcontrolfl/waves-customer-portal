/**
 * The admin bell's daily ring budget against live Postgres (GATE_ALERT_RING_BUDGET): the day count across Eastern midnight
 * and the fall-back day, the 11th row held out of the bell list, the one count row (first write rings, later writes are
 * quiet), a held row's refresh, a write on a caller's transaction, and the Activity feed's held source. The exemption
 * lists and the decision rules are in alert-ring-budget.test.js (no database).
 */
const SKIP = !process.env.DATABASE_URL;
// A small pool, so a writer that waits for a connection while holding the count row's lock shows up as a hang.
process.env.DB_POOL_MAX = '3';
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('daily ring budget (live Postgres)', () => {
  let db;
  let NotificationService;
  let budget;
  let activity;
  let etDateString;
  const RUN = `ring-budget-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const made = [];

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
  // Rows this suite owns, and only those: its fixture marker, its title prefix, the ids it tracked, and the day's count row (the
  // guard in beforeAll proves none existed before the suite started, so a count row for today is the suite's own).
  const OWN_PREFIX = 'ring-budget-test-';
  const ownRows = () => db('notifications').where({ recipient_type: 'admin' }).where((q) => {
    q.whereRaw("metadata->>'fixture' = ?", [RUN]).orWhereRaw('starts_with(title, ?)', [RUN]).orWhereIn('id', made);
    q.orWhereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${etDateString()}`]);
  });
  const clearOwn = () => ownRows().del();
  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    // The budget counts every stamped row of the day, so this suite needs a database it can own: a private QA database or the
    // isolated CI database (the guard the other *-db suites use).
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database: this suite counts every ring-budget row of the day');
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    budget = require('../services/alert-ring-budget');
    activity = require('../services/agent-activity');
    ({ etDateString } = require('../utils/datetime-et'));
    // Leftovers of an earlier run of this suite are ours by their prefix; anything else already stamped for today is not, and
    // would change every count below, so refuse to run rather than delete it.
    await db('notifications').where({ recipient_type: 'admin' })
      .where((q) => q.whereRaw('starts_with(title, ?)', [OWN_PREFIX]).orWhereRaw("starts_with(metadata->>'fixture', ?)", [OWN_PREFIX])).del();
    const day = etDateString();
    const foreign = await db('notifications').where({ recipient_type: 'admin' })
      .where('created_at', '>', db.raw("now() - interval '40 hours'"))
      .where((q) => q.whereRaw("metadata->>'ringBudgetDay' = ?", [day]).orWhereRaw("metadata->>'ringBudgetHeld' = ?", [day])
        .orWhereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${day}`]))
      .count('* as n').first();
    if (Number(foreign.n) > 0) {
      throw new Error(`This database already holds ${foreign.n} ring-budget rows for today that this suite does not own; use a fresh private QA database`);
    }
  });
  beforeEach(async () => {
    process.env.GATE_ALERT_RING_BUDGET = 'true';
    await clearOwn();
  });
  afterAll(async () => {
    delete process.env.GATE_ALERT_RING_BUDGET;
    if (db) {
      await clearOwn();
      await db.destroy();
    }
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

  test('a count that fails inside a caller\'s transaction is rolled back alone: the row rings as before and the caller\'s own work commits', async () => {
    const { impl } = budget._private;
    const real = impl.countRung;
    // The count runs failing SQL on the connection it is handed (the savepoint), as a statement timeout would. Without the
    // savepoint this aborts the caller's transaction: the insert fails with 25P02 and the commit takes the caller's work down.
    impl.countRung = (conn) => conn.raw('select 1/0');
    let rowId;
    let sideId;
    try {
      await db.transaction(async (trx) => {
        const [side] = await trx('notifications').insert({
          recipient_type: 'admin', category: 'inventory', title: `${RUN} caller work`, body: 'x', metadata: JSON.stringify({ fixture: RUN, feed: 'activity' }),
        }).returning('id');
        sideId = side.id;
        const row = await NotificationService.create({
          recipientType: 'admin', category: 'inventory', title: `${RUN} count fails`, body: 'x', metadata: { fixture: RUN }, connection: trx,
        });
        expect(row && row.id).toBeTruthy();
        rowId = row.id;
      });
    } finally {
      impl.countRung = real;
    }
    made.push(rowId, sideId);
    const written = await get(rowId);
    expect(written).toBeTruthy();
    expect(budget.isHeld(written)).toBe(false);
    expect(await get(sideId)).toBeTruthy();
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

  test('audiences: an owner-only row is never held or copied into the shared count row; technician and non-owner logins see neither held rows nor the count row', async () => {
    const day = etDateString();
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    // An owner-only row past the budget rings as it does without the budget: unstamped, not held.
    const secret = await write('owner secret words', { category: 'alert', metadata: { fixture: RUN, ownerOnly: true } });
    const secretRow = await get(secret.id);
    expect(secretRow.metadata.ringBudgetHeld).toBeUndefined();
    expect(secretRow.metadata.ringBudgetDay).toBeUndefined();
    // A held ordinary row makes the count row; a row stamped held with ownerOnly by other means stays out of its list.
    const ordinary = await write('ordinary held words');
    const [forced] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: `${RUN} forced owner-only held title`, body: 'x',
      metadata: JSON.stringify({ fixture: RUN, ownerOnly: true, feed: 'activity', quiet: true, ringBudgetHeld: day }),
    }).returning('id');
    made.push(forced.id);
    await budget.writeCountRow(day);
    const count = await waitFor(() => countRow(day));
    made.push(count.id);
    expect(count.detail).toContain('ordinary held words');
    expect(count.detail).not.toContain('forced owner-only held title');
    expect(count.detail).not.toContain('owner secret words');
    expect(count.title).toBe('System — 1 more alert held today');

    // Activity "Held alerts": the owner login (fullAccess) sees the forced owner-only row, any other login does not.
    const since = new Date(Date.now() - 3600 * 1000);
    const ownerIds = (await activity._private.loadHeldRows(db, since, null, true)).map((r) => r.id);
    const otherIds = (await activity._private.loadHeldRows(db, since, null, false)).map((r) => r.id);
    expect(ownerIds).toEqual(expect.arrayContaining([forced.id, ordinary.id]));
    expect(otherIds).toContain(ordinary.id);
    expect(otherIds).not.toContain(forced.id);
    // Even a focus id cannot load it for another login.
    expect((await activity._private.loadHeldRows(db, since, forced.id, false)).map((r) => r.id)).not.toContain(forced.id);

    // The bell: a non-owner admin login never lists an owner-only row; a technician login lists neither held rows nor the count row.
    const adminIds = (await NotificationService.getAdminNotifications(500, 0, { role: 'admin' })).map((r) => r.id);
    expect(adminIds).toContain(count.id);
    expect(adminIds).not.toContain(secret.id);
    expect(adminIds).not.toContain(ordinary.id);
    const techIds = (await NotificationService.getAdminNotifications(500, 0, { role: 'technician' })).map((r) => r.id);
    for (const id of [count.id, ordinary.id, secret.id, forced.id]) expect(techIds).not.toContain(id);
  });

  test('a tech-visible trigger row past the budget rings and stays in a technician\'s bell; a non-tech-visible row is held out of it', async () => {
    for (let i = 0; i < 10; i += 1) await write(`fill ${i}`);
    const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
    const techKey = Object.entries(TRIGGER_REGISTRY).find(([, t]) => t.techVisible && !t.rule?.contact && !t.rule?.promise && t.category === 'alert')?.[0] || 'twilio_failure';
    const visible = await write('tech visible', { category: 'alert', metadata: { fixture: RUN, triggerKey: techKey } });
    const stored = await get(visible.id);
    expect(stored.metadata.feed).toBeUndefined();
    expect(stored.metadata.ringBudgetHeld).toBeUndefined();
    const held = await write('not tech visible');
    expect((await get(held.id)).metadata.ringBudgetHeld).toBe(etDateString());
    const techIds = (await NotificationService.getAdminNotifications(500, 0, { role: 'technician' })).map((r) => r.id);
    expect(techIds).toContain(visible.id);
    expect(techIds).not.toContain(held.id);
  });

  test('concurrent count writers all finish: the refresh read runs on the lock holder\'s own transaction, not the pool', async () => {
    const day = etDateString();
    for (let i = 0; i < 3; i += 1) {
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'inventory', title: `${RUN} held ${i}`, body: 'x',
        metadata: JSON.stringify({ fixture: RUN, feed: 'activity', quiet: true, ringBudgetHeld: day }),
      }).returning('id');
      made.push(row.id);
    }
    const results = await Promise.all(Array.from({ length: 12 }, () => budget.writeCountRow(day)));
    expect(results.every(Boolean)).toBe(true);
    const rows = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`ring-budget:${day}`]);
    expect(rows).toHaveLength(1);
    made.push(rows[0].id);
    expect(rows[0].title).toBe('System — 3 more alerts held today');
    expect(rows[0].detail.split('\n')).toHaveLength(3);
  }, 30000);

  test('push-only recipients: within the budget the push goes and counts; past it the push is held and listed as held', async () => {
    const day = etDateString();
    const PushService = require('../services/push-notifications');
    const { triggerNotification } = require('../services/notification-triggers');
    const push = jest.spyOn(PushService, 'sendToAdminUsers').mockResolvedValue({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0, results: [] });
    jest.spyOn(require('../services/admin-unread'), 'getUnreadCountForAdmin').mockResolvedValue({ count: 0, at: Date.now() });
    const admins = await db('technicians').where({ active: true, role: 'admin' }).select('id');
    const prior = await db('notification_preferences').where({ trigger_key: 'dashboard_alert' }).whereIn('admin_user_id', admins.map((a) => a.id));
    await db('notification_preferences').where({ trigger_key: 'dashboard_alert' }).whereIn('admin_user_id', admins.map((a) => a.id)).del();
    // Every admin: bell entries off, phone push on.
    if (admins.length === 0) {
      const [admin] = await db('technicians').insert({ name: 'Synthetic Admin', email: `${RUN}@example.invalid`, password_hash: 'synthetic', role: 'admin', active: true }).returning('id');
      admins.push(admin);
    }
    await db('notification_preferences').insert(admins.map((a) => ({ admin_user_id: a.id, trigger_key: 'dashboard_alert', bell_enabled: false, push_enabled: true, sound_enabled: true })));
    try {
      const fire = (n) => triggerNotification('dashboard_alert', { title: `${RUN} push only ${n}`, message: 'Synthetic' });
      for (let i = 0; i < 10; i += 1) {
        const stats = await fire(i);
        expect(stats).toMatchObject({ bellWritten: false });
        expect(stats.ringBudgetHeld).toBeUndefined();
      }
      expect(push).toHaveBeenCalledTimes(10);
      const counted = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'ringBudgetDay' = ?", [day]);
      expect(counted).toHaveLength(10);
      for (const row of counted) {
        made.push(row.id);
        expect(row.metadata).toMatchObject({ feed: 'activity', quiet: true, ringBudgetPushOnly: true });
      }
      expect(await bellRows(counted.map((r) => r.id)).select('id')).toHaveLength(0);

      const eleventh = await fire(10);
      expect(eleventh).toMatchObject({ ringBudgetHeld: true, push: { sent: 0, skipped: 'ring_budget' } });
      expect(push).toHaveBeenCalledTimes(10);
      const heldRows = await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'ringBudgetHeld' = ?", [day]);
      expect(heldRows).toHaveLength(1);
      made.push(heldRows[0].id);
      expect(heldRows[0].title).toContain('push only 10');
      expect(await bellRows([heldRows[0].id]).select('id')).toHaveLength(0);
      const listed = await activity._private.loadHeldRows(db, new Date(Date.now() - 3600 * 1000), null, true);
      expect(listed.map((r) => r.id)).toContain(heldRows[0].id);
      const count = await waitFor(() => countRow(day));
      expect(count).toBeTruthy();
      made.push(count.id);
      expect(count.title).toBe('System — 1 more alert held today');
    } finally {
      await db('notification_preferences').where({ trigger_key: 'dashboard_alert' }).whereIn('admin_user_id', admins.map((a) => a.id)).del();
      if (prior.length) await db('notification_preferences').insert(prior);
      await db('technicians').where({ email: `${RUN}@example.invalid` }).del();
      jest.restoreAllMocks();
    }
  }, 60000);

  test('Held alerts: an open held row stays listed however old; a done one only inside the window; the audience filters still apply', async () => {
    const days = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
    const insert = async (name, over = {}, meta = {}) => {
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'inventory', title: `${RUN} ${name}`, body: 'x', created_at: days(3),
        metadata: JSON.stringify({ fixture: RUN, feed: 'activity', quiet: true, ringBudgetHeld: '2020-01-01', ...meta }), ...over,
      }).returning('id');
      made.push(row.id);
      return row.id;
    };
    const openOld = await insert('open old');
    const resolvedOld = await insert('resolved old', {}, { resolved: true });
    const doneOld = await insert('done old', { done_at: days(2) });
    const doneRecent = await insert('done recent', { created_at: days(3), done_at: new Date() });
    const ownerOld = await insert('owner only old', {}, { ownerOnly: true });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const ids = (await activity._private.loadHeldRows(db, since, null, false)).map((r) => r.id);
    expect(ids).toContain(openOld);
    expect(ids).toContain(doneRecent);
    expect(ids).not.toContain(resolvedOld);
    expect(ids).not.toContain(doneOld);
    expect(ids).not.toContain(ownerOld);
    expect((await activity._private.loadHeldRows(db, since, null, true)).map((r) => r.id)).toContain(ownerOld);
    // It reaches the feed itself: the old open row reads as an item under Held alerts.
    const feed = activity.buildActivity({ held: await activity._private.loadHeldRows(db, since, null, false) });
    expect(feed.items.filter((i) => i.agent === 'Held alerts').map((i) => i.notificationId)).toContain(openOld);
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
