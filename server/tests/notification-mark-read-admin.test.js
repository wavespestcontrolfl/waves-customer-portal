/**
 * P2 (07-19 admin audit): the admin PUT /:id/read endpoint called markRead(id)
 * with no recipient scope, so an admin could clear a CUSTOMER's notification by
 * id. markReadAdmin scopes the update to recipient_type 'admin' (the shared
 * admin queue) so customer rows are off-limits.
 */

jest.mock('../models/db', () => {
  const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), whereNull: jest.fn(() => q), update: jest.fn(async () => 1) };
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
  });

  test('stamps done and read on admin rows not yet done, with a plain, 200-character resolution', async () => {
    const count = await NotificationService.markAdminDone(['a', 'a', 'b'], { by: 'claude', resolution: `  Fixed \u{1F600}   in PR  ${'word '.repeat(80)}` });
    expect(count).toBe(2);
    expect(db.__q.whereIn).toHaveBeenCalledWith('id', ['a', 'b']);
    expect(db.__q.where).toHaveBeenCalledWith({ recipient_type: 'admin' });
    expect(db.__q.whereNull).toHaveBeenCalledWith('done_at');
    const patch = db.__q.update.mock.calls[0][0];
    expect(patch).toMatchObject({ done_at: expect.any(Date), done_by: 'claude', read_at: expect.any(String) });
    expect(patch.resolution).toMatch(/^Fixed in PR word word.*…$/);
    expect(patch.resolution.length).toBeLessThanOrEqual(200);
  });

  test('writes nothing without ids or an actor', async () => {
    expect(await NotificationService.markAdminDone([], { by: 'claude' })).toBe(0);
    expect(await NotificationService.markAdminDone(['a'], {})).toBe(0);
    expect(db.__q.update).not.toHaveBeenCalled();
  });
});
