/**
 * closeout-alerts — the one fact→issue mapping + the per-visit memo shared by
 * dashboard-alerts (live feed) and the command-center route.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));

const { getCloseoutStatus } = require('../services/closeout-status');
const { loadCloseoutStatuses, closeoutIssuesForVisit, CLOSEOUT_ALERT_TYPES, __private } = require('../services/closeout-alerts');

const fact = (state, reason, extra = {}) => ({ state, reason, ...extra });
const base = (o = {}) => ({
  found: true,
  facts: {
    completion: fact('done', 'record_exists'), application: fact('done', 'x'), photos: fact('not_required', 'x'),
    report: fact('done', 'x'), reportDelivery: fact('done', 'x'), ...o,
  },
});

beforeEach(() => { jest.clearAllMocks(); __private.memo.clear(); });

describe('closeoutIssuesForVisit', () => {
  test('closed out / unavailable / not found → no issues', () => {
    expect(closeoutIssuesForVisit(base())).toEqual([]);
    expect(closeoutIssuesForVisit(null)).toEqual([]);
    expect(closeoutIssuesForVisit({ found: false })).toEqual([]);
  });
  test('unknown and not_required facts never become issues; awaiting/in-flight are transient', () => {
    expect(closeoutIssuesForVisit(base({ report: fact('unknown', 'requirements_unavailable'), application: fact('not_required', 'visit_outcome_inspection_only') }))).toEqual([]);
    expect(closeoutIssuesForVisit(base({ completion: fact('pending', 'completion_running'), report: fact('pending', 'awaiting_completion') }))).toEqual([]);
    expect(closeoutIssuesForVisit(base({ reportDelivery: fact('pending', 'recap_sms_in_flight') }))).toEqual([]);
  });
  test('stuck completion (no record / failed / resumable) is ONE issue on the report type', () => {
    for (const c of [fact('pending', 'completed_visit_without_record'), fact('failed', 'completion_attempt_failed'), fact('pending', 'completion_side_effects_resumable')]) {
      const issues = closeoutIssuesForVisit(base({ completion: c, report: fact('pending', 'awaiting_completion'), application: fact('pending', 'awaiting_completion') }));
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe(CLOSEOUT_ALERT_TYPES.report);
    }
    expect(closeoutIssuesForVisit(base({ completion: fact('pending', 'completion_side_effects_resumable') }))[0].summary).toMatch(/stuck mid-commit/);
  });
  test('report / delivery-failed / all-retracted application / short photos map to the three legacy types', () => {
    const issues = closeoutIssuesForVisit(base({
      report: fact('pending', 'no_report_artifact'),
      application: fact('failed', 'all_application_rows_retracted'),
      photos: fact('pending', 'photo_count_short', { required: 2, actual: 1 }),
    }));
    expect(issues.map((i) => i.type)).toEqual([CLOSEOUT_ALERT_TYPES.report, CLOSEOUT_ALERT_TYPES.application, CLOSEOUT_ALERT_TYPES.photos]);
    expect(issues[1].summary).toMatch(/retracted/);
    expect(issues[2]).toMatchObject({ requiredPhotoCount: 2, actualPhotoCount: 1 });
    const delivery = closeoutIssuesForVisit(base({ reportDelivery: fact('failed', 'delivery_exhausted') }));
    expect(delivery).toEqual([expect.objectContaining({ type: CLOSEOUT_ALERT_TYPES.report, fact: 'reportDelivery', summary: expect.stringMatching(/delivery failed/) })]);
    expect(closeoutIssuesForVisit(base({ reportDelivery: fact('pending', 'delivery_queued') }))).toEqual([]);
  });
});

describe('loadCloseoutStatuses', () => {
  test('bounded to 4 concurrent, dedupes ids, memoises fully-read results for 90s', async () => {
    let inFlight = 0; let peak = 0;
    getCloseoutStatus.mockImplementation(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
      return base();
    });
    const ids = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
    const first = await loadCloseoutStatuses([...ids, 'svc-0']);
    expect(first.size).toBe(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(10);
    await loadCloseoutStatuses(ids);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(10);
    await loadCloseoutStatuses(ids, { now: Date.now() + 91 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(20);
  });
  test('never memoises a full or PARTIAL outage', async () => {
    getCloseoutStatus.mockRejectedValueOnce(new Error('down')).mockResolvedValue(base());
    expect((await loadCloseoutStatuses(['a'])).get('a')).toBeNull();
    await loadCloseoutStatuses(['a']);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
    getCloseoutStatus.mockReset();
    getCloseoutStatus.mockResolvedValue({ ...base(), unavailable: [{ lookup: 'service_photos', error: 'timeout' }] });
    await loadCloseoutStatuses(['b']); await loadCloseoutStatuses(['b']);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
  });
});
