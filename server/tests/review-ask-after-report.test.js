/**
 * GATE_REVIEW_ASK_AFTER_REPORT (owner 2026-10-22): the completion panel's
 * send-time preview names the new Automatic timing, and the extra every-five-minutes
 * review-sequences registration in scheduler.js no-ops while the gate is off.
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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
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
    // The five-minute ticks are named so the panel's tick rounding matches the cron.
    // explicit choices keep :14/:44; the fast table is named separately
    expect(lawn.cadenceTickMinutesOfHour).toEqual([14, 44]);
    expect(lawn.afterReportTickMinutesOfHour).toEqual(expect.arrayContaining([0, 5, 10, 14, 44]));
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

describe('the */5 review-sequences registration in scheduler.js', () => {
  const cron = require('../utils/scheduled-cron');
  const { runExclusive } = require('../utils/cron-lock');
  const ReviewService = require('../services/review-request');
  const { initScheduledJobs } = require('../services/scheduler');

  function registrations() {
    cron.schedule.mockClear();
    process.env.GATE_CRON_JOBS = 'true';
    initScheduledJobs();
    return {
      main: cron.schedule.mock.calls.find(([e]) => e === '14,44 * * * *'),
      fast: cron.schedule.mock.calls.find(([e, task]) => e === '*/5 * * * *' && String(task).includes('reviewAskAfterReportLive')),
    };
  }

  beforeEach(() => {
    jest.spyOn(ReviewService, 'processReviewSequences').mockResolvedValue({ sent: 0, completed: 0, stopped: 0 });
    runExclusive.mockClear();
  });

  test('is registered beside the untouched :14/:44 job, with the same timezone', () => {
    const { main, fast } = registrations();
    expect(main).toBeDefined();
    expect(fast).toBeDefined();
    expect(fast[2]).toEqual({ timezone: 'America/New_York' });
    expect(main[2]).toEqual({ timezone: 'America/New_York' });
  });

  test('gate off: the 5-minute tick returns before taking the lock or reading a sequence', async () => {
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    const { fast } = registrations();
    await fast[1]();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(ReviewService.processReviewSequences).not.toHaveBeenCalled();
  });

  test('gate on but cadences off: still a no-op', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    const { fast } = registrations();
    await fast[1]();
    expect(ReviewService.processReviewSequences).not.toHaveBeenCalled();
  });

  test('gate on and cadences on: runs the same job under the shared review-sequences lock; the :14/:44 job does too', async () => {
    process.env.GATE_REVIEW_ASK_AFTER_REPORT = 'true';
    process.env.GATE_REVIEW_SEQUENCES = 'true';
    const { main, fast } = registrations();
    await fast[1]();
    expect(runExclusive).toHaveBeenCalledWith('review-sequences', expect.any(Function));
    expect(ReviewService.processReviewSequences).toHaveBeenCalledTimes(1);
    await main[1]();
    expect(runExclusive).toHaveBeenNthCalledWith(2, 'review-sequences', expect.any(Function));
    expect(ReviewService.processReviewSequences).toHaveBeenCalledTimes(2);
  });
});

describe('the report text anchor (completion enrollment + paid invoice share one reader)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const { reportTextAnchorFromNotes } = require('../services/review-request').__private;

  test('the completion enrollment passes the record anchor through the shared reader', () => {
    expect(src).toContain('reportTextAnchor: await ReviewService.reportTextAnchorForRecord(record.id),');
  });

  test('a sent text anchors to its send time; a delivered held text to its delivery', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsAt: '2026-10-20T14:00:00.000Z' })).toEqual({ status: 'sent', at: '2026-10-20T14:00:00.000Z' });
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'deferred', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z', completionSmsDeferredDeliveredAt: '2026-10-20T12:03:00.000Z' })).toEqual({ status: 'sent', at: '2026-10-20T12:03:00.000Z' });
  });

  test('a completion notice routed to the customer App is not a report text', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'push' })).toBeNull();
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'push' }, { atPayment: true })).toBeNull();
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent', sentSmsChannel: 'mms', sentSmsAt: '2026-10-20T14:00:00.000Z' })).toEqual({ status: 'sent', at: '2026-10-20T14:00:00.000Z' });
  });

  test('a text the send window still holds anchors to its release', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'deferred', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z' })).toEqual({ status: 'deferred', at: '2026-10-20T12:00:00.000Z' });
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'deferred' })).toBeNull();
  });

  test.each([['failed'], ['blocked'], ['skipped_recap_sms_already_sent'], ['no_phone'], [undefined]])('a %s text gives no anchor', (status) => {
    expect(reportTextAnchorFromNotes(status ? { completionSmsStatus: status } : {})).toBeNull();
    expect(reportTextAnchorFromNotes(status ? { completionSmsStatus: status } : {}, { atPayment: true })).toBeNull();
  });

  test('at payment, only a delivered text earns the paid anchor', () => {
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'sent' }, { atPayment: true })).toMatchObject({ status: 'paid' });
    expect(reportTextAnchorFromNotes({ completionSmsStatus: 'deferred', completionSmsDeferredTo: '2026-10-20T12:00:00.000Z' }, { atPayment: true })).toEqual({ status: 'deferred', at: '2026-10-20T12:00:00.000Z' });
  });
});
