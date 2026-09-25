jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(),
  claimAttempt: jest.fn(),
  markDelivered: jest.fn(),
  markSendFailed: jest.fn(),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(),
}));

const db = require('../models/db');
const ContactLedger = require('../services/collections/contact-ledger');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const { sendReminderChannels } = require('../services/billing-reminder-delivery');

describe('billing reminder per-channel delivery progress', () => {
  let rows;

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    db.mockImplementation((table) => {
      if (table !== 'collections_contact_ledger') throw new Error(`Unexpected table ${table}`);
      const query = { where: jest.fn(() => query) };
      query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return query;
    });
    collectionsChannelPermitted.mockResolvedValue(true);
    ContactLedger.recordContact.mockImplementation(async (input) => {
      let row = rows.find((candidate) => candidate.idempotency_key === input.idempotencyKey);
      if (row) return { id: row.id, metadata: { ...row.metadata }, reused: true };
      row = {
        id: `ledger-${rows.length + 1}`,
        customer_id: input.customerId,
        channel: input.channel,
        purpose: input.purpose,
        source: input.source,
        occurred_at: new Date(),
        idempotency_key: input.idempotencyKey,
        metadata: { ...input.metadata },
      };
      rows.push(row);
      return { id: row.id, metadata: { ...row.metadata } };
    });
    ContactLedger.claimAttempt.mockImplementation(async (entry) => {
      const row = rows.find((candidate) => candidate.id === entry.id);
      if (entry.metadata.delivered) return { allowed: false, delivered: true };
      if (!entry.reused) return { allowed: true };
      if (!entry.metadata.send_failed) return { allowed: false, held: true };
      row.metadata.send_failed = false;
      return { allowed: true };
    });
    ContactLedger.markDelivered.mockImplementation(async (entry) => {
      rows.find((candidate) => candidate.id === entry.id).metadata.delivered = true;
      return true;
    });
    ContactLedger.markSendFailed.mockImplementation(async (entry, extra) => {
      Object.assign(rows.find((candidate) => candidate.id === entry.id).metadata, { send_failed: true, ...extra });
      return true;
    });
  });

  const deliver = (channels, send, eventKey = 'invoice-1:gentle') => sendReminderChannels({
    customerId: 'customer-1', invoiceId: 'invoice-1', source: 'balance_reminder_workflow',
    purpose: 'balance_reminder', eventKey, channels, metadata: { tier: 'gentle' }, send,
  });

  test('Email acceptance and deferred App resume App only', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-email' })
      .mockResolvedValueOnce({ sent: false, deferred: true, deliveryOutcome: 'not_sent', code: 'APP_DEFERRED' })
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-push' });

    await expect(deliver(['email', 'push'], send)).resolves.toMatchObject({ complete: false, deliveredNow: ['email'] });
    await expect(deliver(['email', 'push'], send)).resolves.toMatchObject({ complete: true, deliveredNow: ['push'] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'push', 'push']);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'email', metadata: expect.objectContaining({ delivered: true, notificationEventKey: 'invoice-1:gentle' }) }),
      expect.objectContaining({ channel: 'push', metadata: expect.objectContaining({ delivered: true, selectedChannels: ['email', 'push'] }) }),
    ]));
  });

  test('accepted Text is not repeated while failed Email is retried', async () => {
    const send = jest.fn(async (channel) => {
      if (channel === 'email' && send.mock.calls.length === 1) return { sent: false, deliveryOutcome: 'not_sent', code: 'EMAIL_FAILED' };
      return { sent: true, deliveryOutcome: 'accepted', auditLogId: `audit-${channel}` };
    });

    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: false, deliveredNow: ['sms'] });
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: true, deliveredNow: ['email'] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms', 'email']);
    expect(ContactLedger.claimAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      reused: true, metadata: expect.objectContaining({ send_failed: true }),
    }));
    expect(rows.find((row) => row.channel === 'email').metadata)
      .toMatchObject({ send_failed: false, delivered: true });
  });

  test('an unstamped acceptance is held and never sent twice', async () => {
    ContactLedger.markDelivered.mockResolvedValueOnce(false);
    const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['sms'], send)).resolves.toMatchObject({
      complete: false, results: { sms: expect.objectContaining({ code: 'REMINDER_ACCEPTANCE_UNSTAMPED' }) },
    });
    await expect(deliver(['sms'], send)).resolves.toMatchObject({
      complete: false, results: { sms: expect.objectContaining({ deliveryHeld: true }) },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  });

  test('a Text-specific denial preserves selected Email and App; a global hold sends nothing', async () => {
    const send = jest.fn(async (channel) => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: `audit-${channel}` }));
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => channel !== 'sms');

    await expect(deliver(['email', 'push', 'sms'], send, 'channel-hold')).resolves.toMatchObject({
      complete: false, deliveredNow: ['email', 'push'],
      results: { sms: expect.objectContaining({ code: 'COLLECTIONS_POLICY' }) },
    });
    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'push']);
    expect(ContactLedger.recordContact.mock.calls.map(([input]) => input.channel)).toEqual(['email', 'push']);

    send.mockClear();
    collectionsChannelPermitted.mockResolvedValue(false);
    await expect(deliver(['email', 'push', 'sms'], send, 'global-hold')).resolves.toMatchObject({ complete: false });
    expect(send).not.toHaveBeenCalled();
  });
});
