jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => () => require('../models/db'));
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
jest.mock('../services/visit-completion-summary', () => ({
  retrySummaryThroughHandoff: jest.fn(async (message, dispatch) => { await dispatch(); return { ok: true }; }),
  reconcileSummaryEmailRecovery: jest.fn(async () => ({ reconciled: true })),
  reconcileSummaryEmailBounce: jest.fn(async () => ({ reconciled: true })),
}));

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
    // Uncertain settlements commit with their summary reconciliation.
    db.transaction = jest.fn(async (cb) => cb(db));
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
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
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

  test('a visit summary retry is refused before the handoff when its recipient is no longer current', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'blocked' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    const summary = require('../services/visit-completion-summary');
    summary.retrySummaryThroughHandoff.mockResolvedValueOnce({ ok: false, reason: 'visit_summary_recipient_changed' });

    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
      send_attempt_token: 'attempt-2' });
    const result = await retry.retryOne(stored);

    expect(result).toMatchObject({ sent: false, stopped: true, reason: 'Suppressed before retry: visit_summary_recipient_changed' });
    expect(summary.retrySummaryThroughHandoff).toHaveBeenCalledWith(stored, expect.any(Function));
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', provider_retry_next_at: null }));
    expect(summary.reconcileSummaryEmailRecovery).toHaveBeenCalledTimes(1);
    expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a visit summary retry whose provider request throws after the handoff settles as uncertain, never requeued', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'failed', template_key: 'service.visit_summary', recipient_email_snapshot: 'a@example.com' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.sendOne.mockRejectedValue(new Error('socket hang up'));
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
      send_attempt_token: 'attempt-4', provider_retry_count: 0 });
    expect(await retry.retryOne(stored)).toMatchObject({ sent: false, uncertain: true });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', provider_retry_next_at: null,
      error_message: expect.stringMatching(/^Provider outcome unknown/) }));
    expect(chain.update).not.toHaveBeenCalledWith(expect.objectContaining({ provider_retry_next_at: expect.any(Date) }));
    // The uncertain settlement reopens the summary for office review, like an exhausted retry.
    expect(require('../services/visit-completion-summary').reconcileSummaryEmailBounce)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1', template_key: 'service.visit_summary' }), db);
  });

  test('a failure clearing the provider block before the visit summary request keeps the ordinary retry schedule', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'failed' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockRejectedValueOnce(new Error('unblock timed out'));
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
      send_attempt_token: 'attempt-5', provider_retry_count: 0 });
    expect(await retry.retryOne(stored)).toMatchObject({ sent: false });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', provider_retry_next_at: expect.any(Date) }));
  });

  test('a visit summary retry whose bookkeeping fails after SendGrid accepted settles as uncertain, never requeued', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue([{ id: 'message-1', status: 'failed' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-9' });
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
      send_attempt_token: 'attempt-6', provider_retry_count: 0 });
    expect(await retry.retryOne(stored)).toMatchObject({ sent: false, uncertain: true });
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', provider_retry_next_at: null,
      error_message: expect.stringMatching(/^Provider outcome unknown/) }));
    expect(chain.update).not.toHaveBeenCalledWith(expect.objectContaining({ provider_retry_next_at: expect.any(Date) }));
  });

  test('a visit summary retry stopped by the suppression ledger settles its summary aggregate', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'blocked', template_key: 'service.visit_summary' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue({ suppression_type: 'do_not_email' });
    const summary = require('../services/visit-completion-summary');
    summary.reconcileSummaryEmailRecovery.mockClear();
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001', send_attempt_token: 'attempt-7' });
    expect(await retry.retryOne(stored)).toMatchObject({ sent: false, stopped: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    // The ledger terminalization and the summary settlement commit
    // together (Codex #4303 r6 P2): the reconcile call now rides the same
    // transaction as the email_messages update, not a call of its own.
    expect(summary.reconcileSummaryEmailRecovery).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id, status: 'blocked' }), db);
  });

  test('a stopped visit summary retry never reports terminalized when its summary reconcile fails, so the transaction has something to roll back', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'blocked', template_key: 'service.visit_summary' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue({ suppression_type: 'do_not_email' });
    const summary = require('../services/visit-completion-summary');
    summary.reconcileSummaryEmailRecovery.mockRejectedValueOnce(new Error('reconcile down'));
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001', send_attempt_token: 'attempt-10' });
    // Never terminalizes the ledger row silently: a failed reconcile must
    // surface so the transaction wrapping both writes has something to
    // fail on (the real db.transaction rolls back; this mock only proves
    // the error is no longer swallowed by a standalone .catch).
    await expect(retry.retryOne(stored)).rejects.toThrow('reconcile down');
  });

  test('a failed uncertain settlement after an ambiguous provider throw is retried once and never requeued', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    let uncertainWrites = 0;
    let failNextReturning = false;
    chain.returning = jest.fn(async () => {
      if (failNextReturning) { failNextReturning = false; throw new Error('pg blip on the uncertain settlement'); }
      return [{ id: 'message-1', status: 'failed' }];
    });
    chain.update = jest.fn((data) => {
      if (typeof data.error_message === 'string' && data.error_message.startsWith('Provider outcome unknown')) {
        uncertainWrites += 1;
        if (uncertainWrites === 1) failNextReturning = true;
      }
      return chain;
    });
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    db.mockReturnValue(chain);
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.sendOne.mockRejectedValue(new Error('socket hang up'));
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001', send_attempt_token: 'attempt-9' });
    expect(await retry.retryOne(stored)).toMatchObject({ sent: false, uncertain: true });
    expect(uncertainWrites).toBe(2);
    // No retry schedule was ever written for the row.
    expect(chain.update.mock.calls.some(([data]) => data.provider_retry_next_at instanceof Date)).toBe(false);
  });

  test('a visit summary retry marks the handoff as started before contacting SendGrid, and stale-claim recovery settles such a row as uncertain', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.whereNull = jest.fn(() => chain);
    chain.whereNot = jest.fn(() => chain);
    chain.orWhereNot = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'sent' }]);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    db.mockReturnValue(chain);
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-8' });
    // The retry's handoff mock receives no transaction; the marker is written before it on the root handle.
    const stored = message({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001', send_attempt_token: 'attempt-8' });
    expect((await retry.retryOne(stored)).sent).toBe(true);
    // The reclaimable pre-provider marker precedes the held handoff; the started marker is written at the Mail Send boundary, before the request.
    const pending = chain.update.mock.calls.findIndex(([data]) => data.error_message === retry.HANDOFF_PENDING);
    const marker = chain.update.mock.calls.findIndex(([data]) => data.error_message === retry.HANDOFF_STARTED);
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(pending);
    expect(chain.where).toHaveBeenCalledWith(expect.objectContaining({ error_message: retry.HANDOFF_PENDING, status: 'queued' }));
    expect(chain.update.mock.invocationCallOrder[marker]).toBeLessThan(sendgrid.sendOne.mock.invocationCallOrder[0]);
    // Recovery: a started handoff settles as uncertain; other stale claims requeue.
    chain.update.mockClear();
    chain.select = jest.fn(async () => [{ id: 'message-1', send_attempt_token: 'attempt-8' }]);
    await retry.recoverStaleClaims();
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ provider_retry_next_at: null, provider_retry_exhausted_at: expect.any(Date),
      error_message: expect.stringMatching(/^Provider outcome unknown/) }));
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ error_message: 'Interrupted provider retry claim recovered' }));
  });

  test('other templates never consult the visit summary fence', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'sent' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-3' });
    expect((await retry.retryOne(message({ send_attempt_token: 'attempt-3' }))).sent).toBe(true);
    expect(require('../services/visit-completion-summary').retrySummaryThroughHandoff).not.toHaveBeenCalled();
  });

  test('stops without touching SendGrid when the recipient became suppressed', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
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
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    // The uncertain settlement selects its claims and settles each in its own transaction.
    chain.select = jest.fn(async () => [{ id: 'stale-summary', send_attempt_token: 'attempt-9' }]);
    chain.returning = jest.fn(async () => [{ id: 'stale-summary', status: 'failed', template_key: 'service.visit_summary' }]);
    db.mockReturnValue(chain);
    const now = new Date('2026-07-16T12:30:00Z');

    // Two recovery updates run (started handoffs settle as uncertain, the
    // rest requeue); the fake yields one row for each.
    await expect(retry.recoverStaleClaims(now)).resolves.toBe(2);
    expect(require('../services/visit-completion-summary').reconcileSummaryEmailBounce)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'stale-summary' }), db);
    expect(db.transaction).toHaveBeenCalled();

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
