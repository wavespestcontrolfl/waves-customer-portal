/**
 * P2 (07-19 admin audit): the admin PUT /:id/read endpoint called markRead(id)
 * with no recipient scope, so an admin could clear a CUSTOMER's notification by
 * id. markReadAdmin scopes the update to recipient_type 'admin' (the shared
 * admin queue) so customer rows are off-limits.
 */

jest.mock('../models/db', () => {
  const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), whereNull: jest.fn(() => q), whereNotNull: jest.fn(() => q), whereRaw: jest.fn(() => q), update: jest.fn(async () => 1), first: jest.fn(async () => undefined) };
  const db = jest.fn(() => q);
  db.raw = jest.fn((sql) => sql);
  db.__q = q;
  return db;
});

const db = require('../models/db');
const NotificationService = require('../services/notification-service');

describe('markReadAdmin', () => {
  beforeEach(() => {
    db.mockClear();
    db.__q.where.mockClear();
    db.__q.update.mockClear();
    db.__q.update.mockResolvedValue(1);
  });

  test('scopes the update to id AND recipient_type admin', async () => {
    const ok = await NotificationService.markReadAdmin('notif-1');
    expect(db).toHaveBeenCalledWith('notifications');
    expect(db.__q.where).toHaveBeenCalledWith({ id: 'notif-1', recipient_type: 'admin' });
    expect(db.__q.update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.any(Date) }));
    expect(ok).toBe(true);
  });

  test('returns false when no admin row matched (e.g. a customer id)', async () => {
    db.__q.update.mockResolvedValueOnce(0);
    const ok = await NotificationService.markReadAdmin('customer-notif');
    expect(db.__q.where).toHaveBeenCalledWith({ id: 'customer-notif', recipient_type: 'admin' });
    expect(ok).toBe(false);
  });
});

describe('markAdminDone', () => {
  beforeEach(() => {
    db.__q.update.mockClear();
    db.__q.update.mockResolvedValue(2);
    db.__q.whereIn.mockClear();
    db.__q.whereNull.mockClear();
    db.__q.whereRaw.mockClear();
    db.raw.mockClear();
  });

  test('stamps done and read on admin rows not yet done, with a plain, 200-character resolution', async () => {
    const count = await NotificationService.markAdminDone(['a', 'a', 'b'], { by: 'claude', resolution: `  Fixed \u{1F600}   in PR  ${'word '.repeat(80)}` });
    expect(count).toBe(2);
    expect(db.__q.whereIn).toHaveBeenCalledWith('id', ['a', 'b']);
    expect(db.__q.where).toHaveBeenCalledWith({ recipient_type: 'admin' });
    expect(db.__q.whereNull).toHaveBeenCalledWith('done_at');
    const patch = db.__q.update.mock.calls[0][0];
    // keepExisting: the first done (a person's own included) and an earlier read stand; an unread row is read at the done instant.
    expect(patch).toMatchObject({
      done_at: 'COALESCE(done_at, ?::timestamptz)', done_by: 'COALESCE(done_by, ?)',
      resolution: 'COALESCE(resolution, ?)', read_at: 'COALESCE(read_at, ?::timestamptz)',
    });
    const bound = Object.fromEntries(db.raw.mock.calls.map(([sql, bindings]) => [sql, bindings]));
    expect(bound['COALESCE(done_by, ?)']).toEqual(['claude']);
    expect(bound['COALESCE(done_at, ?::timestamptz)'][0]).toBeInstanceOf(Date);
    expect(bound['COALESCE(read_at, ?::timestamptz)']).toEqual(bound['COALESCE(done_at, ?::timestamptz)']);
    const resolution = bound['COALESCE(resolution, ?)'][0];
    expect(resolution).toMatch(/^Fixed in PR word word.*…$/);
    expect(resolution.length).toBeLessThanOrEqual(200);
  });

  test('expectedVersion fences the update on the md5 content version of the one row', async () => {
    const version = 'b'.repeat(32);
    await NotificationService.markAdminDone(['a'], { by: '7', expectedVersion: version });
    expect(db.__q.whereRaw).toHaveBeenCalledWith(`${NotificationService._private.NOTIFICATION_VERSION_SQL} = ?`, [version]);
    expect(NotificationService._private.NOTIFICATION_VERSION_SQL).toMatch(/^md5\(concat_ws\('\|', title, body, link, detail, metadata::text\)\)$/);
  });

  test('no expectedVersion adds no version fence (Claude and system callers)', async () => {
    await NotificationService.markAdminDone(['a'], { by: 'claude' });
    expect(db.__q.whereRaw).not.toHaveBeenCalled();
  });

  test('expectedVersion with more than one id writes nothing', async () => {
    expect(await NotificationService.markAdminDone(['a', 'b'], { by: '7', expectedVersion: 'b'.repeat(32) })).toBe(0);
    expect(db.__q.update).not.toHaveBeenCalled();
  });

  test('writes nothing without ids or an actor', async () => {
    expect(await NotificationService.markAdminDone([], { by: 'claude' })).toBe(0);
    expect(await NotificationService.markAdminDone(['a'], {})).toBe(0);
    expect(db.__q.update).not.toHaveBeenCalled();
  });
});

describe('reopenAdminDone', () => {
  const TOKEN = '2026-09-30 12:00:00.123456+00';
  const { PERSON_DONE_BY_SQL } = NotificationService._private;
  beforeEach(() => {
    for (const fn of ['where', 'whereNotNull', 'whereRaw', 'update', 'first']) db.__q[fn].mockClear();
    db.raw.mockClear();
    db.__q.update.mockResolvedValue(1);
    db.__q.first.mockResolvedValue(undefined);
  });

  test('clears the done fields only while done_at still equals the served token and a person closed it', async () => {
    expect(await NotificationService.reopenAdminDone('n1', { expectedDoneAt: TOKEN })).toBe('reopened');
    expect(db.__q.where).toHaveBeenCalledWith({ id: 'n1', recipient_type: 'admin' });
    expect(db.__q.whereNotNull).toHaveBeenCalledWith('done_at');
    expect(db.__q.whereRaw).toHaveBeenCalledWith('done_at = ?::timestamptz', [TOKEN]);
    expect(db.__q.whereRaw).toHaveBeenCalledWith(PERSON_DONE_BY_SQL);
    expect(db.__q.update).toHaveBeenCalledWith({ done_at: null, done_by: null, resolution: null });
  });

  test('without a token nothing is written', async () => {
    expect(await NotificationService.reopenAdminDone('n1', {})).toBe('changed');
    expect(await NotificationService.reopenAdminDone('n1')).toBe('changed');
    expect(db.__q.update).not.toHaveBeenCalled();
  });

  test('nothing matched: a missing or no-longer-done row is not_found; still done under a newer close is changed; a system close is not_reopenable', async () => {
    db.__q.update.mockResolvedValue(0);
    db.__q.first.mockResolvedValueOnce(undefined);
    expect(await NotificationService.reopenAdminDone('n1', { expectedDoneAt: TOKEN })).toBe('not_found');
    db.__q.first.mockResolvedValueOnce({ done_at: null, fence_ok: null });
    expect(await NotificationService.reopenAdminDone('n1', { expectedDoneAt: TOKEN })).toBe('not_found');
    db.__q.first.mockResolvedValueOnce({ done_at: new Date(), fence_ok: false });
    expect(await NotificationService.reopenAdminDone('n1', { expectedDoneAt: TOKEN })).toBe('changed');
    db.__q.first.mockResolvedValueOnce({ done_at: new Date(), fence_ok: true });
    expect(await NotificationService.reopenAdminDone('n1', { expectedDoneAt: TOKEN })).toBe('not_reopenable');
  });

  test('a person is a technician id (uuid, or plain digits) or claude; system components are not', () => {
    // The SQL is the one definition; mirror it in JS to pin which done_by values it admits.
    const re = [...PERSON_DONE_BY_SQL.matchAll(/~\*? '([^']+)'/g)].map((m) => new RegExp(m[1], PERSON_DONE_BY_SQL.includes(`~* '${m[1]}'`) ? 'i' : ''));
    const isPerson = (by) => by === 'claude' || re.some((r) => r.test(by));
    for (const by of ['7', '123', '6f1c2d9e-4b7a-4c1e-9a3b-0d5e7f8a9b10', '6F1C2D9E-4B7A-4C1E-9A3B-0D5E7F8A9B10', 'claude']) expect(isPerson(by)).toBe(true);
    for (const by of ['episodes', 'relevance', 'ops-crons', 'ops-crons:3-clean-runs', 'supersede', 'promise-chaser', 'supplies', 'dispatch', 'backfill', 'collections', 'followup-sla', 'procurement', 'sms-commitments', 'email-commitments', 'cancellation-processor', 'admin-cancellation', '12abc', '']) expect(isPerson(by)).toBe(false);
  });
});

describe('getAdminDoneNotifications', () => {
  test('selects the full-precision done_at token and the reopenable flag, ordered on plain done_at', async () => {
    const order = [];
    db.__q.select = jest.fn(() => db.__q);
    db.__q.orderByRaw = jest.fn((sql) => { order.push(sql); return db.__q; });
    db.__q.limit = jest.fn(async () => []);
    db.raw.mockClear();
    await NotificationService.getAdminDoneNotifications({ role: 'admin' });
    const raws = db.raw.mock.calls.map(([sql]) => sql);
    expect(raws).toContain('done_at::text AS done_at_token');
    expect(raws.some((sql) => /AS reopenable$/.test(sql) && sql.includes('done_by'))).toBe(true);
    expect(order).toEqual(['done_at DESC, id DESC']);
  });
});
