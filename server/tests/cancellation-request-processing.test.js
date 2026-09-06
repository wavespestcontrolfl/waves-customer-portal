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
// already-cancelled row, refuses a complete row, and — like the real helper's
// guarded update — only stamps rows whose track_state is a live value (NULL
// falls through to the ok-with-fallback path without stamping anything).
jest.mock('../services/track-transitions', () => ({
  cancel: jest.fn(async (serviceId, { reason } = {}) => {
    const db = require('../models/db');
    const row = (db.__tables.scheduled_services || []).find((r) => r.id === serviceId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.track_state === 'cancelled') return { ok: true, state: 'cancelled' };
    if (row.track_state === 'complete') return { ok: false, reason: 'cannot_cancel_complete' };
    if (!['scheduled', 'en_route', 'on_property'].includes(row.track_state)) {
      // 0-row guarded update — the real helper re-loads and reports ok.
      return { ok: true, state: row.track_state || 'cancelled' };
    }
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

// Churn-reason classifier (Phase 7) — mocked so tests control the outcome;
// the default resolves unclassified (the real module's fail-closed floor).
const mockNotifyAdmin = jest.fn().mockResolvedValue({ id: 'notif-1' });
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));

jest.mock('../services/churn-classifier', () => ({
  classifyChurnReason: jest.fn().mockResolvedValue({ code: 'unclassified', source: 'none' }),
}));

jest.mock('../services/invoice', () => ({
  voidOpenInvoicesForCancelledService: jest.fn().mockResolvedValue([]),
  // Mirrors the real exported list — the processor post-checks with it.
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'],
}));

jest.mock('../services/estimate-card-holds', () => ({
  handleCardHoldCancellation: jest.fn().mockResolvedValue({ handled: false, reason: 'no_hold' }),
}));

// Appointment-card fee lane — consulted only when the hold rail reports
// no_hold (mutually exclusive lanes). Default: no fee lane on the visit.
jest.mock('../services/appointment-card-request', () => ({
  handleAppointmentCardCancellation: jest.fn().mockResolvedValue({ handled: false, released: true, reason: 'no_card_request' }),
}));

// The keep-through sweep reads only the coverage-identity constant — never
// load the heavy renewals module inside this harness.
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
}));

// Plan-rate ledger: the repair-only retry VERIFIES the first run's scoped
// wind-down through loadComponents; default = clean (no residual component).
const mockLoadComponents = jest.fn(async () => []);
jest.mock('../services/plan-rate-ledger', () => ({
  loadComponents: (...a) => mockLoadComponents(...a),
  resetLedgerToScalar: jest.fn(async () => {}),
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
    // keepThrough (C3) narrows the sweep to strictly-after the paid window.
    if (opOrVal === '>') return (r) => r[col] != null && r[col] > maybeVal;
    throw new Error(`fake db: unsupported operator ${opOrVal}`);
  };
  // Grouped builder: AND-chains split into OR-disjuncts by orWhere, matching
  // knex's where(function () { this.where(...).orWhere(...) }). Recursive —
  // a nested where(function) becomes one condition of the enclosing chain.
  function buildGroupMatcher(fn) {
    const disjuncts = [];
    let current = [];
    const asCond = (a, op, val) => (typeof a === 'function' ? buildGroupMatcher(a) : colCond(a, op, val));
    const group = {
      where(a, op, val) { current.push(asCond(a, op, val)); return group; },
      orWhere(a, op, val) { disjuncts.push(current); current = [asCond(a, op, val)]; return group; },
      whereNull(col) { current.push((r) => r[col] == null); return group; },
      whereNotNull(col) { current.push((r) => r[col] != null); return group; },
      whereIn(col, vals) { current.push((r) => vals.includes(r[col])); return group; },
      whereNotIn(col, vals) { current.push((r) => !vals.includes(r[col])); return group; },
      whereRaw(sql, bindings) {
        const distinct = String(sql).match(/\(?\s*([a-z_]+)\s+IS\s+DISTINCT\s+FROM\s+\?/i);
        if (!distinct) throw new Error(`fake db group: unsupported whereRaw ${sql}`);
        const col = distinct[1];
        const v = Array.isArray(bindings) ? bindings[0] : bindings;
        current.push((r) => r[col] !== v); // JS !== is null-safe like IS DISTINCT FROM
        return group;
      },
    };
    fn.call(group);
    disjuncts.push(current);
    return (r) => disjuncts.some((ds) => ds.every((c) => c(r)));
  }
  function makeQuery(table) {
    const rows = tables[table] || (tables[table] = []);
    const conds = [];
    const q = {
      where(criteria, opOrVal, maybeVal) {
        if (typeof criteria === 'function') {
          conds.push(buildGroupMatcher(criteria));
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
      // Scoped-path support: the aliased join reads its own (empty) table,
      // so live-row family resolution yields scope_not_owned — exactly the
      // post-first-attempt state the repair-only retry runs from.
      leftJoin() { return q; },
      forUpdate() { return q; },
      whereIn(col, vals) { conds.push((r) => (vals instanceof Set ? vals.has(r[col]) : vals.includes(r[col]))); return q; },
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
  // The retrieval-task raise runs retire + insert on one transaction under
  // an advisory lock; the fake shares the same tables and swallows raw().
  db.transaction = async (fn) => {
    const trx = (table) => makeQuery(table);
    trx.raw = async () => ({});
    trx.fn = { now: () => new Date() };
    return fn(trx);
  };
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
const { classifyChurnReason } = require('../services/churn-classifier');

const FUTURE = '2999-01-01';
const PAST = '2000-01-01';

describe('processCancellationRequest', () => {
  beforeEach(() => {
    db.__reset();
    jest.clearAllMocks();
  });

  test('pulls upcoming visits through the composed cancel path, stops recurrence, churns + winds down billing', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', is_recurring: true, recurring_pattern: 'quarterly', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      { id: 's2', customer_id: 'c1', is_recurring: true, recurring_parent_id: 's1', recurring_pattern: 'quarterly', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
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
    db.__tables.payment_methods = [
      { id: 'pm1', customer_id: 'c1', is_default: true, autopay_enabled: true },
      { id: 'pm2', customer_id: 'c1', is_default: false, autopay_enabled: true },
      { id: 'pm3', customer_id: 'other', is_default: true, autopay_enabled: true },
    ];
    db.__tables.customer_interactions = [];

    db.__tables.recurring_plan_alerts = [
      { id: 'old-lapse', recurring_parent_id: 's1', customer_id: 'c1', alert_type: 'plan_lapsed', resolved_at: null },
      { id: 'other-lapse', recurring_parent_id: 's1', customer_id: 'other', alert_type: 'plan_lapsed', resolved_at: null },
    ];
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
    const decisions = db.__tables.recurring_plan_alerts;
    expect(decisions.filter(row => row.customer_id === 'c1')).toHaveLength(2);
    expect(decisions.filter(row => row.customer_id === 'c1').every(row => row.resolved_action === 'cancel_series' && row.resolved_at)).toBe(true);
    expect(decisions.find(row => row.id === 'other-lapse').resolved_at).toBeNull();

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

    // Saved payment METHODS disabled too — StripeService.charge() selects by
    // payment_methods.autopay_enabled alone, so the customer flag isn't enough.
    expect(db.__tables.payment_methods.find((m) => m.id === 'pm1').autopay_enabled).toBe(false);
    expect(db.__tables.payment_methods.find((m) => m.id === 'pm2').autopay_enabled).toBe(false);
    expect(db.__tables.payment_methods.find((m) => m.id === 'pm3').autopay_enabled).toBe(true);

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
      // ANOTHER customer's cancelled visit whose history note happens to carry
      // the same string — the hard customer scope must keep it out.
      { id: 'sOtherCust', customer_id: 'other', status: 'cancelled', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.job_status_history = [
      { job_id: 's1', from_status: 'pending', to_status: 'cancelled', notes: reason },
      { job_id: 'sRevived', from_status: 'pending', to_status: 'cancelled', notes: reason },
      { job_id: 'sOtherCust', from_status: 'pending', to_status: 'cancelled', notes: reason },
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
    // The other customer's visit was never touched despite the matching note.
    expect(AppointmentReminders.handleCancellation).not.toHaveBeenCalledWith('sOtherCust', expect.anything());
    expect(InvoiceService.voidOpenInvoicesForCancelledService).not.toHaveBeenCalledWith('sOtherCust');
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

  test('appointment-card fee outcomes surface the same money-unresolved reasons (hold-less visits)', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      { id: 's2', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    // Hold rail reports no_hold (default) → the appointment rail is
    // consulted; a declined fee parks money unresolved, a clean outside-
    // window cancel is benign.
    const ApptCardRequests = require('../services/appointment-card-request');
    ApptCardRequests.handleAppointmentCardCancellation
      .mockResolvedValueOnce({ charged: false, reason: 'charge_review', error: 'ambiguous' })
      .mockResolvedValueOnce({ handled: true, released: true, reason: 'cancel_outside_window' });

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req8' });

    expect(result.cancelledCount).toBe(2);
    expect(result.errors).toEqual(['appt_card_fee:s1']);
    expect(result.ok).toBe(false);
    // Customer-initiated cancel: the fallback never passes a waive flag.
    expect(ApptCardRequests.handleAppointmentCardCancellation).toHaveBeenCalledWith({ scheduledServiceId: 's1' });
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
    // A NULL-track legacy row is normalized before the track-layer cancel, so
    // the guarded update matches and the tracker fields actually get stamped
    // (the helper's 0-row fallback reports ok WITHOUT stamping).
    expect(svc('s1').track_state).toBe('cancelled');
    expect(svc('s1').cancelled_at).toBeInstanceOf(Date);
    expect(result.cancelledCount).toBe(1);
    expect(result.errors).toEqual(['in_progress_visit:sDrift']);
    expect(result.ok).toBe(false);
  });

  test('a straggler occurrence inserted mid-sweep is caught by the second sweep pass', async () => {
    db.__tables.scheduled_services = [
      { id: 's1', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    // Simulate a concurrent completion auto-extending the series while the
    // first visit is being cancelled: the flip commits AND a fresh future
    // occurrence appears that the first sweep never saw.
    transitionJobStatus.mockImplementationOnce(async ({ jobId, fromStatus, toStatus }) => {
      const rows = db.__tables.scheduled_services;
      const row = rows.find((r) => r.id === jobId);
      if (!row || row.status !== fromStatus) throw new Error(`transitionJobStatus: ${jobId} not in state ${fromStatus}`);
      row.status = toStatus;
      rows.push({ id: 'sNew', customer_id: 'c1', status: 'pending', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false });
      (db.__tables.job_status_history = db.__tables.job_status_history || []).push({ job_id: jobId, from_status: fromStatus, to_status: toStatus });
      return { customerPayload: {}, adminPayload: {} };
    });

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'req13' });

    const svc = (id) => db.__tables.scheduled_services.find((r) => r.id === id);
    expect(svc('s1').status).toBe('cancelled');
    expect(svc('sNew').status).toBe('cancelled'); // caught by pass 2
    expect(result.cancelledCount).toBe(2);
    expect(result.ok).toBe(true);
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

  describe('churn-reason taxonomy (Phase 7)', () => {
    test('stamps churn_mrr + detail at churn, then applies the classified code', async () => {
      classifyChurnReason.mockResolvedValue({ code: 'price', source: 'live' });
      db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true, monthly_rate: 89.5 }];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Too expensive, found cheaper', requestId: 'r1' });
      const cust = db.__tables.customers[0];
      expect(result.churned).toBe(true);
      expect(cust.churn_mrr).toBe(89.5); // rate snapshotted AT churn
      expect(cust.churn_reason_detail).toBe('Too expensive, found cheaper');
      expect(cust.churn_reason_code).toBe('price');
      expect(cust.churn_reason).toBe(CHURN_REASON); // legacy short reason still written
      expect(classifyChurnReason).toHaveBeenCalledWith('Too expensive, found cheaper');
    });

    test('classifier failure leaves unclassified and NEVER flags the request (fail-closed, not an error)', async () => {
      classifyChurnReason.mockRejectedValue(new Error('provider down'));
      db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true, monthly_rate: 45 }];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'whatever', requestId: 'r1' });
      const cust = db.__tables.customers[0];
      expect(cust.churn_reason_code).toBe('unclassified');
      expect(cust.churn_mrr).toBe(45); // the synchronous stamps still landed
      expect(result.ok).toBe(true); // classification is never an operational failure
      expect(result.errors).toEqual([]);
    });

    test('already-churned customer: taxonomy untouched, classifier not called', async () => {
      classifyChurnReason.mockResolvedValue({ code: 'price', source: 'live' });
      db.__tables.customers = [{
        id: 'c1', pipeline_stage: 'churned', active: true, autopay_enabled: true,
        monthly_rate: 60, churned_at: '2026-06-01', churn_reason: 'old',
        churn_reason_code: 'moving', churn_reason_detail: 'original words', churn_mrr: 120,
      }];
      await processCancellationRequest({ customerId: 'c1', reason: 'new words', requestId: 'r2' });
      const cust = db.__tables.customers[0];
      expect(cust.churn_reason_code).toBe('moving'); // original classification preserved
      expect(cust.churn_reason_detail).toBe('original words');
      expect(cust.churn_mrr).toBe(120); // original snapshot preserved
      expect(classifyChurnReason).not.toHaveBeenCalled();
    });
  });
  test('visitReason: the cancelled rows carry the customer-safe copy while the churn columns keep the internal reason', async () => {
    db.__tables.scheduled_services = [
      { id: 'v1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-01', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    const result = await processCancellationRequest({
      customerId: 'c1', requestId: 'reqV', actor: { type: 'admin', userId: 'admin-1' },
      reason: 'price — gate code 4471, owner travelling', visitReason: 'Service plan cancelled',
    });

    expect(result.ok).toBe(true);
    // The public tracker echoes cancellation_reason verbatim to anyone
    // holding a shared link: never the operator's note.
    expect(db.__tables.scheduled_services[0].cancellation_reason).toBe('Service plan cancelled');
    expect(db.__tables.customers[0].churn_reason_detail).toMatch(/gate code 4471/);
  });

  test('raises ONE deduped office task when the churned account has Waves-owned bait stations', async () => {
    db.__tables.scheduled_services = [];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [
      { id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true },
      { id: 't2', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: false },   // retired — not counted
      { id: 't3', customer_id: 'c1', program: 'termite', owned_by: 'customer', is_active: true }, // theirs — not ours to pull
      { id: 't4', customer_id: 'other', program: 'termite', owned_by: 'waves', is_active: true },
      { id: 't5', customer_id: 'c1', program: 'rodent', owned_by: 'waves', is_active: true },     // rodent hardware — not a bait rental
    ];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqT' });

    expect(result.churned).toBe(true);
    expect(result.errors).not.toContain('termite_retrieval_task');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('service');
    expect(title).toMatch(/Termite stations to retrieve/);
    expect(body).toMatch(/^1 Waves-owned bait station on this property/);
    expect(body).toMatch(/No charge to the customer/);
    expect(opts.dedupeKey).toBe('termite_station_retrieval:c1:reqT');
    expect(opts.bell).toBe(true);
    expect(opts.metadata).toEqual(expect.objectContaining({ kind: 'termite_station_retrieval', customerId: 'c1', stationCount: 1 }));
  });

  test('deferTermiteRetrieval holds the IMMEDIATE task for the caller\'s term decision — an end-now prepaid cancel raises nothing here', async () => {
    db.__tables.scheduled_services = [];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [
      { id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true },
    ];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqT3', deferTermiteRetrieval: true });

    expect(result.churned).toBe(true);
    expect(result.errors).not.toContain('termite_retrieval_task');
    // Returned to the caller, exactly like the dated task: the annual-
    // prepay cancel decision is recorded AFTER this run, and a conflicting
    // or lost decision must leave no instruction to pull stations from a
    // term that still stands.
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(result.termiteRetrievalPending).toEqual({ retrieveAfter: null });
  });

  test('end-of-coverage cancel DATES the retrieval task for the coverage boundary — stations stay until paid termite visits deliver', async () => {
    db.__tables.scheduled_services = [
      { id: 'tv1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-01', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false, prepaid_method: 'annual_prepay_invoice', service_type: 'Termite Bait Station Quarterly' },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [
      { id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true },
    ];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqT2', keepThrough: '2099-02-28', keepVisitIds: ['tv1'] });

    expect(result.churned).toBe(true);
    // The DATED task is DEFERRED, never raised here: it also depends on the
    // caller's annual-prepay term decision, which happens after this run —
    // a conflicting renew decision must leave no instruction to pull
    // stations from a program that continues.
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(result.termiteRetrievalPending).toEqual({ retrieveAfter: '2099-02-28' });
    // The covered termite visit stays on the calendar.
    expect(db.__tables.scheduled_services[0].status).toBe('confirmed');
  });

  test('a waiver never papers over an already-charged fee — terminal charged holds park for office review', async () => {
    db.__tables.scheduled_services = [
      { id: 'w1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-01', track_state: null, cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    // Run 1 already charged the late-cancel fee: the hold is terminal and
    // invisible to heldCardForScheduledService (the rail reports no_hold).
    db.__tables.estimate_card_holds = [{ id: 'h9', scheduled_service_id: 'w1', status: 'charged_no_show' }];
    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqW', waiveLateFee: true });
    expect(result.errors).toContain('card_hold_already_charged:w1');
    // The record must NOT claim a waiver for money the customer already paid.
    expect(result.lateFeeWaived).toBe(false);
  });

  test('feeEvaluationAt freezes the fee rails\' clock — the sweep judges cancel windows at the approved instant, not mid-run', async () => {
    db.__tables.scheduled_services = [
      { id: 'f1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-01', track_state: null, cancelled_at: null, recurring_ongoing: false },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    const approvedAt = new Date('2026-08-31T12:00:00Z');
    await processCancellationRequest({ customerId: 'c1', requestId: 'reqF', feeEvaluationAt: approvedAt });
    expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: 'f1', now: approvedAt });
  });

  test('a RESCHEDULED covered termite visit never dates the retrieval — the sweep pulls open rebook intents, so nothing deliverable remains', async () => {
    db.__tables.scheduled_services = [
      // Covered by the term but sitting as an open rebook intent (stale
      // original date): the sweep cancels it regardless of date/keepIds.
      { id: 'tv1', customer_id: 'c1', status: 'rescheduled', scheduled_date: '2020-01-01', track_state: null, cancelled_at: null, recurring_ongoing: false, prepaid_method: 'annual_prepay_invoice', service_type: 'Termite Bait Station Quarterly' },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [
      { id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true },
    ];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqT2r', keepThrough: '2099-02-28', keepVisitIds: ['tv1'] });

    expect(result.churned).toBe(true);
    // The rebook intent was pulled, so staff pull the stations NOW — a
    // dated task would tell them to wait for a visit nobody delivers.
    expect(db.__tables.scheduled_services[0].status).toBe('cancelled');
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toBe('Termite stations to retrieve after cancellation');
    expect(opts.metadata.retrieveAfter).toBeUndefined();
  });

  test('mixed account: a NON-termite prepaid term never dates the retrieval — the uncovered termite program ends now, stations come out now', async () => {
    db.__tables.scheduled_services = [
      // The prepaid PEST term's covered visit rides out the window…
      { id: 'pest1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-01', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false, service_type: 'Quarterly Pest Control' },
      // …but the termite visit is uncovered and is pulled now.
      { id: 'term1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-02-10', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false, service_type: 'Termite Bait Station Quarterly' },
    ];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    db.__tables.termite_stations = [
      { id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true },
    ];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    await processCancellationRequest({ customerId: 'c1', requestId: 'reqT3', keepThrough: '2099-02-28', keepVisitIds: ['pest1'] });

    const byId = Object.fromEntries(db.__tables.scheduled_services.map((r) => [r.id, r]));
    expect(byId.pest1.status).toBe('confirmed');
    expect(byId.term1.status).toBe('cancelled');
    const [, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toBe('Termite stations to retrieve after cancellation');
    expect(body).toContain('Schedule the retrieval visit.');
    expect(body).not.toContain('AFTER that date');
    expect(opts.metadata.retrieveAfter).toBeUndefined();
  });

  test('rental flag without pinned stations still raises the task; no rental → no task', async () => {
    db.__tables.scheduled_services = [];
    db.__tables.termite_stations = [];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];

    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: true }];
    mockNotifyAdmin.mockClear();
    await processCancellationRequest({ customerId: 'c1', requestId: 'reqF' });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin.mock.calls[0][2]).toMatch(/flagged as a bait-station rental/);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.flaggedRental).toBe(true);

    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true, termite_stations_rented: false }];
    mockNotifyAdmin.mockClear();
    await processCancellationRequest({ customerId: 'c1', requestId: 'reqN' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('no retrieval task when the churn itself did not persist (account still live)', async () => {
    db.__tables.scheduled_services = [];
    db.__tables.termite_stations = [{ id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true }];
    // No customer row → the churn block finds nothing to update → churned=false.
    db.__tables.customers = [];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqL' });
    expect(result.churned).toBe(false);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a retrieval alert that did not persist is an error, never a silent success', async () => {
    db.__tables.scheduled_services = [];
    db.__tables.termite_stations = [{ id: 't1', customer_id: 'c1', program: 'termite', owned_by: 'waves', is_active: true }];
    db.__tables.customers = [{ id: 'c1', pipeline_stage: 'active_customer', active: true }];
    db.__tables.payments = [];
    db.__tables.customer_interactions = [];
    mockNotifyAdmin.mockClear();
    mockNotifyAdmin.mockResolvedValueOnce(null);

    const result = await processCancellationRequest({ customerId: 'c1', requestId: 'reqX' });
    expect(result.churned).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('termite_retrieval_task');

    // A policy-suppressed sentinel is truthy but landed no row — same outcome.
    mockNotifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true, reason: 'bell_policy' });
    const suppressed = await processCancellationRequest({ customerId: 'c1', requestId: 'reqY' });
    expect(suppressed.errors).toContain('termite_retrieval_task');

    // Internal test-customer suppression (no reason) is the one silent skip.
    mockNotifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    const internal = await processCancellationRequest({ customerId: 'c1', requestId: 'reqZ' });
    expect(internal.errors).not.toContain('termite_retrieval_task');
  });

  // ── C3: admin-side options on the same engine ──────────────────────────
  describe('admin options (actor / keepThrough / waiveLateFee)', () => {
    const seedActive = () => {
      db.__tables.customers = [
        { id: 'c1', pipeline_stage: 'active_customer', active: true, autopay_enabled: true, next_charge_date: new Date(), monthly_rate: 89 },
      ];
      db.__tables.payments = [];
      db.__tables.payment_methods = [];
      db.__tables.appointment_reminders = [];
      db.__tables.invoices = [];
      db.__tables.plan_holds = [];
      db.__tables.termite_stations = [];
      db.__tables.job_status_history = [];
      db.__tables.customer_interactions = [];
    };

    test('keepThrough keeps COVERED dated visits on/before the paid-coverage end, still pulls what falls after AND open rebook intents, and stops recurrence on everything', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 'in1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-01-10', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true, prepaid_method: 'annual_prepay_invoice' },
        { id: 'edge', customer_id: 'c1', status: 'pending', scheduled_date: '2099-02-28', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true, annual_prepay_term_id: 'term-1' },
        { id: 'after', customer_id: 'c1', status: 'pending', scheduled_date: '2099-03-01', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false, prepaid_method: 'annual_prepay_invoice' },
        { id: 'rebook', customer_id: 'c1', status: 'rescheduled', scheduled_date: PAST, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: false },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', keepThrough: '2099-02-28', keepVisitIds: ['in1', 'edge'] });
      const byId = Object.fromEntries(db.__tables.scheduled_services.map((r) => [r.id, r]));
      expect(byId.in1.status).toBe('confirmed');
      expect(byId.edge.status).toBe('pending');
      expect(byId.after.status).toBe('cancelled');
      expect(byId.rebook.status).toBe('cancelled');
      expect(byId.in1.recurring_ongoing).toBe(false);
      expect(byId.edge.recurring_ongoing).toBe(false);
      expect(result).toEqual(expect.objectContaining({ ok: true, churned: true, cancelledCount: 2, recurrenceStopped: 2, keptThrough: '2099-02-28' }));
      // Billing still stops now — coverage is paid, the plan is not renewing.
      expect(db.__tables.customers[0]).toEqual(expect.objectContaining({ active: false, pipeline_stage: 'churned', autopay_enabled: false }));
      expect(db.__tables.customer_interactions[0].body).toContain('Paid coverage kept through 2099-02-28');
    });

    test('mixed account: keepThrough retains ONLY term-covered rows — uncovered visits inside the window are pulled now', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        // Prepaid pest — covered, inside the window: stays.
        { id: 'pest', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-01-10', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true, prepaid_method: 'annual_prepay_invoice' },
        // Monthly lawn — NOT covered by the term: billing stops now, so the
        // visit must not stay on the calendar deliverable for free.
        { id: 'lawn', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-01-15', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r7', requestId: 'r7', keepThrough: '2099-02-28', keepVisitIds: ['pest'] });
      const byId = Object.fromEntries(db.__tables.scheduled_services.map((r) => [r.id, r]));
      expect(byId.pest.status).toBe('confirmed');
      expect(byId.lawn.status).toBe('cancelled');
      expect(result).toEqual(expect.objectContaining({ ok: true, cancelledCount: 1, keptThrough: '2099-02-28' }));
    });

    test('an in-progress COVERED visit inside the keep window is not an error — retained live work needs no manual cancellation', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        // A tech mid-delivery on a paid visit that is deliberately staying
        // on the calendar: flagging it would report the cancel as partial
        // and skip the term's cancel decision.
        { id: 'live', customer_id: 'c1', status: 'en_route', scheduled_date: '2099-01-10', track_state: 'en_route', cancelled_at: null, recurring_ongoing: true },
        { id: 'in1', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-01-20', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
        // Uncovered live work still needs office eyes.
        { id: 'other', customer_id: 'c1', status: 'on_site', scheduled_date: '2099-01-11', track_state: 'on_property', cancelled_at: null, recurring_ongoing: false },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r9', requestId: 'r9', keepThrough: '2099-02-28', keepVisitIds: ['live', 'in1'] });
      expect(result.errors).toEqual(['in_progress_visit:other']);
      const byId = Object.fromEntries(db.__tables.scheduled_services.map((r) => [r.id, r]));
      expect(byId.live.status).toBe('en_route');
      expect(byId.in1.status).toBe('confirmed');

      // Alone, the retained live visit leaves the cancel fully clean.
      seedActive();
      db.__tables.scheduled_services = [
        { id: 'live', customer_id: 'c1', status: 'en_route', scheduled_date: '2099-01-10', track_state: 'en_route', cancelled_at: null, recurring_ongoing: true },
      ];
      const clean = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r10', requestId: 'r10', keepThrough: '2099-02-28', keepVisitIds: ['live'] });
      expect(clean).toEqual(expect.objectContaining({ ok: true, churned: true, errors: [] }));
    });

    test('keepThrough WITHOUT the covered-row set refuses before any write — a stamp or audit-linked term id is not coverage', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        // A refunded prior term RETAINS annual_prepay_term_id for audit with
        // its stamps cleared — this row must never ride out a new window free.
        { id: 'dead', customer_id: 'c1', status: 'confirmed', scheduled_date: '2099-01-10', track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true, annual_prepay_term_id: 'term-DEAD' },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r8', requestId: 'r8', keepThrough: '2099-02-28' });
      expect(result).toEqual(expect.objectContaining({ ok: false, churned: false, cancelledCount: 0, errors: ['keep_through_missing_coverage'] }));
      expect(db.__tables.scheduled_services[0].status).toBe('confirmed');
      expect(db.__tables.customers[0].active).toBe(true);
    });

    test('scoped repair retry: scope_not_owned WITH prior-cancelled rows for this request re-runs side effects instead of refusing', async () => {
      seedActive();
      // Run 1 of request r1 already cancelled the visit; a side effect
      // (invoice void) failed. The family is gone from the live rows.
      db.__tables.scheduled_services = [
        { id: 'sv1', customer_id: 'c1', status: 'cancelled', scheduled_date: FUTURE, track_state: 'cancelled', cancelled_at: new Date(), recurring_ongoing: false },
      ];
      db.__tables.job_status_history = [
        { job_id: 'sv1', from_status: 'confirmed', to_status: 'cancelled', notes: 'Admin cancellation request r1' },
      ];
      const InvoiceService = require('../services/invoice');
      InvoiceService.voidOpenInvoicesForCancelledService.mockClear();
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(result).toEqual(expect.objectContaining({ ok: true, churned: false, scopedWoundDown: true }));
      // The repair pass re-ran the failed per-visit side effects.
      expect(InvoiceService.voidOpenInvoicesForCancelledService).toHaveBeenCalledWith('sv1');
      // The account was NOT churned and nothing new was cancelled.
      expect(db.__tables.customers[0].active).toBe(true);

      // Run 1's WIND-DOWN failed (the ledger still carries the family):
      // the retry must NOT report wound-down — the tier/rate would keep
      // billing the cancelled family while the run read clean.
      mockLoadComponents.mockResolvedValueOnce([{ family_key: 'lawn_care', monthly_rate: '60.00' }]);
      const unwound = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(unwound.scopedWoundDown).toBe(false);
      expect(unwound.ok).toBe(false);
      expect(unwound.errors).toContain('scoped_wind_down');
      // A HELD family's parked component is legitimately $0 — but the
      // wind-down deletes every in-scope component in the same transaction
      // as the tier demote, so ANY surviving row means that transaction
      // rolled back (codex GH r27 P1): never "done" on a $0 residual.
      mockLoadComponents.mockResolvedValueOnce([{ family_key: 'lawn_care', monthly_rate: '0.00' }]);
      const parkedResidual = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(parkedResidual.scopedWoundDown).toBe(false);
      expect(parkedResidual.errors).toContain('scoped_wind_down');

      // The retry marker is the IMMUTABLE historyNote, never the editable
      // reason: a reworded note still finds run 1's rows.
      const reworded = await processCancellationRequest({ customerId: 'c1', reason: 'price — customer called back', historyNote: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(reworded).toEqual(expect.objectContaining({ ok: true, scopedWoundDown: true }));

      // Per-application account: components prove nothing — the proof is
      // the REQUEST-scoped stamp the wind-down transaction writes on the
      // acceptance row, never the customer-wide waveguard_tier_source
      // (a PRIOR scoped cancel leaves that set; codex GH r33 P1).
      db.__tables.customers[0].billing_mode = 'per_application';
      db.__tables.customers[0].waveguard_tier_source = 'cancellation_scoped';
      db.__tables.service_requests = [{ id: 'r1', customer_id: 'c1', metadata: JSON.stringify({ cancel_plan: { scope: ['lawn_care'] } }) }];
      const perAppUnverified = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(perAppUnverified.scopedWoundDown).toBe(false);
      expect(perAppUnverified.errors).toContain('scoped_wind_down');
      db.__tables.service_requests[0].metadata = JSON.stringify({ cancel_plan: { scope: ['lawn_care'], scopedWindDownCommitted: true } });
      const perAppVerified = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r1', requestId: 'r1', families: ['lawn_care'] });
      expect(perAppVerified.scopedWoundDown).toBe(true);

      // No prior-cancelled rows for the reason → the refusal stands.
      db.__tables.job_status_history = [];
      const refused = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r2', requestId: 'r2', families: ['lawn_care'] });
      expect(refused).toEqual(expect.objectContaining({ ok: false, errors: ['scope_not_owned'] }));
    });

    test('a past keepThrough is ignored — the sweep never widens', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r2', requestId: 'r2', keepThrough: PAST });
      expect(db.__tables.scheduled_services[0].status).toBe('cancelled');
      expect(result.keptThrough).toBeNull();
    });

    test('waiveLateFee tells both fee rails to waive (offboard intent on a whole-account cancel) and is recorded', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const ApptCardRequests = require('../services/appointment-card-request');
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r3', requestId: 'r3', waiveLateFee: true });
      expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: 's1', waiveFee: true, intent: 'offboard' });
      expect(ApptCardRequests.handleAppointmentCardCancellation).toHaveBeenCalledWith({ scheduledServiceId: 's1', waiveFee: true });
      expect(result.lateFeeWaived).toBe(true);
      expect(db.__tables.customer_interactions[0].body).toContain('Scheduled-visit fee waived');
    });

    test('a waiver answered by anything but released:true (e.g. a PARKED hold) is never reported waived', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      // A parked hold is DEFERRED collection, not a waived fee — the shape
      // carries no released field at all.
      CardHolds.handleCardHoldCancellation.mockResolvedValueOnce({ handled: true, parked: true, reason: 'waived_cancel_park' });
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r9', requestId: 'r9', waiveLateFee: true });
      expect(result.lateFeeWaived).toBe(false);
      expect(result.errors).toContain('card_hold:s1');
    });

    test('a card-hold release race ({released:false}, NO reason) is unresolved money — flagged, and the waiver is NOT reported', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      CardHolds.handleCardHoldCancellation.mockResolvedValueOnce({ released: false });
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r8', requestId: 'r8', waiveLateFee: true });
      expect(result.errors).toEqual(['card_hold:s1']);
      expect(result.ok).toBe(false);
      // A fee may still charge — the run must not claim the fee was waived.
      expect(result.lateFeeWaived).toBe(false);
      expect(db.__tables.customer_interactions[0].body).not.toContain('Scheduled-visit fee waived');
    });

    test('the waiver is reported ONLY after every applicable rail confirms release', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r9', requestId: 'r9', waiveLateFee: true });
      expect(result.errors).toEqual([]);
      expect(result.lateFeeWaived).toBe(true);
    });

    test('a waive that lost the row to a concurrent fee worker is unresolved money — flagged, never a clean cancel', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const ApptCardRequests = require('../services/appointment-card-request');
      ApptCardRequests.handleAppointmentCardCancellation
        .mockResolvedValueOnce({ handled: false, released: false, reason: 'waive_race_lost' });
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r5', requestId: 'r5', waiveLateFee: true });
      expect(result.errors).toEqual(['appt_card_fee:s1']);
      expect(result.ok).toBe(false);
    });

    test('ANY non-released appt-fee outcome is flagged even if its reason is not in the review set', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const ApptCardRequests = require('../services/appointment-card-request');
      ApptCardRequests.handleAppointmentCardCancellation
        .mockResolvedValueOnce({ handled: true, released: false, reason: 'charge_in_progress' });
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Portal cancellation request r6', requestId: 'r6' });
      expect(result.errors).toEqual(['appt_card_fee:s1']);
      expect(result.ok).toBe(false);
    });

    test('the default (customer-initiated) call is byte-identical: no waive args, no actor suffix, Portal note', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      const result = await processCancellationRequest({ customerId: 'c1', reason: 'Portal cancellation request r4', requestId: 'r4' });
      expect(CardHolds.handleCardHoldCancellation).toHaveBeenCalledWith({ scheduledServiceId: 's1' });
      expect(result).toEqual(expect.objectContaining({ keptThrough: null, lateFeeWaived: false }));
      expect(db.__tables.customers[0].churn_reason_detail).toBe('Portal cancellation request r4');
      expect(db.__tables.customer_interactions[0].body).toMatch(/^Portal cancellation request r4/);
    });

    test('actor is recorded on the timeline note and churn_reason_detail', async () => {
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r5', requestId: 'r5', actor: { type: 'admin', userId: 'admin-1' } });
      expect(db.__tables.customers[0].churn_reason_detail).toBe('Admin cancellation request r5 [Admin (user admin-1)]');
      expect(db.__tables.customer_interactions[0].body).toMatch(/^Admin \(user admin-1\) cancellation request r5/);

      db.__reset();
      seedActive();
      db.__tables.scheduled_services = [
        { id: 's1', customer_id: 'c1', status: 'confirmed', scheduled_date: FUTURE, track_state: 'scheduled', cancelled_at: null, recurring_ongoing: true },
      ];
      await processCancellationRequest({ customerId: 'c1', reason: 'Admin cancellation request r6', requestId: 'r6', actor: { type: 'ib', userId: 'admin-1' } });
      expect(db.__tables.customers[0].churn_reason_detail).toBe('Admin cancellation request r6 [Intelligence Bar (user admin-1)]');
    });
  });
});
