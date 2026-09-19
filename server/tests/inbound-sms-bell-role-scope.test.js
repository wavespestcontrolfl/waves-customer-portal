// Compile the actual retarget/clear UPDATE paths without a database/provider.
const mockQueries = [];
let mockRemaining;
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const trx = (table) => {
    const query = knex(table);
    query.then = (resolve, reject) => {
      mockQueries.push(query.toSQL());
      return Promise.resolve(table === 'messages as m' ? mockRemaining : 0).then(resolve, reject);
    };
    return query;
  };
  trx.raw = (sql, ...args) => /^(SET LOCAL|SELECT pg_advisory)/.test(sql)
    ? Promise.resolve({}) : knex.raw(sql, ...args);
  return { transaction: async work => work(trx) };
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ TRIGGER_REGISTRY: {
  sms_reply: { techVisible: true }, owner_only: { techVisible: false },
} }));
const { retargetOrClearUnknownSenderBell } = require('../services/inbound-sms-read');

beforeEach(() => { mockQueries.length = 0; });
test.each([true, false])('technician bell update is fail-closed with remaining sibling=%s', async remaining => {
  mockRemaining = remaining ? { twilio_sid: 'SM-unread' } : null;
  await retargetOrClearUnknownSenderBell('+19415550100', new Date(), 'technician');
  const update = mockQueries.find(query => query.method === 'update');
  expect(update).toBeDefined();
  expect(update.sql).toContain("COALESCE(metadata->>'triggerKey', '') IN (?)");
  expect(update.bindings).toContain('sms_reply');
  expect(update.bindings).not.toContain('owner_only');
});
test.each(['admin', undefined])('authorized role=%s retains the full sender-bell scope', async role => {
  mockRemaining = null;
  await retargetOrClearUnknownSenderBell('+19415550100', new Date(), role);
  const update = mockQueries.find(query => query.method === 'update');
  expect(update).toBeDefined();
  expect(update.sql).not.toContain("metadata->>'triggerKey'");
});
