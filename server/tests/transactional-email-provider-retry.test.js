jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(),
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(),
  activeSuppressionFor: jest.fn(),
  redactEmailAddresses: jest.fn((value) => String(value).replace(/\b[^\s@]+@[^\s@]+\b/g, '[redacted-email]')),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const retry = require('../services/transactional-email-provider-retry');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const emailTemplates = require('../services/email-template-library');

const message = (overrides = {}) => ({
  id: 'message-1',
  template_key: 'quote.request_received',
  recipient_type: 'customer',
  recipient_email_snapshot: 'customer@example.com',
  subject_snapshot: 'We received your request',
  suppression_group_key_snapshot: 'service_operational',
  categories: ['email_template'],
  has_attachments: false,
  provider_retry_count: 0,
  ...overrides,
});

describe('transactional email provider retry classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql) => sql);
  });

  test('recognizes both SendGrid provider-block event shapes', () => {
    expect(retry.isProviderBlockedEvent({ event: 'blocked' })).toBe(true);
    expect(retry.isProviderBlockedEvent({ event: 'bounce', type: 'blocked' })).toBe(true);
    expect(retry.isProviderBlockedEvent({ event: 'bounce', type: 'bounce' })).toBe(false);
    expect(retry.isProviderBlockedEvent({ event: 'dropped' })).toBe(false);
  });

  test('only exact-body transactional snapshots are eligible', () => {
    expect(retry.isTransactionalRetryEligible(message())).toBe(true);
    expect(retry.isTransactionalRetryEligible(message({ has_attachments: true }))).toBe(false);
    expect(retry.isTransactionalRetryEligible(message({ recipient_type: 'test' }))).toBe(false);
    expect(retry.isTransactionalRetryEligible(message({ suppression_group_key_snapshot: 'marketing_referral' }))).toBe(false);
    expect(retry.isTransactionalRetryEligible(message({ categories: ['bounce_recovery'] }))).toBe(false);
    expect(retry.isTransactionalRetryEligible(message({ subject_snapshot: null }))).toBe(false);
  });

  test('schedules 10 minute, 1 hour, and 6 hour backoff slots', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    for (const [count, delay] of retry.RETRY_DELAYS_MS.entries()) {
      expect(retry.retryStateForProviderBlock(message({ provider_retry_count: count }), now)).toEqual({
        provider_retry_next_at: new Date(now.getTime() + delay),
        provider_retry_exhausted_at: null,
      });
    }
  });

  test('marks the message exhausted after the third retry', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    expect(retry.retryStateForProviderBlock(message({ provider_retry_count: 3 }), now)).toEqual({
      provider_retry_next_at: null,
      provider_retry_exhausted_at: now,
    });
  });

  test('never schedules excluded messages', () => {
    expect(retry.retryStateForProviderBlock(message({ has_attachments: true }))).toEqual({});
  });

  test('rechecks suppression, clears only the provider block, then replays the stored snapshot', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'sent' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-2' });

    const stored = message({
      send_attempt_token: 'attempt-2',
      from_email_snapshot: 'contact@example.com',
      from_name_snapshot: 'Waves',
      reply_to_snapshot: 'reply@example.com',
      html_snapshot: '<p>Exact stored body</p>',
      text_snapshot: 'Exact stored body',
    });
    const result = await retry.retryOne(stored);

    expect(result.sent).toBe(true);
    expect(emailTemplates.activeSuppressionFor).toHaveBeenCalled();
    expect(sendgrid.clearBlockedAddress).toHaveBeenCalledWith('customer@example.com');
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'customer@example.com',
      subject: 'We received your request',
      html: '<p>Exact stored body</p>',
      text: 'Exact stored body',
      customArgs: { email_message_id: 'message-1', send_attempt_token: 'attempt-2' },
      suppressErrorLog: true,
    }));
    expect(sendgrid.clearBlockedAddress.mock.invocationCallOrder[0])
      .toBeLessThan(sendgrid.sendOne.mock.invocationCallOrder[0]);
  });

  test('stops without touching SendGrid when the recipient became suppressed', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'blocked' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue({ suppression_type: 'bounce' });

    const result = await retry.retryOne(message({ send_attempt_token: 'attempt-2' }));

    expect(result).toMatchObject({ sent: false, stopped: true });
    expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('recovers interrupted retry-worker claims after the stale window', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.whereNull = jest.fn(() => chain);
    chain.update = jest.fn(async () => 1);
    db.mockReturnValue(chain);
    const now = new Date('2026-07-16T12:30:00Z');

    await expect(retry.recoverStaleClaims(now)).resolves.toBe(1);

    expect(chain.where).toHaveBeenCalledWith({ status: 'queued' });
    expect(chain.where).toHaveBeenCalledWith('provider_retry_count', '>', 0);
    expect(chain.where).toHaveBeenCalledWith('queued_at', '<=', new Date('2026-07-16T12:20:00Z'));
    expect(chain.whereNull).toHaveBeenCalledWith('provider_message_id');
    expect(chain.whereNull).toHaveBeenCalledWith('sent_at');
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      provider_retry_next_at: now,
      provider_retry_count: 'GREATEST(provider_retry_count - 1, 0)',
    }));
  });
});
