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

// A shared thread row (dedupeKey sms-thread:<customerId>) stands for every text
// from the customer. Reading one message must never clear it while other texts
// are unread: a SID alone never touches it, and a customer-wide clear checks
// that no unread inbound text is left on any business number.
describe('shared thread row (sms-thread:<customerId>) read state', () => {
  const updateSql = () => mockQueries.find((q) => q.method === 'update');

  test('a clear by message SID leaves thread rows alone', async () => {
    await NotificationService.markInboundSmsReadAdmin({ twilioSid: 'SM-latest', role: 'admin' });
    const { sql, bindings } = updateSql();
    expect(sql).toContain("NOT (COALESCE(metadata->>'dedupeKey', '') LIKE 'sms-thread:%')");
    expect(sql).toContain("metadata->'payload'->>'twilioSid' = ANY(?)");
    expect(sql).not.toContain('EXISTS');
    expect(bindings).toContainEqual(['SM-latest']);
  });

  test('a customer-wide clear (thread open, post-write read check) clears a thread row only when no unread inbound text remains', async () => {
    await NotificationService.markInboundSmsReadAdmin({ customerId: 'cust-1', twilioSid: 'SM-latest', role: 'admin' });
    const { sql, bindings } = updateSql();
    // Thread rows are matched by link and the whole-customer unread check, not by the SID.
    expect(sql).toMatch(/NOT \(COALESCE\(metadata->>'dedupeKey', ''\) LIKE 'sms-thread:%'\) OR NOT \(\s*\(\s*EXISTS/);
    expect(sql).toContain('uc.customer_id = ?');
    expect(sql).toContain('ul.customer_id = ?');
    expect(sql).toContain("(COALESCE(metadata->>'dedupeKey', '') LIKE 'sms-thread:%' OR metadata->'payload'->>'twilioSid' = ANY(?))");
    expect(bindings.filter((v) => v === 'cust-1')).toHaveLength(2);
  });

  test('the unread check covers every conversation of the customer, so a second business number counts', async () => {
    await NotificationService.markInboundSmsReadAdmin({ customerId: 'cust-1', role: 'admin' });
    const { sql } = updateSql();
    expect(sql).toContain('JOIN conversations uc ON uc.id = um.conversation_id');
    expect(sql).not.toMatch(/conversation_id = /);
  });

  // Hidden recruiting replies (message_type job_*) are not the customer's texts
  // and never ring this bell, so one unread must not hold the thread row open.
  test('the unread check leaves out recruiting rows, on unified and legacy sources', async () => {
    await NotificationService.markInboundSmsReadAdmin({ customerId: 'cust-1', role: 'admin' });
    const { sql } = updateSql();
    expect(sql).toContain("(um.message_type IS NULL OR um.message_type NOT LIKE 'job\\_%')");
    expect(sql).toContain("(ul.message_type IS NULL OR ul.message_type NOT LIKE 'job\\_%')");
  });
});
