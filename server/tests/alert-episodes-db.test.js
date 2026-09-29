/**
 * Alert episodes (notification-service closeAdminAlertKeys /
 * openAdminAlertKeys / raiseAdminAlertWithReopen) against live Postgres, the
 * SQL as the schedule-integrity watchdog runs it: a close marks the row read
 * and auto-cleared (a row a person already read keeps its own read_at), a
 * raise on an auto-cleared row rings it again with a bumped generation, and a
 * raise on an open row that predates dedupe versions stays silent. Every row
 * these tests insert is deleted afterwards. The watchdog's own rules are
 * covered by schedule-integrity-watchdog.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
// The episode helpers live in the schedule-integrity watchdog (private to it).
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
    ({ _private: helpers } = require('../services/schedule-integrity-watchdog'));
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

  test('close: an unread row is read and auto-cleared; a READ row keeps its read_at but is auto-cleared; empty list is a no-op', async () => {
    const unread = await bell('close-unread');
    const read = await bell('close-read', { read: true });
    const other = await bell('close-untouched');
    expect(await close([])).toBe(0);
    expect(await close(['close-unread', 'close-read'])).toBe(2);

    const u = await get(unread.id);
    expect(u.read_at).not.toBeNull();
    expect(u.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'gap resolved', dedupeKey: key('close-unread') });
    expect(typeof u.metadata.autoClearedAt).toBe('string');
    const r = await get(read.id);
    expect(new Date(r.read_at).toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(r.metadata.autoCleared).toBe(true);
    expect((await get(other.id)).read_at).toBeNull();

    // Already cleared: a second close rewrites nothing.
    expect(await close(['close-unread', 'close-read'])).toBe(0);
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
  const held = async (s) => [...await watchdog._completedUnpricedRoots([s.key], NOW)];

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

  test('priced (own row or parent), completed before the episode, or episode restarted by a later ring: released', async () => {
    expect(await held(await series({ childOver: { estimated_price: 99 } }))).toEqual([]);
    const pricedParent = await series();
    await db('scheduled_services').where({ id: pricedParent.root.id }).update({ primary_line_price: 72 });
    expect(await held(pricedParent)).toEqual([]);
    expect(await held(await series({ completedAt: '2026-09-24T15:00:00Z' }))).toEqual([]);
    expect(await held(await series({ rungAt: '2026-09-29T10:00:00Z' }))).toEqual([]);
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
