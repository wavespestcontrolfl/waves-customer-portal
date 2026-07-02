// Unit tests for the cancellation auto-processor: pulling a customer's upcoming
// visits off the calendar through the composed admin-cancel path
// (transitionJobStatus + reminder cancel + invoice void + card-hold resolution
// + track-layer cancel), stopping recurrence, churning the account, and
// winding down billing.

// Stateful mock mirroring transitionJobStatus's contract: atomic guard on
// fromStatus (throws on mismatch), flips status, appends job_status_history.
jest.mock('../services/job-status', () => ({
  transitionJobStatus: jest.fn(async ({ jobId, fromStatus, toStatus }) => {
    const db = require('../models/db');
    const rows = db.__tables.scheduled_services || [];
    const row = rows.find((r) => r.id === jobId);
    if (!row || row.status !== fromStatus) {
      throw new Error(`transitionJobStatus: ${jobId} not in state ${fromStatus} (racing transition or stale fromStatus)`);
    }
    row.status = toStatus;
    row.updated_at = new Date();
    (db.__tables.job_status_history = db.__tables.job_status_history || []).push({
      job_id: jobId,
      from_status: fromStatus,
      to_status: toStatus,
    });
    return { customerPayload: {}, adminPayload: {} };
  }),
}));

// Stateful mock mirroring trackTransitions.cancel semantics: no-op on an
// already-cancelled row, refuses a complete row, otherwise stamps the
// customer-visible track layer.
jest.mock('../services/track-transitions', () => ({
  cancel: jest.fn(async (serviceId, { reason } = {}) => {
    const db = require('../models/db');
    const row = (db.__tables.scheduled_services || []).find((r) => r.id === serviceId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.track_state === 'cancelled') return { ok: true, state: 'cancelled' };
    if (row.track_state === 'complete') return { ok: false, reason: 'cannot_cancel_complete' };
    Object.assign(row, {
      track_state: 'cancelled',
      cancelled_at: new Date(),
      cancellation_reason: reason || null,
    });
    return { ok: true, state: 'cancelled' };
  }),
}));

jest.mock('../services/appointment-reminders', () => ({
  handleCancellation: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/invoice', () => ({
  voidOpenInvoicesForCancelledService: jest.fn().mockResolvedValue([]),
  // Mirrors the real exported list — the processor post-checks with it.
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'],
}));

jest.mock('../services/estimate-card-holds', () => ({
  handleCardHoldCancellation: jest.fn().mockResolvedValue({ handled: false, reason: 'no_hold' }),
}));

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Minimal stateful knex fake keyed by table name. Rows live on db.__tables so
// tests can seed and assert against them directly.
jest.mock('../models/db', () => {
  const tables = {};
  const matchesAll = (row, conds) => conds.every((c) => c(row));
  const colCond = (col, opOrVal, maybeVal) => {
    if (maybeVal === undefined) return (r) => r[col] === opOrVal;
    if (opOrVal === '>=') return (r) => r[col] != null && r[col] >= maybeVal;
    throw new Error(`fake db: unsupported operator ${opOrVal}`);
  };
  function makeQuery(table) {
    const rows = tables[table] || (tables[table] = []);
    const conds = [];
    const q = {
      where(criteria, opOrVal, maybeVal) {
        if (typeof criteria === 'function') {
          // Grouped builder: AND-chains split into OR-disjuncts by orWhere,
          // matching knex's where(function () { this.where(...).orWhere(...) }).
          const disjuncts = [];
          let current = [];
          const group = {
            where(col, op, val) { current.push(colCond(col, op, val)); return group; },
            orWhere(col, op, val) { disjuncts.push(current); current = [colCond(col, op, val)]; return group; },
          };
          criteria.call(group);
          disjuncts.push(current);
          conds.push((r) => disjuncts.some((ds) => ds.every((c) => c(r))));
        } else if (typeof criteria === 'string') {
          conds.push(colCond(criteria, opOrVal, maybeVal));
        } else {
          Object.entries(criteria || {}).forEach(([k, v]) => conds.push((r) => r[k] === v));
        }
        return q;
      },
      whereNot(col, val) { conds.push((r) => r[col] !== val); return q; },
      whereNull(col) { conds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { conds.push((r) => r[col] != null); return q; },
      whereIn(col, vals) { conds.push((r) => vals.includes(r[col])); return q; },
      whereNotIn(col, vals) { conds.push((r) => !vals.includes(r[col])); return q; },
      whereRaw(sql) {
        if (/track_state\s+IS\s+NULL\s+OR\s+track_state\s+NOT\s+IN/i.test(sql)) {
          const excluded = [...sql.matchAll(/'([a-z_]+)'/gi)].map((m) => m[1]);
          conds.push((r) => r.track_state == null || !excluded.includes(r.track_state));
        } else if (/cancelled\s+IS\s+DISTINCT\s+FROM\s+true/i.test(sql)) {
          conds.push((r) => r.cancelled !== true); // JS !== treats null correctly
        }
        return q;
      },
      select() { return Promise.resolve(rows.filter((r) => matchesAll(r, conds))); },
      first() { return Promise.resolve(rows.find((r) => matchesAll(r, conds)) || null); },
      update(updates) {
        let n = 0;
        rows.forEach((r) => { if (matchesAll(r, conds)) { Object.assign(r, updates); n += 1; } });
        return Promise.resolve(n);
      },
      insert(payload) {
        (Array.isArray(payload) ? payload : [payload]).forEach((p) => rows.push({ ...p }));
        return Promise.resolve([1]);
      },
    };
    return q;
  }
  const db = (table) => makeQuery(table);
  db.__tables = tables;
  db.__reset = () => { Object.keys(tables).forEach((k) => delete tables[k]); };
  return db;
});

const db = require('../models/db');
const trackTransitions = require('../services/track-transitions');
const { transitionJobStatus } = require('../services/job-status');
const AppointmentReminders = require('../services/appointment-reminders');
const InvoiceService = require('../services/invoice');
const CardHolds = require('../services/estimate-card-holds');
const { etDateString } = require('../utils/datetime-et');
const { processCancellationRequest, CHURN_REASON } = require('../services/cancellation-processor');

const FUTURE = '2999-01-01';
const PAST = '2000-01-01';

describe('processCancellationRequest', () => {
  beforeEach(() => {
    db.__reset();
    jest.clearAllMocks();
  });

  test('pulls upcoming visits through the composed cancel path, stops recurrence, churns + winds down billing', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      { id: 's2', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      { id: 's3', customer_id: 'c1', status: 'completed', scheduled_date: PAST, track_state: 'complete', cancelled_at: null, recurring_ongoing: false },
      { id: 's4', customer_id: 'c1', status: 'cancelled', scheduled_date: FUTURE, track_state: 'cancelled', cancelled_at: new Date(), recurring_ongoing: false },
      { id: 's5', customer_id: 'other', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      // 'rescheduled' phantom keeps its ORIGINAL (past) date until SmartRebooker
      // actions it — an open rebook intent, pulled regardless of date.
      { id: 's6', customer_id: 'c1', status: 'rescheduled', scheduled_date: PAST, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      // Historical stale pending row — predates the request, left untouched.
      { id: 's7', customer_id: 'c1', status: 'pending', scheduled_date: PAST, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      // no_show history is terminal — never rewritten by an account cancellation.
      { id: 's8', customer_id: 'c1', status: 'no_show', scheduled_date: FUTURE, track_state: null, cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [
      { id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true, next_charge_date: new Date() },
    ];
    db.__tables.payments = [
      { id: 'p1', customer_id: 'c1', status: 'failed', superseded_by_payment_id: null, next_retry_at: new Date() },
      { id: 'p2', customer_id: 'c1', status: 'paid', superseded_by_payment_id: null, next_retry_at: null },
      { id: 'p3', customer_id: 'other', status: 'failed', superseded_by_payment_id: null, next_retry_at: new Date() },
    ];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req1' });

    // s1 (pending future) + s2 (confirmed future) + s6 (rescheduled phantom) pulled.
    expect(result.cancelledCount).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);

    const svc = (id) => db.__tables.scheduled_services.find((r) => r.id === id);
    for (const id of ['s1', 's2', 's6']) {
      expect(svc(id).status).toBe('cancelled');
      expect(svc(id).track_state).toBe('cancelled');
      expect(svc(id).cancelled_at).toBeInstanceOf(Date);
    }
    expect(svc('s3').status).toBe('completed');   // completed visit never touched
    expect(svc('s7').status).toBe('pending');     // historical stale row preserved
    expect(svc('s8').status).toBe('no_show');     // no_show history preserved

    // Composed cancel side effects fired once per pulled visit.
    const pulledIds = ['s1', 's2', 's6'];
    expect(transitionJobStatus).toHaveBeenCalledTimes(3);
    expect(db.__tables.job_status_history.map((h) => h.job_id).sort()).toEqual(pulledIds);
    expect(db.__tables.job_status_history.every((h) => h.to_status === 'cancelled')).toBe(true);
    expect(AppointmentReminders.handleCancellation).toHaveBeenCalledTimes(3);
    for (const id of pulledIds) {
      // Per-visit cancellation SMS suppressed — the route sends one dedicated
      // confirmation SMS for the whole request.
      expect(AppointmentReminders.handleCancellation).toHaveBeenCalledWith(id, { sendNotification: false });
      expect(InvoiceService.voidOpenInvoicesForCancelledService).toHaveBeenCalledWith(id);
      expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: id });
    }
    expect(trackTransitions.cancel).toHaveBeenCalledTimes(3);

    // Recurrence stopped for this customer only.
    expect(svc('s1').recurring_ongoing).toBe(false);
    expect(svc('s2').recurring_ongoing).toBe(false);
    expect(svc('s5').recurring_ongoing).toBe(true);

    // Customer churned / inactive + billing wound down.
    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);
    expect(cust.pipeline_stage).toBe('churned');
    expect(cust.autopay_enabled).toBe(false);
    expect(cust.next_charge_date).toBeNull();
    // churned_at is a DATE column — stamped as the ET calendar date string,
    // not a JS Date (which lands on the wrong day after ET midnight).
    expect(cust.churned_at).toBe(etDateString());
    expect(cust.churn_reason).toBe(CHURN_REASON);
    expect(cust.churn_reason.length).toBeLessThanOrEqual(30);
    expect(result.churned).toBe(true);

    // Armed failed-payment retry disarmed — for this customer only.
    expect(db.__tables.payments.find((p) => p.id === 'p1').next_retry_at).toBeNull();
    expect(db.__tables.payments.find((p) => p.id === 'p3').next_retry_at).toBeInstanceOf(Date);

    // Audit note written once.
    expect(db.__tables.customer_interactions).toHaveLength(1);
    expect(db.__tables.customer_interactions[0].customer_id).toBe('c1');
  });

  test('does not force-cancel or overcount a genuinely-complete visit (inconsistent status)', async () => {
    db.__tables.scheduled_services = [
      // status not literally 'completed' but track_state IS complete — must be left alone.
      { id: 'sC', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'complete', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req2' });

    const sC = db.__tables.scheduled_services[0];
    expect(sC.status).toBe('pending');       // not force-cancelled
    expect(sC.track_state).toBe('complete');
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(result.cancelledCount).toBe(0);   // not overcounted
    expect(result.ok).toBe(true);
  });

  test('a visit raced to a terminal state is a benign no-op; raced to in-progress is flagged for review', async () => {
    db.__tables.scheduled_services = [
      { id: 'sA', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 'sB', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    // sA: a concurrent duplicate request already cancelled it → guard throws,
    // re-check sees terminal 'cancelled' → benign skip, no error.
    transitionJobStatus.mockImplementationOnce(async ({ jobId }) => {
      const row = db.__tables.scheduled_services.find((r) => r.id === jobId);
      row.status = 'cancelled';
      throw new Error(`transitionJobStatus: ${jobId} not in state pending (racing transition or stale fromStatus)`);
    });
    // sB: a tech went en_route mid-request → guard throws, re-check sees a
    // live in-progress visit → recorded for manual review.
    transitionJobStatus.mockImplementationOnce(async ({ jobId }) => {
      const row = db.__tables.scheduled_services.find((r) => r.id === jobId);
      row.status = 'en_route';
      throw new Error(`transitionJobStatus: ${jobId} not in state confirmed (racing transition or stale fromStatus)`);
    });

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req4' });

    expect(result.cancelledCount).toBe(0);
    expect(result.errors).toEqual(['cancel_visit:sB']);
    expect(result.ok).toBe(false);
    // The raced-to-CANCELLED visit still gets the idempotent side effects so a
    // half-processed concurrent duplicate is repaired; the in-progress one
    // (flip never committed) gets none.
    expect(InvoiceService.voidOpenInvoicesForCancelledService).toHaveBeenCalledTimes(1);
    expect(InvoiceService.voidOpenInvoicesForCancelledService).toHaveBeenCalledWith('sA');
    expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledTimes(1);
    expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: 'sA' });
  });

  test('a retry repairs side effects for visits a prior attempt already cancelled', async () => {
    const reason = 'Portal cancellation request req1';
    db.__tables.scheduled_services = [
      // Attempt 1 flipped the status but its side effects failed: the track
      // layer is still 'scheduled' and an invoice is still open.
      { id: 's1', customer_id: 'c1', status: 'cancelled', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      // Cancelled by this request too, but an admin has since revived it —
      // current status is no longer 'cancelled', so the repair leaves it alone
      // (past-dated, so the fresh sweep skips it as well).
      { id: 'sRevived', customer_id: 'c1', status: 'pending', scheduled_date: PAST, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.job_status_history = [
      { job_id: 's1', from_status: 'pending', to_status: 'cancelled', notes: reason },
      { job_id: 'sRevived', from_status: 'pending', to_status: 'cancelled', notes: reason },
    ];
    db.__tables.invoices = [
      { id: 'inv1', scheduled_service_id: 's1', status: 'sent' },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'churned', active: false, churned_at: '2026-07-01', churn_reason: 'old', autopay_enabled: false }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', reason, requestId: 'req1' });

    // Nothing newly flipped — the repair pass re-runs side effects only.
    expect(result.cancelledCount).toBe(0);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(AppointmentReminders.handleCancellation).toHaveBeenCalledWith('s1', { sendNotification: false });
    expect(InvoiceService.voidOpenInvoicesForCancelledService).toHaveBeenCalledWith('s1');
    expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: 's1' });
    // Track layer repaired this time.
    const s1 = db.__tables.scheduled_services.find((r) => r.id === 's1');
    expect(s1.track_state).toBe('cancelled');
    // Still-unresolved money keeps the review flag up.
    expect(result.errors).toContain('invoice_review:inv1');
    // The revived visit was left alone.
    const revived = db.__tables.scheduled_services.find((r) => r.id === 'sRevived');
    expect(revived.status).toBe('pending');
    expect(AppointmentReminders.handleCancellation).not.toHaveBeenCalledWith('sRevived', expect.anything());
  });

  test('a visit whose tracker goes live between the sweep and the flip is reverted and flagged', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    // Simulate the race: the flip commits, but by then a tech has gone
    // en_route on the tracker with its best-effort status sync failing.
    transitionJobStatus.mockImplementationOnce(async ({ jobId, fromStatus, toStatus }) => {
      const row = db.__tables.scheduled_services.find((r) => r.id === jobId);
      if (!row || row.status !== fromStatus) throw new Error(`transitionJobStatus: ${jobId} not in state ${fromStatus}`);
      row.status = toStatus;
      row.track_state = 'en_route';
      (db.__tables.job_status_history = db.__tables.job_status_history || []).push({ job_id: jobId, from_status: fromStatus, to_status: toStatus });
      return { customerPayload: {}, adminPayload: {} };
    });

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req11' });

    // Compensating revert restored the pre-flip status (second, default-mock
    // transitionJobStatus call) and the visit is flagged, not counted.
    const s1 = db.__tables.scheduled_services.find((r) => r.id === 's1');
    expect(s1.status).toBe('pending');
    expect(transitionJobStatus).toHaveBeenCalledTimes(2);
    expect(result.cancelledCount).toBe(0);
    expect(result.errors).toEqual(['in_progress_visit:s1']);
    expect(result.ok).toBe(false);
    // No side effects for a reverted cancel.
    expect(InvoiceService.voidOpenInvoicesForCancelledService).not.toHaveBeenCalled();
    expect(CardHolds.handleCardHoldCancellation).not.toHaveBeenCalled();
  });

  test('a money-path side-effect failure is recorded but does not strand the sweep', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's2', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    CardHolds.handleCardHoldCancellation.mockRejectedValueOnce(new Error('stripe down'));

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req5' });

    // Both visits still cancelled; the card-hold failure is surfaced.
    expect(result.cancelledCount).toBe(2);
    expect(result.errors).toEqual(['card_hold:s1']);
    expect(result.ok).toBe(false);
    expect(db.__tables.scheduled_services.every((r) => r.status === 'cancelled')).toBe(true);
  });

  test('an invoice the void sweep could not safely resolve is surfaced for manual review', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    // voidOpenInvoicesForCancelledService never throws — it silently skips
    // whatever it can't safely void. The post-check must catch everything not
    // money-resolved: a skipped voidable invoice AND captured money ('paid' —
    // cash collected for a visit that now won't happen → refund decision).
    db.__tables.invoices = [
      { id: 'inv1', scheduled_service_id: 's1', status: 'sent' },
      { id: 'inv2', scheduled_service_id: 's1', status: 'void' },      // already voided — fine
      { id: 'inv3', scheduled_service_id: 'other', status: 'sent' },   // other visit — untouched
      { id: 'inv4', scheduled_service_id: 's1', status: 'paid' },      // captured money — review
      { id: 'inv5', scheduled_service_id: 's1', status: 'refunded' },  // already resolved — fine
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req6' });

    expect(result.cancelledCount).toBe(1);
    expect(result.errors).toEqual(['invoice_review:inv1', 'invoice_review:inv4']);
    expect(result.ok).toBe(false);
  });

  test('a reminder row left uncancelled after the helper runs is surfaced for manual review', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's2', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    // handleCancellation swallows its own failures and returns null — the
    // default mock here doesn't touch the rows, simulating a silent failure
    // for s1. s2's row reads as if the helper succeeded.
    db.__tables.appointment_reminders = [
      { id: 'r1', scheduled_service_id: 's1', cancelled: false },
      { id: 'r2', scheduled_service_id: 's2', cancelled: true },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req12' });

    expect(result.cancelledCount).toBe(2);
    expect(result.errors).toEqual(['reminder_cancel:s1']);
    expect(result.ok).toBe(false);
  });

  test('a failed or non-ok track-layer cancel is surfaced so staff repair the public tracker', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's2', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's3', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    trackTransitions.cancel
      .mockResolvedValueOnce({ ok: false, reason: 'not_found' })  // s1: non-ok result
      .mockRejectedValueOnce(new Error('socket layer down'));     // s2: throw
    // s3 falls through to the default stateful mock → ok.

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req9' });

    // All three status flips still committed; the tracker failures are surfaced.
    expect(result.cancelledCount).toBe(3);
    expect(result.errors).toEqual(['track_cancel:s1', 'track_cancel:s2']);
    expect(result.ok).toBe(false);
    expect(db.__tables.scheduled_services.every((r) => r.status === 'cancelled')).toBe(true);
  });

  test('a card-hold outcome that leaves money unresolved is surfaced; benign outcomes are not', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's2', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's3', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    CardHolds.handleCardHoldCancellation
      .mockResolvedValueOnce({ charged: false, reason: 'charge_failed', error: 'card declined' })
      .mockResolvedValueOnce({ charged: false, reason: 'charge_review', error: 'ambiguous' })
      .mockResolvedValueOnce({ released: true }); // free release — benign

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req7' });

    expect(result.cancelledCount).toBe(3);
    expect(result.errors).toEqual(['card_hold:s1', 'card_hold:s2']);
    expect(result.ok).toBe(false);
  });

  test('an in-progress visit is never auto-cancelled but is flagged for manual review; churn still proceeds', async () => {
    db.__tables.scheduled_services = [
      { id: 'sLive', customer_id: 'c1', status: 'en_route', scheduled_date: FUTURE, track_state: 'en_route', cancelled_at: null, recurring_ongoing: true },
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req8' });

    // The live visit stays live; the pending one is pulled.
    const live = db.__tables.scheduled_services.find((r) => r.id === 'sLive');
    expect(live.status).toBe('en_route');
    expect(result.cancelledCount).toBe(1);
    // Flagged so the admin alert says "review manually" instead of claiming
    // full auto-processing while a tech is rolling.
    expect(result.errors).toEqual(['in_progress_visit:sLive']);
    expect(result.ok).toBe(false);
    // Churn + billing wind-down still run (owner directive: churn on submit).
    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);
    expect(cust.pipeline_stage).toBe('churned');
    expect(cust.autopay_enabled).toBe(false);
    expect(result.churned).toBe(true);
    // The live visit's recurrence is still stopped.
    expect(live.recurring_ongoing).toBe(false);
  });

  test('a visit whose track_state leads its lagging legacy status is treated as in progress, not swept', async () => {
    db.__tables.scheduled_services = [
      // Tech is on the property but the best-effort status sync failed —
      // status still says 'confirmed'. Must NOT be auto-cancelled.
      { id: 'sDrift', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'on_property', cancelled_at: null, recurring_ongoing: false },
      // Stale drift the other way: finished visit whose track_state stuck at
      // en_route — history, neither swept (terminal status) nor flagged live.
      { id: 'sStale', customer_id: 'c1', status: 'completed', scheduled_date: PAST, track_state: 'en_route', cancelled_at: null, recurring_ongoing: false },
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: null, cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req10' });

    const svc = (id) => db.__tables.scheduled_services.find((r) => r.id === id);
    expect(svc('sDrift').status).toBe('confirmed');       // live work untouched
    expect(svc('sStale').status).toBe('completed');       // history untouched
    expect(svc('s1').status).toBe('cancelled');           // NULL track_state still sweeps
    expect(result.cancelledCount).toBe(1);
    expect(result.errors).toEqual(['in_progress_visit:sDrift']);
    expect(result.ok).toBe(false);
  });

  test('already-churned account is re-inactivated but keeps its original churn date and writes no new note', async () => {
    const originalChurnedAt = '2026-01-01';
    db.__tables.scheduled_services = [];
    db.__tables.payments = [];
    // pipeline is already churned but active was left true (the finding-2 case).
    db.__tables.customers = [
      { id: 'c1', pipeline_stage: 'churned', active: true, churned_at: originalChurnedAt, churn_reason: 'old', autopay_enabled: true },
    ];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req3' });

    const cust = db.__tables.customers[0];
    expect(cust.active).toBe(false);                  // finding 2: active flipped even when already churned
    expect(cust.autopay_enabled).toBe(false);
    expect(cust.churned_at).toBe(originalChurnedAt);  // original churn date preserved
    expect(cust.churn_reason).toBe('old');            // original reason preserved
    expect(result.churned).toBe(true);
    expect(db.__tables.customer_interactions).toHaveLength(0); // no duplicate audit note
  });

  test('throws when customerId is missing', async () => {
    await expect(processCancellationRequest({})).rejects.toThrow(/customerId/);
  });
});
