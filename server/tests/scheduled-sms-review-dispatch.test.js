jest.mock('../models/db', () => jest.fn());
jest.mock('../services/review-ask-history', () => ({
  ...jest.requireActual('../services/review-ask-history'),
  lastDeliveredAskAt: jest.fn(),
  lastManualAskAt: jest.fn(),
}));
const mockHeld = new Set();
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (key, work) => {
    if (mockHeld.has(key)) return { skipped: true, reason: 'lease_held' };
    mockHeld.add(key);
    try { return await work(); } finally { mockHeld.delete(key); }
  },
  wasLockSkipped: result => result?.skipped === true,
}));
jest.mock('../services/messaging/deferred-replay-registry', () => ({
  requiresDurableFinalize: entry => entry === 'durable-test',
}));
const db = require('../models/db');
const history = require('../services/review-ask-history');
const { dispatchScheduledSms } = require('../services/scheduled-sms-delivery');

let row, providerRow, updates;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-09T15:00:00Z'));
  mockHeld.clear();
  history.lastDeliveredAskAt.mockReset().mockResolvedValue(null);
  history.lastManualAskAt.mockReset().mockResolvedValue(null);
  providerRow = null;
  updates = [];
  row = { id: 'queued-1', customer_id: 'customer-1', status: 'sending',
    message_body: 'Please leave a review: https://g.page/r/example/review',
    metadata: { scheduled_sms_attempts: 3, entry_point: 'durable-test', parked_decision_ids: ['parked-1'] } };
  db.raw = (sql, bindings) => ({ sql, bindings });
  db.mockImplementation(() => {
    const filters = {};
    return {
      where(values) { Object.assign(filters, values); return this; },
      whereIn() { return this; }, whereRaw() { return this; },
      first: async () => providerRow,
      update: async patch => {
        updates.push({ patch, held: mockHeld.has('review-send:customer-1') });
        if (filters.id !== row.id || (filters.status && filters.status !== row.status)) return 0;
        const meta = { ...row.metadata };
        if (patch.metadata.sql.includes("- 'bundled_review_request_id'")) {
          delete meta.bundled_review_request_id;
          delete meta.review_ask_reservation;
        } else if (patch.metadata.sql.includes("jsonb_build_object('review_ask_reservation', true")) {
          meta.queued_at = meta.queued_at || row.created_at;
          meta.review_ask_reservation = true;
        } else if (patch.metadata.sql.includes('review_hold_reason')) {
          meta.review_hold_reason = patch.metadata.bindings[0];
          meta.scheduled_sms_attempts = Math.max(0, meta.scheduled_sms_attempts - 1);
        } else {
          delete meta.review_ask_reservation;
          meta.queued_at = meta.queued_at || row.created_at;
          if (patch.metadata.sql.includes('finalize_pending')) {
            meta.finalize_pending = true;
            meta.provider_message_id = patch.metadata.bindings[0];
          }
        }
        Object.assign(row, patch, { metadata: meta });
        return 1;
      },
    };
  });
});
afterEach(() => jest.useRealTimers());

test('a queued staff ask holds the customer lock through provider and durable settlement', async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const send = jest.fn(async () => { entered(); await wait; return { sent: true, providerMessageId: 'SM-accepted' }; });
  const first = dispatchScheduledSms(row, row.metadata, send);
  try {
    await started;
    const other = jest.fn();
    expect(await require('../services/review-ask-dispatch').dispatchReviewAsk('customer-1', other))
      .toMatchObject({ code: 'REVIEW_SEND_BUSY' });
    expect(other).not.toHaveBeenCalled();
  } finally { finish(); }
  expect(await first).toMatchObject({ sent: true });
  expect(row.status).toBe('sent');
  expect(row.created_at).toEqual(new Date());
  expect(row.metadata).toMatchObject({ finalize_pending: true, provider_message_id: 'SM-accepted', parked_decision_ids: ['parked-1'] });
  expect(updates[0].held).toBe(true);
  expect(mockHeld.size).toBe(0);
});

test.each(['recent', 'history', 'busy'])('%s holds refund the final claimed attempt and retain the queue', async kind => {
  if (kind === 'recent') history.lastManualAskAt.mockResolvedValue(new Date(Date.now() - 3600000));
  if (kind === 'history') history.lastManualAskAt.mockRejectedValue(new Error('history unavailable'));
  if (kind === 'busy') mockHeld.add('review-send:customer-1');
  const send = jest.fn();
  expect(await dispatchScheduledSms(row, row.metadata, send)).toMatchObject({ sent: false, scheduledHold: true });
  expect(send).not.toHaveBeenCalled();
  expect(row.status).toBe('scheduled');
  expect(row.metadata).toMatchObject({ scheduled_sms_attempts: 2, parked_decision_ids: ['parked-1'] });
  expect(row.scheduled_for.getTime()).toBe(Date.now() + (kind === 'recent' ? 71 * 3600000 : 15 * 60000));
});

test.each(['outcome', 'provider-log'])('accepted errors settle under lock using %s evidence', async source => {
  const error = new Error('post-accept audit failed');
  if (source === 'outcome') error.providerOutcome = { sent: true, providerMessageId: 'SM-proof' };
  else providerRow = { id: 'provider-1', twilio_sid: 'SM-proof' };
  await expect(dispatchScheduledSms(row, row.metadata, async () => { throw error; })).rejects.toBe(error);
  expect(row.status).toBe('sent');
  expect(row.metadata.provider_message_id).toBe('SM-proof');
  expect(updates[0].held).toBe(true);
  expect(error.providerOutcome.sent).toBe(true);
});

test('a non-review scheduled message keeps its provider and finalization behavior', async () => {
  row.message_body = 'Please review and sign your agreement: https://portal.test/contract/abc';
  history.lastManualAskAt.mockRejectedValue(new Error('must not consult review history'));
  const send = jest.fn().mockResolvedValue({ sent: true, providerMessageId: 'SM-ordinary' });
  expect(await dispatchScheduledSms(row, row.metadata, send)).toMatchObject({ sent: true });
  expect(history.lastManualAskAt).not.toHaveBeenCalled();
  expect(row.status).toBe('sent');
});

test('persisted bundled-review linkage guards a message even without visible review wording', async () => {
  row.message_body = 'Thank you: https://portal.test/l/abc123';
  row.metadata.bundled_review_request_id = 'review-1';
  history.lastDeliveredAskAt.mockResolvedValue(new Date());
  const send = jest.fn();
  expect(await dispatchScheduledSms(row, row.metadata, send)).toMatchObject({ code: 'REVIEW_ASK_SPACING', scheduledHold: true });
  expect(send).not.toHaveBeenCalled();
});

test('an unlinked review ask refuses dispatch without inventing a customer', async () => {
  row.customer_id = null;
  const send = jest.fn();
  expect(await dispatchScheduledSms(row, row.metadata, send)).toMatchObject({ code: 'REVIEW_CUSTOMER_REQUIRED', blocked: true });
  expect(send).not.toHaveBeenCalled();
});


test('a review-policy replay is guarded when its stored body contains only a short link', async () => {
  row.message_body = 'Here you go: https://portal.test/l/abc123';
  history.lastDeliveredAskAt.mockResolvedValue(new Date());
  const send = jest.fn();
  expect(await dispatchScheduledSms(row, row.metadata, send, 'review_request')).toMatchObject({ code: 'REVIEW_ASK_SPACING' });
  expect(send).not.toHaveBeenCalled();
});


test('repeated settlement failures preserve accepted evidence for the scheduler recovery handler', async () => {
  row.created_at = new Date(Date.now() - 7 * 86400000);
  const queuedAt = row.created_at;
  const original = db.getMockImplementation();
  db.mockImplementation((...args) => {
    const query = original(...args);
    const update = query.update;
    query.update = async patch => {
      if (patch.metadata.sql.includes("jsonb_build_object('review_ask_reservation', true")) return update(patch);
      expect(mockHeld.has('review-send:customer-1')).toBe(true);
      throw new Error('settlement unavailable');
    };
    return query;
  });
  await expect(dispatchScheduledSms(row, row.metadata, async () => ({ sent: true, providerMessageId: 'SM-durable-proof' })))
    .rejects.toMatchObject({ providerOutcome: { sent: true, providerMessageId: 'SM-durable-proof' }, scheduledReviewAsk: true });
  expect(row.status).toBe('sending');
  expect(row.metadata.review_ask_reservation).toBe(true);
  expect(row.created_at).toEqual(new Date());
  expect(row.metadata.queued_at).toEqual(queuedAt);
});

test.each(['recent', 'history', 'busy'])('completion keeps its transactional links when review is held: %s', async kind => {
  const completion = 'Your service is complete: https://portal.test/report/abc\nReceipt: https://portal.test/receipt/xyz';
  row.message_body = completion + '\n\nEnjoyed the service? A quick review means the world: https://portal.test/rate/review1';
  row.metadata.entry_point = 'dispatch_completion_deferred';
  row.metadata.bundled_review_request_id = 'review-1';
  if (kind === 'recent') history.lastDeliveredAskAt.mockResolvedValue(new Date());
  if (kind === 'history') history.lastManualAskAt.mockRejectedValue(new Error('unavailable'));
  if (kind === 'busy') mockHeld.add('review-send:customer-1');
  const meta = row.metadata;
  const send = jest.fn(async () => {
    expect(row.message_body).toBe(completion);
    expect(meta.bundled_review_request_id).toBeUndefined();
    expect(row.metadata.bundled_review_request_id).toBeUndefined();
    return { sent: true, providerMessageId: 'SM-completion' };
  });
  expect(await dispatchScheduledSms(row, meta, send, 'service_complete')).toMatchObject({ sent: true });
  expect(send).toHaveBeenCalledTimes(1);
  expect(row.status).toBe('sent');
  expect(updates.at(-1).patch.metadata.sql).not.toContain('review_ask_delivered_at');
});

test('an unpersisted completion rewrite never dispatches a stale bundled ask', async () => {
  row.message_body = 'Receipt: https://portal.test/receipt/xyz\n\nEnjoyed the service? A quick review means the world: https://portal.test/rate/review1';
  row.metadata.entry_point = 'dispatch_completion_deferred';
  row.metadata.bundled_review_request_id = 'review-1';
  history.lastDeliveredAskAt.mockResolvedValue(new Date());
  const original = db.getMockImplementation();
  db.mockImplementation((...args) => { const q = original(...args); q.update = async () => { throw new Error('rewrite unavailable'); }; return q; });
  const send = jest.fn();
  await expect(dispatchScheduledSms(row, row.metadata, send, 'service_complete')).rejects.toThrow('rewrite unavailable');
  expect(send).not.toHaveBeenCalled();
});

test.each(['gate-blocked', 'template-disabled', 'owner-silence'])('suppressed queued asks do not record review delivery: %s', async providerMessageId => {
  const result = await dispatchScheduledSms(row, row.metadata, async () => ({ sent: true, providerMessageId }));
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'REVIEW_SEND_SUPPRESSED' });
  expect(row.status).toBe('canceled');
  expect(row.metadata.review_ask_reservation).toBeUndefined();
  expect(updates.at(-1).held).toBe(true);
  expect(updates.at(-1).patch.metadata.sql).not.toContain('review_ask_delivered_at');
});
