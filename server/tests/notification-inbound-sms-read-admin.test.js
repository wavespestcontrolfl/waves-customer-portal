// markInboundSmsReadAdmin and the shared customer thread bell (one row per
// customer conversation, dedupeKey sms-thread:<customerId>): a message SID
// never clears the thread row, and a customer-wide clear clears it only when
// no unread inbound text from that customer is left. These assert the query
// each call shape builds, which is the whole rule.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockCalls;
jest.mock('../models/db', () => {
  const builder = () => {
    const b = {
      where(...args) { mockCalls.push(['where', ...args]); return b; },
      whereNull(col) { mockCalls.push(['whereNull', col]); return b; },
      whereRaw(sql, bindings) { mockCalls.push(['whereRaw', sql, bindings]); return b; },
      update: async (patch) => { mockCalls.push(['update', patch]); return 1; },
    };
    return b;
  };
  return jest.fn(() => builder());
});

const NotificationService = require('../services/notification-service');

const raws = () => mockCalls.filter((c) => c[0] === 'whereRaw');

beforeEach(() => { mockCalls = []; });

test('nothing to clear without a customer or a SID', async () => {
  expect(await NotificationService.markInboundSmsReadAdmin({})).toBe(0);
  expect(mockCalls).toEqual([]);
});

test('a customer-wide clear keeps the thread row while the customer still has an unread inbound text', async () => {
  await NotificationService.markInboundSmsReadAdmin({ customerId: 'c-1' });
  const [link, thread] = raws();
  expect(link[2]).toEqual(['/admin/communications?thread=c-1']);
  expect(thread[1]).toContain("LIKE 'sms-thread:%'");
  expect(thread[1]).toMatch(/NOT \(\(\s*EXISTS/);
  expect(thread[2]).toEqual(['c-1', 'c-1']);
  expect(mockCalls.at(-1)[0]).toBe('update');
});

test('a SID alone never clears a thread row (only per-text bells match it)', async () => {
  await NotificationService.markInboundSmsReadAdmin({ twilioSid: 'SM1' });
  const [sid] = raws();
  expect(sid[1]).toMatch(/^\(NOT \(.*sms-thread:%.*\) AND metadata->'payload'->>'twilioSid' = ANY\(\?\)\)$/);
  expect(sid[2]).toEqual([['SM1']]);
});

test('a customer clear with SIDs keeps the thread row in scope under the unread-text guard', async () => {
  await NotificationService.markInboundSmsReadAdmin({ customerId: 'c-2', twilioSids: ['SM2', 'SM3'] });
  const sid = raws().at(-1);
  expect(sid[1]).toMatch(/^\(COALESCE.*sms-thread:%.* OR metadata->'payload'->>'twilioSid' = ANY\(\?\)\)$/);
  expect(sid[2]).toEqual([['SM2', 'SM3']]);
});
