/**
 * Annual rate review — APPLY lane (services/rate-review-apply.js).
 *
 * Observable behavior pinned here, against an in-memory knex stand-in with
 * real table state and rollback (helpers/rate-review-apply-fixture.js):
 *   scheduling  — the 30-day rule from the planned send, the anniversary
 *                 floor, the monthly roll-forward, the no-future-visit hold,
 *                 the dues-day and prepaid-renewal effective dates, lane
 *                 holds, idempotency, nothing sent;
 *   apply       — per lane with fixtures, the rate-moved hold, the live-
 *                 invoice (series guard) hold, the plan-hold interplay, the
 *                 retention-offer blocker NOT tripped, gate-off no-op,
 *                 idempotency (a second run applies nothing), the lock
 *                 order, the Billing bell on a hold.
 * The Edit-appointment series helpers are mocked at their module boundary
 * (routes/admin-schedule.js _private) with the fixture's own faithful
 * re-derivation; the ledger, audit-log and alert-compose modules are REAL.
 */
process.env.GATE_RATE_REVIEW = 'true';
process.env.GATE_PLAN_RATE_LEDGER = 'true';
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
process.env.GATE_CANCEL_FLOW_V2 = 'true';

const fixture = require('./helpers/rate-review-apply-fixture');

const mockDb = fixture.createFakeDb();
const mockSchedule = { guardThrows: null, seriesLockBusy: false, propagateOverride: null, calls: [] };
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-1' }));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async (trx, customerId) => { mockDb.log.push(['commsLock', customerId]); }),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/price-change-notices', () => ({ MIN_NOTICE_DAYS: 30 }));
jest.mock('../services/annual-prepay-renewals', () => ({
  coveredTermsAsOf: (dbh, today) => dbh('annual_prepay_terms as t')
    .whereIn('t.status', ['active', 'renewal_pending'])
    .where('t.term_start', '<=', today)
    .where('t.term_end', '>=', today),
}));
jest.mock('../routes/admin-schedule', () => {
  const { parseTemplateOverrides } = require('../services/recurring-template-overrides');
  const sum = (rows) => (rows || []).reduce((s, a) => s + (Number(a.estimated_price) > 0 ? Number(a.estimated_price) : 0), 0);
  // Faithful reduction of admin-schedule.js calculateStoredVisitFinancials:
  // structured primary (minus line discount) else estimated minus the
  // parent's add-ons, plus due add-ons, minus the appointment discount.
  const calc = (parent, addonRows, allParentAddonRows) => {
    const primaryGross = Number(parent.primary_line_price);
    let primaryNet = Number.isFinite(primaryGross) && primaryGross > 0
      ? Math.max(0, primaryGross - (Number(parent.line_discount_dollars) > 0 ? Number(parent.line_discount_dollars) : 0))
      : null;
    if (primaryNet == null) {
      const est = Number(parent.estimated_price);
      primaryNet = Number.isFinite(est) && est > 0 ? Math.max(0, est - sum(allParentAddonRows || addonRows)) : 0;
    }
    const subtotal = Math.round((primaryNet + sum(addonRows)) * 100) / 100;
    let discount = 0;
    if (parent.discount_type === 'percent') discount = Math.round(subtotal * Number(parent.discount_amount || 0)) / 100;
    else if (parent.discount_type === 'fixed') discount = Number(parent.discount_amount || 0);
    return { price: subtotal > 0 ? Math.max(0, Math.round((subtotal - discount) * 100) / 100) : null, appointmentDiscountDollars: discount > 0 ? discount : null };
  };
  const targets = (parentId, fromDateStr, editedId) => mockDb.store.scheduled_services
    .filter((s) => (String(s.id) === String(parentId) || String(s.recurring_parent_id) === String(parentId))
      && s.is_recurring && ['pending', 'confirmed'].includes(s.status) && String(s.id) !== String(editedId)
      && (!fromDateStr || s.scheduled_date >= fromDateStr))
    .sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : 1));
  const httpError = (status, message, code) => Object.assign(new Error(message), { statusCode: status, isOperational: true, ...(code ? { code } : {}) });
  return {
    _test: {
      acquireRecurringSeriesMaintenanceLock: jest.fn(async (conn, parentId, wait) => {
        mockDb.log.push(['seriesLock', String(parentId), wait]);
        if (mockSchedule.seriesLockBusy) throw httpError(409, 'This plan is being updated — reload and save again.', 'VISIT_CHANGED_RETRY');
      }),
      lockAndGuardFollowingSiblings: jest.fn(async (conn, { editedId, parentId, fromDateStr }) => {
        mockDb.log.push(['lockAndGuard', String(parentId), fromDateStr]);
        if (mockSchedule.guardThrows) throw mockSchedule.guardThrows;
        return targets(parentId, fromDateStr, editedId).map((s) => ({ ...s }));
      }),
      propagatePriceServiceToFollowingSiblings: jest.fn(async (conn, { editedId, parentId, fromDateStr, fields }) => {
        const rows = targets(parentId, fromDateStr, editedId);
        for (const row of rows) {
          row.estimated_price = mockSchedule.propagateOverride != null ? mockSchedule.propagateOverride : String(fields.estimated_price.toFixed(2));
          row.primary_line_price = String(fields.primary_line_price.toFixed(2));
          row.updated_at = new Date();
        }
        return rows.map((r) => r.id);
      }),
      stampRecurringTemplateOverrides: jest.fn(async (conn, parentId, fields) => {
        const parent = mockDb.store.scheduled_services.find((s) => String(s.id) === String(parentId));
        const existing = parseTemplateOverrides(parent.recurring_template_overrides) || {};
        parent.recurring_template_overrides = JSON.stringify({ ...existing, ...fields });
        return true;
      }),
      calculateStoredVisitFinancials: calc,
      loadStoredDiscountScope: async () => null,
      parseTemplateOverrides,
      readProvenanceOverrides: (raw) => {
        let value = raw;
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
        if (!value || typeof value !== 'object') return {};
        const out = {};
        for (const key of ['anchored_split_per_visit', 'appointment_address']) if (value[key] !== undefined) out[key] = value[key];
        return out;
      },
    },
  };
});

const apply = require('../services/rate-review-apply');
const PlanRateLedger = require('../services/plan-rate-ledger');
const { offerEligibility } = require('../services/cancellation-resolution/retention-offer');
const { CUSTOMER, VISIT, ROW, TERM, BATCH_KEY, TODAY, NOW } = fixture;

const schedule = require('../routes/admin-schedule')._test;

function pestBook(n = 1, { dates = ['2026-12-10', '2027-03-10', '2027-06-10'], price = '117.00', snapshot = {}, customer = {}, ledger = true } = {}) {
  const series = fixture.pestSeries(n, dates, { price });
  return {
    rate_review_batches: [fixture.batchRow()],
    rate_review_snapshots: [fixture.snapshotRow(n, snapshot)],
    customers: [fixture.customerRow(n, customer)],
    scheduled_services: series.all,
    customer_plan_rates: ledger ? [{ id: 'cpr-1', customer_id: CUSTOMER(n), family_key: 'pest_control', monthly_rate: '39.00', source: 'estimate_accept' }] : [],
  };
}

async function scheduleBook(book, opts = {}) {
  mockDb.reset(book);
  return apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW, ...opts });
}

const notices = () => mockDb.store.price_change_notices;
const snapshots = () => mockDb.store.rate_review_snapshots;
const visits = () => mockDb.store.scheduled_services;
const customer1 = () => mockDb.store.customers.find((c) => c.id === CUSTOMER(1));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RATE_REVIEW = 'true';
  mockSchedule.guardThrows = null;
  mockSchedule.seriesLockBusy = false;
  mockSchedule.propagateOverride = null;
  mockDb.reset();
});

// ── scheduling ──────────────────────────────────────────────────────────

describe('scheduleNoticeRows — gate and inputs', () => {
  test('gate off → nothing read or written', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    mockDb.reset(pestBook());
    expect(await apply.scheduleNoticeRows(BATCH_KEY, { now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(mockDb.log).toEqual([]);
    expect(notices()).toHaveLength(0);
  });
  test('a batch with no approved rows is refused (route → 409)', async () => {
    const book = pestBook(1, { snapshot: { status: 'green' } });
    const out = await scheduleBook(book);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('nothing_approved');
    expect(notices()).toHaveLength(0);
  });
  test('an approved row with no positive delta is nothing to schedule', async () => {
    const out = await scheduleBook(pestBook(1, { snapshot: { delta_cents: 0, proposed_rate_cents: 11700 } }));
    expect(out).toMatchObject({ ok: false, reason: 'no_positive_delta', approved: 1 });
  });
  test('bad batch key / planned send date are 400s', async () => {
    mockDb.reset(pestBook());
    await expect(apply.scheduleNoticeRows('dec-2026', { now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: '11/02/2026', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: '2026-10-01', now: NOW })).rejects.toMatchObject({ status: 400, message: /past/ });
  });
  test('an unknown batch is a 404', async () => {
    mockDb.reset({ ...pestBook(), rate_review_batches: [] });
    await expect(apply.scheduleNoticeRows(BATCH_KEY, { now: NOW })).rejects.toMatchObject({ status: 404 });
  });
});

describe('scheduleNoticeRows — per_application effective date', () => {
  test('creates ONE draft notice row per approved line, sends nothing, links the ranking row and leaves it approved', async () => {
    const out = await scheduleBook(pestBook());
    expect(out).toMatchObject({ ok: true, created: 1, alreadyScheduled: 0, held: [], firstEffectiveDate: '2026-12-10', lastEffectiveDate: '2026-12-10', approved: 1 });
    expect(notices()).toHaveLength(1);
    const notice = notices()[0];
    expect(notice).toMatchObject({
      customer_id: CUSTOMER(1), status: 'draft',
      current_amount_cents: 11700, new_amount_cents: 12100, noticed_current_cents: 11700, noticed_new_cents: 12100,
      cadence_label: 'application', effective_date: '2026-12-10', billing_lane: 'per_application', family_key: 'pest_control',
      rate_review_row_id: ROW(1), apply_attempts: 0,
    });
    // nothing sent, nothing applied: sent_at / applied_at stay NULL and the leg flags their false defaults
    expect(notice.sent_at == null && notice.applied_at == null && notice.email_sent === false && notice.sms_sent === false).toBe(true);
    expect(notice.notice_token).toMatch(/^[0-9a-f]{32}$/);
    const meta = JSON.parse(notice.metadata);
    expect(meta).toMatchObject({ source: 'rate_review', batch_key: BATCH_KEY, planned_send_date: TODAY, anniversary_occurrence: '2026-12-05', first_visit_id: VISIT(101), visits_per_year: 4, current_rate_source: 'visit_median' });
    expect(snapshots()[0]).toMatchObject({ status: 'approved', notice_id: notice.id });
    expect(mockDb.store.activity_log.map((a) => a.action)).toEqual(['rate_review_notices_scheduled']);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
  test('the 30-day rule is measured from the PLANNED SEND: a visit inside the window is passed over for the next one', async () => {
    const out = await scheduleBook(pestBook(), { plannedSendDate: '2026-11-20' });
    // floor = max(anniversary 2026-12-05, 2026-11-20 + 30 = 2026-12-20) → 2026-12-20 → the March visit
    expect(out.created).toBe(1);
    expect(notices()[0].effective_date).toBe('2027-03-10');
  });
  test('a monthly-cadence line rolls forward visit by visit until the 30-day rule holds', async () => {
    const dates = ['2026-12-05', '2027-01-05', '2027-02-05', '2027-03-05'];
    const book = pestBook(1, { dates, snapshot: { cadence: 'monthly', visits_per_year: 12 } });
    book.scheduled_services.forEach((s) => { s._cadence = 'monthly'; });
    const out = await scheduleBook(book, { plannedSendDate: '2026-11-20' });
    expect(out.created).toBe(1);
    expect(notices()[0].effective_date).toBe('2027-01-05'); // first application ≥ 2026-12-20
  });
  test('the anniversary occurrence in the batch window is the other floor (a catch-up row past its anniversary uses send + 30)', async () => {
    const book = pestBook(1, { snapshot: { anniversary_date: '2025-06-15' } }); // June anniversary, December batch window → no occurrence
    const out = await scheduleBook(book, { plannedSendDate: '2026-11-02' });
    expect(out.created).toBe(1);
    expect(notices()[0].effective_date).toBe('2026-12-10'); // first visit ≥ 2026-12-02
    expect(JSON.parse(notices()[0].metadata).anniversary_occurrence).toBeNull();
  });
  test('a callback and a parked-reschedule row never anchor the effective date', async () => {
    const book = pestBook();
    book.scheduled_services[1].is_callback = true; // 2026-12-10
    book.scheduled_services[2].status = 'rescheduled'; // 2027-03-10
    const out = await scheduleBook(book);
    expect(notices()[0].effective_date).toBe('2027-06-10');
    expect(out.created).toBe(1);
  });
  test('no future visit → held with the reason, no notice row, the ranking row flagged and still approved', async () => {
    const out = await scheduleBook(pestBook(1, { dates: [] }));
    expect(out.created).toBe(0);
    expect(out.held).toEqual([expect.objectContaining({ rowId: ROW(1), customerId: CUSTOMER(1), familyKey: 'pest_control', reason: 'no_future_visit' })]);
    expect(notices()).toHaveLength(0);
    expect(snapshots()[0].status).toBe('approved');
    expect(JSON.parse(snapshots()[0].flags)).toEqual(['notice_hold:no_future_visit']);
    expect(mockDb.store.activity_log).toHaveLength(0);
  });
  test('per_visit / NULL lanes are the cleanup cohort — held, never scheduled', async () => {
    const out = await scheduleBook(pestBook(1, { snapshot: { billing_lane: 'per_visit' }, customer: { billing_mode: 'per_visit' } }));
    expect(out.held.map((h) => h.reason)).toEqual(['lane_cleanup']);
    expect(notices()).toHaveLength(0);
  });
  test('a termite line is never scheduled', async () => {
    const out = await scheduleBook(pestBook(1, { snapshot: { family_key: 'termite' } }));
    expect(out.held.map((h) => h.reason)).toEqual(['termite_program']);
  });
  test('idempotent: a second call schedules nothing new and reports the row as already scheduled', async () => {
    await scheduleBook(pestBook());
    const again = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(again).toMatchObject({ ok: true, created: 0, alreadyScheduled: 1 });
    expect(notices()).toHaveLength(1);
  });
  test('an existing notice with the same event tuple (customer, date, amounts) holds the row instead of silently reusing it', async () => {
    const book = pestBook();
    book.price_change_notices = [fixture.noticeRow(1, { status: 'draft', rate_review_row_id: null, effective_date: '2026-12-10' })];
    const out = await scheduleBook(book);
    expect(out.held.map((h) => h.reason)).toEqual(['notice_event_collision']);
    expect(notices()).toHaveLength(1);
    expect(snapshots()[0].notice_id).toBeNull();
  });
});

describe('scheduleNoticeRows — monthly and prepaid lanes', () => {
  test('monthly_membership: the first dues day on or after both floors, labelled per month', async () => {
    const book = pestBook(1, {
      snapshot: { billing_lane: 'monthly_membership', rate_unit: 'month', current_rate_source: 'ledger_slice', current_rate_cents: 3333, proposed_rate_cents: 3633, delta_cents: 300, visits_per_year: 4 },
      customer: { billing_mode: 'monthly_membership', billing_day: 15, monthly_rate: '33.33' },
    });
    const out = await scheduleBook(book, { plannedSendDate: '2026-11-02' });
    expect(out.created).toBe(1);
    // floor = anniversary 2026-12-05 (> 2026-12-02) → first 15th on/after → 2026-12-15
    expect(notices()[0]).toMatchObject({ billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2026-12-15', noticed_current_cents: 3333, noticed_new_cents: 3633 });
  });
  test('monthly_membership: a floor past the dues day rolls to next month', async () => {
    const book = pestBook(1, {
      snapshot: { billing_lane: 'monthly_membership', rate_unit: 'month', current_rate_source: 'monthly_rate', current_rate_cents: 3333, proposed_rate_cents: 3633, delta_cents: 300 },
      customer: { billing_mode: 'monthly_membership', billing_day: 1, monthly_rate: '33.33' },
    });
    await scheduleBook(book, { plannedSendDate: '2026-11-02' });
    expect(notices()[0].effective_date).toBe('2027-01-01');
  });
  function prepayBook(termOverrides = {}, snapshotOverrides = {}) {
    const book = pestBook(1, {
      snapshot: { billing_lane: 'annual_prepay', current_rate_source: 'prepay_term', current_rate_cents: 11700, proposed_rate_cents: 12100, delta_cents: 400, ...snapshotOverrides },
      customer: { billing_mode: 'annual_prepay' },
    });
    book.annual_prepay_terms = [{
      id: TERM(1), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control',
      term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null, notice_30_sent_at: null, notice_15_sent_at: null, notice_7_sent_at: null,
      annual_plan_version: null, renewal_noticed_fee: null, next_term_prepay_amount: null, ...termOverrides,
    }];
    return book;
  }
  test('annual_prepay: the successor term start is the effective date and the metadata carries the term amounts', async () => {
    const out = await scheduleBook(prepayBook());
    expect(out.created).toBe(1);
    const notice = notices()[0];
    // the public page shows current → new "per year": the ANNUAL totals, cent-exact with the renewal amount
    expect(notice).toMatchObject({
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
    });
    expect(JSON.parse(notice.metadata)).toMatchObject({
      term_id: TERM(1), term_end: '2027-05-14', coverage_visits: 4, current_term_amount_cents: 46800, next_term_amount_cents: 48400,
      per_application_current_cents: 11700, per_application_new_cents: 12100,
    });
  });
  test('annual_prepay: a term renewing inside the notice window, or already reminded, is held', async () => {
    let out = await scheduleBook(prepayBook({ term_end: '2026-11-28' }));
    expect(out.held.map((h) => h.reason)).toEqual(['renewal_too_soon']);
    out = await scheduleBook(prepayBook({ notice_30_sent_at: new Date('2026-10-01T12:00:00Z') }));
    expect(out.held.map((h) => h.reason)).toEqual(['renewal_notice_already_sent']);
    out = await scheduleBook(prepayBook({ status: 'cancelled' }));
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_not_found']);
  });
  test('annual_prepay: two live terms that could carry the line hold rather than guess', async () => {
    const book = prepayBook();
    book.annual_prepay_terms.push({ ...book.annual_prepay_terms[0], id: TERM(2), coverage_service_type: 'Pest' });
    const out = await scheduleBook(book);
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_ambiguous']);
  });
});

// ── apply ───────────────────────────────────────────────────────────────

function sentBook(overrides = {}) {
  const book = pestBook(1, overrides.book || {});
  book.rate_review_snapshots[0].status = 'sent';
  book.rate_review_snapshots[0].notice_id = fixture.noticeRow(1).id;
  book.price_change_notices = [fixture.noticeRow(1, overrides.notice || {})];
  return book;
}

const ASOF = new Date('2026-12-10T08:10:00Z'); // 2026-12-10 03:10 ET

async function runApply(book, asOf = ASOF) {
  mockDb.reset(book);
  return apply.applyDueRateChanges({ asOf, now: asOf });
}

describe('applyDueRateChanges — gate, due selection, idempotency', () => {
  test('gate off → returns before any query (the kill switch leaves every customer on the lower rate)', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    mockDb.reset(sentBook());
    expect(await apply.applyDueRateChanges({ asOf: ASOF })).toEqual({ ok: false, reason: 'gate_off' });
    expect(mockDb.log).toEqual([]);
    expect(visits()[1].estimated_price).toBe('117.00');
  });
  test('only SENT (or viewed) notices whose effective date has arrived are due; drafts, future dates and applied rows are not', async () => {
    const book = sentBook();
    book.price_change_notices = [
      fixture.noticeRow(1, { id: 'n-draft', status: 'draft' }),
      fixture.noticeRow(1, { id: 'n-future', effective_date: '2027-03-10' }),
      fixture.noticeRow(1, { id: 'n-applied', applied_at: new Date('2026-12-01T08:00:00Z') }),
      fixture.noticeRow(1, { id: 'n-legacy', rate_review_row_id: null }),
    ];
    const out = await runApply(book);
    expect(out).toMatchObject({ ok: true, due: 0, applied: 0, held: 0 });
  });
  test('status alone is never delivery evidence: a previewed DRAFT flipped to viewed by the public page is not due; a sent row with no delivered leg is not due', async () => {
    mockDb.reset({ price_change_notices: [
      fixture.noticeRow(1, { id: 'n-viewed-draft', status: 'viewed', sent_at: null, email_sent: false, sms_sent: false }),
      fixture.noticeRow(2, { id: 'n-no-leg', status: 'sent', email_sent: false, sms_sent: false }),
      fixture.noticeRow(3, { id: 'n-viewed-sent', status: 'viewed', email_sent: false, sms_sent: true }),
    ] });
    const due = await apply._private.loadDueNotices(mockDb, '2026-12-10');
    expect(due.map((n) => n.id)).toEqual(['n-viewed-sent']);
    expect(apply._private.wasDelivered({ status: 'viewed', sent_at: null, email_sent: true })).toBe(false);
    expect(apply._private.wasDelivered({ status: 'sent', sent_at: new Date(), email_sent: false, sms_sent: false })).toBe(false);
    expect(apply._private.wasDelivered({ status: 'sent', sent_at: new Date(), email_sent: true, sms_sent: false })).toBe(true);
  });
  test('the 30-day rule is enforced from the ACTUAL delivery day: a notice delivered 20 days before its effective date holds', async () => {
    const book = sentBook({ notice: { sent_at: new Date('2026-11-20T15:00:00Z') } }); // effective 2026-12-10 → 20 days
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['notice_too_recent']);
    expect(visits()[1].estimated_price).toBe('117.00');
    expect(notices()[0]).toMatchObject({ applied_at: null, apply_hold_reason: 'notice_too_recent' });
    // exactly 30 days is fine
    const ok = await runApply(sentBook({ notice: { sent_at: new Date('2026-11-10T15:00:00Z') } }));
    expect(ok.applied).toBe(1);
  });
  test('a prepaid notice is due as soon as it is sent (the renewal machinery reads the amount before the term ends)', async () => {
    const due = await apply._private.loadDueNotices(mockDb, '2026-12-10');
    expect(due).toEqual([]);
    mockDb.reset({ price_change_notices: [fixture.noticeRow(1, { billing_lane: 'annual_prepay', effective_date: '2027-05-15' }), fixture.noticeRow(2, { effective_date: '2027-05-15' })] });
    const rows = await apply._private.loadDueNotices(mockDb, '2026-12-10');
    expect(rows.map((r) => r.billing_lane)).toEqual(['annual_prepay']);
  });
  test('a second nightly run after an apply finds nothing due and changes nothing', async () => {
    const book = sentBook();
    const first = await runApply(book);
    expect(first).toMatchObject({ due: 1, applied: 1 });
    const snapshot = JSON.stringify(mockDb.store);
    const second = await apply.applyDueRateChanges({ asOf: ASOF, now: ASOF });
    expect(second).toMatchObject({ due: 0, applied: 0, held: 0 });
    expect(JSON.stringify(mockDb.store)).toBe(snapshot);
  });
});

describe('applyDueRateChanges — per_application', () => {
  test('reprices only the visits on/after the effective date through the series helper, stamps the template, moves the fee and the ledger slice, and records everything', async () => {
    const out = await runApply(sentBook());
    expect(out).toMatchObject({ ok: true, due: 1, applied: 1, held: 0 });
    // visits: Dec 10 + later at $121 (primary stamped too); nothing before the effective date in this fixture
    const byDate = Object.fromEntries(visits().filter((v) => v.recurring_parent_id).map((v) => [v.scheduled_date, [v.estimated_price, v.primary_line_price]]));
    expect(byDate).toEqual({ '2026-12-10': ['121.00', '121.00'], '2027-03-10': ['121.00', '121.00'], '2027-06-10': ['121.00', '121.00'] });
    const parent = visits().find((v) => !v.recurring_parent_id);
    expect(parent.estimated_price).toBe('117.00'); // the completed first visit stays history
    expect(JSON.parse(parent.recurring_template_overrides)).toEqual({ primary_line_price: 121, estimated_price: 121 });
    // the one sanctioned non-accept writer of per_application_fee
    expect(customer1().per_application_fee).toBe(121);
    // ledger slice (monthly equivalent): 39.00 + 4.00 × 4 / 12 = 40.33; scalar follows
    expect(mockDb.store.customer_plan_rates).toEqual([expect.objectContaining({ family_key: 'pest_control', monthly_rate: 40.33, source: 'annual_review' })]);
    expect(customer1().monthly_rate).toBe(40.33);
    // the notice, the ranking row, the ledgers
    const notice = notices()[0];
    expect(notice.applied_at).toEqual(ASOF);
    expect(notice.apply_hold_reason).toBeNull();
    expect(notice.apply_attempts).toBe(1);
    expect(notice.applies_from_visit_id).toBe(VISIT(101));
    expect(snapshots()[0].status).toBe('applied');
    expect(mockDb.store.activity_log).toEqual([expect.objectContaining({ action: 'rate_review_rate_applied', customer_id: CUSTOMER(1) })]);
    expect(mockDb.store.audit_log.map((a) => a.action)).toEqual(['customer.rate_annual_review']);
    expect(mockDb.store.audit_log[0].metadata).toMatchObject({ noticed_current_cents: 11700, noticed_new_cents: 12100, source: 'annual_review', feeUpdated: true, visitIds: [VISIT(101), VISIT(102), VISIT(103)] });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    // the series helper received the modal's own shape
    expect(schedule.propagatePriceServiceToFollowingSiblings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      editedId: notice.id, parentId: VISIT(100), fromDateStr: '2026-12-10', fields: { primary_line_price: 121, estimated_price: 121 }, priceChanged: true, serviceChanged: false,
    }));
  });
  test('a visit before the effective date keeps the old rate', async () => {
    const book = sentBook({ book: { dates: ['2026-11-20', '2026-12-10', '2027-03-10'] } });
    const out = await runApply(book);
    expect(out.applied).toBe(1);
    const byDate = Object.fromEntries(visits().filter((v) => v.recurring_parent_id).map((v) => [v.scheduled_date, v.estimated_price]));
    expect(byDate).toEqual({ '2026-11-20': '117.00', '2026-12-10': '121.00', '2027-03-10': '121.00' });
  });
  test('lock order: comms lock, customers row FOR UPDATE, notice row, then the series lock and the series guard', async () => {
    await runApply(sentBook());
    const names = mockDb.log.filter((e) => ['commsLock', 'forUpdate', 'seriesLock', 'lockAndGuard'].includes(e[0])).map((e) => (e[0] === 'forUpdate' ? `forUpdate:${e[1]}` : e[0]));
    expect(names).toEqual(['commsLock', 'forUpdate:customers', 'forUpdate:price_change_notices', 'seriesLock', 'lockAndGuard']);
    expect(schedule.acquireRecurringSeriesMaintenanceLock).toHaveBeenCalledWith(expect.anything(), VISIT(100), false);
  });
  test('the retention-offer blocker is NOT tripped: no manual-override audit row, the ledger source is not a manual source', async () => {
    await runApply(sentBook());
    expect(PlanRateLedger.MANUAL_RATE_SOURCES.has(apply.LEDGER_SOURCE)).toBe(false);
    expect(mockDb.store.audit_log.some((a) => a.action === PlanRateLedger.MANUAL_RATE_AUDIT_ACTION)).toBe(false);
    // facts.js's manualOverride leg: the permanent audit trail OR a surviving ledger row with a manual source
    const manualAudit = mockDb.store.audit_log.filter((a) => a.action === PlanRateLedger.MANUAL_RATE_AUDIT_ACTION);
    const manualLedger = mockDb.store.customer_plan_rates.filter((r) => PlanRateLedger.MANUAL_RATE_SOURCES.has(r.source));
    const manualPriceOverrideAt = manualAudit.length || manualLedger.length ? new Date() : null;
    const facts = { families: ['pest_control'], tenureDays: 400, completedPaidVisits: 5, accountCurrent: true, openComplaint: false, openCallbackLanes: [], prepay: false, billingMode: 'per_application', priorRetentionOfferAt: null, manualPriceOverrideAt };
    expect(offerEligibility(facts, { reasonCode: 'price', now: ASOF })).toEqual({ eligible: true, familyKey: 'pest_control', blockers: [] });
  });
  test('rate moved since the notice (a target visit at a different price) → hold, nothing written, the bell rings once', async () => {
    const book = sentBook();
    book.scheduled_services[2].estimated_price = '120.00'; // 2027-03-10 repriced by hand after the notice
    const out = await runApply(book);
    expect(out).toMatchObject({ due: 1, applied: 0, held: 1, holds: [expect.objectContaining({ noticeId: notices()[0].id, reason: 'rate_moved_since_notice' })] });
    expect(visits().map((v) => v.estimated_price)).toEqual(['117.00', '117.00', '120.00', '117.00']);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(mockDb.store.customer_plan_rates[0].monthly_rate).toBe('39.00');
    expect(notices()[0]).toMatchObject({ applied_at: null, apply_hold_reason: 'rate_moved_since_notice', apply_attempts: 1 });
    expect(JSON.parse(notices()[0].metadata).last_hold).toMatchObject({ reason: 'rate_moved_since_notice' });
    expect(snapshots()[0].status).toBe('sent');
    expect(mockDb.store.audit_log).toHaveLength(0);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(headline).toBe('Billing — finish an annual rate change by hand');
    expect(why).toBe(apply.HOLD_COPY.rate_moved_since_notice);
    expect(opts).toMatchObject({ dedupeKey: `rate-review-apply-hold:${notices()[0].id}:rate_moved_since_notice`, refreshOnDedupe: true, link: `/admin/customers?customerId=${CUSTOMER(1)}` });
    expect(opts.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', subject: { type: 'customer', id: CUSTOMER(1) }, doneWhen: 'rate_review_notice_applied', who: 'person' });
  });
  test('every hold copy passes the admin-notification rule (one sentence, no code tokens, ≤110 chars)', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    for (const [code, why] of Object.entries(apply.HOLD_COPY)) {
      expect(() => composeAdminAlert({
        area: 'Billing', action: 'finish an annual rate change by hand', why, severity: 'needs-you',
        link: `/admin/customers?customerId=${CUSTOMER(1)}`, subject: { type: 'customer', id: CUSTOMER(1) }, doneWhen: 'rate_review_notice_applied', who: 'person',
      })).not.toThrow(code);
    }
  });
  test('a live invoice on a target visit (the series guard refusal) → hold, rolled back', async () => {
    mockSchedule.guardThrows = Object.assign(new Error("Can't apply this price/service change to the rest of the series: the 2027-03-10 visit already has an invoice. Settle or void that invoice first, or set the change to this appointment only."), { statusCode: 409, isOperational: true });
    const out = await runApply(sentBook());
    expect(out.holds[0].reason).toBe('series_guard_refused');
    expect(visits().every((v) => v.estimated_price === '117.00')).toBe(true);
    expect(schedule.propagatePriceServiceToFollowingSiblings).not.toHaveBeenCalled();
    expect(notices()[0].apply_hold_reason).toBe('series_guard_refused');
    expect(JSON.parse(notices()[0].metadata).last_hold.detail).toMatch(/already has an invoice/);
  });
  test('a busy series (maintenance lock held elsewhere) → retried tonight, never waited on', async () => {
    mockSchedule.seriesLockBusy = true;
    const out = await runApply(sentBook());
    expect(out.holds[0].reason).toBe('series_busy');
    expect(schedule.lockAndGuardFollowingSiblings).not.toHaveBeenCalled();
  });
  test('an active plan hold on the account → plan_on_hold tonight; once the hold resumes the next night applies', async () => {
    const book = sentBook();
    book.plan_holds = [{ id: 'hold-1', customer_id: CUSTOMER(1), family_key: 'lawn_care', status: 'active', resume_on: '2026-12-20' }];
    const out = await runApply(book);
    expect(out.holds[0].reason).toBe('plan_on_hold');
    expect(visits()[1].estimated_price).toBe('117.00');
    expect(notices()[0]).toMatchObject({ apply_hold_reason: 'plan_on_hold', apply_attempts: 1 });
    // the hold resumes (holds.js restores the pre-hold rate; nothing of ours was written around it)
    mockDb.store.plan_holds[0].status = 'resumed';
    const next = await apply.applyDueRateChanges({ asOf: new Date('2026-12-21T08:10:00Z'), now: new Date('2026-12-21T08:10:00Z') });
    expect(next).toMatchObject({ due: 1, applied: 1, held: 0 });
    expect(visits()[1].estimated_price).toBe('121.00');
    expect(notices()[0]).toMatchObject({ apply_hold_reason: null, apply_attempts: 2 });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
  test('the fee stays untouched when it is not the amount the customer was told (a two-line account), visits still reprice', async () => {
    const book = sentBook({ book: { customer: { per_application_fee: '40.54' } } });
    const out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe('40.54');
    expect(mockDb.store.audit_log[0].metadata).toMatchObject({ feeUpdated: false, feeUntouchedReason: 'fee_differs_from_noticed_current' });
    expect(visits()[1].estimated_price).toBe('121.00');
  });
  test('the fee is account-wide, so it moves only when every consumer is inside the noticed scope: another line\'s open visit, or an unpriced visit outside the repriced set, leaves it', async () => {
    // a lawn visit on the same account → the one fee column may be the lawn line's fallback
    let book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(501), scheduled_date: '2026-12-20', estimated_price: '65.00', _line: 'lawn_care', recurring_parent_id: VISIT(500) });
    let out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(mockDb.store.audit_log[0].metadata).toMatchObject({ feeUpdated: false, feeUntouchedReason: 'fee_shared_with_other_lines' });
    expect(visits()[1].estimated_price).toBe('121.00'); // the series still repriced
    // an unpriced one-off pest visit before the effective date bills the fee → it must keep billing the old one
    book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(502), scheduled_date: '2026-12-03', estimated_price: null, is_recurring: false, recurring_parent_id: null });
    out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(mockDb.store.audit_log[0].metadata.feeUntouchedReason).toBe('fee_consumers_outside_scope');
    // a PRICED one-off outside the set is no consumer of the fallback → the fee moves
    book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(503), scheduled_date: '2026-12-03', estimated_price: '150.00', is_recurring: false, recurring_parent_id: null });
    out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe(121);
  });
  test('the fee consumers mirror billing-lane\'s own fallback rule: a bare $0 the stamped-zero gate does not make authoritative, an en_route stop, an on_site stop — but never a callback or an authoritative $0', async () => {
    const { consumesPerApplicationFee } = apply._private;
    const stampedZeroGate = process.env.GATE_STAMPED_ZERO_FREE;
    delete process.env.GATE_STAMPED_ZERO_FREE;
    try {
      expect(consumesPerApplicationFee({ estimated_price: null, is_callback: false })).toBe(true);
      expect(consumesPerApplicationFee({ estimated_price: '', is_callback: false })).toBe(true);
      expect(consumesPerApplicationFee({ estimated_price: '0.00', primary_line_price: null, is_callback: false })).toBe(true); // bare zero, gate off → fee
      expect(consumesPerApplicationFee({ estimated_price: '0.00', primary_line_price: '117.00', is_callback: false })).toBe(false); // authoritative $0 (discounted to free)
      expect(consumesPerApplicationFee({ estimated_price: null, is_callback: true })).toBe(false);
      expect(consumesPerApplicationFee({ estimated_price: '117.00', is_callback: false })).toBe(false);
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(consumesPerApplicationFee({ estimated_price: '0.00', primary_line_price: null, is_callback: false })).toBe(false); // gate on: every stamped $0 is free
    } finally {
      if (stampedZeroGate === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = stampedZeroGate;
    }
    // an overdue bare-$0 pest visit before the effective date (gate off) bills the fee → the fee stays
    delete process.env.GATE_STAMPED_ZERO_FREE;
    let book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(504), scheduled_date: '2026-12-03', estimated_price: '0.00', primary_line_price: null, is_recurring: false, recurring_parent_id: null });
    let out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(mockDb.store.audit_log[0].metadata.feeUntouchedReason).toBe('fee_consumers_outside_scope');
    // an on_site unpriced stop (not pending/confirmed, not terminal) is still a consumer
    book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(505), scheduled_date: '2026-12-09', status: 'on_site', estimated_price: null, is_recurring: false, recurring_parent_id: null });
    out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(mockDb.store.audit_log[0].metadata.feeUntouchedReason).toBe('fee_consumers_outside_scope');
    // an unpriced CALLBACK bills nothing → not a consumer → the fee moves
    book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(506), scheduled_date: '2026-12-04', estimated_price: null, is_callback: true, is_recurring: false, recurring_parent_id: null });
    out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(customer1().per_application_fee).toBe(121);
  });
  test('a NULL fee stays NULL (unpriced is never $0 and never invented)', async () => {
    const book = sentBook({ book: { customer: { per_application_fee: null } } });
    await runApply(book);
    expect(customer1().per_application_fee).toBeNull();
    expect(mockDb.store.audit_log[0].metadata.feeUntouchedReason).toBe('no_fee_on_file');
  });
  test('no family ledger slice → the ledger and the reporting scalar are left alone', async () => {
    const book = sentBook({ book: { ledger: false } });
    const out = await runApply(book);
    expect(out.applied).toBe(1);
    expect(mockDb.store.customer_plan_rates).toEqual([]);
    expect(customer1().monthly_rate).toBe('39.00');
  });
  test.each([
    ['an unpriced visit', (b) => { b.scheduled_services[2].estimated_price = null; }, 'visit_unpriced'],
    ['an add-on line', (b) => { b.scheduled_service_addons = [{ id: 'ad-1', scheduled_service_id: VISIT(102), estimated_price: '20.00' }]; }, 'visit_has_addons'],
    ['an appointment discount', (b) => { b.scheduled_services[2].discount_type = 'percent'; b.scheduled_services[2].discount_amount = 10; b.scheduled_services[2].discount_dollars = '11.70'; }, 'visit_has_discount'],
    ['a structured price that disagrees with the stamp', (b) => { b.scheduled_services[2].primary_line_price = '130.00'; }, 'visit_price_structure'],
    ['a prepaid visit', (b) => { b.scheduled_services[2].annual_prepay_term_id = TERM(1); }, 'visit_prepaid'],
    ['a parked reschedule request in the window', (b) => { b.scheduled_services[2].status = 'rescheduled'; }, 'visit_in_reschedule'],
  ])('%s on a target visit → hold %s, nothing written', async (_label, mutate, reason) => {
    const book = sentBook();
    mutate(book);
    const before = JSON.stringify({ v: book.scheduled_services, c: book.customers });
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual([reason]);
    expect(JSON.stringify({ v: visits(), c: mockDb.store.customers })).toBe(before);
    expect(mockDb.store.audit_log).toHaveLength(0);
  });
  test('a series template that would not spawn later visits at the noticed amount (parent discount) → hold', async () => {
    const book = sentBook();
    book.scheduled_services[0].discount_type = 'percent';
    book.scheduled_services[0].discount_amount = 10;
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['series_template_complex']);
    expect(visits()[1].estimated_price).toBe('117.00');
  });
  test('the live billing lane is re-read under the lock: a per-application line that moved to dues, or under a prepaid term, is never applied on the old basis', async () => {
    let book = sentBook({ book: { customer: { billing_mode: 'monthly_membership' } } });
    let out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['billing_lane_changed']);
    expect(visits()[1].estimated_price).toBe('117.00');
    expect(customer1().monthly_rate).toBe('39.00');
    expect(mockDb.store.customer_plan_rates[0].monthly_rate).toBe('39.00');
    expect(JSON.parse(notices()[0].metadata).last_hold.detail).toEqual({ noticed: 'per_application', live: 'monthly_membership' });
    book = sentBook();
    book.annual_prepay_terms = [{ id: TERM(1), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control', term_start: '2026-11-15', term_end: '2027-11-14' }];
    out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['billing_lane_changed']);
    expect(visits()[1].estimated_price).toBe('117.00');
  });
  test('a line running as two series → hold for a hand reprice', async () => {
    const book = sentBook();
    const second = fixture.pestSeries(1, ['2026-12-12']);
    second.all.forEach((v, i) => { v.id = `${VISIT(900 + i)}`; if (v.recurring_parent_id) v.recurring_parent_id = VISIT(900); });
    book.scheduled_services.push(...second.all);
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['multiple_series']);
  });
  test('the repriced visits are proven to carry the noticed amount — a derivation landing elsewhere rolls back', async () => {
    mockSchedule.propagateOverride = '120.50';
    const out = await runApply(sentBook());
    expect(out.holds.map((h) => h.reason)).toEqual(['reprice_mismatch']);
    expect(visits()[1].estimated_price).toBe('117.00'); // rolled back
    expect(customer1().per_application_fee).toBe('117.00');
  });
  test('series price overrides switched off → hold (later visits would spawn at the old price)', async () => {
    const spawnMod = jest.isolateModules.bind(jest);
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'false';
    let isolated;
    spawnMod(() => { isolated = require('../services/rate-review-apply'); });
    process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';
    mockDb.reset(sentBook());
    const out = await isolated.applyDueRateChanges({ asOf: ASOF, now: ASOF });
    expect(out.holds.map((h) => h.reason)).toEqual(['template_overlay_gate_off']);
    expect(visits()[1].estimated_price).toBe('117.00');
  });
});

describe('applyDueRateChanges — monthly_membership', () => {
  function monthlyBook({ source = 'ledger_slice', ledger, customer = {}, notice = {} } = {}) {
    const book = sentBook({
      book: {
        snapshot: { billing_lane: 'monthly_membership', rate_unit: 'month', current_rate_source: source, current_rate_cents: 3333, proposed_rate_cents: 3633, delta_cents: 300 },
        customer: { billing_mode: 'monthly_membership', billing_day: 1, monthly_rate: '33.33', per_application_fee: null, ...customer },
        ledger: false,
      },
      notice: {
        billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2027-01-01', noticed_current_cents: 3333, noticed_new_cents: 3633,
        current_amount_cents: 3333, new_amount_cents: 3633,
        metadata: { source: 'rate_review', batch_key: BATCH_KEY, planned_send_date: TODAY, rate_unit: 'month', visits_per_year: 4, current_rate_source: source }, ...notice,
      },
    });
    book.customer_plan_rates = ledger || [{ id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '33.33', source: 'estimate_accept' }];
    return book;
  }
  const JAN = new Date('2027-01-01T08:10:00Z');
  test('moves the family slice and the dues scalar by the delta under source annual_review; nothing else is touched', async () => {
    const out = await runApply(monthlyBook(), JAN);
    expect(out).toMatchObject({ due: 1, applied: 1, held: 0 });
    expect(mockDb.store.customer_plan_rates).toEqual([expect.objectContaining({ family_key: 'pest_control', monthly_rate: 36.33, source: 'annual_review' })]);
    expect(customer1().monthly_rate).toBe(36.33);
    expect(customer1().per_application_fee).toBeNull();
    expect(visits().every((v) => v.estimated_price === '117.00')).toBe(true);
    expect(mockDb.store.audit_log.map((a) => a.action)).toEqual(['customer.rate_annual_review']);
    expect(mockDb.store.audit_log.some((a) => a.action === PlanRateLedger.MANUAL_RATE_AUDIT_ACTION)).toBe(false);
    expect(notices()[0].applied_at).toEqual(JAN);
    expect(snapshots()[0].status).toBe('applied');
  });
  test('a rider slice keeps its own row; the sum of slices still equals the scalar', async () => {
    const book = monthlyBook({ ledger: [
      { id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'tree_shrub', monthly_rate: '25.00', source: 'estimate_accept' },
      { id: 'cpr-2', customer_id: CUSTOMER(1), family_key: 'palm_injection', monthly_rate: '8.33', source: 'estimate_accept' },
    ], customer: { monthly_rate: '33.33' } });
    book.rate_review_snapshots[0].family_key = 'tree_shrub';
    book.price_change_notices[0].family_key = 'tree_shrub';
    const out = await runApply(book, JAN);
    expect(out.applied).toBe(1);
    expect(mockDb.store.customer_plan_rates.map((r) => [r.family_key, Number(r.monthly_rate), r.source])).toEqual([['tree_shrub', 28, 'annual_review'], ['palm_injection', 8.33, 'estimate_accept']]);
    expect(customer1().monthly_rate).toBe(36.33);
  });
  test('legacy single-line account priced off the scalar: the unattributed slice moves with it', async () => {
    const book = monthlyBook({ source: 'monthly_rate', ledger: [{ id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'unattributed', monthly_rate: '33.33', source: 'backfill' }] });
    const out = await runApply(book, JAN);
    expect(out.applied).toBe(1);
    expect(mockDb.store.customer_plan_rates).toEqual([expect.objectContaining({ family_key: 'unattributed', monthly_rate: 36.33, source: 'annual_review' })]);
    expect(customer1().monthly_rate).toBe(36.33);
  });
  test('legacy account with an EMPTY ledger: the blind-scalar-writer reset seeds one unattributed slice equal to the new scalar', async () => {
    const book = monthlyBook({ source: 'monthly_rate', ledger: [] });
    const out = await runApply(book, JAN);
    expect(out.applied).toBe(1);
    expect(mockDb.store.customer_plan_rates).toEqual([expect.objectContaining({ family_key: 'unattributed', monthly_rate: 36.33, source: 'annual_review' })]);
    expect(customer1().monthly_rate).toBe(36.33);
  });
  test('rate moved (the slice is no longer what the customer was told) → hold, nothing written', async () => {
    const book = monthlyBook({ ledger: [{ id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '35.00', source: 'admin_edit' }], customer: { monthly_rate: '35.00' } });
    const out = await runApply(book, JAN);
    expect(out.holds.map((h) => h.reason)).toEqual(['rate_moved_since_notice']);
    expect(customer1().monthly_rate).toBe('35.00');
    expect(mockDb.store.customer_plan_rates[0].monthly_rate).toBe('35.00');
  });
  test('a ledger that does not sum to the scalar → hold rather than widen the drift', async () => {
    const book = monthlyBook({ ledger: [
      { id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '33.33', source: 'estimate_accept' },
      { id: 'cpr-2', customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '50.00', source: 'estimate_accept' },
    ], customer: { monthly_rate: '33.33' } });
    const out = await runApply(book, JAN);
    expect(out.holds.map((h) => h.reason)).toEqual(['ledger_scalar_mismatch']);
    expect(customer1().monthly_rate).toBe('33.33');
    expect(mockDb.store.customer_plan_rates.map((r) => r.monthly_rate)).toEqual(['33.33', '50.00']);
  });
});

describe('applyDueRateChanges — annual_prepay', () => {
  function prepayBook(termOverrides = {}) {
    const book = sentBook({
      book: { snapshot: { billing_lane: 'annual_prepay', current_rate_source: 'prepay_term' }, customer: { billing_mode: 'annual_prepay' } },
      notice: {
        billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
        current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
        metadata: {
          source: 'rate_review', batch_key: BATCH_KEY, planned_send_date: TODAY, rate_unit: 'application', visits_per_year: 4, current_rate_source: 'prepay_term',
          term_id: TERM(1), term_end: '2027-05-14', coverage_visits: 4, current_term_amount_cents: 46800, next_term_amount_cents: 48400, per_application_current_cents: 11700, per_application_new_cents: 12100,
        },
      },
    });
    book.annual_prepay_terms = [{
      id: TERM(1), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control',
      term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null, notice_30_sent_at: null, notice_15_sent_at: null, notice_7_sent_at: null,
      annual_plan_version: null, renewal_noticed_fee: null, next_term_prepay_amount: null, ...termOverrides,
    }];
    book.scheduled_services.forEach((v) => { if (v.recurring_parent_id) v.annual_prepay_term_id = TERM(1); });
    return book;
  }
  test('writes the successor amount on the live term and nothing else — the term amount and the covered visits stay', async () => {
    const out = await runApply(prepayBook());
    expect(out).toMatchObject({ due: 1, applied: 1 });
    const term = mockDb.store.annual_prepay_terms[0];
    expect(term.prepay_amount).toBe('468.00');
    expect(term.next_term_prepay_amount).toBe(484);
    expect(visits().every((v) => v.estimated_price === '117.00')).toBe(true);
    expect(customer1().per_application_fee).toBe('117.00');
    expect(customer1().monthly_rate).toBe('39.00');
    expect(mockDb.store.customer_plan_rates[0].monthly_rate).toBe('39.00');
    expect(mockDb.store.audit_log[0].metadata).toMatchObject({ lane: 'annual_prepay', termId: TERM(1), noticed_current_cents: 46800, noticed_new_cents: 48400, after: { prepay_amount: 468, next_term_prepay_amount: 484 } });
    expect(notices()[0].applied_at).toEqual(ASOF);
    expect(snapshots()[0].status).toBe('applied');
  });
  test('"notified amount is the charged amount": a renewal reminder already out, or a moved term amount, holds', async () => {
    let out = await runApply(prepayBook({ notice_30_sent_at: new Date('2027-04-14T12:00:00Z') }));
    expect(out.holds.map((h) => h.reason)).toEqual(['renewal_notice_already_sent']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
    out = await runApply(prepayBook({ prepay_amount: '480.00' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['rate_moved_since_notice']);
    out = await runApply(prepayBook({ renewal_decision: 'cancel' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['term_not_live']);
    out = await runApply(prepayBook({ next_term_prepay_amount: '500.00' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['rate_moved_since_notice']);
  });
  test('the termite program is never reached', async () => {
    const out = await runApply(prepayBook({ annual_plan_version: 'v3' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['termite_program']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
  });
  test('a term that is no longer live is a hold, not an apply', async () => {
    const out = await runApply(prepayBook({ status: 'cancelled' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['term_not_live']);
  });
});

describe('listApplyHolds', () => {
  test('lists held, unapplied rate-review notices with the batch and prose', async () => {
    const book = sentBook();
    book.price_change_notices[0].apply_hold_reason = 'rate_moved_since_notice';
    book.price_change_notices[0].apply_attempts = 2;
    book.price_change_notices[0].metadata = { last_hold: { reason: 'rate_moved_since_notice', at: '2026-12-10T08:10:00.000Z' } };
    book.price_change_notices.push(fixture.noticeRow(2, { id: 'n-applied', applied_at: new Date(), apply_hold_reason: 'plan_on_hold' }));
    mockDb.reset(book);
    const holds = await apply.listApplyHolds();
    expect(holds).toEqual([expect.objectContaining({
      noticeId: notices()[0].id, customerId: CUSTOMER(1), batchKey: BATCH_KEY, cadence: 'quarterly', familyKey: 'pest_control', billingLane: 'per_application',
      effectiveDate: '2026-12-10', holdReason: 'rate_moved_since_notice', holdCopy: apply.HOLD_COPY.rate_moved_since_notice, attempts: 2,
      lastHold: expect.objectContaining({ reason: 'rate_moved_since_notice' }),
    })]);
  });
});

describe('scheduling races', () => {
  test('the ranking row is locked and re-read before the insert: a link that landed meanwhile is honoured, never overwritten', async () => {
    mockDb.reset(pestBook());
    const row = mockDb.store.rate_review_snapshots[0];
    const stale = { ...row, notice_id: null }; // the candidate as read before the lock
    mockDb.store.rate_review_snapshots[0].notice_id = 'n-landed-first';
    const out = await apply._private.scheduleRow(mockDb, stale, {
      batch: fixture.batchRow(), customer: fixture.customerRow(1), lane: 'per_application', accountLines: 1,
      today: TODAY, plannedSend: TODAY, noticeFloor: '2026-12-02', batchId: 'b-2', batchKey: BATCH_KEY, actorId: null,
    });
    expect(out).toEqual({ alreadyScheduled: true, rowId: ROW(1) });
    expect(notices()).toHaveLength(0);
    expect(mockDb.store.rate_review_snapshots[0].notice_id).toBe('n-landed-first');
    expect(mockDb.log.some((e) => e[0] === 'forUpdate' && e[1] === 'rate_review_snapshots')).toBe(true);
  });
  test('a row that lost its approval before the lock creates no notice', async () => {
    mockDb.reset(pestBook());
    const stale = { ...mockDb.store.rate_review_snapshots[0] };
    mockDb.store.rate_review_snapshots[0].status = 'exception';
    await expect(apply._private.scheduleRow(mockDb, stale, {
      batch: fixture.batchRow(), customer: fixture.customerRow(1), lane: 'per_application', accountLines: 1,
      today: TODAY, plannedSend: TODAY, noticeFloor: '2026-12-02', batchId: 'b-2', batchKey: BATCH_KEY, actorId: null,
    })).rejects.toMatchObject({ holdCode: 'row_not_approved' });
    expect(notices()).toHaveLength(0);
  });
  test('scheduling runs in one transaction under the per-batch lock, and the migration makes one notice per ranking row unique', async () => {
    mockDb.reset(pestBook());
    await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(mockDb.transaction).toHaveBeenCalled();
    const lockCall = mockDb.raw.mock.calls.find(([sql]) => /pg_advisory_xact_lock/.test(sql));
    expect(lockCall).toBeTruthy();
    expect(lockCall[1]).toEqual(['rate-review-batch', BATCH_KEY]);
    const fs = require('fs');
    const path = require('path');
    const migration = fs.readFileSync(path.join(__dirname, '../models/migrations/20260930230000_rate_review_apply.js'), 'utf8');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \$\{ROW_IDX\} ON \$\{NOTICES\} \(rate_review_row_id\) WHERE rate_review_row_id IS NOT NULL/);
  });
});

describe('retireDraftNotices and the rebuild guard', () => {
  test('retires the batch\'s undelivered rows (a draft, and a draft the public page flipped to viewed on a preview) and unlinks their ranking rows; a delivered notice is kept', async () => {
    const book = pestBook();
    await scheduleBook(book);
    // a previewed draft: the public page flipped it to 'viewed' without any delivery
    mockDb.store.rate_review_snapshots.push(fixture.snapshotRow(3, { customer_id: CUSTOMER(1), status: 'approved', family_key: 'mosquito', notice_id: 'n-previewed-3' }));
    mockDb.store.price_change_notices.push(fixture.noticeRow(3, { id: 'n-previewed-3', customer_id: CUSTOMER(1), family_key: 'mosquito', status: 'viewed', sent_at: null, email_sent: false, sms_sent: false }));
    // a second line already delivered (and viewed)
    mockDb.store.rate_review_snapshots.push(fixture.snapshotRow(2, { status: 'sent', family_key: 'lawn_care', notice_id: 'n-sent-2' }));
    mockDb.store.price_change_notices.push(fixture.noticeRow(2, { id: 'n-sent-2', family_key: 'lawn_care', status: 'viewed' }));
    const out = await apply.retireDraftNotices(BATCH_KEY);
    expect(out).toEqual({ ok: true, batchKey: BATCH_KEY, retired: 2, keptDelivered: 1 });
    expect(notices().map((n) => n.id)).toEqual(['n-sent-2']);
    expect(snapshots().map((r) => [r.family_key, r.notice_id])).toEqual([['pest_control', null], ['mosquito', null], ['lawn_care', 'n-sent-2']]);
    expect(mockDb.log.some((e) => e[0] === 'forUpdate' && e[1] === 'price_change_notices')).toBe(true);
    // and the batch can be scheduled again (the mosquito line has no visits in this book → held, not re-linked)
    const again = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(again).toMatchObject({ created: 1, alreadyScheduled: 0 });
    expect(again.held.map((h) => [h.familyKey, h.reason])).toEqual([['mosquito', 'no_future_visit']]);
    expect(snapshots().find((r) => r.family_key === 'pest_control').notice_id).not.toBeNull();
  });
  test('gate off → retires nothing', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    mockDb.reset(pestBook());
    expect(await apply.retireDraftNotices(BATCH_KEY)).toEqual({ ok: false, reason: 'gate_off' });
  });
  test('a rebuild is refused while any ranking row carries a notice row (its draft would be orphaned)', async () => {
    const rateReview = require('../services/rate-review');
    await scheduleBook(pestBook());
    expect(await rateReview.buildBatch({ batchKey: BATCH_KEY, now: NOW })).toEqual({ ok: false, reason: 'batch_has_scheduled_rows', batchKey: BATCH_KEY });
    expect(snapshots()).toHaveLength(1);
  });
  test('the rebuild re-checks under the batch lock inside its write: a draft that landed during the ranking refuses the DELETE', async () => {
    const rateReview = require('../services/rate-review');
    const book = pestBook();
    book.rate_review_config = [];
    mockDb.reset(book);
    // an empty book: every ranking loader answers nothing, so the only
    // thing left to the write is the lock + the re-checked guards
    mockDb.rawHandlers.push([/WITH ov AS|AS first_visit|WITH te AS|WaveGuard Monthly/, () => ({ rows: [] })]);
    mockDb.rawHandlers.push([/pg_advisory_xact_lock/, () => { mockDb.store.rate_review_snapshots[0].notice_id = 'n-landed-during-ranking'; return { rows: [] }; }]);
    const out = await rateReview.buildBatch({ batchKey: BATCH_KEY, now: NOW });
    expect(out).toEqual({ ok: false, reason: 'batch_has_scheduled_rows', batchKey: BATCH_KEY });
    // the refusal came from INSIDE the write (after the lock), and nothing was deleted or rewritten
    expect(mockDb.raw.mock.calls.some(([sql]) => /pg_advisory_xact_lock/.test(sql))).toBe(true);
    expect(snapshots()).toHaveLength(1);
    expect(mockDb.store.rate_review_batches).toHaveLength(1);
    expect(mockDb.log.filter((e) => e[0] === 'insert' && e[1] === 'rate_review_batches')).toHaveLength(0);
  });
});

describe('noticedRenewalAmountConflict — the admin renewal consumer of next_term_prepay_amount', () => {
  const term = (overrides = {}) => ({ id: TERM(1), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null, next_term_prepay_amount: '484.00', ...overrides });
  const renew = (amount, extra = {}) => apply.noticedRenewalAmountConflict(mockDb, { customerId: CUSTOMER(1), amount, coverageServiceType: 'Quarterly Pest Control', termStart: '2027-05-15', today: '2027-05-14', ...extra });
  test('a renewal of the predecessor term at a different amount than its noticed successor amount is a conflict; the noticed amount is not', async () => {
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484 });
    expect(await renew(484)).toBeNull();
  });
  test('the predecessor is matched by coverage family and the new term\'s start — a pest notice never blocks a lawn prepay, nor a renewal a year away', async () => {
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await renew(300, { coverageServiceType: 'Lawn Care Program' })).toBeNull();
    expect(await renew(468, { termStart: '2028-05-15', today: '2028-05-14' })).toBeNull();
    // the nearest-ending candidate is the predecessor when two of the family carry noticed amounts
    mockDb.reset({ annual_prepay_terms: [term(), term({ id: TERM(2), term_start: '2025-05-15', term_end: '2026-05-14', next_term_prepay_amount: '450.00' })] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484 });
  });
  test('a term already renewed, cancelled or decided, or one with no noticed amount, is no predecessor', async () => {
    mockDb.reset({ annual_prepay_terms: [term({ status: 'renewed' })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term({ renewal_decision: 'cancel' })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await apply.noticedRenewalAmountConflict(mockDb, { customerId: CUSTOMER(2), amount: 468, coverageServiceType: 'Quarterly Pest Control', termStart: '2027-05-15', today: '2027-05-14' })).toBeNull();
  });
  test('both admin prepay routes consult it with the requested coverage and term start, behind the gate, and 409 without the acknowledgement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-customers.js'), 'utf8');
    expect(src.match(/noticedRenewalAmountConflictFor\(customer\.id, amount, \{ coverageServiceType, termStart \}\)/g)).toHaveLength(2);
    expect(src).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.rateReviewLive\(\)\) return null;/);
    expect(src.match(/code: 'RENEWAL_AMOUNT_NOTICED'/g)).toHaveLength(2);
    expect(src.match(/acknowledgeNoticedAmount !== true/g)).toHaveLength(2);
    // the guard sits AFTER termStart is known in both routes
    for (const m of src.matchAll(/noticedRenewalAmountConflictFor\(customer\.id, amount/g)) {
      const before = src.slice(Math.max(0, m.index - 1500), m.index);
      expect(before).toMatch(/const termStart = termStartInput\.date/);
    }
  });
});

describe('wiring', () => {
  const fs = require('fs');
  const path = require('path');
  test('the nightly apply reads the gate before its cron lock, runs at 3:10 AM ET', () => {
    const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    const start = scheduler.indexOf("cron.schedule('10 3 * * *'");
    expect(start).toBeGreaterThan(0);
    const tick = scheduler.slice(start, scheduler.indexOf('cron.schedule(', start + 10));
    expect(tick).toMatch(/rateReviewLive\(\)\) return;/);
    expect(tick.indexOf('rateReviewLive()')).toBeLessThan(tick.indexOf("runExclusive('rate-review-apply'"));
    expect(tick).toMatch(/applyDueRateChanges\(\)/);
    expect(tick).toMatch(/\}, \{ timezone: 'America\/New_York' \}\);/);
  });
  test('the schedule helpers the apply destructures are real exports of admin-schedule.js (router._test), not an interface the mock invented', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const start = src.indexOf('router._test = {');
    expect(start).toBeGreaterThan(0);
    const bag = src.slice(start, src.indexOf('\n};', start));
    for (const name of ['acquireRecurringSeriesMaintenanceLock', 'lockAndGuardFollowingSiblings', 'propagatePriceServiceToFollowingSiblings', 'stampRecurringTemplateOverrides', 'calculateStoredVisitFinancials', 'loadStoredDiscountScope', 'parseTemplateOverrides', 'readProvenanceOverrides']) {
      expect(bag).toMatch(new RegExp(`(^|\\s)${name},`));
    }
    const applySrc = fs.readFileSync(path.join(__dirname, '../services/rate-review-apply.js'), 'utf8');
    expect(applySrc).toMatch(/require\('\.\.\/routes\/admin-schedule'\)\._test/);
    expect(applySrc).not.toMatch(/admin-schedule'\)\._private/);
  });
  test('the 30-day minimum is the notice workflow\'s own constant, not a second copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/rate-review-apply.js'), 'utf8');
    expect(src).toMatch(/const \{ MIN_NOTICE_DAYS \} = require\('\.\/price-change-notices'\)/);
    expect(src).not.toMatch(/MIN_NOTICE_DAYS\s*=\s*\d/);
  });
  test('the apply lane never writes a manual-override audit action or a manual ledger source', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../services/rate-review-apply.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may NAME the manual action; code may not write it
    expect(code).not.toMatch(/rate_manual_override|MANUAL_RATE_AUDIT_ACTION/);
    expect(code).not.toMatch(/'admin_edit'|'ib_update'|'ib_bulk_update'/);
    expect(apply.AUDIT_ACTION).toBe('customer.rate_annual_review');
    expect(apply.LEDGER_SOURCE).toBe('annual_review');
  });
});
