// Query compilation only; no database connection or provider credentials.
const mockQueries = [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const db = (table) => {
    const query = knex(table);
    query.then = (resolve, reject) => {
      const compiled = query.toSQL();
      mockQueries.push(compiled);
      const result = compiled.method === 'update' ? 0
        : (compiled.method === 'pluck' || compiled.sql.startsWith('select distinct') ? [] : { conversations: 2, messages: 5 });
      return Promise.resolve(result).then(resolve, reject);
    };
    return query;
  };
  db.raw = knex.raw.bind(knex);
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
const { countUnreadInboundSms, markInboundSmsRead } = require('../services/inbound-sms-read');
beforeEach(() => { mockQueries.length = 0; });
test('global counts retain their scope and separate units', async () => {
  expect(await countUnreadInboundSms({ role: 'admin' })).toEqual({ conversations: 2, messages: 5 });
  expect(mockQueries[0].sql).not.toContain('and "conversations"."customer_id" = ?');
  expect(mockQueries[0].sql).toContain('"messages"."is_read" is null');
  expect(mockQueries[0].bindings).toEqual(['sms', 'inbound', false, 1]);
});
test('a blocked (marked-spam) sender never counts toward the badge', async () => {
  await countUnreadInboundSms({ role: 'admin' });
  expect(mockQueries[0].sql).toContain('not exists (select 1 from "blocked_numbers"');
});
test('customer counts bind the account id and retain unread exclusions', async () => {
  const customerId = '00000000-0000-4000-8000-000000000001';
  const internalPhone = '+19415550199';
  await countUnreadInboundSms({ customerId, excludePhones: [internalPhone], role: 'admin' });
  expect(mockQueries[0].sql).toContain('and "conversations"."customer_id" = ?');
  expect(mockQueries[0].sql).not.toContain(customerId);
  expect(mockQueries[0].bindings).toEqual(['sms', 'inbound', false, customerId, internalPhone, internalPhone, internalPhone, 1]);
});


test('a read request matching no inbound SIDs cannot update any bell or legacy row', async () => {
  expect(await markInboundSmsRead({ messageIds: ['missing-message'], role: 'technician' }))
    .toEqual({ updated: 0, notificationsCleared: 0 });
  const mirror = mockQueries.find(query => query.method === 'update' && query.sql.startsWith('update "sms_log"'));
  expect(mirror.sql).toContain('and 1 = ?');
  expect(mirror.bindings).toContain(0);
  expect(mockQueries.some(query => query.sql.includes('"notifications"'))).toBe(false);
  expect(mockQueries.some(query => query.sql.includes('"messages" as "m"'))).toBe(false);
});
