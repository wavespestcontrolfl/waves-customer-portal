// A known sender's sms_reply bell links /admin/communications?thread=<id> and,
// when the message is known, appends &message=<sid> so the page scrolls to
// that message. Rows written before that carry the bare thread link, so the
// read-state matcher must accept both and never another customer's thread.
const mockQueries = [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const db = (table) => {
    const query = knex(table);
    query.then = (resolve, reject) => { mockQueries.push(query.toSQL()); return Promise.resolve(0).then(resolve, reject); };
    return query;
  };
  db.raw = (...args) => knex.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const NotificationService = require('../services/notification-service');

beforeEach(() => { mockQueries.length = 0; });

test('markInboundSmsReadAdmin matches the thread link bare or with &message=, bound to exactly that customer', async () => {
  await NotificationService.markInboundSmsReadAdmin({ customerId: 'cust-1', role: 'admin' });
  const update = mockQueries.find((q) => q.method === 'update');
  expect(update.sql).toContain("split_part(link, '&message=', 1) = ?");
  expect(update.bindings).toContain('/admin/communications?thread=cust-1');
  expect(update.bindings.filter((v) => String(v).includes('message='))).toEqual([]);
});
