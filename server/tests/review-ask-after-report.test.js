/**
 * GATE_REVIEW_ASK_AFTER_REPORT (owner 2026-10-22): the completion panel's
 * send-time preview names the new Automatic timing, and the review sender keeps
 * its :14/:44 schedule.
 * The enrollment arithmetic lives in review-sequences.test.js.
 */
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    columnInfo: jest.fn().mockResolvedValue({ report_template_version: {} }),
    where() { return this; },
    del: jest.fn().mockResolvedValue(0),
  }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
// The gates map is read once at load; these tests flip env vars per test, so the
// three map gates they use are read live. Everything else is the real module.
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  const live = { reviewSequences: 'GATE_REVIEW_SEQUENCES', cronJobs: 'GATE_CRON_JOBS', smsSendWindow: 'GATE_SMS_SEND_WINDOW' };
  return { ...actual, isEnabled: (name) => (live[name] ? process.env[live[name]] === 'true' : actual.isEnabled(name)) };
});
jest.mock('../services/google-business', () => ({}));
jest.mock('../services/review-incentives', () => ({}));
jest.mock('../services/review-reply/publisher', () => ({}));
jest.mock('../services/review-reply/drafter', () => ({}));
jest.mock('../services/review-reply/grounding', () => ({}));
jest.mock('../services/review-reply/runner', () => ({}));
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../services/twilio', () => ({}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), wasLockSkipped: (r) => r?.skipped === true, settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['GATE_REVIEW_ASK_AFTER_REPORT', 'GATE_REVIEW_SEQUENCES', 'GATE_CRON_JOBS', 'GATE_SMS_SEND_WINDOW'];
const saved = {};
beforeEach(() => { ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

describe('GET /admin/reviews/send-time-preview with GATE_REVIEW_ASK_AFTER_REPORT', () => {
  function load() {
    const router = require('../routes/admin-reviews');
    return router.stack.find((layer) => layer.route?.path === '/send-time-preview').route.stack.at(-1).handle;
  }
  async function preview(serviceType = 'Lawn Care') {
    const handler = load();
    const res = { json: jest.fn() };
    const next = jest.fn();
    await handler({ query: { serviceType } }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res.json.mock.calls[0][0];
  }

  test('gate on: the preview is now + 10 minutes with a stable after_report bucket, for any service line', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    process.env.GATE_CRON_JOBS = 'true';
    const before = Date.now();
    const lawn = await preview('Lawn Care');
    const pest = await preview('Quarterly Pest Control');
    expect(lawn).toMatchObject({ afterReport: true, afterReportMinutes: 10, bucket: 'after_report:+10m', reviewSequencesEnabled: true, schedulerEnabled: true });
    expect(pest.bucket).toBe(lawn.bucket);
    const delta = new Date(lawn.at).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(10 * 60000);
    expect(delta).toBeLessThan(10 * 60000 + 5000);
    expect(lawn.earliestAt).toBe(lawn.at);
    expect(lawn.latestAt).toBe(lawn.at);
    // The ask goes at the :14/:44 sends; the panel names them.
    expect(lawn.cadenceTickMinutesOfHour).toEqual([14, 44]);
    expect(lawn).not.toHaveProperty('afterReportTickMinutesOfHour');
  });

  test('gate on with cadences off: the legacy path ignores the gate (120 minutes, no after-report preview)', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_CRON_JOBS = 'true';
    const out = await preview();
    expect(out).toMatchObject({ afterReport: false, afterReportMinutes: null, reviewSequencesEnabled: false, bucket: 'legacy:+120m', earliestAt: null, latestAt: null });
  });

  test('gate off: the smart window (or the legacy 120 minutes) exactly as before', async () => {
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    process.env.GATE_CRON_JOBS = 'true';
    const smart = await preview();
    expect(smart).toMatchObject({ afterReport: false, afterReportMinutes: null, reviewSequencesEnabled: true });
    expect(smart.bucket).toMatch(/^(anchored|relative):/);
    expect(smart.cadenceTickMinutesOfHour).toEqual([14, 44]);
    delete process.env.GATE_REVIEW_SEQUENCES;
    const legacy = await preview();
    expect(legacy).toMatchObject({ afterReport: false, bucket: 'legacy:+120m', earliestAt: null, latestAt: null });
  });
});

test('the review sender keeps its one :14/:44 registration (no extra tick for this gate)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
  expect(src).not.toMatch(/reviewAskAfterReportLive/);
});

describe('the report text anchor (completion enrollment + paid invoice share one reader)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const { reportTextAnchorFromNotes } = require('../services/review-request').__private;

  test('the completion enrollment passes the record anchor through the shared reader', () => {
    expect(src).toContain('reportTextAnchor: await ReviewService.reportTextAnchorForRecord(record.id),');
  });

  test('a text sent at completion anchors to its send time', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsAt: '2026-10-20T14:00:00.000Z' })).toEqual({ status: 'sent', at: '2026-10-20T14:00:00.000Z' });
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'mms', sentSmsAt: '2026-10-20T14:00:00.000Z' })).toEqual({ status: 'sent', at: '2026-10-20T14:00:00.000Z' });
  });

  test('a completion notice routed to the customer App is not a report text', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'push' })).toBeNull();
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'push' }, { atPayment: true })).toBeNull();
  });

  test('a text the send window held for the morning keeps the smart window, queued or delivered', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'deferred', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z' })).toBeNull();
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z', completionSmsDeferredDeliveredAt: '2026-10-20T12:03:00.000Z' })).toBeNull();
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z' }, { atPayment: true })).toBeNull();
  });

  test.each([['failed'], ['blocked'], ['skipped_recap_sms_already_sent'], ['no_phone'], [undefined]])('a %s text gives no anchor', (status) => {
    expect(reportTextAnchorFromNotes(status ? { completionSmsStatus: status } : {})).toBeNull();
    expect(reportTextAnchorFromNotes(status ? { completionSmsStatus: status } : {}, { atPayment: true })).toBeNull();
  });

  test('at payment, a text sent at completion earns the paid anchor', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent' }, { atPayment: true })).toMatchObject({ status: 'paid' });
  });
});

describe('the combined-visit anchor (reportTextAnchorForVisit)', () => {
  const ReviewService = require('../services/review-request');
  const fakeDatabase = (effect) => jest.fn(() => ({ where() { return this; }, first: async () => (effect instanceof Error ? Promise.reject(effect) : effect) }));

  test('gate on, summary text sent: anchors to the effect send time', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    const sentAt = new Date('2026-10-20T13:05:00.000Z');
    expect(await ReviewService.reportTextAnchorForVisit('v-1', fakeDatabase({ status: 'sent', sent_at: sentAt }))).toEqual({ status: 'sent', at: sentAt });
  });

  test('a summary held by quiet hours and sent at 8 AM anchors to that text (codex #6471 r1 P2)', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    const sentAt = new Date('2026-10-20T12:01:00Z');
    expect(await ReviewService.reportTextAnchorForVisit('v-1', fakeDatabase({ status: 'sent', sent_at: sentAt, scheduled_at: new Date('2026-10-20T12:00:00Z') }))).toEqual({ status: 'sent', at: sentAt });
  });

  test.each([
    ['suppressed', { status: 'suppressed', sent_at: null }],
    ['missing', null],
    ['failed', { status: 'failed', sent_at: null }],
    ['unreadable', new Error('db down')],
  ])('gate on, summary text %s: no anchor (smart window)', async (_label, effect) => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    expect(await ReviewService.reportTextAnchorForVisit('v-1', fakeDatabase(effect))).toBeNull();
  });

  test('gate off: no anchor and no read', async () => {
    const database = fakeDatabase({ status: 'sent', sent_at: new Date() });
    expect(await ReviewService.reportTextAnchorForVisit('v-1', database)).toBeNull();
    expect(database).not.toHaveBeenCalled();
  });
});

describe('a report held for the morning pulls its review ask when it goes out as a text (pullAskAfterHeldReport)', () => {
  const ReviewService = require('../services/review-request');
  const db = require('../models/db');
  function chain(updated = 1) {
    const calls = { where: [], whereNull: [], whereNotNull: [], whereRaw: [], update: null };
    const q = {
      select: async () => [{ id: 'seq-1', customer_id: 'c-1' }],
      where(...a) { calls.where.push(a); return q; },
      whereNull(c) { calls.whereNull.push(c); return q; },
      whereNotNull(c) { calls.whereNotNull.push(c); return q; },
      whereRaw(sql) { calls.whereRaw.push(sql); return q; },
      update: async (patch) => { calls.update = patch; return updated; },
    };
    return { q, calls };
  }
  let restore;
  beforeEach(() => { restore = db.getMockImplementation(); jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-21T12:03:00Z').getTime()); });
  afterEach(() => { db.mockImplementation(restore); Date.now.mockRestore(); });

  test('gates on, sent as SMS/MMS (or proved by a Twilio SID): one conditional write re-plans an untouched smart-window Day-0 ask to 10 minutes from now', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    for (const proof of [{ channel: 'sms' }, { channel: 'mms' }]) {
      const { q, calls } = chain();
      db.mockImplementation(() => q);
      const { runExclusive } = require('../utils/cron-lock');
      runExclusive.mockClear();
      expect(await ReviewService.pullAskAfterHeldReport('sr-1', proof)).toEqual({ pulled: 1 });
      // the select and the locked write share one predicate; the write is by id under the customer's send lock
      expect(calls.where[0][0]).toEqual({ service_record_id: 'sr-1', status: 'active', current_step: 0, touches_sent: 0, started_by: 'post_service' });
      expect(calls.where[2][0]).toEqual({ id: 'seq-1' });
      expect(calls.whereNull).toEqual(['customer_requested', 'customer_requested']);
      expect(calls.whereRaw).toEqual(["decision ->> 'reason' = 'smart_window'", "decision ->> 'reason' = 'smart_window'"]);
      // earlier or later (the 10-minute floor after a delayed replay); a claimed row (NULL) is skipped
      expect(calls.whereNotNull).toEqual(['next_run_at', 'next_run_at']);
      expect(runExclusive).toHaveBeenCalledWith('review-send:c-1', expect.any(Function), { recordHealth: false });
      expect(calls.update.next_run_at.toISOString()).toBe('2026-10-21T12:13:00.000Z');
      expect(JSON.parse(calls.update.decision)).toMatchObject({ reason: 'after_report' });
    }
  });

  test.each([
    ['the App', { channel: 'push' }],
    ['an unknown channel', {}],
    ['email', { channel: 'email' }],
  ])('%s: nothing moves, no write', async (_label, proof) => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    const { q, calls } = chain();
    db.mockImplementation(() => q);
    expect(await ReviewService.pullAskAfterHeldReport('sr-1', proof)).toEqual({ pulled: 0 });
    expect(calls.update).toBeNull();
  });

  test('gate off, cadences off (codex #6471 r1 P2), or no record: nothing moves', async () => {
    const { q, calls } = chain();
    db.mockImplementation(() => q);
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    expect(await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms' })).toEqual({ pulled: 0 });
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    delete process.env.GATE_REVIEW_SEQUENCES;
    expect(await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms' })).toEqual({ pulled: 0 });
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    expect(await ReviewService.pullAskAfterHeldReport(null, { channel: 'sms' })).toEqual({ pulled: 0 });
    expect(calls.update).toBeNull();
  });

  test('a failed write never throws', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    const { q } = chain();
    q.update = async () => { throw new Error('db down'); };
    db.mockImplementation(() => q);
    expect(await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms' })).toEqual({ pulled: 0 });
  });

  test('the replay channel: the first pass knows it; a finalize-only retry reads a Twilio SID as a text; an App push has none', () => {
    expect(ReviewService.heldReportReplayChannel({ channel: 'push' })).toBe('push');
    expect(ReviewService.heldReportReplayChannel({ channel: 'mms', providerMessageId: 'SM0123456789abcdef0123456789abcdef' })).toBe('mms');
    expect(ReviewService.heldReportReplayChannel({ providerMessageId: 'SM0123456789abcdef0123456789abcdef' })).toBe('sms');
    expect(ReviewService.heldReportReplayChannel({ providerMessageId: 'MM0123456789abcdef0123456789abcdef' })).toBe('sms');
    expect(ReviewService.heldReportReplayChannel({ providerMessageId: 'push-abc' })).toBeUndefined();
    expect(ReviewService.heldReportReplayChannel({})).toBeUndefined();
  });

  test('the completion replay finalize stamps the channel and pulls with it (a finalize-only retry too)', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/messaging/deferred-replay-registry.js'), 'utf8');
    expect(src).toContain("const channel = ReviewService.heldReportReplayChannel({ channel: ctx.channel, providerMessageId: ctx.providerMessageId || meta.provider_message_id });");
    expect(src).toContain("await finalizeDeferredCompletionSend(meta, { retry: ctx.retry === true, channel, deliveredAt });");
    expect(src).toContain("await ReviewService.pullAskAfterHeldReport(meta.service_record_id, { channel, deliveredAt });");
    const scheduler = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(scheduler).toContain('{ providerMessageId: smsResult.providerMessageId, customerId: msg.customer_id || null, channel: smsResult.channel || null });');
  });

  test('a recovered finalize plans from the stored delivery time, never in the past (codex #6471 r6 P2)', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    const recent = chain();
    db.mockImplementation(() => recent.q);
    await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms', deliveredAt: new Date('2026-10-21T11:58:00Z') });
    expect(recent.calls.update.next_run_at.toISOString()).toBe('2026-10-21T12:08:00.000Z');
    const old = chain();
    db.mockImplementation(() => old.q);
    await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms', deliveredAt: new Date('2026-10-21T11:00:00Z') });
    expect(old.calls.update.next_run_at.toISOString()).toBe('2026-10-21T12:03:00.000Z');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain('deliveredAt: msg.created_at || null })');
  });

  test('a held send lock (that ask is being sent right now) is left alone', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    require('../utils/cron-lock').runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'locked' }));
    const { q, calls } = chain();
    db.mockImplementation(() => q);
    expect(await ReviewService.pullAskAfterHeldReport('sr-1', { channel: 'sms' })).toEqual({ pulled: 0 });
    expect(calls.update).toBeNull();
  });
});
