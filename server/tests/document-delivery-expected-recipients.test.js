/**
 * deliverDocumentRequestChannels with expectedRecipientKeys (the Mark accepted consumer notice card,
 * GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND): a channel goes out only to the recipient the card confirmed. The check
 * runs on the recipient delivery itself prepared, before the link is activated or anything is sent.
 * Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockWrites = [];
let mockRequestRow;
jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereNull', 'whereIn', 'select', 'orderBy', 'forUpdate']) q[m] = () => q;
    q.first = async () => {
      if (table === 'customer_contracts as cc') return mockRequestRow;
      if (table === 'customer_contracts') return { ...mockRequestRow };
      return null;
    };
    q.update = async (payload) => { mockWrites.push({ table, op: 'update', payload }); return 1; };
    q.insert = async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; };
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.transaction = async (cb) => cb(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true, sendOne: jest.fn().mockResolvedValue({ messageId: 'sg-1' }), serviceGroupId: () => null,
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true, providerMessageId: 'tw-1' }),
}));

const sendgrid = require('../services/sendgrid-mail');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { deliverDocumentRequestChannels } = require('../services/document-contract-delivery');
const { recipientKey } = require('../services/estimate-accept-effects');

const EMAIL = 'pat@example.com';
const PHONE = '+19415550100';

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  mockRequestRow = {
    id: 'contract-1', customer_id: 'cust-1', contract_type: 'document_template', status: 'sent',
    document_template_key: 'consumer_notice.fdacs_13692', title: 'Consumer Notice Form (FDACS-13692)', requires_signature_snapshot: true,
    customer_first_name: 'Pat', customer_last_name: 'Owner', customer_email: EMAIL, customer_phone: PHONE, template_expire_after_days: 14,
  };
});

const sentEmail = () => sendgrid.sendOne.mock.calls.length > 0;
const activated = () => mockWrites.some((w) => w.table === 'customer_contracts' && w.op === 'update');

test('matching keys: both channels go out', async () => {
  const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, {
    channels: ['email', 'sms'], expectedRecipientKeys: { email: recipientKey(EMAIL), sms: recipientKey(PHONE) },
  });
  expect(result.ok).toBe(true);
  expect(sentEmail()).toBe(true);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE }));
});

test('the email changed after it was confirmed: that channel is refused, the other still goes out', async () => {
  mockRequestRow.customer_email = 'someone.else@example.com';
  const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, {
    channels: ['email', 'sms'], expectedRecipientKeys: { email: recipientKey(EMAIL), sms: recipientKey(PHONE) },
  });
  expect(result.deliveries.find((d) => d.channel === 'email')).toMatchObject({ ok: false, code: 'RECIPIENT_CHANGED' });
  expect(sentEmail()).toBe(false);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('every recipient changed: nothing is activated or sent', async () => {
  mockRequestRow.customer_email = 'someone.else@example.com';
  mockRequestRow.recipient_phone = '+19415550199';
  mockRequestRow.customer_phone = '+19415550199';
  const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, {
    channels: ['email', 'sms'], expectedRecipientKeys: { email: recipientKey(EMAIL), sms: recipientKey(PHONE) },
  });
  expect(result.ok).toBe(false);
  expect(result.deliveries.map((d) => d.code)).toEqual(['RECIPIENT_CHANGED', 'RECIPIENT_CHANGED']);
  expect(activated()).toBe(false);
  expect(sentEmail()).toBe(false);
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('without expected keys, delivery is unchanged', async () => {
  mockRequestRow.customer_email = 'someone.else@example.com';
  const result = await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, { channels: ['email'] });
  expect(result.ok).toBe(true);
  expect(sendgrid.sendOne.mock.calls[0][0]).toMatchObject({ to: 'someone.else@example.com' });
});

test('a text held for the send window records the send that queued it, so the replay can recheck its gate', async () => {
  sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-10-27T12:00:00.000Z' });
  await deliverDocumentRequestChannels('contract-1', { actorType: 'system' }, { channels: ['sms'], smsEntryPoint: 'manual_accept_consumer_notice' });
  const queued = mockWrites.find((w) => w.table === 'sms_log' && w.op === 'insert');
  expect(JSON.parse(queued.payload.metadata)).toMatchObject({ entry_point: 'document_request_reminder_deferred', origin_entry_point: 'manual_accept_consumer_notice' });
});
