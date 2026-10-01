/**
 * Alert episodes (admin-alert-episodes closeAdminAlertKeys /
 * openAdminAlertKeys / raiseAdminAlertWithReopen) against live Postgres, the
 * SQL as the schedule-integrity watchdog runs it: a close marks the row read
 * done and auto-cleared (a row a person already read keeps its own read_at), a
 * raise on an auto-cleared row rings it again with a bumped generation, and a
 * raise on an open row that predates dedupe versions stays silent. Every row
 * these tests insert is deleted afterwards. The watchdog's own rules are
 * covered by schedule-integrity-watchdog.test.js.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

// Both suites share the pool; it closes once, after the last of them.
afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('alert episodes (live Postgres)', () => {
  let db;
  let NotificationService;
  let helpers;
  const RUN = `episodes-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (name) => `${RUN}:${name}`;

  beforeAll(() => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    helpers = require('../services/admin-alert-episodes');
  });
  afterAll(async () => {
    await db('notifications').whereRaw("starts_with(metadata->>'dedupeKey', ?)", [RUN]).del();
  });

  const bell = async (name, { read = false, meta = {} } = {}) => {
    const [row] = await db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Fixture alert', body: 'Fixture body', link: '/admin/dispatch',
      read_at: read ? new Date('2026-09-01T12:00:00Z') : null,
      metadata: JSON.stringify({ dedupeKey: key(name), ...meta }),
    }).returning('*');
    return row;
  };
  const get = (id) => db('notifications').where({ id }).first();
  const raise = (name, over = {}) => helpers.raiseAdminAlertWithReopen('alert', 'Fixture alert', 'Fixture body', {
    link: '/admin/dispatch', bell: true, dedupeKey: key(name), metadata: { dedupeKey: key(name) }, ...over,
  });
  const close = (names, reason = 'gap resolved') => helpers.closeAdminAlertKeys(db, names.map(key), reason);

  test('close: an unread row is read, done and auto-cleared; a READ (not done) row keeps its read_at but is still done and auto-cleared; empty list is a no-op', async () => {
    const unread = await bell('close-unread');
    const read = await bell('close-read', { read: true });
    const other = await bell('close-untouched');
    expect(await close([])).toBe(0);
    expect(await close(['close-unread', 'close-read'])).toBe(2);

    const u = await get(unread.id);
    expect(u.read_at).not.toBeNull();
    // An unread row is read at the done instant.
    expect(new Date(u.read_at).getTime()).toBe(new Date(u.done_at).getTime());
    expect(u.done_by).toBe('episodes');
    expect(u.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'gap resolved', dedupeKey: key('close-unread') });
    expect(typeof u.metadata.autoClearedAt).toBe('string');
    const r = await get(read.id);
    expect(new Date(r.read_at).toISOString()).toBe('2026-09-01T12:00:00.000Z');
    // Read is not done: the person's read is closed too (done_at stamped), their read_at kept.
    expect([r.done_by, r.done_at === null]).toEqual(['episodes', false]);
    expect(r.metadata.autoCleared).toBe(true);
    const untouched = await get(other.id);
    expect([untouched.read_at, untouched.done_at]).toEqual([null, null]);

    // Already cleared: a second close rewrites nothing.
    expect(await close(['close-unread', 'close-read'])).toBe(0);
  });

  test('done state: a close is also done (a person\'s resolution and done time stand; the close takes done_by) and a comeback puts the row back in the bell', async () => {
    const auto = await bell('done-auto');
    const person = await bell('done-person');
    expect(await NotificationService.markAdminDone([person.id], { by: '7', resolution: 'Handled by phone' })).toBe(1);
    // A second done of the same row writes nothing.
    expect(await NotificationService.markAdminDone([person.id], { by: 'claude' })).toBe(0);
    expect(await helpers.closeAdminAlertKeys(db, [key('done-auto'), key('done-person')], 'gap resolved', { resolution: 'Series priced' })).toBe(2);

    const a = await get(auto.id);
    expect(a.done_at).not.toBeNull();
    expect([a.done_by, a.resolution]).toEqual(['episodes', 'Series priced']);
    expect(a.read_at).not.toBeNull();
    const p = await get(person.id);
    // The system close takes done_by (so the person's old reopen token can't put a
    // cleared alert back); their resolution and done time stand.
    expect([p.done_by, p.resolution]).toEqual(['episodes', 'Handled by phone']);
    const listed = (await NotificationService.getAdminNotifications(500)).map((r) => r.id);
    expect(listed).not.toContain(auto.id);
    expect(listed).not.toContain(person.id);

    // The problem comes back: the same raise re-rings the row and clears every done field.
    const result = await raise('done-auto');
    expect(result.rang).toBe(true);
    const back = await get(auto.id);
    expect(back.read_at).toBeNull();
    expect([back.done_at, back.done_by, back.resolution]).toEqual([null, null, null]);
    expect((await NotificationService.getAdminNotifications(500)).map((r) => r.id)).toContain(auto.id);

    // A person reopens a done row: done fields clear, read_at stays. The reopen
    // is fenced on the full-precision done_at the Recently-done list served.
    const tokenOf = async (id) => (await db('notifications').where({ id }).first(db.raw('done_at::text AS done_at_token'))).done_at_token;
    // A person's Done that a system close then took over (the check cleared it)
    // is not reopenable, even with the person's own token (Codex #5462 r5 P1).
    expect(await NotificationService.reopenAdminDone(person.id, { expectedDoneAt: await tokenOf(person.id) })).toBe('not_reopenable');
    // A person's Done no system touched is.
    const manual = await bell('done-manual');
    expect(await NotificationService.markAdminDone([manual.id], { by: '7', resolution: 'Handled by phone' })).toBe(1);
    const doneToken = await tokenOf(manual.id);
    // A stale list (an older close of the same row) cannot clear it...
    expect(await NotificationService.reopenAdminDone(manual.id, { expectedDoneAt: '2020-01-01 00:00:00.000001+00' })).toBe('changed');
    expect((await get(manual.id)).done_at).not.toBeNull();
    // ...nor can one that names a microsecond neighbour of the real close.
    expect(await NotificationService.reopenAdminDone(manual.id, { expectedDoneAt: doneToken.replace(/(\d)([+-]\d+)$/, (_m, d, z) => `${(Number(d) + 1) % 10}${z}`) })).toBe('changed');
    expect(await NotificationService.reopenAdminDone(manual.id, { expectedDoneAt: doneToken })).toBe('reopened');
    const reopened = await get(manual.id);
    expect([reopened.done_at, reopened.done_by, reopened.resolution]).toEqual([null, null, null]);
    expect(reopened.read_at).not.toBeNull();
    expect(await NotificationService.reopenAdminDone(manual.id, { expectedDoneAt: doneToken })).toBe('not_found');

    // A system close (done_by is a component, not a person) is never reopenable.
    expect(await helpers.closeAdminAlertKeys(db, [key('done-auto')], 'gap resolved again', { resolution: 'Series priced' })).toBe(1);
    const systemToken = await tokenOf(auto.id);
    expect(await NotificationService.reopenAdminDone(auto.id, { expectedDoneAt: systemToken })).toBe('not_reopenable');
    expect((await get(auto.id)).done_at).not.toBeNull();
    const doneList = await NotificationService.getAdminDoneNotifications({ role: 'admin', limit: 5000 });
    expect(doneList.find((r) => r.id === auto.id)).toMatchObject({ reopenable: false, done_at_token: systemToken });
  });

  test('a system closer that selects with openToCloser takes over a person\'s Done exactly once: done_by is the component, done_at stays, the person\'s Reopen is refused, a second run writes nothing', async () => {
    const callLogId = `${RUN}-call`;
    const mk = async (name, readAt = null) => {
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'missed_call', title: 'Fixture call', body: 'Fixture body', link: '/admin/communications', read_at: readAt,
        metadata: JSON.stringify({ dedupeKey: key(name), triggerKey: 'customer_missed_call', payload: { callLogId } }),
      }).returning('*');
      return row;
    };
    const tokenOf = async (id) => (await db('notifications').where({ id }).first(db.raw('done_at::text AS done_at_token'))).done_at_token;
    const person = await mk('closer-person');
    const open = await mk('closer-open');
    const system = await mk('closer-system');
    expect(await NotificationService.markAdminDone([person.id], { by: '7', resolution: 'Called back' })).toBe(1);
    expect(await NotificationService.markAdminDone([system.id], { by: 'dispatch', resolution: 'Cleared by dispatch' })).toBe(1);
    const personDone = await get(person.id);
    const personToken = await tokenOf(person.id);
    const systemBefore = await get(system.id);
    const systemToken = await tokenOf(system.id);

    // Person-done + open rows are reached; the row another component closed is left alone.
    expect(await NotificationService.supersedeMissedCallAdmin({ callLogId })).toBe(2);
    const p = await get(person.id);
    expect(p.done_by).toBe('supersede');
    expect(new Date(p.done_at).getTime()).toBe(new Date(personDone.done_at).getTime());
    expect(await tokenOf(person.id)).toBe(personToken);
    expect(p.resolution).toBe('Called back');
    expect(await NotificationService.reopenAdminDone(person.id, { expectedDoneAt: personToken })).toBe('not_reopenable');
    expect((await get(person.id)).done_at).not.toBeNull();
    const o = await get(open.id);
    expect([o.done_by, o.resolution]).toEqual(['supersede', 'Superseded by a newer event on the same call']);
    const s = await get(system.id);
    expect([s.done_by, s.resolution, await tokenOf(system.id)]).toEqual(['dispatch', 'Cleared by dispatch', systemToken]);
    expect(new Date(s.done_at).getTime()).toBe(new Date(systemBefore.done_at).getTime());

    // A second run finds nothing: every row is done by a system component now.
    const before = await Promise.all([person.id, open.id, system.id].map(get));
    expect(await NotificationService.supersedeMissedCallAdmin({ callLogId })).toBe(0);
    expect(await Promise.all([person.id, open.id, system.id].map(get))).toEqual(before);
  });

  test('keyset paging at full precision: rows created in one millisecond, microseconds apart, are neither skipped nor repeated across a cursor', async () => {
    const ids = [];
    for (const us of ['123900', '123500', '123100']) {
      const row = await bell(`keyset-${us}`);
      await db('notifications').where({ id: row.id }).update({ created_at: db.raw('?::timestamptz', [`2031-01-01 12:00:00.${us}+00`]) });
      ids.push(row.id);
    }
    const page = async (before) => (await NotificationService.getAdminNotifications(1, 0, { role: 'admin', before })).filter((r) => ids.includes(r.id) || r.created_at_cursor?.startsWith('2031-01-01'));
    const first = await page(null);
    expect(first.map((r) => r.id)).toEqual([ids[0]]); // newest row in the table (year 2031)
    expect(first[0].created_at_cursor).toMatch(/^2031-01-01 \d\d:00:00\.1239\d*[+-]\d\d/);
    const second = await page({ at: first[0].created_at_cursor, id: first[0].id });
    expect(second.map((r) => r.id)).toEqual([ids[1]]);
    const third = await page({ at: second[0].created_at_cursor, id: second[0].id });
    expect(third.map((r) => r.id)).toEqual([ids[2]]);
  });

  test('a quiet refresh (ringOnRefresh false) rewrites a standing READ row\'s text and keeps the read; a reopen still rings despite it', async () => {
    const quiet = { refreshOnDedupe: true, ringOnRefresh: () => false };
    const standing = await bell('quiet-standing', { read: true });
    const result = await helpers.raiseAdminAlertWithReopen('alert', 'New title', 'New body', {
      link: '/admin/dispatch', bell: true, dedupeKey: key('quiet-standing'), metadata: { dedupeKey: key('quiet-standing') }, ...quiet,
    });
    expect(result).toMatchObject({ deduped: true, refreshed: true, rung: false, rang: false });
    const s1 = await get(standing.id);
    expect([s1.title, s1.body]).toEqual(['New title', 'New body']);
    expect(new Date(s1.read_at).toISOString()).toBe('2026-09-01T12:00:00.000Z');

    const cleared = await bell('quiet-cleared', { read: true, meta: { autoCleared: true } });
    const reopened = await helpers.raiseAdminAlertWithReopen('alert', 'Back again', 'Body', {
      link: '/admin/dispatch', bell: true, dedupeKey: key('quiet-cleared'), metadata: { dedupeKey: key('quiet-cleared') }, ...quiet,
    });
    expect(reopened.rang).toBe(true);
    const c1 = await get(cleared.id);
    expect(c1.read_at).toBeNull();
    expect(c1.metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1 });
  });

  test('openAdminAlertKeys: by prefix, skipping auto-cleared rows', async () => {
    await bell('open-a');
    await bell('open-b', { read: true });
    await bell('open-c', { meta: { autoCleared: true } });
    const keys = await helpers.openAdminAlertKeys(db, `${RUN}:open-`);
    expect(keys.sort()).toEqual([key('open-a'), key('open-b')]);
  });

  test('raise on an auto-cleared row re-rings it: unread again, generation 1, autoCleared false', async () => {
    const row = await bell('reopen', { read: true, meta: { autoCleared: true, autoClearedReason: 'gap resolved' } });
    const result = await raise('reopen');
    expect(result.rang).toBe(true);
    expect(result.refreshed).toBe(true);
    const after = await get(row.id);
    expect(after.read_at).toBeNull();
    expect(after.metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 1, dedupeVersion: '::g1' });
    // Still one row for the key.
    expect(await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key('reopen')]).count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('raise on an open row that predates dedupe versions stays silent (no refresh, a read stays read)', async () => {
    const unread = await bell('standing-unread');
    const read = await bell('standing-read', { read: true });
    const a = await raise('standing-unread');
    const b = await raise('standing-read');
    expect(a).toMatchObject({ deduped: true, rang: false });
    expect(b).toMatchObject({ deduped: true, rang: false });
    expect((await get(unread.id)).metadata.dedupeVersion).toBeUndefined();
    expect((await get(read.id)).read_at).not.toBeNull();
  });

  test('a fresh key creates the row and reports a ring', async () => {
    const result = await raise('fresh');
    expect(result).toMatchObject({ deduped: false, rang: true });
    expect(await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key('fresh')]).count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('a second fix and comeback reaches generation 2; the same generation never re-rings', async () => {
    const row = await bell('cycle');
    await close(['cycle']);
    expect((await raise('cycle')).rang).toBe(true);
    expect((await get(row.id)).metadata.recurrenceGeneration).toBe(1);
    // Standing again: silent.
    expect((await raise('cycle')).rang).toBe(false);
    await db('notifications').where({ id: row.id }).update({ read_at: new Date() });
    await close(['cycle'], 'no longer unpriced');
    expect((await get(row.id)).metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'no longer unpriced' });
    expect((await raise('cycle')).rang).toBe(true);
    const after = await get(row.id);
    expect(after.read_at).toBeNull();
    expect(after.metadata).toMatchObject({ autoCleared: false, recurrenceGeneration: 2, dedupeVersion: '::g2' });
  });

  test('with a base version: generation 0 keeps the caller version (no ring); a reopen appends the generation; a changed evidence version then rings once', async () => {
    const row = await bell('versioned', { meta: { dedupeVersion: 'ev1' } });
    expect((await raise('versioned', { dedupeVersion: 'ev1', refreshOnDedupe: true })).rang).toBe(false);
    await close(['versioned']);
    expect((await raise('versioned', { dedupeVersion: 'ev1', refreshOnDedupe: true })).rang).toBe(true);
    expect((await get(row.id)).metadata.dedupeVersion).toBe('ev1::g1');
    // Standing at generation 1: the same evidence stays silent, changed evidence rings.
    expect((await raise('versioned', { dedupeVersion: 'ev1', refreshOnDedupe: true })).rang).toBe(false);
    expect((await raise('versioned', { dedupeVersion: 'ev2', refreshOnDedupe: true })).rang).toBe(true);
    expect((await get(row.id)).metadata.dedupeVersion).toBe('ev2::g1');
  });

  test('notifyAdmin\'s own dedupe lookup and the reopen probe both read the NEWEST row of a key', async () => {
    // Two rows under one key (an aged-out window, or a leftover duplicate): an old auto-cleared one and a newer standing one.
    const older = await bell('newest', { meta: { autoCleared: true, recurrenceGeneration: 3, dedupeVersion: 'ev0::g3' } });
    await db('notifications').where({ id: older.id }).update({ created_at: new Date('2026-08-01T12:00:00Z') });
    const newer = await bell('newest', { read: true, meta: { dedupeVersion: 'ev1' } });
    // The probe sees the newer, standing row: no reopen, no generation bump, nothing rung.
    const silent = await raise('newest', { dedupeVersion: 'ev1', refreshOnDedupe: true });
    expect(silent).toMatchObject({ deduped: true, rang: false });
    expect((await get(older.id)).metadata.recurrenceGeneration).toBe(3);
    // A changed version refreshes the NEWER row (notifyAdmin's lookup), never the older one.
    const changed = await raise('newest', { dedupeVersion: 'ev2', refreshOnDedupe: true });
    expect(changed).toMatchObject({ refreshed: true, rang: true });
    expect((await get(newer.id)).metadata.dedupeVersion).toBe('ev2');
    expect((await get(newer.id)).read_at).toBeNull();
    expect((await get(older.id)).metadata.dedupeVersion).toBe('ev0::g3');
    expect((await get(older.id)).read_at).toBeNull(); // untouched
  });

  test('a dismissal racing the watchdog\'s refresh is never overwritten back to unread (the standing-row read takes a row lock)', async () => {
    const row = await bell('race', { meta: { dedupeVersion: 'ev1', autoCleared: true } });
    await db('notifications').where({ id: row.id }).update({ read_at: new Date('2026-09-01T12:00:00Z') });
    const trx = await db.transaction();
    try {
      // The wrapper reopens the row (rung) inside trx and holds its row lock until commit.
      const raised = await raise('race', { dedupeVersion: 'ev1', refreshOnDedupe: true, trx });
      expect(raised.rang).toBe(true);
      // A person dismisses it now: queued behind the lock, not lost.
      let dismissed = false;
      const dismissal = NotificationService.markReadAdmin(row.id).then((r) => { dismissed = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(dismissed).toBe(false);
      await trx.commit();
      expect(await dismissal).toBe(true);
    } catch (err) {
      if (!trx.isCompleted()) await trx.rollback();
      throw err;
    }
    // The dismissal landed on top of the refresh.
    expect((await get(row.id)).read_at).not.toBeNull();
  });
});

/**
 * The watchdog's completed-visit check for the unpriced-series close pass, on
 * the real shared coverage select and the real invoice linkage (direct, or
 * through the visit's service record): a visit that completed during the
 * alert's episode, is still unpriced and has no live invoice holds the bell
 * open.
 */
maybeDescribe('unpriced series: completed visit holds its bell (live Postgres)', () => {
  let db;
  let watchdog;
  const made = { invoices: [], service_records: [], notifications: [], scheduled_services: [], customers: [] };
  const RUN = `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const NOW = new Date('2026-09-29T16:00:00Z');
  let n = 0;

  beforeAll(() => {
    db = require('../models/db');
    watchdog = require('../services/schedule-integrity-watchdog');
  });
  afterAll(async () => {
    for (const table of ['invoices', 'service_records', 'notifications', 'scheduled_services', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
  });

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  // A series: unpriced root + a completed, unpriced child, and the root's bell.
  const series = async ({ completedAt = '2026-09-28T15:00:00Z', childOver = {}, bellCreatedAt = '2026-09-25T12:00:00Z', rungAt = null, episodeStartedAt = null } = {}) => {
    n += 1;
    const customer = await insert('customers', { first_name: 'Hold', phone: `+1555555${String(8000 + n)}` });
    const root = await insert('scheduled_services', { customer_id: customer.id, scheduled_date: '2026-09-20', service_type: 'General Pest Control', status: 'pending', is_recurring: true });
    const child = await insert('scheduled_services', {
      customer_id: customer.id, scheduled_date: '2026-09-28', service_type: 'General Pest Control', status: 'completed',
      is_recurring: true, recurring_parent_id: root.id, completed_at: completedAt, ...childOver,
    });
    const key = `unpriced-series:${root.id}`;
    await insert('notifications', {
      recipient_type: 'admin', category: 'alert', title: RUN, created_at: bellCreatedAt,
      metadata: JSON.stringify({ dedupeKey: key, ...(rungAt ? { rungAt } : {}), ...(episodeStartedAt ? { episode_started_at: episodeStartedAt } : {}) }),
    });
    return { customer, root, child, key };
  };
  // The real bell reader (open or auto-cleared bells, with each one's start),
  // narrowed to this fixture's series, then the completed-visit check.
  const held = async (s) => {
    const since = await watchdog._unpricedSeriesBells();
    const mine = new Map([...since].filter(([root]) => root === String(s.root.id)));
    return [...(await watchdog._completedUnpricedSince(mine)).keys()];
  };

  test('completed, unpriced, no invoice: held', async () => {
    const s = await series();
    expect(await held(s)).toEqual([s.root.id]);
  });

  // The visit's base application on an invoice (the line every service mint writes).
  const baseLines = (visitId) => JSON.stringify([{ client_id: `scheduled_${visitId}_primary`, description: 'General Pest Control', quantity: 1, unit_price: 120, amount: 120 }]);

  test('no invoice releases a completed, still-unpriced visit, whatever it bills: whether it was billed right is a person\'s call', async () => {
    const viaRecord = await series();
    const record = await insert('service_records', { customer_id: viaRecord.customer.id, service_date: '2026-09-28', service_type: 'General Pest Control', scheduled_service_id: viaRecord.child.id });
    await insert('invoices', { customer_id: viaRecord.customer.id, token: `${RUN}-a`, invoice_number: `${RUN}-a`, service_record_id: record.id, status: 'sent', line_items: baseLines(viaRecord.child.id) });
    expect(await held(viaRecord)).toEqual([viaRecord.root.id]);

    const direct = await series();
    await insert('invoices', { customer_id: direct.customer.id, token: `${RUN}-b`, invoice_number: `${RUN}-b`, scheduled_service_id: direct.child.id, status: 'paid', line_items: baseLines(direct.child.id) });
    expect(await held(direct)).toEqual([direct.root.id]);
  });

  test('an authoritative $0 stamp (GATE_STAMPED_ZERO_FREE on) is a price and releases it; with the gate off a bare 0 still holds', async () => {
    const saved = process.env.GATE_STAMPED_ZERO_FREE;
    try {
      const free = await series({ childOver: { estimated_price: 0 } });
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(await held(free)).toEqual([]);
      delete process.env.GATE_STAMPED_ZERO_FREE;
      expect(await held(free)).toEqual([free.root.id]);
    } finally {
      if (saved === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = saved;
    }
  });

  test('a backfilled completion (completed_at NULL) never holds, however recently the row was edited', async () => {
    const backfilled = await series({ completedAt: null });
    await db('scheduled_services').where({ id: backfilled.child.id }).update({ updated_at: NOW });
    expect(await held(backfilled)).toEqual([]);
  });

  test('priced (own row or parent), or completed before the bell first rang: released; a later ring never moves the start', async () => {
    expect(await held(await series({ childOver: { estimated_price: 99 } }))).toEqual([]);
    const pricedParent = await series();
    await db('scheduled_services').where({ id: pricedParent.root.id }).update({ primary_line_price: 72 });
    expect(await held(pricedParent)).toEqual([]);
    expect(await held(await series({ completedAt: '2026-09-24T15:00:00Z' }))).toEqual([]);
    const rerung = await series({ rungAt: '2026-09-29T10:00:00Z', episodeStartedAt: '2026-09-29T09:00:00Z' });
    expect(await held(rerung)).toEqual([rerung.root.id]);
  });

  test('full cycle: a visit that completed between the first scan and the insert still holds after the bell is cleared and REOPENED (the reopen keeps the start)', async () => {
    // Scan at 14:00, visit completed 15:00, bell inserted 16:00.
    const s = await series({ completedAt: '2026-09-28T15:00:00Z', bellCreatedAt: '2026-09-28T16:00:00Z', episodeStartedAt: '2026-09-28T14:00:00Z' });
    expect(await held(s)).toEqual([s.root.id]);
    // Cleared (priced, then unpriced again), then reopened through the real wrapper with the watchdog's own raise.
    await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [s.key])
      .update({ read_at: NOW, metadata: db.raw("metadata || ?::jsonb", [JSON.stringify({ autoCleared: true, autoClearedAt: NOW.toISOString() })]) });
    const since = new Map([...await watchdog._unpricedSeriesBells()].filter(([root]) => root === String(s.root.id)));
    const [raise] = watchdog._unpricedSeriesAlerts({ upcomingByRoot: new Map(), overdueByRoot: new Map(),
      completedByRoot: await watchdog._completedUnpricedSince(since), bellSince: since, episodes: true, now: NOW });
    const [dedupeKey, title, body, metadata] = raise;
    const result = await require('../services/admin-alert-episodes').raiseAdminAlertWithReopen('alert', title, body, { dedupeKey, bell: true, metadata: { dedupeKey, ...metadata } });
    expect(result.rang).toBe(true);
    const bell = await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [s.key]).orderBy('created_at', 'desc').first('metadata', 'read_at');
    const meta = typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata;
    expect(meta.episode_started_at).toBe('2026-09-28T14:00:00.000Z');
    expect(bell.read_at).toBeNull();
    // The next run still holds it: the reopen did not move the watch past the visit.
    expect(await held(s)).toEqual([s.root.id]);
  });

  test('an AUTO-CLEARED bell still counts: a completed visit priced, then unpriced again, holds its series live (it reopens)', async () => {
    const s = await series();
    await db('scheduled_services').where({ id: s.child.id }).update({ estimated_price: 99 });
    expect(await held(s)).toEqual([]);
    await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [s.key])
      .update({ read_at: NOW, metadata: db.raw("metadata || ?::jsonb", [JSON.stringify({ autoCleared: true, autoClearedAt: NOW.toISOString() })]) });
    await db('scheduled_services').where({ id: s.child.id }).update({ estimated_price: null });
    expect(await held(s)).toEqual([s.root.id]);
  });

  test('a first-application stamp alone releases nothing: billing\'s verdict needs the visit\'s source estimate', async () => {
    const s = await series();
    const stamped = await insert('invoices', { customer_id: s.customer.id, token: `${RUN}-c`, invoice_number: `${RUN}-c`, status: 'sent' });
    await db('scheduled_services').where({ id: s.child.id }).update({ first_application_invoice_id: stamped.id });
    expect(await held(s)).toEqual([s.root.id]);
    await db('scheduled_services').where({ id: s.child.id }).update({ first_application_invoice_id: null });
  });

  test('episode_started_at (pre-scan time) beats created_at/rungAt: a visit that completed just before the bell landed still holds', async () => {
    const raced = await series({ completedAt: '2026-09-28T15:00:00Z', bellCreatedAt: '2026-09-28T16:00:00Z', rungAt: '2026-09-28T16:00:05Z', episodeStartedAt: '2026-09-28T14:00:00Z' });
    expect(await held(raced)).toEqual([raced.root.id]);
    const legacy = await series({ completedAt: '2026-09-28T15:00:00Z', bellCreatedAt: '2026-09-28T16:00:00Z' });
    expect(await held(legacy)).toEqual([]);
  });
});

/**
 * The churned-customer live-work finder (class 4), the real query: a customer
 * whose live pipeline_stage is 'churned' (and not soft-deleted) with a live
 * upcoming visit or a never-sent invoice is found; the same customer with only
 * past / cancelled / completed visits and sent / paid / void invoices, an
 * active customer with drafts, a reactivated customer carrying a stale
 * churned_at, and a soft-deleted churned customer are not.
 */
maybeDescribe('churned customer with live work: the finder (live Postgres)', () => {
  let db;
  let watchdog;
  const made = { invoices: [], scheduled_services: [], customers: [], annual_prepay_terms: [], payer_statements: [], payers: [], service_records: [] };
  const RUN = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const TODAY = '2026-09-29';
  let n = 0;
  let mine = [];

  beforeAll(() => {
    db = require('../models/db');
    watchdog = require('../services/schedule-integrity-watchdog');
  });
  beforeEach(() => { mine = []; });
  afterAll(async () => {
    for (const table of ['annual_prepay_terms', 'invoices', 'payer_statements', 'payers', 'service_records', 'scheduled_services', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
  });

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const customer = async (over = {}) => {
    n += 1;
    const row = await insert('customers', { first_name: 'Finder', phone: `+1555556${String(1000 + n)}`, pipeline_stage: 'churned', ...over });
    mine.push(row.id);
    return row;
  };
  const visit = (c, over = {}) => insert('scheduled_services', {
    customer_id: c.id, scheduled_date: '2026-10-05', service_type: 'General Pest Control', status: 'pending', ...over,
  });
  const invoice = (c, status, over = {}) => {
    n += 1;
    return insert('invoices', { customer_id: c.id, token: `${RUN}-${n}`, invoice_number: `${RUN}-${n}`, status, ...over });
  };
  // Only this test's customers, so a shared dev database's own rows never matter.
  const found = async () => Object.fromEntries((await watchdog._findChurnedLiveWork(TODAY))
    .filter((r) => mine.includes(r.id)).map((r) => [r.id, [r.live_visits, r.unsent_invoices]]));
  const legsOf = async (c) => (await watchdog._findChurnedLiveWork(TODAY)).find((r) => r.id === c.id) || null;

  test('churned outside the cancel steps with a live visit and/or an unsent invoice the cancel would void is found, with counts', async () => {
    const visitOnly = await customer();
    await visit(visitOnly); await visit(visitOnly, { status: 'confirmed', scheduled_date: TODAY });
    // A visit cancelled outside the app whose invoice was never voided: linked
    // directly, or through the visit's service record (invoice.js's link).
    const invoiceOnly = await customer();
    const gone = await visit(invoiceOnly, { status: 'cancelled' });
    const record = await insert('service_records', { customer_id: invoiceOnly.id, scheduled_service_id: gone.id, service_date: '2026-10-05', service_type: 'General Pest Control' });
    await invoice(invoiceOnly, 'draft', { scheduled_service_id: gone.id });
    await invoice(invoiceOnly, 'scheduled', { service_record_id: record.id });
    const both = await customer();
    const live = await visit(both, { status: 'confirmed' });
    await invoice(both, 'draft', { scheduled_service_id: live.id });
    expect(await found()).toEqual({
      [visitOnly.id]: [2, 0], [invoiceOnly.id]: [0, 2], [both.id]: [1, 1],
    });
  });

  test('a churn done by the cancel steps (churn_episode_id stamped) never pages: what they leave is deliberate', async () => {
    const processed = await customer({ churn_episode_id: randomUUID() });
    const v = await visit(processed);
    await invoice(processed, 'draft', { scheduled_service_id: v.id });
    await insert('annual_prepay_terms', { customer_id: processed.id, term_start: '2026-01-01', term_end: '2026-12-31', status: 'active' });
    expect(await legsOf(processed)).toBeNull();
  });

  test('an invoice for finished work is an earned receivable, and one with no visit link is not attributable: neither pages', async () => {
    const c = await customer();
    const done = await visit(c, { status: 'completed', scheduled_date: '2026-09-15' });
    const missed = await visit(c, { status: 'no_show', scheduled_date: '2026-09-16' });
    const record = await insert('service_records', { customer_id: c.id, scheduled_service_id: done.id, service_date: '2026-09-15', service_type: 'General Pest Control' });
    await invoice(c, 'draft', { scheduled_service_id: done.id });
    await invoice(c, 'scheduled', { service_record_id: record.id });
    await invoice(c, 'draft', { scheduled_service_id: missed.id });
    await invoice(c, 'draft');
    expect(await legsOf(c)).toBeNull();
  });

  test('churned with only past, finished or unknown-status visits and only sent, paid, void or archived invoices is not found', async () => {
    const c = await customer();
    await visit(c, { scheduled_date: '2026-09-28' }); // yesterday, still pending: not upcoming
    for (const status of ['cancelled', 'completed', 'skipped', 'no_show']) await visit(c, { status });
    await visit(c, { status: null }); // no status: not live by the guard's rule
    const gone = await visit(c, { status: 'cancelled', scheduled_date: '2026-10-12' });
    for (const status of ['sent', 'viewed', 'overdue', 'paid', 'void', 'refunded', 'sending']) await invoice(c, status, { scheduled_service_id: gone.id });
    await invoice(c, 'draft', { scheduled_service_id: gone.id, archived_at: new Date('2026-09-01T12:00:00Z') });
    expect(await found()).toEqual({});
  });

  test('the churn guard\'s own live work counts: a rescheduled row (whatever its old date), a tracker-live row, an ongoing series anchor', async () => {
    const rescheduled = await customer();
    await visit(rescheduled, { status: 'rescheduled', scheduled_date: '2026-08-01' });
    const tracked = await customer();
    await visit(tracked, { status: 'confirmed', scheduled_date: '2026-09-20', track_state: 'on_property' });
    const series = await customer();
    await visit(series, { status: 'completed', scheduled_date: '2026-09-01', recurring_ongoing: true, is_recurring: true });
    expect((await legsOf(rescheduled)).live_visits).toBe(1);
    expect((await legsOf(tracked)).live_visits).toBe(1);
    expect(await legsOf(series)).toMatchObject({ live_visits: 0, ongoing_series: 1 });
  });

  test('a paid prepay term still covering, or an unpaid prepay invoice, counts; a void one does not', async () => {
    const term = await customer();
    await insert('annual_prepay_terms', { customer_id: term.id, term_start: '2026-01-01', term_end: '2026-12-31', status: 'active' });
    const pending = await customer();
    const pendingInvoice = await invoice(pending, 'sent', { sent_at: new Date('2026-09-20T12:00:00Z') });
    await insert('annual_prepay_terms', { customer_id: pending.id, term_start: '2026-10-01', term_end: '2027-09-30', status: 'payment_pending', prepay_invoice_id: pendingInvoice.id });
    const voided = await customer();
    const voidInvoice = await invoice(voided, 'void');
    await insert('annual_prepay_terms', { customer_id: voided.id, term_start: '2026-10-01', term_end: '2027-09-30', status: 'payment_pending', prepay_invoice_id: voidInvoice.id });
    expect(await legsOf(term)).toMatchObject({ prepay_terms: 1 });
    expect(await legsOf(pending)).toMatchObject({ pending_prepay_invoices: 1 });
    expect(await legsOf(voided)).toBeNull();
  });

  // A term the cancel machinery decided ('cancelled' + renewal_decision
  // 'cancel'), sold as two General Pest Control visits.
  const lapse = (c, disposition, inv, over = {}) => insert('annual_prepay_terms', { customer_id: c.id, term_start: '2026-01-01', term_end: '2026-12-31',
    status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: disposition, prepay_invoice_id: inv.id,
    coverage_service_type: 'General Pest Control', coverage_visit_count: 2, ...over });
  const paidInvoice = (c) => invoice(c, 'paid', { paid_at: new Date('2026-01-02T12:00:00Z'), sent_at: new Date('2026-01-01T12:00:00Z') });

  test('a decided lapse is the renewal machinery\'s own outcome: an end-at-term lapse with its sold visits, or an end-now lapse awaiting its refund, never pages', async () => {
    const endAtTerm = await customer();
    const kept = await lapse(endAtTerm, 'end_at_term', await paidInvoice(endAtTerm));
    await visit(endAtTerm, { annual_prepay_term_id: kept.id });
    await visit(endAtTerm, { annual_prepay_term_id: kept.id, status: 'confirmed', scheduled_date: '2026-12-05' });
    const endNow = await customer();
    await lapse(endNow, 'end_now_refund', await paidInvoice(endNow));
    expect(await legsOf(endAtTerm)).toBeNull();
    expect(await legsOf(endNow)).toBeNull();
  });

  test('only the lapse\'s sold coverage rides out (coverageRowsForTerm, the cancel\'s keep set): another family, a visit past the sold count, one outside the window, a rescheduled rebook, a visit on an end-now lapse, revoked coverage or a live term still page', async () => {
    const extra = await customer();
    const kept = await lapse(extra, 'end_at_term', await paidInvoice(extra));
    await visit(extra, { annual_prepay_term_id: kept.id }); // sold visit 1 (kept)
    await visit(extra, { annual_prepay_term_id: kept.id, scheduled_date: '2026-11-05' }); // sold visit 2 (kept)
    await visit(extra, { annual_prepay_term_id: kept.id, scheduled_date: '2026-12-05' }); // a third on a two-visit term
    await visit(extra, { annual_prepay_term_id: kept.id, service_type: 'Lawn Care' }); // linked, but not the covered family
    await visit(extra, { annual_prepay_term_id: kept.id, status: 'rescheduled', scheduled_date: '2026-08-01' });
    await visit(extra, { annual_prepay_term_id: kept.id, status: 'confirmed', scheduled_date: '2027-01-15' }); // moved past term_end
    const early = await customer(); // a lapse whose window has not started: a visit before term_start is not covered
    const future = await lapse(early, 'end_at_term', await paidInvoice(early), { term_start: '2026-11-01', term_end: '2027-10-31' });
    await visit(early, { annual_prepay_term_id: future.id, scheduled_date: '2026-10-15' });
    await visit(early, { annual_prepay_term_id: future.id, scheduled_date: '2026-11-05' });
    const endNow = await customer();
    const refunding = await lapse(endNow, 'end_now_refund', await paidInvoice(endNow));
    await visit(endNow, { annual_prepay_term_id: refunding.id });
    const revoked = await customer(); // a lost dispute reopens the invoice: no longer paid coverage
    const disputed = await lapse(revoked, 'end_at_term', await invoice(revoked, 'overdue', { sent_at: new Date('2026-01-01T12:00:00Z') }));
    await visit(revoked, { annual_prepay_term_id: disputed.id });
    const live = await customer(); // churned outside Cancel plan: the term was never decided
    const active = await insert('annual_prepay_terms', { customer_id: live.id, term_start: '2026-01-01', term_end: '2026-12-31', status: 'active' });
    await visit(live, { annual_prepay_term_id: active.id });
    expect(await legsOf(extra)).toMatchObject({ live_visits: 4, prepay_terms: 0 });
    expect(await legsOf(early)).toMatchObject({ live_visits: 1, prepay_terms: 0 });
    expect(await legsOf(endNow)).toMatchObject({ live_visits: 1, prepay_terms: 0 });
    expect(await legsOf(revoked)).toMatchObject({ live_visits: 1, prepay_terms: 0 });
    expect(await legsOf(live)).toMatchObject({ live_visits: 1, prepay_terms: 1 });
  });

  test('a payer\'s receivable is not the churned customer\'s unsent work: a third-party payer, a NET statement accrual, a draft withdrawn to the payer', async () => {
    const c = await customer();
    const gone = await visit(c, { status: 'cancelled' });
    const payer = await insert('payers', { display_name: `Payer ${RUN}` });
    const statement = await insert('payer_statements', { payer_id: payer.id, period_start: '2026-09-01', period_end: '2026-09-30',
      terms_snapshot: JSON.stringify({ net_days: 30 }), token: `${RUN}-stmt` });
    await invoice(c, 'draft', { scheduled_service_id: gone.id, payer_id: payer.id });
    await invoice(c, 'draft', { scheduled_service_id: gone.id, payer_statement_id: statement.id });
    await invoice(c, 'scheduled', { scheduled_service_id: gone.id, scheduled_send_error: 'payer_billed: withdrawn to the payer' });
    expect(await legsOf(c)).toBeNull();
  });

  test('a collected prepay invoice whose term has not advanced yet is paid coverage, never an unpaid invoice; a status-less unpaid one is still unpaid', async () => {
    const pendingTerm = (c, inv) => insert('annual_prepay_terms', { customer_id: c.id, term_start: '2026-10-01', term_end: '2027-09-30', status: 'payment_pending', prepay_invoice_id: inv.id });
    const paid = await customer();
    await pendingTerm(paid, await invoice(paid, 'paid', { paid_at: new Date('2026-09-25T12:00:00Z'), sent_at: new Date('2026-09-20T12:00:00Z') }));
    const credit = await customer();
    await pendingTerm(credit, await invoice(credit, 'prepaid', { sent_at: new Date('2026-09-20T12:00:00Z') }));
    const paidAtOnly = await customer();
    await pendingTerm(paidAtOnly, await invoice(paidAtOnly, 'sent', { paid_at: new Date('2026-09-25T12:00:00Z'), sent_at: new Date('2026-09-20T12:00:00Z') }));
    const statusless = await customer();
    await pendingTerm(statusless, await invoice(statusless, null, { sent_at: new Date('2026-09-20T12:00:00Z') }));
    for (const c of [paid, credit, paidAtOnly]) expect(await legsOf(c)).toMatchObject({ prepay_terms: 1, pending_prepay_invoices: 0 });
    expect(await legsOf(statusless)).toMatchObject({ prepay_terms: 0, pending_prepay_invoices: 1 });
  });

  test('an invoice that already reached the customer is not unsent: any delivery stamp, or Text/App accepted with only the email retrying', async () => {
    const c = await customer();
    const gone = await visit(c, { status: 'cancelled' });
    await invoice(c, 'scheduled', { scheduled_service_id: gone.id, sms_sent_at: new Date('2026-09-20T12:00:00Z') });
    await invoice(c, 'scheduled', { scheduled_service_id: gone.id, scheduled_send_error: 'BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED' });
    await invoice(c, 'draft', { scheduled_service_id: gone.id, viewed_at: new Date('2026-09-21T12:00:00Z') });
    expect(await legsOf(c)).toBeNull();
    await invoice(c, 'scheduled', { scheduled_service_id: gone.id });
    expect(await legsOf(c)).toMatchObject({ unsent_invoices: 1 });
  });

  test('an active or reactivated customer (stale churned_at) with drafts and future visits is not found; nor is a soft-deleted churned one', async () => {
    const active = await customer({ pipeline_stage: 'active_customer' });
    await visit(active); await invoice(active, 'draft');
    const reactivated = await customer({ pipeline_stage: 'active_customer', churned_at: '2026-05-01' });
    await visit(reactivated); await invoice(reactivated, 'scheduled');
    const merged = await customer({ deleted_at: new Date('2026-09-01T12:00:00Z') });
    await visit(merged); await invoice(merged, 'draft');
    expect(await found()).toEqual({});
  });

  test('it clears when the work is cleaned up: cancelling the visit leaves its draft to void, voiding it clears', async () => {
    const c = await customer();
    const v = await visit(c);
    const inv = await invoice(c, 'draft', { scheduled_service_id: v.id });
    expect(await found()).toEqual({ [c.id]: [1, 1] });
    await db('scheduled_services').where({ id: v.id }).update({ status: 'cancelled' });
    expect(await found()).toEqual({ [c.id]: [0, 1] });
    await db('invoices').where({ id: inv.id }).update({ status: 'void' });
    expect(await found()).toEqual({});
  });
});
