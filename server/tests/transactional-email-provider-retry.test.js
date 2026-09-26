jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(),
  sendOne: jest.fn(),
  isDefiniteRejection: jest.fn((err) => [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(Number(err?.status))),
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
const NotificationService = require('../services/notification-service');

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
  provider_handoff_phase: 'pending',
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
        provider_handoff_phase: 'rejected',
        provider_handoff_attempt_token: null,
      });
    }
  });

  test('marks the message exhausted after the third retry', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    expect(retry.retryStateForProviderBlock(message({ provider_retry_count: 3 }), now)).toEqual({
      provider_retry_next_at: null,
      provider_retry_exhausted_at: now,
      provider_handoff_phase: 'rejected',
      provider_handoff_attempt_token: null,
    });
  });

  test('keeps the retry-state helper compatible with legacy row shapes', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const legacy = message();
    delete legacy.provider_handoff_phase;
    expect(retry.retryStateForProviderBlock(legacy, now)).toEqual({
      provider_retry_next_at: new Date(now.getTime() + (10 * 60 * 1000)),
      provider_retry_exhausted_at: null,
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
    chain.whereRaw = jest.fn(() => chain);
    chain.whereNotNull = jest.fn(() => chain);
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
    expect(chain.where).toHaveBeenCalledWith(expect.objectContaining({ provider_handoff_phase: 'pending', status: 'queued' }));
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
    chain.whereRaw = jest.fn(() => chain);
    chain.whereNotNull = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
    // The uncertain settlement selects its claims and settles each in its own transaction.
    chain.select = jest.fn(async () => [{ id: 'stale-summary', send_attempt_token: 'attempt-9' }]);
    chain.returning = jest.fn(async () => [{ id: 'stale-summary', status: 'failed', template_key: 'service.visit_summary' }]);
    db.mockReturnValue(chain);
    const now = new Date('2026-07-16T12:30:00Z');

    // Two recovery updates run (started handoffs settle as uncertain, the
    // rest requeue); the fake yields one row for each.
    await expect(retry.recoverStaleClaims(now)).resolves.toBe(3);
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

  test('stale recovery emits no exhaustion alert when its settlement CAS is lost', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.whereNull = jest.fn(() => chain);
    chain.whereRaw = jest.fn(() => chain);
    chain.whereNotNull = jest.fn(() => chain);
    chain.update = jest.fn(() => chain);
    chain.returning = jest.fn(async () => []);
    chain.select = jest.fn()
      .mockResolvedValueOnce([{ id: 'lost-claim', send_attempt_token: 'old-token' }])
      .mockResolvedValueOnce([]);
    chain.then = (resolve, reject) => Promise.resolve(0).then(resolve, reject);
    db.mockReturnValue(chain);

    await expect(retry.recoverStaleClaims(new Date())).resolves.toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([400, 429])('a definite provider rejection (%s) records rejected and keeps bounded retry', async (status) => {
    const updates = [];
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn((data) => { updates.push(data); return chain; });
    chain.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    chain.returning = jest.fn(async () => [{ ...message(), status: 'failed' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    sendgrid.sendOne.mockRejectedValue(Object.assign(new Error(`HTTP ${status}`), { status }));

    expect(await retry.retryOne(message({ send_attempt_token: `attempt-${status}` }))).toMatchObject({ sent: false });
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'failed', provider_handoff_phase: 'rejected', provider_retry_next_at: expect.any(Date),
    }));
  });

  test('a pre-request SendGrid configuration failure records rejected and keeps bounded retry', async () => {
    const updates = [];
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn((data) => { updates.push(data); return chain; });
    chain.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    chain.returning = jest.fn(async () => [{ ...message(), status: 'failed' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    sendgrid.sendOne.mockRejectedValue(Object.assign(new Error('SendGrid unavailable'), { code: 'SENDGRID_NOT_CONFIGURED' }));

    expect(await retry.retryOne(message({ send_attempt_token: 'not-configured' }))).toMatchObject({ sent: false });
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'failed', provider_handoff_phase: 'rejected', provider_retry_next_at: expect.any(Date),
    }));
  });

  test.each([408, 500, null])('an ambiguous provider failure (%s) remains started and is never scheduled', async (status) => {
    const updates = [];
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn((data) => { updates.push(data); return chain; });
    chain.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    chain.returning = jest.fn(async () => [{ ...message(), status: 'failed', provider_handoff_phase: 'started' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    sendgrid.sendOne.mockRejectedValue(Object.assign(new Error('provider outcome unavailable'), status == null ? {} : { status }));

    expect(await retry.retryOne(message({ send_attempt_token: `ambiguous-${status}` }))).toMatchObject({ sent: false, uncertain: true });
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'failed', provider_handoff_phase: 'started', provider_retry_next_at: null,
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({ provider_retry_next_at: expect.any(Date) }));
  });

  test('a lost pending-to-started CAS makes no provider call', async () => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn((data) => (data.provider_handoff_phase === 'started' ? Promise.resolve(0) : chain));
    chain.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    chain.returning = jest.fn(async () => []);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });

    expect(await retry.retryOne(message({ send_attempt_token: 'lost-token' })))
      .toEqual({ sent: false, stopped: true, reason: 'claim_lost' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('accepted-send bookkeeping failure remains started and never schedules', async () => {
    const updates = [];
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn((data) => { updates.push(data); return chain; });
    chain.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    chain.returning = jest.fn()
      .mockRejectedValueOnce(new Error('accepted row write failed'))
      .mockResolvedValueOnce([{ ...message(), status: 'failed', provider_handoff_phase: 'started' }]);
    db.mockReturnValue(chain);
    emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'quote.request_received' } });
    emailTemplates.activeSuppressionFor.mockResolvedValue(null);
    sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'accepted-1' });

    expect(await retry.retryOne(message({ send_attempt_token: 'accepted-write-failed' })))
      .toMatchObject({ sent: false, uncertain: true });
    expect(updates).not.toContainEqual(expect.objectContaining({ provider_retry_next_at: expect.any(Date) }));
  });

  describe('annual-offer guard (Codex round 3 on #4608, structural move): automatic provider retries', () => {
    // Codex round 3 on #4608: the annual-offer guard's AUTHORITATIVE check
    // moved to sendgrid.sendOne itself (the true provider boundary) — which
    // this test file mocks away entirely (see the top-of-file jest.mock).
    // These tests therefore simulate sendOne's own refusal contract (an
    // error flagged .annualOfferWithheld / .annualOfferGuardFailed) rather
    // than exercising a real guard query through a fake table-routed db —
    // that content-derivation mechanism now belongs to sendgrid-mail's own
    // test suite. What THIS file must still prove: it calls sendOne with the
    // retried row's stored html/text, and correctly maps sendOne's refusal
    // onto its existing bookkeeping.
    function annualOfferWithheldError() {
      const err = new Error('annual_offer_withheld');
      err.code = 'ANNUAL_OFFER_WITHHELD';
      err.annualOfferWithheld = true;
      err.retryable = false;
      return err;
    }
    function annualOfferGuardFailedError(message = 'estimates lookup unavailable') {
      const err = new Error(`annual offer guard failed: ${message}`);
      err.code = 'ANNUAL_OFFER_GUARD_FAILED';
      err.annualOfferGuardFailed = true;
      return err;
    }

    function emailMessagesChain(returningRow) {
      const chain = {};
      chain.where = jest.fn(() => chain);
      chain.update = jest.fn((payload) => { chain._lastUpdate = payload; return chain; });
      chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
      chain.returning = jest.fn(async () => [returningRow || { id: 'message-1', status: 'blocked' }]);
      return chain;
    }

    beforeEach(() => {
      emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'estimate.expiring_notice' } });
      emailTemplates.activeSuppressionFor.mockResolvedValue(null);
      sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
    });

    test('sendOne refuses as withheld: the retry stops permanently, never re-picked', async () => {
      const messagesChain = emailMessagesChain({ id: 'message-1', status: 'blocked', error_message: 'annual_offer_withheld' });
      db.mockImplementation((table) => {
        if (table === 'email_messages') return messagesChain;
        throw new Error(`unexpected table ${table}`);
      });
      sendgrid.sendOne.mockRejectedValueOnce(annualOfferWithheldError());

      const stored = message({
        template_key: 'estimate.expiring_notice',
        send_attempt_token: 'attempt-annual-1',
        html_snapshot: '<p>Your estimate is expiring: https://portal.wavespestcontrol.com/estimate/synthetic-token-a</p>',
        text_snapshot: 'View it: https://portal.wavespestcontrol.com/estimate/synthetic-token-a',
      });
      const result = await retry.retryOne(stored);

      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
        html: stored.html_snapshot, text: stored.text_snapshot,
        // Round 9 structural fix (P1): templateKey is passed through so
        // sendOne can resolve its own rewrite-vs-refuse policy — a
        // NON-receipt template (estimate.expiring_notice) resolves
        // 'refuse', so a withheld link in it is still refused permanently
        // here, never silently rewritten.
        templateKey: 'estimate.expiring_notice',
      }));
      expect(result).toMatchObject({ sent: false, stopped: true, reason: 'annual_offer_withheld' });
      // stopRetry's own bookkeeping shape: permanent, never re-queued.
      expect(messagesChain._lastUpdate).toEqual(expect.objectContaining({
        status: 'blocked',
        error_message: 'annual_offer_withheld',
        provider_retry_next_at: null,
      }));
      // claimDueRetries requires provider_retry_next_at NOT NULL — this row can never match again.
      expect(messagesChain._lastUpdate.provider_retry_next_at).toBeNull();
    });

    test('sendOne accepts: the retry sends normally', async () => {
      const messagesChain = emailMessagesChain({ id: 'message-1', status: 'sent' });
      db.mockImplementation((table) => {
        if (table === 'email_messages') return messagesChain;
        throw new Error(`unexpected table ${table}`);
      });
      sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-annual-delivered' });

      const stored = message({
        template_key: 'estimate.expiring_notice',
        send_attempt_token: 'attempt-annual-2',
        html_snapshot: '<p>https://portal.wavespestcontrol.com/estimate/synthetic-token-b</p>',
        text_snapshot: '',
      });
      const result = await retry.retryOne(stored);

      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(result.sent).toBe(true);
    });

    test('round 9 structural fix (P1): a retried deposit.receipt whose stored content still carries a withheld link is rewritten by sendOne and sent — the stored snapshot is updated to match', async () => {
      const messagesChain = emailMessagesChain({ id: 'message-1', status: 'sent', template_key: 'deposit.receipt' });
      db.mockImplementation((table) => {
        if (table === 'email_messages') return messagesChain;
        throw new Error(`unexpected table ${table}`);
      });
      const rewrittenHtml = '<p>https://portal.wavespestcontrol.com</p>';
      const rewrittenText = 'https://portal.wavespestcontrol.com';
      sendgrid.sendOne.mockResolvedValue({
        messageId: 'provider-deposit-receipt-retry',
        withheldLinksRewritten: ['est-withheld-1'],
        html: rewrittenHtml,
        text: rewrittenText,
      });

      const stored = message({
        template_key: 'deposit.receipt',
        send_attempt_token: 'attempt-annual-rewrite',
        html_snapshot: '<p>https://portal.wavespestcontrol.com/estimate/synthetic-token-withheld</p>',
        text_snapshot: 'https://portal.wavespestcontrol.com/estimate/synthetic-token-withheld',
      });
      const result = await retry.retryOne(stored);

      // templateKey lets sendOne resolve 'rewrite' for this template on its
      // own — this sweep has no explicit opinion of its own to forward.
      expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
        html: stored.html_snapshot, text: stored.text_snapshot, templateKey: 'deposit.receipt',
      }));
      expect(result.sent).toBe(true);
      expect(result.stopped).not.toBe(true);
      // The stored row's snapshot fields are updated to match what actually
      // went out, in the SAME write as the provider acceptance bookkeeping.
      expect(messagesChain._lastUpdate).toEqual(expect.objectContaining({
        provider_message_id: 'provider-deposit-receipt-retry',
        html_snapshot: rewrittenHtml,
        text_snapshot: rewrittenText,
      }));
    });

    test('sendOne refuses with a guard INFRASTRUCTURE failure: not a permanent stop — the ordinary retry-later classification applies (provider never attempted)', async () => {
      const messagesChain = emailMessagesChain({ id: 'message-1', status: 'failed' });
      db.mockImplementation((table) => {
        if (table === 'email_messages') return messagesChain;
        throw new Error(`unexpected table ${table}`);
      });
      sendgrid.sendOne.mockRejectedValueOnce(annualOfferGuardFailedError());

      const stored = message({
        template_key: 'estimate.expiring_notice',
        send_attempt_token: 'attempt-annual-4',
        html_snapshot: '<p>Hi Sam, your technician is on the way!</p>',
        text_snapshot: 'Hi Sam, your technician is on the way!',
      });
      const result = await retry.retryOne(stored);

      // Not stopped/permanent — an infra failure is the SAME "retry later"
      // shape as any other pre-send failure this file already classifies.
      expect(result.stopped).not.toBe(true);
      expect(result.sent).toBe(false);
      // dispatchStarted was reverted: never set provider_retry_next_at: null
      // the way a definite (guard-blocked or provider-rejected) outcome would.
      expect(messagesChain._lastUpdate?.provider_retry_next_at).not.toBeNull();
    });

    test('pre-push audit P1 (b49be57b12 round 4): a VISIT SUMMARY retry whose guard INFRASTRUCTURE failure occurs settles as a definite failure, NOT uncertain (dispatchStarted must be reverted, not just for the withheld case)', async () => {
      const chain = {};
      chain.where = jest.fn(() => chain);
      chain.update = jest.fn((payload) => { chain._lastUpdate = payload; return chain; });
      chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
      chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'failed', template_key: 'service.visit_summary', recipient_email_snapshot: 'a@example.com' }]);
      db.mockReturnValue(chain);
      emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
      emailTemplates.activeSuppressionFor.mockResolvedValue(null);
      sendgrid.sendOne.mockRejectedValueOnce(annualOfferGuardFailedError());

      const stored = message({
        template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
        send_attempt_token: 'attempt-annual-5', provider_retry_count: 0,
      });
      const result = await retry.retryOne(stored);

      // Never uncertain — the provider was never attempted, sendOne's own
      // guard refused before the wire. Before the fix, dispatchStarted
      // stayed true for this flag (only annualOfferWithheld reset it), so
      // retrySummaryThroughHandoff's own catch wrongly read "the wire was
      // touched" and settled this as markRetryUncertain instead.
      expect(result.uncertain).not.toBe(true);
      expect(result.sent).toBe(false);
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      // markRetryFailure's shape (retry-later, NOT markRetryUncertain's
      // null-next-at "settled, never requeued" shape).
      expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed', provider_retry_next_at: expect.any(Date),
      }));
      expect(chain.update).not.toHaveBeenCalledWith(expect.objectContaining({
        error_message: expect.stringMatching(/^Provider outcome unknown/),
      }));
    });

    test('pre-push audit P1 (b49be57b12 round 4): a VISIT SUMMARY retry whose guard says WITHHELD still settles as the existing permanent stop, unaffected by the guardFailed fix', async () => {
      const chain = {};
      chain.where = jest.fn(() => chain);
      chain.update = jest.fn((payload) => { chain._lastUpdate = payload; return chain; });
      chain.then = (res, rej) => Promise.resolve(1).then(res, rej);
      chain.returning = jest.fn(async () => [{ id: 'message-1', status: 'blocked', template_key: 'service.visit_summary' }]);
      db.mockReturnValue(chain);
      emailTemplates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'service.visit_summary' } });
      emailTemplates.activeSuppressionFor.mockResolvedValue(null);
      sendgrid.sendOne.mockRejectedValueOnce(annualOfferWithheldError());

      const stored = message({
        template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001',
        send_attempt_token: 'attempt-annual-6', provider_retry_count: 0,
      });
      const result = await retry.retryOne(stored);

      expect(result).toMatchObject({ sent: false, stopped: true, reason: 'annual_offer_withheld' });
      expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'blocked', error_message: 'annual_offer_withheld', provider_retry_next_at: null,
      }));
    });
  });
});
