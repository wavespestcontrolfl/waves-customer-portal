/**
 * P2 (07-19 admin audit): the admin PUT /:id/read endpoint called markRead(id)
 * with no recipient scope, so an admin could clear a CUSTOMER's notification by
 * id. markReadAdmin scopes the update to recipient_type 'admin' (the shared
 * admin queue) so customer rows are off-limits.
 */

jest.mock('../models/db', () => {
  const q = { where: jest.fn(() => q), update: jest.fn(async () => 1) };
  const db = jest.fn(() => q);
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
