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
jest.mock('../services/price-change-notices', () => ({
  MIN_NOTICE_DAYS: 30,
  lockNoticeEvent: jest.fn(async (conn, event) => { mockDb.log.push(['noticeEventLock', event]); }),
}));
const mockCloseAlertKeys = jest.fn(async () => 0);
const mockRaiseWithReopen = jest.fn(async (...args) => mockNotifyAdmin(...args));
jest.mock('../services/admin-alert-episodes', () => ({
  closeAdminAlertKeys: (...args) => mockCloseAlertKeys(...args),
  raiseAdminAlertWithReopen: (...args) => mockRaiseWithReopen(...args),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  coveredTermsAsOf: (dbh, today) => dbh('annual_prepay_terms as t')
    .whereIn('t.status', ['active', 'renewal_pending'])
    .where('t.term_start', '<=', today)
    .where('t.term_end', '>=', today),
}));
jest.mock('../routes/admin-customers', () => ({ _private: { ANNUAL_PREPAY_LOCK_NS: 0x4150 } }));
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
  mockRaiseWithReopen.mockImplementation(async (...args) => mockNotifyAdmin(...args));
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
    expect(meta).toMatchObject({ source: 'rate_review', batch_key: BATCH_KEY, planned_send_date: TODAY, anniversary_occurrence: '2026-12-05', first_visit_id: VISIT(101), series_root_id: VISIT(100), visits_per_year: 4, current_rate_source: 'visit_median' });
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
  test('the activity-log write rides its own savepoint: a failed insert never costs the scheduled rows', async () => {
    const book = pestBook();
    mockDb.reset(book);
    delete mockDb.store.activity_log; // the insert throws ("unknown table") — only its savepoint rolls back
    const out = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(out).toMatchObject({ ok: true, created: 1 });
    expect(notices()).toHaveLength(1);
    expect(snapshots()[0].notice_id).toBe(notices()[0].id);
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/rate-review-apply.js'), 'utf8');
    expect(src).toMatch(/await dbh\.transaction\(async \(sp\) => \{\n\s+await sp\('activity_log'\)\.insert\(/);
  });
  test('a successful schedule clears the row\'s earlier notice_hold flags and keeps every other ranking flag', async () => {
    const book = pestBook(1, { snapshot: { flags: ['notice_hold:no_future_visit', 'tier_moved'] } });
    const out = await scheduleBook(book);
    expect(out.created).toBe(1);
    const flags = snapshots()[0].flags;
    expect(Array.isArray(flags) ? flags : JSON.parse(flags)).toEqual(['tier_moved']);
  });
  test('idempotent: a second call schedules nothing new and reports the row as already scheduled', async () => {
    await scheduleBook(pestBook());
    const again = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(again).toMatchObject({ ok: true, created: 0, alreadyScheduled: 1 });
    expect(notices()).toHaveLength(1);
  });
  test('scheduling takes the shared notice-event lock (the legacy send path takes the same one) before its collision check and insert', async () => {
    await scheduleBook(pestBook());
    const lockAt = mockDb.log.findIndex((e) => e[0] === 'noticeEventLock');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(mockDb.log[lockAt][1]).toEqual({ customerId: CUSTOMER(1), effectiveDate: '2026-12-10', currentCents: 11700, newCents: 12100 });
    expect(notices()).toHaveLength(1);
  });
  test('two plan lines of one customer with the same date and amounts are two changes: each gets its own notice (the event is per plan line)', async () => {
    const book = pestBook();
    book.rate_review_snapshots.push(fixture.snapshotRow(1, { id: ROW(2), family_key: 'lawn_care' }));
    const lawn = fixture.pestSeries(2, ['2026-12-10', '2027-03-10'], { parentOverrides: { customer_id: CUSTOMER(1), _line: 'lawn_care' }, childOverrides: { customer_id: CUSTOMER(1), _line: 'lawn_care' } });
    book.scheduled_services.push(...lawn.all);
    const out = await scheduleBook(book);
    expect(out.held).toEqual([]);
    expect(out.created).toBe(2);
    expect(notices().map((n) => n.family_key).sort()).toEqual(['lawn_care', 'pest_control']);
    expect(new Set(notices().map((n) => n.effective_date))).toEqual(new Set(['2026-12-10']));
  });
  test('the per-plan event key: a rate-review notice of the SAME plan line (or a legacy notice) with the same tuple still collides', async () => {
    const book = pestBook();
    book.price_change_notices = [fixture.noticeRow(1, { status: 'draft', rate_review_row_id: ROW(9), effective_date: '2026-12-10' })];
    const out = await scheduleBook(book);
    expect(out.held.map((h) => h.reason)).toEqual(['notice_event_collision']);
    expect(notices()).toHaveLength(1);
  });
  test('the event-uniqueness migration splits the index: legacy notices keep the 4-column event key, rate-review notices add the plan line', async () => {
    const migration = require('../models/migrations/20261001190000_price_change_notices_event_uniq_per_plan');
    const sql = [];
    const knex = { schema: { hasTable: async () => true, hasColumn: async () => true }, raw: async (q) => { sql.push(q.replace(/\s+/g, ' ').trim()); } };
    await migration.up(knex);
    const all = sql.join('\n');
    expect(all).toMatch(/DROP CONSTRAINT IF EXISTS price_change_notices_event_uniq/);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS price_change_notices_event_uniq ON price_change_notices \(customer_id, effective_date, current_amount_cents, new_amount_cents\) WHERE rate_review_row_id IS NULL/);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS price_change_notices_plan_event_uniq ON price_change_notices \(customer_id, effective_date, current_amount_cents, new_amount_cents, family_key\) WHERE rate_review_row_id IS NOT NULL/);
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
  test('annual_prepay: a term whose amount moved since the ranking (its per-application rate is no longer the approved current rate) is held, never noticed on mixed figures', async () => {
    let out = await scheduleBook(prepayBook({ prepay_amount: '500.00' }));
    expect(out.held.map((h) => h.reason)).toEqual(['rate_moved_since_ranking']);
    expect(notices()).toHaveLength(0);
    // a non-increase (the proposed rate is not above the live one) is never noticed either
    out = await scheduleBook(prepayBook({}, { proposed_rate_cents: 11700, delta_cents: 0 }));
    expect(out.created).toBe(0);
    expect(notices()).toHaveLength(0);
  });
  test('annual_prepay: a send on the renewal reminder\'s own day (term_end − 30) leaves no apply tick before the reminder → held; one day earlier schedules', async () => {
    let out = await scheduleBook(prepayBook(), { plannedSendDate: '2027-04-14' });
    expect(out.held.map((h) => h.reason)).toEqual(['renewal_too_soon']);
    out = await scheduleBook(prepayBook(), { plannedSendDate: '2027-04-13' });
    expect(out.created).toBe(1);
  });
  test('annual_prepay: a term renewing inside the notice window, or already reminded, is held', async () => {
    let out = await scheduleBook(prepayBook({ term_end: '2026-11-28' }));
    expect(out.held.map((h) => h.reason)).toEqual(['renewal_too_soon']);
    out = await scheduleBook(prepayBook({ notice_30_sent_at: new Date('2026-10-01T12:00:00Z') }));
    expect(out.held.map((h) => h.reason)).toEqual(['renewal_notice_already_sent']);
    out = await scheduleBook(prepayBook({ status: 'cancelled' }));
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_not_found']);
  });
  test('annual_prepay: a term renewing before the review date (the anniversary occurrence) waits for the next review', async () => {
    // anniversary 2025-12-05 → review date 2026-12-05; a term ending 2026-11-25 renews 2026-11-26, before it
    const out = await scheduleBook(prepayBook({ term_start: '2025-11-26', term_end: '2026-11-25' }), { plannedSendDate: '2026-10-20', now: new Date('2026-10-20T14:00:00Z') });
    expect(out.held.map((h) => [h.reason, h.detail])).toEqual([['renewal_before_review_date', { renewalDay: '2026-11-26', floor: '2026-12-05' }]]);
    expect(notices()).toHaveLength(0);
    // a renewal on or after the review date is fine (floor met), given the 30-day rule
    const ok = await scheduleBook(prepayBook({ term_start: '2025-12-05', term_end: '2026-12-04' }), { plannedSendDate: '2026-11-02' });
    expect(ok.created).toBe(1);
    expect(notices()[0].effective_date).toBe('2026-12-05');
  });
  test('annual_prepay: two live terms that could carry the line hold rather than guess — unless the line\'s own visits link one of them (the ranking\'s precedence)', async () => {
    const book = prepayBook();
    book.annual_prepay_terms.push({ ...book.annual_prepay_terms[0], id: TERM(2), coverage_service_type: 'Pest' });
    let out = await scheduleBook(book);
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_ambiguous']);
    // the open visits of the line carry annual_prepay_term_id → that term, no ambiguity
    const linked = prepayBook();
    linked.annual_prepay_terms.push({ ...linked.annual_prepay_terms[0], id: TERM(2), coverage_service_type: 'Pest', prepay_amount: '500.00' });
    linked.scheduled_services.forEach((v) => { if (v.recurring_parent_id) v.annual_prepay_term_id = TERM(1); });
    out = await scheduleBook(linked);
    expect(out.created).toBe(1);
    expect(JSON.parse(notices()[0].metadata).term_id).toBe(TERM(1));
    // visits linked to BOTH terms → ambiguous again
    const twice = prepayBook();
    twice.annual_prepay_terms.push({ ...twice.annual_prepay_terms[0], id: TERM(2), coverage_service_type: 'Pest' });
    twice.scheduled_services[1].annual_prepay_term_id = TERM(1);
    twice.scheduled_services[2].annual_prepay_term_id = TERM(2);
    out = await scheduleBook(twice);
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_ambiguous']);
  });
  test('annual_prepay: the account\'s plan lines are counted with the ranking\'s live statuses — a second line with only a NULL-status or on-site visit makes an unlabeled term ambiguous', async () => {
    for (const status of [null, 'on_site', 'en_route']) {
      const book = prepayBook({ coverage_service_type: null });
      const lawn = fixture.pestSeries(2, ['2026-12-20'], { parentOverrides: { customer_id: CUSTOMER(1), _line: 'lawn_care' }, childOverrides: { customer_id: CUSTOMER(1), _line: 'lawn_care', status } });
      book.scheduled_services.push(...lawn.all);
      const out = await scheduleBook(book);
      expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_ambiguous']);
    }
  });
  test('annual_prepay: an unlabeled term is matched only on a single-line ACCOUNT — a second line outside the batch still counts', async () => {
    const book = prepayBook({ coverage_service_type: null });
    let out = await scheduleBook(book);
    expect(out.created).toBe(1); // one plan line on the account → the unlabeled term is this line's
    const twoLines = prepayBook({ coverage_service_type: null });
    // a lawn series on the same account, NOT in this batch's rows
    twoLines.scheduled_services.push({ ...twoLines.scheduled_services[1], id: VISIT(701), scheduled_date: '2026-12-20', _line: 'lawn_care', _cadence: 'monthly', recurring_parent_id: VISIT(700) });
    out = await scheduleBook(twoLines);
    expect(out.held.map((h) => h.reason)).toEqual(['prepay_term_ambiguous']); // the ranking's own verdict: an unresolved unlabeled term is ambiguous, never guessed
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
  test('a notice repointed to another customer after the due scan (a merge undo) is never applied under the stale owner: skipped, nothing written, retried next run', async () => {
    const book = sentBook();
    book.customers.push(fixture.customerRow(2));
    mockDb.reset(book);
    const commsLock = require('../utils/customer-comms-lock').lockCustomerComms;
    commsLock.mockImplementationOnce(async () => { mockDb.store.price_change_notices[0].customer_id = CUSTOMER(2); });
    const out = await apply.applyDueRateChanges({ asOf: ASOF, now: ASOF });
    expect(out).toMatchObject({ applied: 0, held: 0, skipped: 1 });
    expect(visits()[1].estimated_price).toBe('117.00');
    expect(customer1().per_application_fee).toBe('117.00');
    expect(notices()[0].applied_at == null).toBe(true);
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
    // the hold's bell closes once the notice applies (never left telling staff to finish it by hand)
    const closeCall = mockCloseAlertKeys.mock.calls.at(-1);
    expect(closeCall[1]).toContain(`rate-review-apply-hold:${notices()[0].id}:plan_on_hold`);
    expect(closeCall[2]).toBe('rate_review_notice_applied');
  });
  test('a hold that changes reason closes the earlier reason\'s bell and keeps the current one', async () => {
    const book = sentBook();
    book.plan_holds = [{ id: 'hold-1', customer_id: CUSTOMER(1), family_key: 'lawn_care', status: 'active', resume_on: '2026-12-20' }];
    await runApply(book);
    const id = notices()[0].id;
    const keys = mockCloseAlertKeys.mock.calls.at(-1)[1];
    expect(keys).not.toContain(`rate-review-apply-hold:${id}:plan_on_hold`);
    expect(keys).toContain(`rate-review-apply-hold:${id}:rate_moved_since_notice`);
  });
  test('hold bells ride the episode-aware raise: a reason that comes back after its bell was closed (A → B → A) rings again through raiseAdminAlertWithReopen', async () => {
    const book = sentBook();
    book.plan_holds = [{ id: 'hold-1', customer_id: CUSTOMER(1), family_key: 'lawn_care', status: 'active', resume_on: '2026-12-20' }];
    await runApply(book);
    const id = notices()[0].id;
    expect(mockRaiseWithReopen).toHaveBeenCalledTimes(1);
    expect(mockRaiseWithReopen.mock.calls[0][3]).toMatchObject({ dedupeKey: `rate-review-apply-hold:${id}:plan_on_hold` });
    // kill switch: ALERT_EPISODES off → the plain composer raise, no close pass
    process.env.ALERT_EPISODES = 'off';
    try {
      mockRaiseWithReopen.mockClear(); mockCloseAlertKeys.mockClear(); mockNotifyAdmin.mockClear();
      const again = sentBook();
      again.plan_holds = book.plan_holds;
      await runApply(again);
      expect(mockRaiseWithReopen).not.toHaveBeenCalled();
      expect(mockCloseAlertKeys).not.toHaveBeenCalled();
      expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.ALERT_EPISODES;
    }
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
    // a legacy NULL-status unpriced visit is live (rate-review.js LIVE_STATUS_SQL) → still a consumer
    book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(507), scheduled_date: '2026-12-08', status: null, estimated_price: null, is_recurring: false, recurring_parent_id: null });
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
    ['a prepaid visit', (b) => { b.scheduled_services[2].prepaid_amount = '117.00'; }, 'visit_prepaid'],
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
  test('a visit keeping only the audit LINK of a voided/refunded prepay (no live coverage, no prepaid money) is not prepaid — the reprice applies', async () => {
    const book = sentBook();
    book.annual_prepay_terms = [{ id: TERM(1), customer_id: CUSTOMER(1), status: 'refunded', prepay_amount: '400.00', coverage_visit_count: 4, coverage_service_type: 'Lawn Care Program', term_start: '2026-06-01', term_end: '2027-05-31' }];
    book.scheduled_services[2].annual_prepay_term_id = TERM(1);
    const out = await runApply(book);
    expect(out.holds).toEqual([]);
    expect(out.applied).toBe(1);
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
  test('an upcoming NULL-status visit of the line is live but outside the series helper\'s target set → hold, nothing repriced or marked applied', async () => {
    const book = sentBook();
    book.scheduled_services.push({ ...book.scheduled_services[1], id: VISIT(510), scheduled_date: '2027-01-10', status: null });
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['visit_status_missing']);
    expect(notices()[0].applied_at == null).toBe(true);
    expect(visits()[1].estimated_price).toBe('117.00');
  });
  test('the noticed series was replaced (cancelled, a new series of the same line accepted) → hold, the old notice never reprices the new plan', async () => {
    const book = sentBook();
    const replacement = fixture.pestSeries(1, ['2026-12-12', '2027-03-12']);
    replacement.all.forEach((v, i) => { v.id = `${VISIT(900 + i)}`; if (v.recurring_parent_id) v.recurring_parent_id = VISIT(900); });
    book.scheduled_services = book.scheduled_services.map((v) => (v.status === 'pending' ? { ...v, status: 'cancelled' } : v));
    book.scheduled_services.push(...replacement.all);
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['plan_replaced']);
    expect(notices()[0].applied_at == null).toBe(true);
    expect(mockDb.store.scheduled_services.filter((v) => v.recurring_parent_id === VISIT(900)).map((v) => v.estimated_price)).toEqual(['117.00', '117.00']);
  });
  test('a notice that never recorded its series → hold (fail closed), nothing repriced', async () => {
    const book = sentBook();
    const meta = { ...book.price_change_notices[0].metadata };
    delete meta.series_root_id;
    book.price_change_notices[0] = { ...book.price_change_notices[0], metadata: meta };
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['notice_series_unrecorded']);
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
  test('a legacy NULL billing_mode member (real tier + positive dues) is on the monthly lane by the canonical resolver — applied, never held as a lane change', async () => {
    const out = await runApply(monthlyBook({ customer: { billing_mode: null, waveguard_tier: 'Gold' } }), JAN);
    expect(out).toMatchObject({ due: 1, applied: 1, held: 0 });
    expect(customer1().monthly_rate).toBe(36.33);
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
  test('priced off the scalar, then the ledger split it across lines before the apply (pest + lawn under the same total) → held, nothing written', async () => {
    const book = monthlyBook({ source: 'monthly_rate', ledger: [
      { id: 'cpr-1', customer_id: CUSTOMER(1), family_key: 'pest_control', monthly_rate: '20.00', source: 'estimate_accept' },
      { id: 'cpr-2', customer_id: CUSTOMER(1), family_key: 'lawn_care', monthly_rate: '13.33', source: 'estimate_accept' },
    ] });
    const out = await runApply(book, JAN);
    expect(out).toMatchObject({ applied: 0, held: 1 });
    expect(out.holds.map((h) => h.reason)).toEqual(['rate_moved_since_notice']);
    expect(mockDb.store.customer_plan_rates.map((r) => Number(r.monthly_rate))).toEqual([20, 13.33]);
    expect(customer1().monthly_rate).toBe('33.33');
  });
  test('priced off the scalar, then the account stopped running exactly that one line (replaced by lawn, or a lawn line joined, ledger empty) → held, nothing written', async () => {
    const replaced = monthlyBook({ source: 'monthly_rate', ledger: [] });
    for (const v of replaced.scheduled_services) v._line = 'lawn_care';
    let out = await runApply(replaced, JAN);
    expect(out).toMatchObject({ applied: 0, held: 1 });
    expect(out.holds.map((h) => h.reason)).toEqual(['rate_moved_since_notice']);
    expect(customer1().monthly_rate).toBe('33.33');
    const joined = monthlyBook({ source: 'monthly_rate', ledger: [] });
    joined.scheduled_services.push({ ...joined.scheduled_services[joined.scheduled_services.length - 1], id: VISIT(900), recurring_parent_id: null, _line: 'lawn_care' });
    out = await runApply(joined, JAN);
    expect(out).toMatchObject({ applied: 0, held: 1 });
    expect(customer1().monthly_rate).toBe('33.33');
    expect(mockDb.store.customer_plan_rates).toEqual([]);
  });
  test('priced off the scalar and the family slice still carries the whole scalar → applied', async () => {
    const out = await runApply(monthlyBook({ source: 'monthly_rate' }), JAN);
    expect(out).toMatchObject({ applied: 1, held: 0 });
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
  test('the prepaid lane takes the renewal writers\' own per-customer annual-prepay lock (try, before the customers row): busy → retried tonight', async () => {
    mockDb.reset(prepayBook());
    let out = await apply.applyDueRateChanges({ asOf: ASOF, now: ASOF });
    expect(out.applied).toBe(1);
    const lockCall = mockDb.raw.mock.calls.find(([sql]) => /pg_try_advisory_xact_lock/.test(sql));
    expect(lockCall).toBeTruthy();
    expect(lockCall[1]).toEqual([0x4150, CUSTOMER(1)]);
    const names = mockDb.log.filter((e) => ['commsLock', 'forUpdate'].includes(e[0])).map((e) => (e[0] === 'forUpdate' ? `forUpdate:${e[1]}` : e[0]));
    expect(names.slice(0, 2)).toEqual(['commsLock', 'forUpdate:customers']);
    expect(mockDb.raw.mock.calls.findIndex(([sql]) => /pg_try_advisory_xact_lock/.test(sql))).toBeGreaterThanOrEqual(0);
    // the renewal route holds it → nothing written, hold recorded
    mockDb.reset(prepayBook());
    mockDb.rawHandlers.push([/pg_try_advisory_xact_lock/, () => ({ rows: [{ locked: false }] })]);
    out = await apply.applyDueRateChanges({ asOf: ASOF, now: ASOF });
    expect(out.holds.map((h) => h.reason)).toEqual(['renewal_in_progress']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
  });
  test('a successor term already on the books → the noticed amount is never written to the predecessor after the fact', async () => {
    const book = prepayBook();
    book.annual_prepay_terms.push({ id: TERM(2), customer_id: CUSTOMER(1), status: 'payment_pending', prepay_amount: '468.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2027-05-15', term_end: '2028-05-14', renewal_decision: null, next_term_prepay_amount: null });
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['successor_already_created']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
    // a renewed_from link counts too, whatever its dates; another family's later term does not
    const book2 = prepayBook();
    book2.annual_prepay_terms.push({ id: TERM(3), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '300.00', coverage_service_type: 'Lawn Care Program', term_start: '2027-06-01', term_end: '2028-05-31', renewal_decision: null, next_term_prepay_amount: null });
    expect((await runApply(book2)).applied).toBe(1);
    const book3 = prepayBook();
    book3.annual_prepay_terms.push({ id: TERM(4), customer_id: CUSTOMER(1), status: 'active', prepay_amount: '468.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2026-05-15', term_end: '2027-05-14', renewal_decision: null, next_term_prepay_amount: null, renewed_from_term_id: TERM(1) });
    expect((await runApply(book3)).holds.map((h) => h.reason)).toEqual(['successor_already_created']);
  });
  test('a term whose dates moved after the notice (the renewal is no longer the one the letter named) holds — the old notice is never applied to a new window', async () => {
    // shortened: renews Dec 21 instead of the noticed May 15
    let out = await runApply(prepayBook({ term_end: '2026-12-20' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['renewal_window_changed']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
    expect(notices()[0].applied_at == null).toBe(true);
    // extended past the noticed renewal
    out = await runApply(prepayBook({ term_end: '2027-06-30' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['renewal_window_changed']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
    // the hold copy obeys the admin-notification rule
    const copy = apply.HOLD_COPY.renewal_window_changed;
    expect(copy.length).toBeLessThanOrEqual(110);
    expect(copy).not.toMatch(/_/);
  });
  test('a legacy UNLABELED term: a named successor of the notice\'s family (no renewed_from link — the admin prepay routes never set one) still counts as created', async () => {
    const book = prepayBook({ coverage_service_type: null });
    book.annual_prepay_terms.push({ id: TERM(2), customer_id: CUSTOMER(1), status: 'payment_pending', prepay_amount: '468.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2027-05-15', term_end: '2028-05-14', renewal_decision: null, next_term_prepay_amount: null });
    const out = await runApply(book);
    expect(out.holds.map((h) => h.reason)).toEqual(['successor_already_created']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
  });
  test('a pinned term whose coverage now names ANOTHER plan line (re-labelled pest → lawn after the notice) holds — the notice is never written onto a different plan', async () => {
    const out = await runApply(prepayBook({ coverage_service_type: 'Lawn Care Program' }));
    expect(out.holds.map((h) => h.reason)).toEqual(['term_family_changed']);
    expect(mockDb.store.annual_prepay_terms[0].next_term_prepay_amount).toBeNull();
    expect(notices()[0].applied_at == null).toBe(true);
    // an unlabeled (legacy) pinned term still applies
    expect((await runApply(prepayBook({ coverage_service_type: null }))).applied).toBe(1);
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
  test('a ranking row repointed to another customer after the candidate read (a merge undo) creates no notice under the stale owner — held, nothing inserted; the comms fence is taken first', async () => {
    const book = pestBook();
    book.customers.push(fixture.customerRow(2));
    mockDb.reset(book);
    const commsLock = require('../utils/customer-comms-lock').lockCustomerComms;
    commsLock.mockImplementationOnce(async (conn, customerId) => {
      mockDb.log.push(['commsLock', customerId]);
      mockDb.store.rate_review_snapshots[0].customer_id = CUSTOMER(2);
    });
    const out = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(out.held.map((h) => h.reason)).toEqual(['row_owner_changed']);
    expect(notices() || []).toHaveLength(0);
    expect(mockDb.log.find((e) => e[0] === 'commsLock')[1]).toBe(CUSTOMER(1));
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
    expect(lockCall[1]).toEqual([`rate_review_batch:${BATCH_KEY}`]);
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
    // a 'sending' claim with no delivery markers yet (a send in flight) is kept linked, never deleted
    mockDb.store.rate_review_snapshots.push(fixture.snapshotRow(4, { customer_id: CUSTOMER(1), status: 'approved', family_key: 'tree_shrub', notice_id: 'n-sending-4' }));
    mockDb.store.price_change_notices.push(fixture.noticeRow(4, { id: 'n-sending-4', customer_id: CUSTOMER(1), family_key: 'tree_shrub', status: 'sending', sent_at: null, email_sent: false, sms_sent: false, current_amount_cents: 6500, new_amount_cents: 7000, noticed_current_cents: 6500, noticed_new_cents: 7000 }));
    const out = await apply.retireDraftNotices(BATCH_KEY);
    expect(out).toEqual({ ok: true, batchKey: BATCH_KEY, retired: 2, keptDelivered: 2, revoked: 2 });
    expect(notices().map((n) => n.id).sort()).toEqual(['n-sending-4', 'n-sent-2']);
    expect(snapshots().map((r) => [r.family_key, r.notice_id])).toEqual([['pest_control', null], ['mosquito', null], ['lawn_care', 'n-sent-2'], ['tree_shrub', 'n-sending-4']]);
    // the retired rows' approval goes with their drafts; the delivered and in-flight rows keep theirs
    expect(snapshots().map((r) => [r.family_key, r.status])).toEqual([['pest_control', 'green'], ['mosquito', 'green'], ['lawn_care', 'sent'], ['tree_shrub', 'approved']]);
    expect(snapshots().filter((r) => r.status === 'green').every((r) => r.approved_at == null && r.approved_by == null)).toBe(true);
    expect(mockDb.log.some((e) => e[0] === 'forUpdate' && e[1] === 'price_change_notices')).toBe(true);
    // and once the owner approves again the batch can be scheduled again (the mosquito line has no visits in this book → held, not re-linked; the in-flight one stays linked)
    for (const r of snapshots()) if (r.status === 'green') r.status = 'approved';
    const again = await apply.scheduleNoticeRows(BATCH_KEY, { plannedSendDate: TODAY, now: NOW });
    expect(again).toMatchObject({ created: 1, alreadyScheduled: 1 });
    expect(again.held.map((h) => [h.familyKey, h.reason])).toEqual([['mosquito', 'no_future_visit']]);
    expect(snapshots().find((r) => r.family_key === 'pest_control').notice_id).not.toBeNull();
  });
  test('retire → rebuild: retiring a scheduled batch\'s drafts returns its approved rows to green, so the rebuild is no longer refused', async () => {
    const rateReview = require('../services/rate-review');
    const book = pestBook();
    book.rate_review_config = [];
    await scheduleBook(book);
    expect(await rateReview.buildBatch({ batchKey: BATCH_KEY, now: NOW })).toMatchObject({ ok: false, reason: 'batch_has_scheduled_rows' });
    expect(await apply.retireDraftNotices(BATCH_KEY)).toMatchObject({ ok: true, retired: 1, revoked: 1 });
    expect(snapshots()[0]).toMatchObject({ status: 'green', notice_id: null, approved_at: null, approved_by: null });
    // an empty book from here: the rebuild runs to its write and replaces the undecided row
    mockDb.rawHandlers.push([/WITH ov AS|AS first_visit|WITH te AS|WaveGuard Monthly/, () => ({ rows: [] })]);
    const out = await rateReview.buildBatch({ batchKey: BATCH_KEY, now: NOW });
    expect(out).toMatchObject({ ok: true, batchKey: BATCH_KEY });
  });
  test('retire with nothing scheduled still returns an approved-but-unscheduled row to green', async () => {
    mockDb.reset(pestBook(1, { snapshot: { status: 'approved', approved_at: NOW, approved_by: 'tech-1' } }));
    expect(await apply.retireDraftNotices(BATCH_KEY)).toEqual({ ok: true, batchKey: BATCH_KEY, retired: 0, keptDelivered: 0, revoked: 1 });
    expect(snapshots()[0]).toMatchObject({ status: 'green', approved_at: null, approved_by: null });
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
    // undecided when the ranking starts (an approved row is refused up
    // front); the draft — and its approval — land during the ranking
    mockDb.store.rate_review_snapshots[0].status = 'green';
    // an empty book: every ranking loader answers nothing, so the only
    // thing left to the write is the lock + the re-checked guards
    mockDb.rawHandlers.push([/WITH ov AS|AS first_visit|WITH te AS|WaveGuard Monthly/, () => ({ rows: [] })]);
    mockDb.rawHandlers.push([/pg_advisory_xact_lock/, () => { Object.assign(mockDb.store.rate_review_snapshots[0], { status: 'approved', notice_id: 'n-landed-during-ranking' }); return { rows: [] }; }]);
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
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    expect(await renew(484)).toBeNull();
  });
  test('the predecessor is matched by coverage family and the new term\'s start — a pest notice never blocks a lawn prepay, nor a renewal a year away', async () => {
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await renew(300, { coverageServiceType: 'Lawn Care Program' })).toBeNull();
    expect(await renew(468, { termStart: '2028-05-15', today: '2028-05-14' })).toBeNull();
    // the nearest-ending candidate is the predecessor when two of the family carry noticed amounts
    mockDb.reset({ annual_prepay_terms: [term(), term({ id: TERM(2), term_start: '2025-05-15', term_end: '2026-05-14', next_term_prepay_amount: '450.00' })] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
  });
  test('a Renew DECISION is not a successor: the amount stays enforceable until a successor term exists; a successor on the books settles it', async () => {
    // recordDecision('renew') marks the term renewed without creating the successor — the guard must still hold
    mockDb.reset({ annual_prepay_terms: [term({ status: 'renewed', renewal_decision: 'renew' })] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    // a successor term already created (at whatever amount) → the guard has done its job
    mockDb.reset({ annual_prepay_terms: [term({ status: 'renewed', renewal_decision: 'renew' }), { id: TERM(2), customer_id: CUSTOMER(1), status: 'payment_pending', prepay_amount: '484.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2027-05-15', term_end: '2028-05-14', renewal_decision: null, next_term_prepay_amount: null, renewed_from_term_id: TERM(1) }] });
    expect(await renew(468)).toBeNull();
  });
  test('a legacy unlabeled predecessor (family from its applied notice): a named successor of that family settles it', async () => {
    const notice = { id: 'n-legacy', customer_id: CUSTOMER(1), billing_lane: 'annual_prepay', family_key: 'pest_control', applied_at: new Date('2027-02-01T08:00:00Z'), metadata: JSON.stringify({ term_id: TERM(1) }) };
    mockDb.reset({ annual_prepay_terms: [term({ coverage_service_type: null })], price_change_notices: [notice] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    mockDb.reset({
      annual_prepay_terms: [term({ coverage_service_type: null }), { id: TERM(2), customer_id: CUSTOMER(1), status: 'payment_pending', prepay_amount: '468.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2027-05-15', term_end: '2028-05-14', renewal_decision: null, next_term_prepay_amount: null }],
      price_change_notices: [notice],
    });
    expect(await renew(468)).toBeNull();
  });
  test('a term re-labelled for another plan after its notice applied (pest → lawn) carries no enforceable amount for either plan — the frozen amount belongs to the noticed plan, which the term no longer covers', async () => {
    const notice = { id: 'n-relabel', customer_id: CUSTOMER(1), billing_lane: 'annual_prepay', family_key: 'pest_control', applied_at: new Date('2027-02-01T08:00:00Z'), metadata: JSON.stringify({ term_id: TERM(1) }) };
    mockDb.reset({ annual_prepay_terms: [term({ coverage_service_type: 'Lawn Care Program' })], price_change_notices: [notice] });
    expect(await renew(300, { coverageServiceType: 'Lawn Care Program' })).toBeNull();
    expect(await renew(468)).toBeNull();
  });
  test('a term cancelled, switched or decided away, or one with no noticed amount, is no predecessor', async () => {
    mockDb.reset({ annual_prepay_terms: [term({ status: 'cancelled' })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term({ renewal_decision: 'cancel' })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term({ renewal_decision: 'switch_plan' })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })] });
    expect(await renew(468)).toBeNull();
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await apply.noticedRenewalAmountConflict(mockDb, { customerId: CUSTOMER(2), amount: 468, coverageServiceType: 'Quarterly Pest Control', termStart: '2027-05-15', today: '2027-05-14' })).toBeNull();
  });
  test('an unlabeled legacy term keeps its protection on a named-service renewal through the applied notice that named it', async () => {
    const unlabeled = term({ coverage_service_type: null });
    mockDb.reset({ annual_prepay_terms: [unlabeled] });
    // no notice attribution yet → a named request does not match an unlabeled term
    expect(await renew(468)).toBeNull();
    // the apply recorded the notice for this term under the pest line → the pest renewal is guarded
    mockDb.reset({ annual_prepay_terms: [unlabeled], price_change_notices: [fixture.noticeRow(1, { billing_lane: 'annual_prepay', family_key: 'pest_control', applied_at: new Date('2027-04-01T08:10:00Z'), effective_date: '2027-05-15', metadata: { term_id: TERM(1) } })] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    expect(await renew(300, { coverageServiceType: 'Lawn Care Program' })).toBeNull(); // another family's renewal is not blocked
  });
  test('inside a write transaction the candidate terms are read FOR UPDATE — whatever their noticed amount is right now — so the nightly apply\'s first write serializes against the renewal', async () => {
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await renew(468, { lock: true })).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    expect(mockDb.log.some((e) => e[0] === 'forUpdate' && e[1] === 'annual_prepay_terms')).toBe(true);
    // a predecessor with NO noticed amount yet is still locked (the apply may be writing its first one)
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })] });
    expect(await renew(468, { lock: true })).toBeNull();
    const locked = mockDb.log.find((e) => e[0] === 'forUpdate' && e[1] === 'annual_prepay_terms');
    expect(locked).toBeTruthy();
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/rate-review-apply.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function noticedRenewalAmountConflict('), src.indexOf('// Held rate-review notices'));
    expect(fn).not.toMatch(/whereNotNull\('next_term_prepay_amount'\)/);
    mockDb.reset({ annual_prepay_terms: [term()] });
    await renew(468);
    expect(mockDb.log.some((e) => e[0] === 'forUpdate' && e[1] === 'annual_prepay_terms')).toBe(false);
  });
  test('both admin prepay routes consult it inside the write transaction (under the annual-prepay lock), with the EXACT amount the term records — tax-inclusive coverage money, setup carved out — and 409 without the acknowledgement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-customers.js'), 'utf8');
    // The noticed renewal amount is the successor term's prepay_amount: what
    // the customer pays for the year (invoice total, county tax included,
    // gross of a deposit credit, minus the setup share). The request's
    // `amount` is pretax (draft) or the collected total with setup inside —
    // never the comparable figure, so no pre-check runs on it.
    expect(src).not.toMatch(/noticedRenewalAmountConflictFor\(customer\.id, (amount|collectedCoverageAmount),/);
    const draftRoute = src.slice(src.indexOf("router.post('/:id/annual-prepay-invoice'"), src.indexOf("router.post('/:id/annual-prepay',"));
    const collectedRoute = src.slice(src.indexOf("router.post('/:id/annual-prepay',"));
    const draftAmount = /const termPrepayAmount = Math\.round\(\(Number\(invoice\.total\) \+ appliedDepositCredit - setupShareOfTotal\) \* 100\) \/ 100;/;
    const collectedAmount = /const termPrepayAmount = Math\.round\(\(Number\(updatedInvoice\.total\) - collectedSetupShare\) \* 100\) \/ 100;/;
    for (const [route, amountRe] of [[draftRoute, draftAmount], [collectedRoute, collectedAmount]]) {
      expect(route).toMatch(amountRe);
      const calls = [...route.matchAll(/const noticedInTrx = await noticedRenewalAmountConflictFor\(customer\.id, termPrepayAmount, \{ coverageServiceType, termStart, trx \}\);\s*if \(noticedInTrx && req\.body\?\.acknowledgeNoticedAmount !== true\) throw noticedRenewalAmountError\(noticedInTrx\);/g)];
      expect(calls).toHaveLength(1);
      const at = calls[0].index;
      expect(route.slice(at).search(amountRe)).toBe(-1); // the amount is computed before the check
      const termCall = route.indexOf('AnnualPrepayRenewals.createTermForAnnualPrepay(', at);
      expect(termCall).toBeGreaterThan(at);
      expect(route.slice(termCall, termCall + 2000)).toMatch(/prepayAmount: termPrepayAmount,/);
      expect(route.slice(0, at)).toMatch(/await lockAndAssertNoAnnualPrepayOverlap\(/);
    }
    expect(src).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.rateReviewLive\(\)\) return null;/);
    expect(src).toMatch(/noticedRenewalAmountConflict\(trx, \{ customerId, amount, coverageServiceType, termStart, today: etDateString\(\), lock: true \}\)/);
    expect(src.match(/if \(err && err\.noticedRenewalAmount\) return res\.status\(409\)\.json\(err\.noticedRenewalAmount\);/g)).toHaveLength(2);
  });
  test('the invoice route that marks an invoice as annual prepay (POST /api/admin/invoices/:id/annual-prepay) is a renewal writer too: it consults the guard inside its transaction, under the annual-prepay lock, with the term amount, coverage and start, and 409s without the acknowledgement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    const route = src.slice(src.indexOf("router.post('/:id/annual-prepay'"), src.indexOf("router.delete('/:id/annual-prepay'"));
    // an amount-only edit of its own term (coverage omitted) is judged on the coverage that term keeps, never as unlabeled
    expect(route).toContain('const noticeArgs = { customerId: termCustomerId, coverageServiceType: resolvedServiceType === undefined ? (linkedTermForNotice?.coverage_service_type || null) : resolvedServiceType, termStart: start || dateOnly(linkedTermForNotice?.term_start) || null, today: etDateString(), lock: true, editingTermId: linkedTermForNotice?.id || null };');
    const call = route.indexOf('.noticedRenewalAmountConflict(trx, { ...noticeArgs, amount: resolvedAmount })');
    expect(call).toBeGreaterThan(0);
    // what the customer actually pays is judged too, FIRST (so the prompt and the override log name the real charge):
    // the LOCKED invoice's total, whenever it differs from the term amount
    expect(route).toMatch(/\.where\(\{ id: invoice\.id \}\)\.forUpdate\(\)\.first\('id', 'customer_id', 'total', 'line_items'\)/);
    // gross of a paid deposit (a negative deposit_credit line): a $434 invoice + $50 deposit is a $484 coverage charge
    expect(route).toMatch(/InvoiceService\._parseInvoiceLineItems\(lockedInvoiceRow\.line_items\)\s*\.filter\(\(li\) => li && li\.category === 'deposit_credit'\)/);
    expect(route).toContain('const chargedTotal = Math.round((Number(lockedInvoiceRow.total) + depositCredit) * 100) / 100;');
    const totalCall = route.indexOf('.noticedRenewalAmountConflict(trx, { ...noticeArgs, amount: chargedTotal })');
    expect(totalCall).toBeGreaterThan(0);
    expect(totalCall).toBeLessThan(call);
    // an edit of the invoice's own term keeps that term's dates (createTermForAnnualPrepay
    // preserves them when no start is sent), so the guard judges the preserved start, never today
    expect(route).toMatch(/const linkedTermForNotice = await trx\('annual_prepay_terms'\)\s*\.where\(\{ prepay_invoice_id: invoice\.id \}\)/);
    // after the per-customer annual-prepay advisory lock, before the term write
    expect(route.indexOf('pg_advisory_xact_lock')).toBeLessThan(call);
    expect(call).toBeLessThan(route.indexOf('AnnualPrepayRenewals.createTermForAnnualPrepay('));
    expect(route.slice(Math.max(0, call - 3000), call)).toMatch(/rateReviewLive\(\)/);
    expect(route).toMatch(/req\.body\?\.acknowledgeNoticedAmount !== true\) throw RateReviewApply\.noticedRenewalAmountError\(noticed\)/);
    expect(route).toMatch(/if \(err && err\.noticedRenewalAmount\) return res\.status\(409\)\.json\(err\.noticedRenewalAmount\);/);
  });
  test('a DELIVERED notice not yet applied by the nightly tick still guards the renewal (the term carries no frozen amount yet); a draft notice does not', async () => {
    const pending = (over = {}) => fixture.noticeRow(1, {
      billing_lane: 'annual_prepay', family_key: 'pest_control', applied_at: null, status: 'sent', sent_at: new Date('2027-03-01T15:00:00Z'), email_sent: true,
      new_amount_cents: 48400, noticed_new_cents: 48400, current_amount_cents: 46800, noticed_current_cents: 46800, effective_date: '2027-05-15', metadata: { term_id: TERM(1), next_term_amount_cents: 48400 }, ...over,
    });
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })], price_change_notices: [pending()] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    expect(await renew(484)).toBeNull();
    // the family comes from the notice: a lawn renewal is not blocked by a pest notice
    expect(await renew(300, { coverageServiceType: 'Lawn Care Program' })).toBeNull();
    // delivered fewer than 30 days before its effective date → the apply refuses it (notice_too_recent), so it guards nothing either
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })], price_change_notices: [pending({ sent_at: new Date('2027-04-20T15:00:00Z'), effective_date: '2027-05-15' })] });
    expect(await renew(468)).toBeNull();
    expect(await renew(484)).toBeNull();
    // never delivered → the customer was told nothing yet
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null })], price_change_notices: [pending({ status: 'draft', sent_at: null, email_sent: false, sms_sent: false })] });
    expect(await renew(468)).toBeNull();
    // the term's dates were edited after delivery (extended through June 30) → a different renewal window: the apply
    // holds that notice (renewal_window_changed), so it guards the July 1 renewal no more than it would be applied to it
    mockDb.reset({ annual_prepay_terms: [term({ next_term_prepay_amount: null, term_end: '2027-06-30' })], price_change_notices: [pending()] });
    expect(await renew(468, { termStart: '2027-07-01', today: '2027-06-30' })).toBeNull();
  });
  test('an APPLIED notice\'s frozen amount guards only the window it named: the term end moved since (the date editor keeps the amount) → it guards nothing', async () => {
    const applied = fixture.noticeRow(1, {
      billing_lane: 'annual_prepay', family_key: 'pest_control', applied_at: new Date('2027-04-15T07:10:00Z'), status: 'sent', sent_at: new Date('2027-03-01T15:00:00Z'), email_sent: true,
      new_amount_cents: 48400, noticed_new_cents: 48400, effective_date: '2027-05-15', metadata: { term_id: TERM(1), next_term_amount_cents: 48400 },
    });
    mockDb.reset({ annual_prepay_terms: [term()], price_change_notices: [applied] });
    expect(await renew(468)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    mockDb.reset({ annual_prepay_terms: [term({ term_end: '2027-04-09' })], price_change_notices: [applied] });
    expect(await renew(468, { termStart: '2027-04-10', today: '2027-04-09' })).toBeNull();
  });
  test('editing the successor term itself (the invoice route on its own term) is still guarded: that term is not a successor that settles the guard', async () => {
    const successor = { id: TERM(2), customer_id: CUSTOMER(1), status: 'payment_pending', prepay_amount: '484.00', coverage_service_type: 'Quarterly Pest Control', term_start: '2027-05-15', term_end: '2028-05-14', renewal_decision: null, next_term_prepay_amount: null, renewed_from_term_id: TERM(1) };
    mockDb.reset({ annual_prepay_terms: [term({ status: 'renewed', renewal_decision: 'renew' }), successor] });
    expect(await renew(500)).toBeNull(); // another writer: the successor exists, the guard has done its job
    expect(await renew(500, { editingTermId: TERM(2) })).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 500 });
    expect(await renew(484, { editingTermId: TERM(2) })).toBeNull();
  });
  test('a $0 renewal is a different amount, not an absent one: it needs the acknowledgement too', async () => {
    mockDb.reset({ annual_prepay_terms: [term()] });
    expect(await renew(0)).toEqual({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 0 });
    expect(await renew(null)).toBeNull();
    expect(await renew('')).toBeNull();
    expect(await renew(-5)).toBeNull();
  });
  test('noticedRenewalAmountError carries the 409 body both route modules return', () => {
    const err = apply.noticedRenewalAmountError({ termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 });
    expect(err.noticedRenewalAmount).toMatchObject({ code: 'RENEWAL_AMOUNT_NOTICED', noticedAmount: 484, chargedAmount: 468, termId: TERM(1) });
    expect(err.noticedRenewalAmount.error).toMatch(/\$484\.00/);
  });
  test('an acknowledged override is recorded in the activity log with who overrode and both amounts', async () => {
    mockDb.reset({ activity_log: [] });
    await apply.recordNoticedAmountOverride(mockDb, {
      customerId: CUSTOMER(1),
      conflict: { termId: TERM(1), termEnd: '2027-05-14', noticedAmount: 484, chargedAmount: 468 },
      adminUserId: 'tech-1',
      adminName: 'Office User',
      source: 'customer360_annual_prepay',
      invoiceId: 'inv-1',
    });
    expect(mockDb.store.activity_log).toEqual([expect.objectContaining({
      customer_id: CUSTOMER(1),
      admin_user_id: 'tech-1',
      action: 'rate_review_noticed_amount_overridden',
    })]);
    const row = mockDb.store.activity_log[0];
    expect(row.description).toMatch(/\$484\.00/);
    expect(row.description).toMatch(/\$468\.00/);
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    expect(meta).toMatchObject({ noticed_amount: 484, charged_amount: 468, predecessor_term_id: TERM(1), invoice_id: 'inv-1', source: 'customer360_annual_prepay', overridden_by: 'tech-1', overridden_by_name: 'Office User' });
  });
  test('the on-site prepay switch (POST /api/admin/schedule/:id/prepay-switch) is a renewal writer too: guarded in its transaction, before the term write, 409 without the acknowledgement, override recorded', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const route = src.slice(src.indexOf("router.post('/:id/prepay-switch',"), src.indexOf("router.post('/:id/prepay-switch/undo'"));
    const call = route.indexOf('RateReviewApply.noticedRenewalAmountConflict(trx, {');
    expect(call).toBeGreaterThan(0);
    expect(route.slice(Math.max(0, call - 600), call)).toMatch(/rateReviewLive\(\)/);
    expect(route.slice(call, call + 400)).toMatch(/amount: switchTermAmount/);
    expect(route.slice(call, call + 400)).toMatch(/lock: true/);
    const check = route.indexOf('if (noticed && req.body?.acknowledgeNoticedAmount !== true) throw RateReviewApply.noticedRenewalAmountError(noticed);', call);
    expect(check).toBeGreaterThan(call);
    const record = route.indexOf('RateReviewApply.recordNoticedAmountOverride(trx, {', check);
    expect(record).toBeGreaterThan(check);
    expect(route.slice(record, record + 400)).toMatch(/source: 'schedule_prepay_switch'/);
    expect(route.slice(record, record + 400)).toMatch(/adminUserId: req\.technicianId/);
    const termWrite = route.indexOf('AnnualPrepayRenewals.createTermForAnnualPrepay(');
    expect(record).toBeLessThan(termWrite);
    expect(route.slice(termWrite, termWrite + 1500)).toMatch(/prepayAmount: switchTermAmount,/);
    expect(route).toMatch(/if \(err && err\.noticedRenewalAmount\) return res\.status\(409\)\.json\(err\.noticedRenewalAmount\);/);
  });
  test('all three renewal writers record the override, inside the write transaction, right after the acknowledgement check', () => {
    const fs = require('fs');
    const path = require('path');
    const customers = fs.readFileSync(path.join(__dirname, '../routes/admin-customers.js'), 'utf8');
    const invoices = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    const draftRoute = customers.slice(customers.indexOf("router.post('/:id/annual-prepay-invoice'"), customers.indexOf("router.post('/:id/annual-prepay',"));
    const collectedRoute = customers.slice(customers.indexOf("router.post('/:id/annual-prepay',"), customers.indexOf("router.post('/:id/refund'"));
    const invoiceRoute = invoices.slice(invoices.indexOf("router.post('/:id/annual-prepay'"), invoices.indexOf("router.delete('/:id/annual-prepay'"));
    for (const [route, conflictVar, invoiceExpr, source] of [
      [draftRoute, 'noticedInTrx', 'invoice.id', 'customer360_annual_prepay_invoice'],
      [collectedRoute, 'noticedInTrx', 'updatedInvoice.id', 'customer360_annual_prepay'],
      [invoiceRoute, 'noticed', 'invoice.id', 'invoice_annual_prepay'],
    ]) {
      const check = route.indexOf(`if (${conflictVar} && req.body?.acknowledgeNoticedAmount !== true)`);
      expect(check).toBeGreaterThan(0);
      const record = route.indexOf('recordNoticedAmountOverride(trx, {', check);
      expect(record).toBeGreaterThan(check);
      expect(record - check).toBeLessThan(400);
      const call = route.slice(record, record + 400);
      expect(call).toContain(`conflict: ${conflictVar}`);
      expect(call).toContain('adminUserId: req.technicianId');
      expect(call).toContain(`invoiceId: ${invoiceExpr}`);
      expect(call).toContain(`source: '${source}'`);
      expect(record).toBeLessThan(route.indexOf('AnnualPrepayRenewals.createTermForAnnualPrepay(', check));
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
    expect(src).toMatch(/const \{ MIN_NOTICE_DAYS, lockNoticeEvent \} = require\('\.\/price-change-notices'\)/);
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
