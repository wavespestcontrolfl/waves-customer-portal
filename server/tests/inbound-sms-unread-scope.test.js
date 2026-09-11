// Query compilation only; no database connection or provider credentials.
const mockQueries = [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const db = (table) => {
    const query = knex(table);
    query.then = (resolve, reject) => {
      mockQueries.push(query.toSQL());
      return Promise.resolve({ conversations: 2, messages: 5 }).then(resolve, reject);
    };
    return query;
  };
  db.raw = knex.raw.bind(knex);
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));
const { countUnreadInboundSms } = require('../services/inbound-sms-read');
beforeEach(() => { mockQueries.length = 0; });
test('global counts retain their scope and separate units', async () => {
  expect(await countUnreadInboundSms()).toEqual({ conversations: 2, messages: 5 });
  expect(mockQueries[0].sql).not.toContain('and "conversations"."customer_id" = ?');
  expect(mockQueries[0].sql).toContain('"messages"."is_read" is null');
  expect(mockQueries[0].bindings).toEqual(['sms', 'inbound', false, 1]);
});
test('a blocked (marked-spam) sender never counts toward the badge', async () => {
  await countUnreadInboundSms();
  expect(mockQueries[0].sql).toContain('not exists (select 1 from "blocked_numbers"');
});
test('customer counts bind the account id and retain unread exclusions', async () => {
  const customerId = '00000000-0000-4000-8000-000000000001';
  const internalPhone = '+19415550199';
  await countUnreadInboundSms({ customerId, excludePhones: [internalPhone] });
  expect(mockQueries[0].sql).toContain('and "conversations"."customer_id" = ?');
  expect(mockQueries[0].sql).not.toContain(customerId);
  expect(mockQueries[0].bindings).toEqual(['sms', 'inbound', false, customerId, internalPhone, internalPhone, internalPhone, 1]);
});
