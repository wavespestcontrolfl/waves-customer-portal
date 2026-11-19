// Query compilation only; no database connection or provider credentials.
const mockQueries = [];
let mockCountRows = [];
let mockPluck = () => [];
let mockDistinct = () => [];
jest.mock('../models/db', () => {
  const knex = require('knex')({ client: 'pg' });
  const db = (table) => {
    const query = knex(table);
    query.then = (resolve, reject) => {
      const compiled = query.toSQL();
      mockQueries.push(compiled);
      const result = compiled.method === 'update' ? 0
        : compiled.method === 'pluck' ? mockPluck(compiled)
          : (compiled.sql.startsWith('select distinct') ? mockDistinct(compiled) : { conversations: 2, messages: 5 });
      return Promise.resolve(result).then(resolve, reject);
    };
    return query;
  };
  db.raw = (sql, bindings) => {
    if (typeof sql === 'string' && sql.includes('WITH canonical_sms AS MATERIALIZED')) {
      mockQueries.push({ sql, bindings, method: 'raw' });
      return Promise.resolve({ rows: mockCountRows });
    }
    return knex.raw(sql, bindings);
  };
  return db;
});
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
const { countUnreadInboundSms, markInboundSmsRead, markAllInboundSmsRead } = require('../services/inbound-sms-read');
beforeEach(() => { mockQueries.length = 0; mockCountRows = []; mockPluck = () => []; mockDistinct = () => []; });
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

// Owner 2026-11-19 ("Mark Texts Read" A): the badge counts a needs-a-reply text only while nobody has read it.
test('the badge count drops needs-a-reply texts somebody already read; a thread with one unread text still counts', async () => {
  mockCountRows = [
    { id: 'read-1', peer: '9415550100', message_body: 'Can you call me?' },
    { id: 'unread-1', peer: '9415550101', message_body: 'The gate is locked' },
    { id: 'read-2', peer: '9415550101', message_body: 'Also the side yard' },
  ];
  mockPluck = (compiled) => (compiled.sql.includes('"is_read" = ?') ? ['read-1', 'read-2'] : []);
  expect(await countUnreadInboundSms({ role: 'admin', unreadOnly: true })).toEqual({ conversations: 1, messages: 1 });
  const readLookup = mockQueries.find((q) => q.method === 'pluck');
  expect(readLookup.sql).toContain('from "messages" where "id" in');
  expect(readLookup.bindings).toEqual(expect.arrayContaining(['read-1', 'unread-1', 'read-2', true]));
});

test('Mark all read selects unread inbound texts up to the boundary, never recruiting replies, then reads them through the one writer', async () => {
  mockPluck = (compiled) => (compiled.sql.includes('"messages" as "m"') ? ['m-1', 'm-2'] : []);
  const readBefore = new Date('2026-11-19T12:00:00Z');
  await markAllInboundSmsRead({ readBefore, role: 'admin', adminUserId: 'admin-1', excludePhones: ['+19415550199'] });
  const select = mockQueries.find((q) => q.method === 'pluck' && q.sql.includes('"messages" as "m"'));
  // The client stamp is millisecond-rounded: the cutoff takes the whole millisecond. It compares the time the inbox
  // shows (an opt-out receipt can date a text earlier than its row).
  expect(select.sql).toContain('LEFT JOIN inbound_sms_optout_receipts r');
  expect(select.sql).toMatch(/THEN LEAST\(m\.created_at, r\.applied_at\)\s+ELSE m\.created_at END\) < \?/);
  expect(select.bindings).toContainEqual(new Date(readBefore.getTime() + 1));
  expect(select.sql).toContain('"m"."message_type" not like ?');
  expect(select.sql).not.toContain('"c"."customer_id" in');
  // The inbox log's internal-phone exclusion: either side of the thread, or the customer's phone.
  expect(select.sql).toContain('not "c"."our_endpoint_id" = ?');
  expect(select.sql).toContain('(not "c"."contact_phone" = ? or "c"."contact_phone" is null)');
  expect(select.sql).toContain('(not "cu"."phone" = ? or "cu"."phone" is null)');
  expect(select.bindings).toEqual(expect.arrayContaining(['sms', 'inbound', 'job\\_%', '+19415550199']));
  // A blocked sender's texts stay unread, matched on the badge's peer identity.
  // The sender is the inbox's per-text identity: the linked legacy row's sender first.
  expect(select.sql).toContain(') legacy ON true');
  expect(select.sql).toMatch(/not exists \(select 1 from "blocked_numbers" as "b" where .*b\.number.* = .*COALESCE\(NULLIF\(legacy\.from_phone, ''\)/s);
  // A digitless legacy block normalizes to '' like a contactless text, so it never matches one.
  expect(select.sql).toMatch(/not exists \(select 1 from "blocked_numbers" as "b" where .*b\.number.*<> ''/s);
  // A backlog-reset tagged row joins the scope so the writer strips its rollback tag.
  expect(select.sql).toContain(`or jsonb_exists(COALESCE(m.metadata, '{}'::jsonb), 'backlog_reset')`);
  const read = mockQueries.find((q) => q.method === 'update' && q.sql.includes('"read_by_admin_user_id" = ?'));
  expect(read.sql).toContain('"id" in (?, ?)');
  expect(read.bindings).toEqual(expect.arrayContaining(['m-1', 'm-2', 'admin-1']));
});

test('Mark all read sends a long backlog to the writer in batches of 500, rechecking every rule before a later batch', async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `m-${i}`);
  // A later batch's recheck finds one text out of scope (say, a route change while the backlog ran).
  const idBindings = (compiled) => compiled.bindings.filter((b) => typeof b === 'string' && b.startsWith('m-'));
  mockPluck = (compiled) => {
    // The writer's own scope check (a technician's customers) keeps the batch it was handed.
    if (compiled.sql.startsWith('select "id" from "messages" where "id" in')) return idBindings(compiled);
    if (!compiled.sql.includes('"messages" as "m"')) return [];
    if (!compiled.sql.includes('"m"."id" in')) return ids;
    return idBindings(compiled).filter((b) => b !== 'm-700');
  };
  await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T12:00:00Z'), role: 'technician', customerIds: ['owned-customer'] });
  const rechecks = mockQueries.filter((q) => q.method === 'pluck' && q.sql.includes('"m"."id" in'));
  expect(rechecks).toHaveLength(2);
  for (const q of rechecks) expect(q.sql).toContain('"c"."customer_id" in (?)');
  // The write itself carries the technician's customers, not only the selection before it.
  const reads0 = mockQueries.filter((q) => q.method === 'update' && q.sql.includes('"read_by_admin_user_id" = ?'));
  for (const q of reads0) expect(q.sql).toContain('"conversation_id" in (select "id" from "conversations" where "customer_id" in (?))');
  const reads = mockQueries.filter((q) => q.method === 'update' && q.sql.includes('"read_by_admin_user_id" = ?'));
  expect(reads.map((q) => q.bindings.filter((b) => typeof b === 'string' && b.startsWith('m-')).length)).toEqual([500, 499, 201]);
  expect(reads[1].bindings).not.toContain('m-700');
});

test('Mark all read never reaches past now, and a technician scope reads only its own customers', async () => {
  const future = new Date(Date.now() + 86400000);
  await markAllInboundSmsRead({ readBefore: future, role: 'technician', customerIds: ['owned-customer'] });
  const select = mockQueries.find((q) => q.method === 'pluck' && q.sql.includes('"messages" as "m"'));
  expect(select.sql).toContain('inner join "conversations" as "c" on "c"."id" = "m"."conversation_id"');
  expect(select.sql).toContain('"c"."customer_id" in (?)');
  const boundary = select.bindings.find((b) => b instanceof Date);
  expect(boundary.getTime()).toBeLessThanOrEqual(Date.now() + 1);
  // Nothing unread: no write at all.
  expect(mockQueries.some((q) => q.method === 'update')).toBe(false);
  await expect(markAllInboundSmsRead({ readBefore: new Date('nope'), role: 'admin' })).rejects.toThrow('readBefore required');
});

test("a technician's read checks its customers inside the write and inside each bell step, not from the id snapshot", async () => {
  mockPluck = (compiled) => {
    if (compiled.sql.startsWith('select "id" from "messages" where "id" in')) return ['m-1'];
    if (compiled.sql.startsWith('select "twilio_sid" from "messages"')) return ['SM-1'];
    return [];
  };
  mockDistinct = (compiled) => (compiled.sql.includes('"conversation_id"') ? [{ conversation_id: 'conv-1' }] : []);
  await markInboundSmsRead({ messageIds: ['m-1'], role: 'technician', customerIds: ['owned-customer'] });
  const owned = '"conversation_id" in (select "id" from "conversations" where "customer_id" in (?))';
  expect(mockQueries.find((q) => q.method === 'update' && q.sql.includes('"read_by_admin_user_id" = ?')).sql).toContain(owned);
  expect(mockQueries.find((q) => q.sql.includes('"conversations" as "cv"')).sql).toContain('"cv"."customer_id" in (?)');
  // The legacy mirror write carries the technician's customers inside the statement.
  const ownedSids = '"twilio_sid" in (select "twilio_sid" from "messages" where "twilio_sid" is not null and "conversation_id" in (select "id" from "conversations" where "customer_id" in (?)))';
  expect(mockQueries.find((q) => q.method === 'update' && q.sql.startsWith('update "sms_log" set "is_read"')).sql).toContain(ownedSids);
  // Bells use the SIDs still on its customers when reconciliation starts.
  expect(mockQueries.some((q) => q.sql.startsWith('select "twilio_sid" from "messages" where "twilio_sid" in (?) and "conversation_id" in (select "id" from "conversations" where "customer_id" in (?))'))).toBe(true);
  // The backlog-marker strip's customer list.
  expect(mockQueries.find((q) => /^select distinct "customer_id".* from "conversations" where "id" in/.test(q.sql)).sql)
    .toContain('and "customer_id" in (?)');
});

test("a row's Mark read reads one sender's texts by the inbox's sender identity, recruiting replies included", async () => {
  await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T12:00:00Z'), role: 'admin', contactPhone: '(941) 555-0100' });
  const select = mockQueries.find((q) => q.method === 'pluck' && q.sql.includes('"messages" as "m"'));
  expect(select.sql).toMatch(/COALESCE\(NULLIF\(legacy\.from_phone, ''\).* = \?/s);
  expect(select.bindings).toContain('9415550100');
  expect(select.sql).not.toContain('"m"."message_type" not like ?');
  await expect(markAllInboundSmsRead({ readBefore: new Date(), role: 'admin', contactPhone: 'front desk' })).rejects.toThrow('contactPhone');
});

test("a technician's row read never selects a recruiting reply, even for one sender", async () => {
  await markAllInboundSmsRead({ readBefore: new Date('2026-11-19T12:00:00Z'), role: 'technician', contactPhone: '+19415550100', customerIds: ['owned-customer'] });
  const select = mockQueries.find((q) => q.method === 'pluck' && q.sql.includes('"messages" as "m"'));
  expect(select.sql).toContain('("m"."message_type" is null or "m"."message_type" not like ?)');
});
