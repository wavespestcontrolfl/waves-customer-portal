jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const notifications = require('../services/notification-service');
const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');

beforeEach(() => jest.clearAllMocks());

test('unplaced visits are escalated before the lock window through the existing deduped admin bell', async () => {
  const query = {};
  for (const method of ['join', 'whereNotNull', 'whereNull', 'whereIn', 'where']) {
    query[method] = jest.fn(() => query);
  }
  query.select = jest.fn(async () => [{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }]);
  db.mockReturnValue(query);
  notifications.notifyAdmin.mockResolvedValue({ id: 'notice1' });

  await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-05T16:00:00Z'));
  expect(query.where).toHaveBeenCalledWith('s.recurring_dispatch_due_date', '<=', '2026-08-23');
  expect(query.whereNull).toHaveBeenCalledWith('s.window_start');
  expect(notifications.notifyAdmin).toHaveBeenCalledWith(
    'schedule_conflict', expect.any(String), expect.stringContaining('2026-08-20'),
    expect.objectContaining({ bell: true, dedupeKey: 'recurring-dispatch:s1:2026-08-20' }),
  );
  // A failed notification must fail the pass, rather than reporting a clean run.
  notifications.notifyAdmin.mockResolvedValue(null);
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).rejects.toThrow('could not be recorded');
});
