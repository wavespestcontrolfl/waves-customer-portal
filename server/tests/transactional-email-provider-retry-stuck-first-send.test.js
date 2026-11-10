// Sweep #7765 B3: a first-attempt row whose process died between the `started` marker and SendGrid's
// answer is settled as outcome unknown (never re-sent), once, with one alert. Fake-knex unit tests; the
// SQL itself is exercised in transactional-email-provider-retry-postgres.test.js (CI only).
jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  REQUEST_TIMEOUT_MS: 120_000,
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(),
  sendOne: jest.fn(),
  isDefiniteRejection: jest.fn(() => false),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(),
  activeSuppressionFor: jest.fn(),
  redactEmailAddresses: jest.fn((value) => String(value)),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ revalidateDelayedDaySend: jest.fn(async () => 'day') }));
jest.mock('../services/visit-completion-summary', () => ({
  retrySummaryThroughHandoff: jest.fn(),
  reconcileSummaryEmailRecovery: jest.fn(async () => ({ reconciled: true })),
  reconcileSummaryEmailBounce: jest.fn(async () => ({ reconciled: true })),
}));

const retry = require('../services/transactional-email-provider-retry');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const NotificationService = require('../services/notification-service');
const Summary = require('../services/visit-completion-summary');

const NOW = new Date('2026-11-08T15:00:00Z');
// 120 s request timeout + 10 min margin.
const CUTOFF = new Date(NOW.getTime() - 120_000 - 10 * 60 * 1000);

// One fake builder per db(table) call, recorded in order. Every chained method returns the builder;
// the terminal methods resolve the scripted value for that table.
function fakeKnex({ candidates = [], locked = { id: 'm1' }, event = null, updated = null } = {}) {
  const built = [];
  db.mockImplementation((table) => {
    const calls = [];
    const builder = { table, calls };
    const chain = (name) => jest.fn((...args) => { calls.push([name, args]); return builder; });
    ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotExists', 'orderBy', 'limit', 'forUpdate', 'update']
      .forEach((name) => { builder[name] = chain(name); });
    builder.select = jest.fn(async (...args) => { calls.push(['select', args]); return table === 'email_messages' ? candidates : []; });
    builder.first = jest.fn(async (...args) => {
      calls.push(['first', args]);
      if (table === 'email_message_events') return event;
      if (table === 'notifications') return null;
      return locked;
    });
    builder.returning = jest.fn(async () => (updated ? [updated] : []));
    built.push(builder);
    return builder;
  });
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.transaction = jest.fn(async (cb) => cb(db));
  return built;
}

const stuckRow = (overrides = {}) => ({
  id: 'm1', send_attempt_token: 'attempt-1', status: 'failed', template_key: 'invoice.sent', provider_retry_count: 0,
  provider_handoff_phase: 'started', provider_handoff_attempt_token: 'attempt-1', ...overrides,
});
const wheres = (builder) => builder.calls.filter(([name]) => name === 'where').map(([, args]) => args);
const named = (builder, name) => builder.calls.filter(([n]) => n === name).map(([, args]) => args);

describe('settleStuckFirstAttempts', () => {
  beforeEach(() => { jest.clearAllMocks(); sendgrid.REQUEST_TIMEOUT_MS = 120_000; });

  test('selects only abandoned first attempts: started, current token, nothing accepted, older than timeout + margin, bounded', async () => {
    const built = fakeKnex({ candidates: [] });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(0);
    const select = built[0];
    expect(wheres(select)).toEqual(expect.arrayContaining([
      [{ status: 'queued', provider_handoff_phase: 'started' }],
      ['queued_at', '<=', CUTOFF],
      ['updated_at', '<=', CUTOFF],
    ]));
    expect(named(select, 'whereNull').map(([col]) => col)).toEqual(expect.arrayContaining([
      'provider_retry_next_at', 'provider_retry_exhausted_at', 'provider_message_id', 'sent_at',
    ]));
    expect(named(select, 'whereNotNull')).toEqual([['send_attempt_token']]);
    expect(named(select, 'whereRaw')).toEqual([['provider_handoff_attempt_token = send_attempt_token']]);
    expect(named(select, 'whereNotExists')).toHaveLength(1);
    expect(named(select, 'limit')).toEqual([[10]]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('derives its age from the SendGrid request timeout, not a copy of it', async () => {
    sendgrid.REQUEST_TIMEOUT_MS = 300_000;
    const built = fakeKnex({ candidates: [] });
    await retry.settleStuckFirstAttempts(NOW);
    expect(wheres(built[0])).toContainEqual(['queued_at', '<=', new Date(NOW.getTime() - 300_000 - retry.FIRST_ATTEMPT_SETTLE_MARGIN_MS)]);
  });

  test('settles nothing when the request timeout is unknown', async () => {
    sendgrid.REQUEST_TIMEOUT_MS = undefined;
    fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }] });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(0);
    expect(db).not.toHaveBeenCalled();
  });

  test('settles a stuck row failed + exhausted in a compare-and-set, reconciles a summary, alerts once, never re-sends', async () => {
    const built = fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], updated: stuckRow() });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(1);

    const update = built.find((b) => named(b, 'update').length);
    expect(named(update, 'update')[0][0]).toEqual({
      status: 'failed',
      provider_retry_next_at: null,
      provider_retry_exhausted_at: NOW,
      error_message: expect.stringMatching(/^Provider outcome unknown: /),
      updated_at: NOW,
    });
    // The handoff phase and token are NOT rewritten: the row stays "uncertain" for every reader.
    expect(Object.keys(named(update, 'update')[0][0])).not.toContain('provider_handoff_phase');
    // Same id + same token, plus every selection guard again.
    expect(wheres(update)).toEqual(expect.arrayContaining([
      [{ id: 'm1', send_attempt_token: 'attempt-1' }],
      [{ status: 'queued', provider_handoff_phase: 'started' }],
      ['queued_at', '<=', CUTOFF],
    ]));
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(Summary.reconcileSummaryEmailBounce).not.toHaveBeenCalled(); // not a summary row
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [type, title, body, options] = NotificationService.notifyAdmin.mock.calls[0];
    expect([type, title]).toEqual(['alert', 'Transactional email delivery failed']);
    expect(body).toMatch(/outcome was never confirmed/);
    expect(body).not.toMatch(/after \d+ provider retries/);
    expect(options.metadata).toMatchObject({ dedupeKey: 'email-provider-retry-exhausted:m1', email_message_id: 'm1' });
  });

  test('a visit summary row reconciles on the same transaction', async () => {
    const summary = stuckRow({ template_key: 'service.visit_summary', trigger_event_id: 'visit_summary:00000000-0000-4000-8000-000000000001' });
    fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], updated: summary });
    await retry.settleStuckFirstAttempts(NOW);
    expect(Summary.reconcileSummaryEmailBounce).toHaveBeenCalledWith(summary, db);
  });

  test('leaves a row with a webhook event for its current attempt: no write, no alert', async () => {
    const built = fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], event: { id: 'event-1' }, updated: stuckRow() });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(0);
    const events = built.find((b) => b.table === 'email_message_events');
    expect(named(events, 'where')).toEqual([['email_message_id', 'm1']]);
    expect(named(events, 'whereRaw')).toEqual([["raw_event->>'send_attempt_token' = ?", ['attempt-1']]]);
    expect(built.some((b) => named(b, 'update').length)).toBe(false);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a lost lock or lost compare-and-set writes nothing and raises no alert', async () => {
    const lostLock = fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], locked: null });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(0);
    expect(lostLock.some((b) => named(b, 'update').length)).toBe(false);

    jest.clearAllMocks();
    fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], updated: null });
    await expect(retry.settleStuckFirstAttempts(NOW)).resolves.toBe(0);
    expect(Summary.reconcileSummaryEmailBounce).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a settlement transaction that throws rolls back (no alert) and propagates to the caller', async () => {
    fakeKnex({ candidates: [{ id: 'm1', send_attempt_token: 'attempt-1' }], updated: stuckRow({ template_key: 'service.visit_summary' }) });
    Summary.reconcileSummaryEmailBounce.mockRejectedValueOnce(new Error('reconcile failed'));
    await expect(retry.settleStuckFirstAttempts(NOW)).rejects.toThrow('reconcile failed');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
