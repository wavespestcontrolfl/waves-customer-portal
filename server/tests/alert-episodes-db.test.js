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
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('alert episodes (live Postgres)', () => {
  let db;
  let NotificationService;
  const RUN = `episodes-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = (name) => `${RUN}:${name}`;

  beforeAll(() => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
  });
  afterAll(async () => {
    await db('notifications').whereRaw("starts_with(metadata->>'dedupeKey', ?)", [RUN]).del();
    await db.destroy();
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
  const raise = (name, over = {}) => NotificationService.raiseAdminAlertWithReopen('alert', 'Fixture alert', 'Fixture body', {
    link: '/admin/dispatch', bell: true, dedupeKey: key(name), metadata: { dedupeKey: key(name) }, ...over,
  });
  const close = (names, reason = 'gap resolved') => NotificationService.closeAdminAlertKeys(db, names.map(key), reason);

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
    const keys = await NotificationService.openAdminAlertKeys(db, `${RUN}:open-`);
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
});
