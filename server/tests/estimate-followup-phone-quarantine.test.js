// B18: the follow-up cron's shared sender skips the SMS leg when the estimate's typed phone is quarantined
// for its customer (a contradicted accept kept another customer's number on the estimate), logs it, and
// still sends the email leg; an ordinary estimate still texts.

jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    const q = {};
    ['where', 'whereIn', 'whereNull', 'andWhere'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (table === 'customers' ? mockDb._customer : null));
    q.insert = jest.fn(async () => {});
    q.then = (resolve, reject) => Promise.resolve(null).then(resolve, reject);
    return q;
  });
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb._customer = null;
  return mockDb;
});
jest.mock('../services/estimate-conversion-guard', () => ({ customerConvertedSince: jest.fn(async () => ({ converted: false })) }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19413180000') }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: jest.fn((s) => s),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendDualChannel } = require('../services/estimate-follow-up')._private;
const { CONTRADICTED_PHONE_NOTE_MARK } = require('../services/estimate-phone-quarantine');

const EST = {
  id: 'est-q1', customer_id: 'cust-1', customer_phone: '+19415550123', customer_email: 'c@example.com',
  created_at: '2026-08-01T00:00:00Z',
};
const EMAIL = { templateKey: 'estimate.followup_unviewed', stage: 'unviewed', payload: {} };

beforeEach(() => {
  jest.clearAllMocks();
  db._customer = null;
});

test('a quarantined estimate phone: the SMS leg is skipped and logged, the email leg still goes', async () => {
  db._customer = { id: 'cust-1', phone: '', internal_notes: `Phone ${CONTRADICTED_PHONE_NOTE_MARK}.` };
  const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
  expect(attempted).toBe(true);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SMS leg skipped for estimate est-q1'));
});

test('control: an unmarked customer still gets the text', async () => {
  db._customer = { id: 'cust-1', phone: '', internal_notes: null };
  await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage.mock.calls[0][0].to).toBe(EST.customer_phone);
});

test('an UNLINKED group sibling re-armed after a contradicted accept (stamp only, no customer_id) is skipped by the cron sender; fixing its phone lifts it', async () => {
  const sibling = {
    ...EST, id: 'est-q-sibling', customer_id: null,
    estimate_data: { acceptPhoneDispute: { key: '9415550123', rejectedCustomerId: 'cust-bob' } },
  };
  await sendDualChannel(sibling, { sms: 'Follow-up body', email: EMAIL });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);

  await sendDualChannel({ ...sibling, customer_phone: '+19415550188' }, { sms: 'Follow-up body', email: EMAIL });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});
