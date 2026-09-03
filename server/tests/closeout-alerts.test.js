/**
 * closeout-alerts — the one fact→issue mapping + the per-visit memo shared by
 * dashboard-alerts (live feed) and the command-center route.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));

const { getCloseoutStatus } = require('../services/closeout-status');
const { loadCloseoutStatuses, closeoutIssuesForVisit, factsFullyKnown, CLOSEOUT_ALERT_TYPES, CLOSEOUT_ALERT_LABELS, __private } = require('../services/closeout-alerts');

const fact = (state, reason, extra = {}) => ({ state, reason, ...extra });
const base = (o = {}) => ({
  found: true,
  facts: {
    completion: fact('done', 'record_exists'), application: fact('done', 'x'), photos: fact('not_required', 'x'),
    report: fact('done', 'x'), reportDelivery: fact('done', 'x'), ...o,
  },
});

beforeEach(() => { jest.clearAllMocks(); __private.memo.clear(); delete process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS; });

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

describe('money + comms facts (GATE_CLOSEOUT_MONEY_COMMS_ALERTS)', () => {
  const on = () => { process.env.GATE_CLOSEOUT_MONEY_COMMS_ALERTS = 'true'; };
  const money = (o = {}) => base({ invoice: fact('done', 'invoice_exists'), invoiceDelivery: fact('done', 'invoice_delivered'), comms: fact('done', 'completion_sms_sent'), ...o });

  test('gate OFF: the three facts never produce an issue and never hold the floor (byte-identical to the legacy mapping)', () => {
    const open = money({ comms: fact('failed', 'completion_sms_failed'), invoice: fact('pending', 'expected_invoice_not_minted'), invoiceDelivery: fact('failed', 'receipt_delivery_exhausted') });
    expect(closeoutIssuesForVisit(open)).toEqual([]);
    expect(factsFullyKnown(money({ comms: fact('unknown', 'no_comms_marker_on_record'), invoiceDelivery: fact('unknown', 'receipt_job_lookup_failed') }))).toBe(true);
  });

  test('comms: only failed alerts; deferral, sending, recap in flight, consent block and every not_required stay silent', () => {
    on();
    expect(closeoutIssuesForVisit(money({ comms: fact('failed', 'completion_sms_failed') }))).toEqual([
      expect.objectContaining({ type: 'completion_notice_failed', fact: 'comms', reason: 'completion_sms_failed', summary: expect.stringMatching(/failed to send/) }),
    ]);
    for (const c of [
      fact('pending', 'deferred_send_window'), fact('pending', 'completion_sms_sending'), fact('pending', 'recap_sms_in_flight'), fact('pending', 'awaiting_completion'),
      fact('not_required', 'completion_sms_blocked_consent'), fact('not_required', 'frozen_posture_manual'), fact('not_required', 'catalog_no_customer_notice'), fact('not_required', 'backfill_completion'),
      fact('unknown', 'no_comms_marker_on_record'), fact('unknown', 'recap_claim_unverified'),
    ]) expect(closeoutIssuesForVisit(money({ comms: c }))).toEqual([]);
  });

  test('invoice: the actionable pending reasons alert; awaiting / not_required / unknown / done stay silent', () => {
    on();
    const reasons = ['parked_manual_refunded_invoice', 'parked_manual_canceled_setup_fee', 'frozen_required_mint_not_minted', 'expected_invoice_not_minted', 'expected_payer_not_minted', 'expected_auto_charge_not_minted'];
    for (const r of reasons) {
      const issues = closeoutIssuesForVisit(money({ invoice: fact('pending', r) }));
      expect(issues).toEqual([expect.objectContaining({ type: 'invoice_not_minted', fact: 'invoice', reason: r })]);
    }
    expect(closeoutIssuesForVisit(money({ invoice: fact('pending', 'parked_manual_refunded_invoice') }))[0].summary).toMatch(/refunded invoice/);
    expect(closeoutIssuesForVisit(money({ invoice: fact('pending', 'parked_manual_canceled_setup_fee') }))[0].summary).toMatch(/setup fee/);
    expect(closeoutIssuesForVisit(money({ invoice: fact('pending', 'frozen_required_mint_not_minted') }))[0].summary).toMatch(/never minted/);
    for (const f of [fact('pending', 'awaiting_completion'), fact('not_required', 'lane_covered_membership'), fact('not_required', 'disposition_intentionally_free'), fact('unknown', 'invoice_lookup_failed'), fact('done', 'invoice_paid')]) {
      expect(closeoutIssuesForVisit(money({ invoice: f }))).toEqual([]);
    }
  });

  test('invoiceDelivery: failed + the two never-sent pendings alert; queue-owned, send-window, draft-unsent, no-invoice-yet, opt-out stay silent', () => {
    on();
    const cases = [
      ['receipt_no_recipient', 'failed', /no receipt recipient/],
      ['receipt_delivery_exhausted', 'failed', /failed after retries/],
      ['completion_sms_failed', 'failed', /pay-link text/],
      ['paid_receipt_not_sent', 'pending', /no receipt was ever sent/],
      ['payer_invoice_unsent', 'pending', /never sent to the payer/],
    ];
    for (const [reason, state, re] of cases) {
      expect(closeoutIssuesForVisit(money({ invoiceDelivery: fact(state, reason) }))).toEqual([
        expect.objectContaining({ type: 'invoice_delivery_incomplete', fact: 'invoiceDelivery', reason, summary: expect.stringMatching(re) }),
      ]);
    }
    for (const f of [
      fact('pending', 'receipt_queued'), fact('pending', 'receipt_processing'), fact('pending', 'receipt_pending'), fact('pending', 'deferred_send_window'),
      fact('pending', 'invoice_draft_unsent'), fact('pending', 'no_invoice_yet'), fact('pending', 'awaiting_completion'),
      fact('not_required', 'receipt_opted_out'), fact('not_required', 'lane_covered_annual'), fact('unknown', 'receipt_job_lookup_failed'), fact('done', 'paid_receipt_delivered'),
    ]) expect(closeoutIssuesForVisit(money({ invoiceDelivery: f }))).toEqual([]);
  });

  test('gate ON: the three issues stack after the legacy ones on distinct lifecycle keys; a stuck completion still short-circuits', () => {
    on();
    const issues = closeoutIssuesForVisit(money({
      report: fact('pending', 'no_report_artifact'),
      comms: fact('failed', 'completion_sms_failed'),
      invoice: fact('pending', 'expected_invoice_not_minted'),
      invoiceDelivery: fact('pending', 'no_invoice_yet'),
    }));
    expect(issues.map((i) => i.type)).toEqual(['missing_required_service_report', 'completion_notice_failed', 'invoice_not_minted']);
    expect(new Set(issues.map((i) => i.type)).size).toBe(issues.length);
    for (const t of ['completion_notice_failed', 'invoice_not_minted', 'invoice_delivery_incomplete']) expect(CLOSEOUT_ALERT_LABELS[t]).toEqual(expect.any(String));
    const stuck = money({ completion: fact('failed', 'completion_attempt_failed'), comms: fact('failed', 'completion_sms_failed'), invoice: fact('pending', 'expected_invoice_not_minted') });
    expect(closeoutIssuesForVisit(stuck).map((i) => i.type)).toEqual([CLOSEOUT_ALERT_TYPES.completion]);
  });

  test('gate ON: a comms or invoiceDelivery outage makes the read incomplete (holds the floor); followUp/license still do not', () => {
    on();
    expect(factsFullyKnown(money({ comms: fact('unknown', 'no_comms_marker_on_record') }))).toBe(false);
    expect(factsFullyKnown(money({ invoiceDelivery: fact('unknown', 'receipt_job_lookup_failed') }))).toBe(false);
    expect(factsFullyKnown(money({ followUp: fact('unknown', 'x'), license: fact('unknown', 'x') }))).toBe(true);
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
    // An UNKNOWN invoice fact is an outage too (pre-push r18): invoice inputs
    // feed the invoice_* contradictions, so the read is incomplete.
    getCloseoutStatus.mockReset();
    getCloseoutStatus.mockResolvedValue(base({ invoice: fact('unknown', 'billing_disposition_lookup_failed') }));
    await loadCloseoutStatuses(['d'], { now: t0 });
    await loadCloseoutStatuses(['d'], { now: t0 + 21 * 1000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
    // fresh:true bypasses the memo READ inside the TTL (write-sensitive
    // snapshots must not persist a stale count — pre-push r20) but still
    // refreshes the memo for subsequent non-fresh reads.
    getCloseoutStatus.mockReset();
    getCloseoutStatus.mockResolvedValue(base());
    await loadCloseoutStatuses(['e'], { now: t0 });
    await loadCloseoutStatuses(['e'], { now: t0 + 1000, fresh: true });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
    await loadCloseoutStatuses(['e'], { now: t0 + 2000 });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(2);
  });
});
