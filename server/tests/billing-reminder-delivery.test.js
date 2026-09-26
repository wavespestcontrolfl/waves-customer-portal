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
      query.whereIn = jest.fn((_column, ids) => { query.ids = ids; return query; });
      query.update = jest.fn(async ({ metadata }) => {
        const patch = JSON.parse(metadata.bindings[0]);
        for (const row of rows.filter((candidate) => query.ids.includes(candidate.id))) {
          row.metadata.policy_waived_channels = patch;
        }
        return query.ids.length;
      });
      query.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return query;
    });
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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

  test('each leg is sent with its own reservation', async () => {
    const send = jest.fn().mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });

    await deliver(['email', 'push'], send);

    expect(send.mock.calls.map(([channel, entry]) => [channel, entry.id])).toEqual([
      ['email', 'ledger-1'], ['push', 'ledger-2'],
    ]);
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

  test('a terminal Email refusal resolves its leg without claiming delivery', async () => {
    const send = jest.fn(async (channel) => (channel === 'email'
      ? { ok: false, skipped: true, reason: 'missing_email', deliveryOutcome: 'not_sent' }
      : { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: true, deliveredNow: ['sms'] });
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: true, deliveredNow: [] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms']);
    const email = rows.find((row) => row.channel === 'email').metadata;
    expect(email).toMatchObject({ send_failed: true, resolved: true, resolution: 'email_terminal_refusal' });
    expect(email.delivered).toBeUndefined();
  });

  test.each([
    'NO_EMAIL_RECIPIENT',
    'BILLING_EMAIL_NOT_SELECTED',
    'BILLING_EMAIL_DISABLED',
    'EMAIL_SUPPRESSED',
  ])('canonical permanent Email refusal %s resolves without claiming delivery', async (code) => {
    const send = jest.fn(async (channel) => (channel === 'email'
      ? { sent: false, blocked: true, code, deliveryOutcome: 'not_sent' }
      : { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send, `canonical:${code}`))
      .resolves.toMatchObject({ complete: true, deliveredNow: ['sms'] });
    await expect(deliver(['email', 'sms'], send, `canonical:${code}`))
      .resolves.toMatchObject({ complete: true, deliveredNow: [] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms']);
    const email = rows.find((row) => row.channel === 'email').metadata;
    expect(email).toMatchObject({ send_failed: true, resolved: true, resolution: 'email_terminal_refusal' });
    expect(email.delivered).toBeUndefined();
  });

  test('held Email with accepted App and Text keeps Email pending without repeating it', async () => {
    const held = Object.assign(new Error('provider retry owns this message'), {
      providerOutcome: {
        sent: false,
        held: true,
        retryable: true,
        deliveryOutcome: 'uncertain',
        code: 'EMAIL_PROVIDER_RETRY_HELD',
      },
    });
    const send = jest.fn(async (channel) => {
      if (channel === 'email') throw held;
      return { sent: true, deliveryOutcome: 'accepted', auditLogId: `audit-${channel}` };
    });

    await expect(deliver(['email', 'push', 'sms'], send, 'held-email'))
      .resolves.toMatchObject({ complete: false, deliveredNow: ['push', 'sms'] });
    await expect(deliver(['email', 'push', 'sms'], send, 'held-email')).resolves.toMatchObject({
      complete: false,
      deliveredNow: [],
      results: { email: expect.objectContaining({ deliveryHeld: true }) },
    });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'push', 'sms']);
    expect(rows.find((row) => row.channel === 'email').metadata).toEqual(expect.not.objectContaining({
      delivered: expect.anything(), resolved: expect.anything(), send_failed: expect.anything(),
    }));
  });

  test.each(['held', 'deliveryHeld'])('%s not-sent Email outcome cannot release or resolve its reservation', async (marker) => {
    const send = jest.fn(async (channel) => (channel === 'email'
      ? {
        sent: false,
        blocked: true,
        code: 'EMAIL_SUPPRESSED',
        deliveryOutcome: 'not_sent',
        [marker]: true,
      }
      : { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send, `held-marker:${marker}`))
      .resolves.toMatchObject({ complete: false, deliveredNow: ['sms'] });
    await expect(deliver(['email', 'sms'], send, `held-marker:${marker}`))
      .resolves.toMatchObject({ complete: false, deliveredNow: [] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms']);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(rows.find((row) => row.channel === 'email').metadata)
      .toEqual(expect.not.objectContaining({ resolved: expect.anything(), delivered: expect.anything() }));
  });

  test('canonical retryable Email refusal stays unresolved and retries after Text delivers', async () => {
    const send = jest.fn(async (channel) => (channel === 'email'
      ? { sent: false, blocked: true, retryable: true, code: 'BILLING_PREFS_UNAVAILABLE', deliveryOutcome: 'not_sent' }
      : { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send, 'retryable-email'))
      .resolves.toMatchObject({ complete: false, deliveredNow: ['sms'] });
    await expect(deliver(['email', 'sms'], send, 'retryable-email'))
      .resolves.toMatchObject({ complete: false, deliveredNow: [] });

    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms', 'email']);
    expect(rows.find((row) => row.channel === 'email').metadata)
      .toEqual(expect.not.objectContaining({ resolved: expect.anything(), delivered: expect.anything() }));
  });

  test('an uncertain Email outcome keeps its reservation held rather than retryable', async () => {
    const send = jest.fn(async (channel) => (channel === 'email'
      ? { ok: false, deliveryOutcome: 'uncertain', error: 'socket hang up' }
      : { sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: false });
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({
      complete: false, results: { email: expect.objectContaining({ deliveryHeld: true }) },
    });
    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['email', 'sms']);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  });

  test('a spacing-window Email denial stays owed after Text delivers', async () => {
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (channel === 'email'
      ? { allowed: false, durable: false } : { allowed: true, durable: false }));
    const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: false, deliveredNow: ['sms'] });
    expect(rows.find((row) => row.channel === 'sms').metadata.policy_waived_channels).toBeUndefined();
  });

  test('a durably denied Email is waived once Text delivers, and never settles an episode alone', async () => {
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (channel === 'email'
      ? { allowed: false, durable: true } : { allowed: true, durable: false }));
    const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));

    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: true, deliveredNow: ['sms'] });
    expect(rows.find((row) => row.channel === 'sms').metadata.policy_waived_channels).toEqual(['email']);
    // A later sweep reads the episode as settled rather than pending forever.
    const { reminderProgress } = require('../services/billing-reminder-delivery');
    await expect(reminderProgress('customer-1', 'balance_reminder_workflow', ['email', 'sms']))
      .resolves.toEqual([expect.objectContaining({ complete: true })]);
    expect(send.mock.calls.map(([channel]) => channel)).toEqual(['sms']);

    collectionsChannelPermitted.mockResolvedValue({ allowed: false, durable: true });
    await expect(deliver(['email', 'sms'], send, 'invoice-1:firm')).resolves.toMatchObject({ complete: false, deliveredNow: [] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a durable Email denial after Text already delivered is persisted before settling', async () => {
    const { reminderProgress } = require('../services/billing-reminder-delivery');
    const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (channel === 'email'
      ? { allowed: false, durable: false } : { allowed: true, durable: false }));
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: false, deliveredNow: ['sms'] });

    // A do-not-email flag lands later: no new leg is written this run.
    collectionsChannelPermitted.mockResolvedValue({ allowed: false, durable: true });
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: true, deliveredNow: [] });
    expect(rows.find((row) => row.channel === 'sms').metadata.policy_waived_channels).toEqual(['email']);
    await expect(reminderProgress('customer-1', 'balance_reminder_workflow', ['email', 'sms']))
      .resolves.toEqual([expect.objectContaining({ complete: true })]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('an unpersisted waiver never reports the episode settled', async () => {
    const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', auditLogId: 'audit-sms' }));
    collectionsChannelPermitted.mockImplementation(async ({ channel }) => (channel === 'email'
      ? { allowed: false, durable: false } : { allowed: true, durable: false }));
    await deliver(['email', 'sms'], send);
    collectionsChannelPermitted.mockResolvedValue({ allowed: false, durable: true });
    db.raw.mockImplementationOnce(() => { throw new Error('connection terminated'); });
    await expect(deliver(['email', 'sms'], send)).resolves.toMatchObject({ complete: false });
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

  test.each(['sms', 'push'])('a success-shaped %s suppression stays pending until delivery is accepted', async (channel) => {
    const send = jest.fn()
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'not_sent', code: 'GATE_DISABLED' })
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' });

    await expect(deliver([channel], send)).resolves.toMatchObject({ complete: false, deliveredNow: [] });
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledTimes(1);

    await expect(deliver([channel], send)).resolves.toMatchObject({ complete: true, deliveredNow: [channel] });
    expect(send).toHaveBeenCalledTimes(2);
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
