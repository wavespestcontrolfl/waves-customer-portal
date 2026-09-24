// Query compilation only; no database connection or provider credentials.
const mockQueries = [];
let mockCountRows = [];
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
  db.raw = (sql, bindings) => {
    if (typeof sql === 'string' && sql.includes('WITH base_sms AS')) {
      mockQueries.push({ sql, bindings, method: 'raw' });
      return Promise.resolve({ rows: mockCountRows });
    }
    return knex.raw(sql, bindings);
  };
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
const { countUnreadInboundSms, markInboundSmsRead } = require('../services/inbound-sms-read');
beforeEach(() => { mockQueries.length = 0; mockCountRows = []; });
test('global count dedupes actionable endpoint threads by peer and ignores read state', async () => {
  mockCountRows = [
    { peer: '9415550100', endpoint: '9415550190', message_body: 'Can you call me?' },
    { peer: '9415550100', endpoint: '9415550191', message_body: 'The gate is locked' },
    { peer: '9415550101', endpoint: '9415550190', message_body: 'Thanks!', prior_outbound_body: 'The work is complete.' },
  ];
  expect(await countUnreadInboundSms({ role: 'admin' })).toEqual({ conversations: 1, messages: 2 });
  expect(mockQueries[0].sql).not.toContain('is_read');
  expect(mockQueries[0].sql).toContain('DISTINCT ON');
  expect(mockQueries[0].sql).toContain("os.delivery_status IN ('queued', 'sent', 'delivered')");
  expect(mockQueries[0].bindings.customerId).toBeNull();
});
test('a blocked (marked-spam) sender never counts toward the badge', async () => {
  await countUnreadInboundSms({ role: 'admin' });
  expect(mockQueries[0].sql).toContain('FROM blocked_numbers b');
});
test('customer counts bind account/internal scope and preserve response policy types', async () => {
  const customerId = '00000000-0000-4000-8000-000000000001';
  const internalPhone = '+19415550199';
  await countUnreadInboundSms({ customerId, excludePhones: [internalPhone], role: 'admin' });
  expect(mockQueries[0].sql).toContain('c.customer_id = CAST(:customerId AS uuid)');
  expect(mockQueries[0].bindings).toMatchObject({
    customerId,
    excludePhones: [internalPhone],
    humanReplyTypes: ['manual', 'ai_approved', 'ai_revised', 'ai_assistant', 'ai_assistant_reply'],
    ignoredInboundTypes: ['opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply'],
  });
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
