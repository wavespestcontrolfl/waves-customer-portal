// The unified inbound insert must serialize with unknown-sender bell clears.
const mockLocks = [];
jest.mock('../models/db', () => {
  const trx = (table) => {
    const q = {
      where: () => q,
      first: async () => null,
      insert: () => q,
      returning: async () => [{ id: 'message-1' }],
      update: async () => 1,
    };
    if (!['messages', 'conversations'].includes(table)) throw new Error(`unexpected table: ${table}`);
    return q;
  };
  trx.raw = async (_sql, args) => { mockLocks.push(args?.[0]); return {}; };
  const db = jest.fn();
  db.transaction = async (work) => work(trx);
  return db;
});
jest.mock('../services/logger', () => ({ error: jest.fn() }));

const { appendMessage } = require('../services/conversations');
const base = { conversationId: 'conversation-1', channel: 'sms', direction: 'inbound',
  authorType: 'customer', twilioSid: 'SM-new', contactPhone: '+12025550101', body: 'Synthetic text' };
beforeEach(() => { mockLocks.length = 0; });

test('inbound SMS inserts take the read-clear phone lock before writing the message', async () => {
  await appendMessage(base);
  expect(mockLocks).toEqual([
    'message:sms:SM-new',
    'inbound_sms_bell_retarget:+12025550101',
  ]);
});

test('outbound and non-SMS messages do not contend with inbound bell clearing', async () => {
  await appendMessage({ ...base, direction: 'outbound' });
  expect(mockLocks).toEqual(['message:sms:SM-new']);
  mockLocks.length = 0;
  await appendMessage({ ...base, channel: 'email' });
  expect(mockLocks).toEqual(['message:email:SM-new']);
});
