jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const notifications = require('../services/notification-service');
const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');
const knex = require('knex')({ client: 'pg' });

const retire = jest.fn();
const retireStatements = [];
const query = {};
beforeEach(() => {
  jest.clearAllMocks();
  retireStatements.length = 0;
  retire.mockResolvedValue(1);
  for (const method of ['join', 'whereNotNull', 'whereNull', 'whereIn', 'where', 'forNoKeyUpdate']) {
    query[method] = jest.fn(() => query);
  }
  query.select = jest.fn(async () => []);
  query.first = jest.fn(async () => ({ id: 's1' }));
  db.transaction = jest.fn(async (run) => run(db));
  db.mockImplementation((table) => {
    if (table !== 'notifications') return query;
    // Compile the real PostgreSQL update, including the correlated subquery;
    // no connection is opened and no DB execution is claimed by this test.
    const cleanup = knex(table);
    const update = cleanup.update.bind(cleanup);
    cleanup.update = (values) => {
      retireStatements.push(update(values).toSQL());
      return retire(values);
    };
    return cleanup;
  });
});

test('unplaced visits are escalated before the lock window through the existing deduped admin bell', async () => {
  query.select = jest.fn(async () => [{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }]);
  notifications.notifyAdmin.mockResolvedValue({ id: 'notice1' });

  await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-05T16:00:00Z'));
  expect(query.where).toHaveBeenCalledWith('s.recurring_dispatch_due_date', '<=', '2026-08-23');
  expect(query.whereNull).toHaveBeenCalledWith('s.window_start');
  expect(notifications.notifyAdmin).toHaveBeenCalledWith(
    'schedule_conflict', expect.any(String), expect.stringContaining('2026-08-20'),
    expect.objectContaining({ bell: true, dedupeKey: 'recurring-dispatch:s1:2026-08-20', refreshOnDedupe: true, trx: db }),
  );
  // A failed notification must fail the pass, rather than reporting a clean run.
  notifications.notifyAdmin.mockResolvedValue(null);
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).rejects.toThrow('could not be recorded');
});

test('a visit placed after the scan raises no alert and is not counted as flagged', async () => {
  query.select.mockResolvedValue([{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }]);
  query.first.mockResolvedValue(null);
  expect(await flagUnplacedVisits({ lockWindowDays: 14 })).toBe(0);
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
});

test('a pass with no pending placement still retires obsolete lane alerts', async () => {
  const now = new Date('2026-08-05T16:00:00Z');
  expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(0);
  expect(retire).toHaveBeenCalledWith(expect.objectContaining({ read_at: now, title: 'Recurring placement alert resolved' }));
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  const { sql, bindings } = retireStatements[0];
  expect(sql).toContain('not exists (select "s"."id" from "scheduled_services" as "s"');
  expect(sql).toContain("s.id::text = notifications.metadata->>'scheduledServiceId'");
  expect(sql).toContain("s.recurring_dispatch_due_date::text = notifications.metadata->>'dueDate'");
  expect(sql).toContain('"s"."window_start" is null');
  expect(sql).not.toContain('"read_at" is null');
  expect(sql).toContain('not "title" = ?');
  expect(bindings).toEqual(expect.arrayContaining(['admin', 'schedule_conflict', 'recurring-dispatch:%', 'pending', 'confirmed']));
});

test('retirement failure fails the pass and the next run retries it', async () => {
  retire.mockRejectedValueOnce(new Error('notification store unavailable'));
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).rejects.toThrow('notification store unavailable');
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).resolves.toBe(0);
  expect(retire).toHaveBeenCalledTimes(2);
});
