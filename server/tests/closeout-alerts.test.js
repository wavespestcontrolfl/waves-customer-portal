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
      expect(issues[0].type).toBe('completion_not_committed'); // own lifecycle key (GH r2)
    }
    expect(closeoutIssuesForVisit(base({ completion: fact('pending', 'completion_side_effects_resumable') }))[0].summary).toMatch(/stuck mid-commit/);
    // Tech-marked incomplete is an operator issue too (GH r3).
    const incomplete = closeoutIssuesForVisit(base({ completion: fact('pending', 'record_marked_incomplete'), report: fact('not_required', 'record_marked_incomplete') }));
    expect(incomplete).toEqual([expect.objectContaining({ type: 'completion_not_committed', summary: expect.stringMatching(/reschedule or follow up/) })]);
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
    // Delivery stage: its OWN lifecycle key; failed and actionable-pending alert, transient stays silent (codex r9).
    const delivery = closeoutIssuesForVisit(base({ reportDelivery: fact('failed', 'delivery_exhausted') }));
    expect(delivery).toEqual([expect.objectContaining({ type: 'report_delivery_incomplete', fact: 'reportDelivery', summary: expect.stringMatching(/delivery failed/) })]);
    expect(closeoutIssuesForVisit(base({ reportDelivery: fact('pending', 'not_enqueued') }))).toEqual([expect.objectContaining({ type: 'report_delivery_incomplete', summary: expect.stringMatching(/never delivered/) })]);
    expect(closeoutIssuesForVisit(base({ reportDelivery: fact('pending', 'project_report_not_sent') }))).toHaveLength(1);
    expect(closeoutIssuesForVisit(base({ reportDelivery: fact('failed', 'delivery_skipped_no_recipient') }))[0].summary).toMatch(/no report recipient on file/);
    for (const r of ['delivery_queued', 'delivery_sending', 'project_report_on_hold', 'recap_sms_in_flight', 'report_not_published']) {
      expect(closeoutIssuesForVisit(base({ reportDelivery: fact('pending', r) }))).toEqual([]);
    }
  });
  test('unevaluated signature requirement is an operator issue with its own type (GH codex r3)', () => {
    const status = { ...base(), requirements: { unevaluated: ['requiresCustomerSignature'] } };
    const issues = closeoutIssuesForVisit(status);
    expect(issues).toEqual([expect.objectContaining({
      type: 'customer_signature_unverified',
      fact: 'requirements',
      reason: 'requires_customer_signature_unevaluated',
      summary: expect.stringMatching(/signature/),
    })]);
    // Not listed → no issue; stuck completion still short-circuits to ONE issue.
    expect(closeoutIssuesForVisit({ ...base(), requirements: { unevaluated: [] } })).toEqual([]);
    const stuck = { ...base({ completion: fact('failed', 'completed_visit_without_record') }), requirements: { unevaluated: ['requiresCustomerSignature'] } };
    expect(closeoutIssuesForVisit(stuck).map((i) => i.type)).toEqual([CLOSEOUT_ALERT_TYPES.completion]);
  });
  test('canonical contradictions map to closeout_contradiction issues with per-code identity (GH codex r4)', () => {
    const status = {
      ...base(),
      contradictions: [
        { code: 'invoice_on_covered_visit', detail: 'x' },
        { code: 'some_future_code', detail: 'y' },
      ],
    };
    const issues = closeoutIssuesForVisit(status);
    expect(issues).toEqual([
      expect.objectContaining({
        type: 'closeout_contradiction',
        fact: 'contradictions',
        reason: 'invoice_on_covered_visit',
        identity: 'closeout_contradiction:invoice_on_covered_visit',
        summary: expect.stringMatching(/covered/),
      }),
      expect.objectContaining({
        reason: 'some_future_code',
        identity: 'closeout_contradiction:some_future_code',
        summary: expect.stringMatching(/some future code/),
      }),
    ]);
    expect(closeoutIssuesForVisit({ ...base(), contradictions: [] })).toEqual([]);
  });
});

describe('loadCloseoutStatuses', () => {
  test('bounded to 2 concurrent, dedupes ids, memoises fully-read results for 90s', async () => {
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
    expect(peak).toBeLessThanOrEqual(2);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(10);
    await loadCloseoutStatuses(ids);
    expect(getCloseoutStatus).toHaveBeenCalledTimes(10);
    await loadCloseoutStatuses(ids, { now: Date.now() + 91 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(20);
  });
  test('outages memoise only BRIEFLY; unrelated-probe failures with fully-known facts memoise long (pre-push r14)', async () => {
    const t0 = Date.now();
    getCloseoutStatus.mockRejectedValueOnce(new Error('down')).mockResolvedValue(base());
    expect((await loadCloseoutStatuses(['a'], { now: t0 })).get('a')).toBeNull();
    // Within the short error TTL a partial outage does not re-pay the probe fan-out…
    await loadCloseoutStatuses(['a'], { now: t0 + 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(1);
    // …but recovery is fast: past the error TTL it refetches.
    await loadCloseoutStatuses(['a'], { now: t0 + 21 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
    // A read with a mapped fact unknown is an outage too — short TTL.
    getCloseoutStatus.mockReset();
    getCloseoutStatus.mockResolvedValue({ ...base({ photos: fact('unknown', 'service_photos_lookup_failed') }), unavailable: [{ lookup: 'service_photos', error: 'timeout' }] });
    await loadCloseoutStatuses(['b'], { now: t0 });
    await loadCloseoutStatuses(['b'], { now: t0 + 21 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
    // An UNRELATED probe failure with all mapped facts known is fully read → 90s memo.
    getCloseoutStatus.mockReset();
    getCloseoutStatus.mockResolvedValue({ ...base(), unavailable: [{ lookup: 'billing_context', error: 'timeout' }] });
    await loadCloseoutStatuses(['c'], { now: t0 });
    await loadCloseoutStatuses(['c'], { now: t0 + 60 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(1);
  });
});
