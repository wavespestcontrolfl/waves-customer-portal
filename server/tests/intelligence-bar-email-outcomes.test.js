// Controlled provider results; no messages leave this test.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
const db = require('../models/db');
const gmail = require('../services/email/gmail-client');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { executeEmailTool } = require('../services/intelligence-bar/email-tools');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');

beforeEach(() => {
  jest.clearAllMocks();
  const email = { id: 'email-fixture', from_address: 'fixture@example.invalid', subject: 'Fixture', gmail_thread_id: 'thread-fixture', customer_id: 'customer-fixture' };
  const customer = { id: 'customer-fixture', first_name: 'Synthetic', last_name: 'Fixture', phone: '+15550101234' };
  db.mockImplementation(table => {
    const chain = { where: jest.fn(() => chain), first: jest.fn(async () => table === 'emails' ? email : customer), update: jest.fn(async () => 1) };
    return chain;
  });
  db.raw = jest.fn();
});

test('Gmail acceptance yields a provider receipt, never a delivered claim', async () => {
  gmail.sendMessage.mockResolvedValue({ id: 'gmail-fixture' });
  const result = await executeEmailTool('send_email_reply', { email_id: 'email-fixture', body: 'Synthetic reply' });
  expect(result).toMatchObject({ success: true, state: 'provider_accepted', providerMessageId: 'gmail-fixture' });
  expect(executionOutcome(result)).toBe('provider_accepted');
});

test('a missing Gmail message ID remains unknown', async () => {
  gmail.sendMessage.mockResolvedValue({});
  const result = await executeEmailTool('send_email_reply', { email_id: 'email-fixture', body: 'Synthetic reply' });
  expect(executionOutcome(result)).toBe('outcome_unknown');
});

test('an SMS reply keeps provider acceptance and its ID', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'sms-fixture', auditLogId: 'audit-fixture' });
  const result = await executeEmailTool('reply_via_sms', { customer_id: 'customer-fixture', message: 'Synthetic reply' });
  expect(result).toMatchObject({ success: true, state: 'provider_accepted', providerMessageId: 'sms-fixture', auditLogId: 'audit-fixture' });
  expect(executionOutcome(result)).toBe('provider_accepted');
});

test('an accepted SMS with a failed audit remains accepted with a warning', async () => {
  const failure = new Error('Synthetic audit failure');
  failure.providerOutcome = { sent: true, providerMessageId: 'sms-fixture' };
  sendCustomerMessage.mockRejectedValue(failure);
  const result = await executeEmailTool('reply_via_sms', { customer_id: 'customer-fixture', message: 'Synthetic reply' });
  expect(result).toMatchObject({ success: true, state: 'provider_accepted', providerMessageId: 'sms-fixture', warning: expect.any(String) });
  expect(executionOutcome(result)).toBe('provider_accepted');
});

test('an inbox update failing after SMS acceptance cannot turn the send into a failed receipt', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'sms-fixture' });
  const original = db.getMockImplementation();
  db.mockImplementation(table => {
    const chain = original(table);
    chain.update.mockRejectedValue(new Error('Synthetic inbox failure'));
    return chain;
  });
  const result = await executeEmailTool('reply_via_sms', { email_id: 'email-fixture', message: 'Synthetic reply' });
  expect(result).toMatchObject({ success: true, state: 'provider_accepted', partial: true, providerMessageId: 'sms-fixture', warning: expect.any(String) });
  expect(executionOutcome(result)).toBe('partially_completed');
});
