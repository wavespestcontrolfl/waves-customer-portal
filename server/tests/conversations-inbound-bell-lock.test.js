// The unified inbound insert must serialize with unknown-sender bell clears.
const mockLocks = [];
const mockInsertedMessages = [];
const mockMessagePatches = [];
let mockExistingMessage = null;
jest.mock('../models/db', () => {
  const trx = (table) => {
    let returnedRow = null;
    const q = {
      where: () => q,
      first: async () => (table === 'messages' ? mockExistingMessage : null),
      insert: (row) => {
        if (table === 'messages') {
          mockInsertedMessages.push(row);
          returnedRow = { id: 'message-1', ...row };
        }
        return q;
      },
      returning: async () => [returnedRow || { id: 'message-1' }],
      update: (patch) => {
        if (table === 'messages') {
          mockMessagePatches.push(patch);
          returnedRow = { ...mockExistingMessage, ...patch };
        }
        return q;
      },
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
  authorType: 'customer', twilioSid: 'SM-new', contactPhone: '+12025550101',
  ourEndpointId: '+19415550100', body: 'Synthetic text' };
beforeEach(() => {
  mockLocks.length = 0;
  mockInsertedMessages.length = 0;
  mockMessagePatches.length = 0;
  mockExistingMessage = null;
});

test('inbound SMS inserts take the read-clear phone lock before writing the message', async () => {
  await appendMessage(base);
  expect(mockLocks).toEqual([
    'message:sms:SM-new',
    'inbound_sms_bell_retarget:+12025550101',
  ]);
  expect(JSON.parse(mockInsertedMessages[0].metadata)).toEqual({
    sms_contact_phone: '+12025550101',
    sms_our_endpoint_id: '+19415550100',
  });
});

test('outbound and non-SMS messages do not contend with inbound bell clearing', async () => {
  await appendMessage({ ...base, direction: 'outbound', metadata: {
    source: 'send', sms_contact_phone: 'caller-value', sms_our_endpoint_id: 'caller-value',
  } });
  expect(mockLocks).toEqual(['message:sms:SM-new']);
  expect(JSON.parse(mockInsertedMessages[0].metadata)).toEqual({
    source: 'send',
    sms_contact_phone: '+12025550101',
    sms_our_endpoint_id: '+19415550100',
  });
  mockLocks.length = 0;
  await appendMessage({ ...base, channel: 'email' });
  expect(mockLocks).toEqual(['message:email:SM-new']);
  expect(JSON.parse(mockInsertedMessages[1].metadata)).toEqual({});
});

test('SMS SID retries preserve the original endpoint identity during metadata updates', async () => {
  mockExistingMessage = {
    id: 'message-existing',
    metadata: {
      source: 'original',
      sms_contact_phone: '+12025550101',
      sms_our_endpoint_id: '+19415550100',
    },
  };

  await appendMessage({
    ...base,
    contactPhone: '+12025550999',
    ourEndpointId: '+19415550999',
    deliveryStatus: 'delivered',
    metadata: {
      retry: 2,
      sms_contact_phone: '+12025550999',
      sms_our_endpoint_id: '+19415550999',
    },
  });

  expect(mockMessagePatches[0].delivery_status).toBe('delivered');
  expect(JSON.parse(mockMessagePatches[0].metadata)).toEqual({
    retry: 2,
    sms_contact_phone: '+12025550101',
    sms_our_endpoint_id: '+19415550100',
  });
});

test('SMS SID retries retain endpoint identity when retry options are missing', async () => {
  mockExistingMessage = {
    id: 'message-existing',
    metadata: JSON.stringify({
      sms_contact_phone: '+12025550101',
      sms_our_endpoint_id: '+19415550100',
    }),
  };
  const withoutEndpointOptions = { ...base };
  delete withoutEndpointOptions.contactPhone;
  delete withoutEndpointOptions.ourEndpointId;

  await appendMessage({
    ...withoutEndpointOptions,
    direction: 'outbound',
    metadata: { retry: 3 },
  });

  expect(JSON.parse(mockMessagePatches[0].metadata)).toEqual({
    retry: 3,
    sms_contact_phone: '+12025550101',
    sms_our_endpoint_id: '+19415550100',
  });
});
