'use strict';
// C2 holds (ruling C-4) + the scoped wind-down plan (ruling C-3).
// db is mocked with a table router; SmartRebooker and messaging are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
const mockReschedule = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/rebooker', () => ({ reschedule: (...a) => mockReschedule(...a) }));
// A skip is a one-way status change with follow-through; the holds tests only
// care that it is asked for, in order, once the hold stands.
const mockTransition = jest.fn().mockResolvedValue({});
jest.mock('../services/job-status', () => ({ transitionJobStatus: (...a) => mockTransition(...a) }));
// The canonical billing-covered reader lives in the schedule route; a visit id
// in this set is prepaid (moved, never skipped).
const mockCovered = jest.fn(async () => new Set());
jest.mock('../routes/admin-schedule', () => ({ findBillingCoveredVisits: (...a) => mockCovered(...a) }));
const mockSms = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSms(...a) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));

// Table-routed db mock: mockState.tables[name] holds rows; where() filters by
// equality; update/insert record and mutate. Enough for holds + the plan.
const mockState = { tables: {} };
function mockMakeBuilder(table) {
  let rows = () => mockState.tables[table] || [];
  let filters = [];
  const applied = () => rows().filter((r) => filters.every((f) => f(r)));
  const builder = {
    where(arg1, arg2, arg3) {
      const col = (k) => String(k).split('.').pop();
      if (typeof arg1 === 'object') {
        const entries = Object.entries(arg1);
        filters.push((r) => entries.every(([k, v]) => String(r[col(k)]) === String(v)));
      } else if (arg3 !== undefined) {
        const [k0, op, v] = [arg1, arg2, arg3];
        const k = col(k0);
        filters.push((r) => {
          const a = r[k] instanceof Date ? r[k].toISOString() : String(r[k] ?? '');
          const b = v instanceof Date ? v.toISOString() : String(v ?? '');
          if (op === '>=') return a >= b;
          if (op === '<=') return a <= b;
          if (op === '>') return a > b;
          return a === b;
        });
      } else if (typeof arg1 === 'function') {
        // grouped where — holds/scoped queries use it for live-or-upcoming;
        // the fixtures only contain matching rows, so pass-through is safe.
        // grouped where — apply against a throwaway sub-builder is overkill;
        // holds only uses it in familyUpcomingVisits which we stub via rows.
        filters.push(() => true);
      } else {
        filters.push((r) => String(r[col(arg1)]) === String(arg2));
      }
      return builder;
    },
    whereNotIn(k, vals) { const c = String(k).split('.').pop(); filters.push((r) => !vals.map(String).includes(String(r[c]))); return builder; },
    whereIn(k, vals) { const c = String(k).split('.').pop(); filters.push((r) => vals.map(String).includes(String(r[c]))); return builder; },
    whereNot(arg) { const e = Object.entries(arg); filters.push((r) => !e.every(([k, v]) => String(r[k]) === String(v))); return builder; },
    whereNull(k) { filters.push((r) => r[k] == null); return builder; },
    whereRaw() { return builder; },
    forUpdate() { mockState.forUpdate = (mockState.forUpdate || 0) + 1; return builder; },
    leftJoin() { return builder; },
    orderBy() { return builder; },
    select(...cols) { return Promise.resolve(applied().map((r) => ({ ...r }))); },
    max(expr) { const k = String(expr).split(' ')[0]; const vals = applied().map((r) => r[k]).filter(Boolean).sort(); return Promise.resolve([{ max: vals[vals.length - 1] || null }]); },
    first(...cols) { const r = applied()[0]; return Promise.resolve(r ? { ...r } : undefined); },
    update(patch) { const hit = applied(); hit.forEach((r) => Object.assign(r, patch)); return Promise.resolve(hit.length); },
    insert(row) {
      const rowsToAdd = (Array.isArray(row) ? row : [row]).map((r, i) => ({ id: r.id || `${table}-${(mockState.tables[table] || []).length + i + 1}`, ...r }));
      mockState.tables[table] = [...(mockState.tables[table] || []), ...rowsToAdd];
      return { returning: () => Promise.resolve(rowsToAdd) , then: (fn) => Promise.resolve(rowsToAdd.length).then(fn) };
    },
  };
  return builder;
}
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockMakeBuilder(String(table).split(' ')[0]));
  fn.transaction = async (cb) => cb(fn);
  fn.schema = { hasTable: async () => true };
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});

const { startHold, applyHoldSkips, runPlanHoldLifecycle } = require('../services/cancellation-resolution/holds');
const { planScopedWindDown, applyScopedWindDown, scopedPricingFingerprint } = require('../services/cancellation-processor');
const lockCalls = () => require('../models/db').raw.mock.calls.filter(([sql]) => /pg_advisory_xact_lock/.test(sql)).map(([, b]) => b);
const { etDateString } = require('../utils/datetime-et');

function seed({ holds = [], customers = [], components = [], visits = [], invoices = [] } = {}) {
  mockState.tables = {
    plan_holds: holds,
    customers,
    customer_plan_rates: components,
    scheduled_services: visits,
    customer_interactions: [],
    services: [],
    invoices,
  };
}

const TODAY = etDateString();
function daysOut(n) {
  const [y, m, d] = TODAY.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const displayOf = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const lawnVisit = (id, date, extra = {}) => ({
  id, customer_id: 'c1', status: 'confirmed', scheduled_date: date, service_type: 'Lawn Care Service', window_start: '08:00', window_end: '10:00', ...extra,
});
const { notifyAdmin: mockNotifyAdmin } = require('../services/notification-service');
const bells = (kind) => mockNotifyAdmin.mock.calls.filter(([, , , opts]) => opts?.metadata?.kind === kind);

beforeEach(() => {
  // A move lands on the fixture, as the real rebooker does: the under-lock
  // identity check reads the moved visit at its new date.
  mockReschedule.mockReset().mockImplementation(async (id, to) => {
    const row = (mockState.tables.scheduled_services || []).find((v) => v.id === id);
    if (row) row.scheduled_date = to;
    return { ok: true };
  });
  mockTransition.mockReset().mockResolvedValue({});
  mockCovered.mockReset().mockResolvedValue(new Set());
  mockNotifyAdmin.mockClear();
  mockSms.mockReset().mockResolvedValue({ sent: true });
  seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership', tier_protected_until: null }] });
});

describe('startHold (ruling C-4)', () => {
  test('rejects a past or missing resume date and >180 days', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: null })).rejects.toMatchObject({ code: 'hold_date_invalid' });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(-1) })).rejects.toMatchObject({ code: 'hold_date_invalid' });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(181) })).rejects.toMatchObject({ code: 'hold_too_long' });
  });

  test('pest can never be held; once per family per 12 months — an undone (cancelled) hold does not count', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'pest_control', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_family_invalid' });
    const customers = [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay' }];
    const prior = (status) => ({ id: 'h0', customer_id: 'c1', family_key: 'lawn_care', status, created_at: new Date() });
    for (const status of ['resumed', 'active']) {
      seed({ customers, holds: [prior(status)], visits: [lawnVisit('l1', daysOut(10))] });
      await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_cooldown' });
    }
    // A hold that was compensated, obsolete or churned was never used up.
    seed({ customers, holds: [prior('cancelled')], visits: [lawnVisit('l1', daysOut(10))] });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) });
    expect(result.holdId).toBeTruthy();
  });

  test('a monthly-lane family with no ledger component fails closed', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_unattributed' });
  });

  test('a rate-bearing NON-monthly lane needs no attribution — no dues to suspend (#3140)', async () => {
    // annual_prepay carries a legacy monthly_rate but the dues cron never
    // bills it; the old rate>0 shortcut demanded a component and blocked the
    // hold (Codex #3669 r3 P2).
    seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay', tier_protected_until: null }], visits: [lawnVisit('l1', daysOut(10))] });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) });
    expect(result.holdId).toBeTruthy();
    expect(mockState.tables.plan_holds[0].held_monthly_rate).toBe(null);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150); // untouched
  });

  test('happy path: component suspended, scalar recomputed, tier protected; in-pause visits are handed back to skip, none are touched yet', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership', tier_protected_until: null }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 90 },
        { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
      ],
      // Two inside the pause, one on the return date (the first visit back).
      visits: [lawnVisit('l1', daysOut(10)), lawnVisit('l2', daysOut(40)), lawnVisit('l3', daysOut(90))],
    });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) });
    expect(result.holdId).toBeTruthy();
    expect(result.pendingSkips.map((v) => v.id)).toEqual(['l1', 'l2']);
    // Nothing is shifted, and nothing is skipped by startHold itself.
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockState.tables.scheduled_services.map((v) => [v.id, v.status, v.scheduled_date])).toEqual([
      ['l1', 'confirmed', daysOut(10)], ['l2', 'confirmed', daysOut(40)], ['l3', 'confirmed', daysOut(90)],
    ]);
    const lawn = mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care');
    expect(Number(lawn.monthly_rate)).toBe(0);
    const customer = mockState.tables.customers[0];
    expect(Number(customer.monthly_rate)).toBe(60);
    expect(String(customer.tier_protected_until)).toBe(daysOut(90));
    expect(mockState.tables.plan_holds).toHaveLength(1);
    expect(Number(mockState.tables.plan_holds[0].held_monthly_rate)).toBe(90);
  });

  test('a prepaid visit inside the pause is MOVED (first to the return date, spacing kept, single-visit), never skipped', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay', tier_protected_until: null }],
      visits: [lawnVisit('p1', daysOut(5)), lawnVisit('s1', daysOut(12)), lawnVisit('p2', daysOut(20)), lawnVisit('back', daysOut(45))],
    });
    mockCovered.mockResolvedValue(new Set(['p1', 'p2']));
    const window = { start: '08:00', end: '10:00' };
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(30) });
    expect(mockReschedule).toHaveBeenCalledTimes(2);
    expect(mockReschedule).toHaveBeenCalledWith('p1', daysOut(30), window, 'plan_hold', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
    expect(mockReschedule).toHaveBeenCalledWith('p2', daysOut(45), window, 'plan_hold', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
    expect(result.moved).toBe(2);
    expect(result.pendingSkips.map((v) => v.id)).toEqual(['s1']);
  });

  test('a prepaid visit that will not move refuses the hold: earlier moves are reverted (single-visit), nothing is written or skipped', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay', tier_protected_until: null }],
      visits: [lawnVisit('p1', daysOut(5)), lawnVisit('s1', daysOut(12)), lawnVisit('p2', daysOut(20))],
    });
    mockCovered.mockResolvedValue(new Set(['p1', 'p2']));
    mockReschedule.mockImplementationOnce(async () => ({ ok: true })).mockRejectedValueOnce(new Error('slot taken'));
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(30) })).rejects.toMatchObject({ code: 'hold_visits_unmovable' });
    expect(mockReschedule).toHaveBeenLastCalledWith('p1', daysOut(5), { start: '08:00', end: '10:00' }, 'plan_hold_revert', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
    expect(mockState.tables.plan_holds).toHaveLength(0);
    expect(mockState.tables.customers[0].tier_protected_until).toBeNull();
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('no visit inside the away dates: nothing to pause — no hold, no writes, and the next visit back is reported', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership', tier_protected_until: null }],
      components: [{ customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 90 }],
      // The only visits are on the return date and later; a past-dated
      // 'rescheduled' placeholder anchors nothing.
      visits: [lawnVisit('back', daysOut(60)), lawnVisit('later', daysOut(90)), lawnVisit('stale', daysOut(-3), { status: 'rescheduled' })],
    });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) });
    expect(result).toEqual({ notNeeded: true, familyKey: 'lawn_care', nextVisitOn: daysOut(60), nextVisitDisplay: displayOf(daysOut(60)) });
    expect(mockState.tables.plan_holds).toHaveLength(0);
    expect(Number(mockState.tables.customer_plan_rates[0].monthly_rate)).toBe(90);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150);
    expect(mockState.tables.customers[0].tier_protected_until).toBeNull();
    expect(mockState.tables.customer_interactions).toHaveLength(0);
    expect(mockReschedule).not.toHaveBeenCalled();
    // And with no visit booked at all there is no date to name.
    seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay' }] });
    expect(await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) }))
      .toEqual({ notNeeded: true, familyKey: 'lawn_care', nextVisitOn: null, nextVisitDisplay: null });
  });
});

describe('applyHoldSkips (rule 1 — a skip is one-way, so it runs only once the hold stands)', () => {
  const held = (over = {}) => ({
    holdId: 'h1', familyKey: 'lawn_care', resumeOn: daysOut(30),
    pendingSkips: [{ id: 'l1', status: 'confirmed', from: daysOut(5) }, { id: 'l2', status: 'rescheduled', from: daysOut(12) }], ...over,
  });
  const record = () => JSON.parse(mockState.tables.plan_holds[0].moved_visits);

  test('skips every in-pause visit through the canonical transition with no customer notice, and records what was skipped', async () => {
    seed({ holds: [{ id: 'h1', customer_id: 'c1', family_key: 'lawn_care', status: 'active', moved_visits: JSON.stringify({ moved: [], toSkip: [], skipped: [] }) }] });
    await applyHoldSkips([held()]);
    expect(mockTransition).toHaveBeenCalledTimes(2);
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'l1', fromStatus: 'confirmed', toStatus: 'skipped', notifyCustomer: false }));
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'l2', fromStatus: 'rescheduled', toStatus: 'skipped', notifyCustomer: false }));
    expect(record().skipped).toEqual(['l1', 'l2']);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a skip that fails rings the office for that visit, the hold stands, and the other skips still run', async () => {
    seed({ holds: [{ id: 'h1', customer_id: 'c1', family_key: 'lawn_care', status: 'active', moved_visits: JSON.stringify({ moved: [], toSkip: [], skipped: [] }) }] });
    mockTransition.mockRejectedValueOnce(new Error('one-way guard'));
    await expect(applyHoldSkips([held()])).resolves.toBeUndefined();
    expect(mockTransition).toHaveBeenCalledTimes(2);
    expect(bells('plan_hold_skip_failed')).toHaveLength(1);
    expect(bells('plan_hold_skip_failed')[0][3]).toMatchObject({ bell: true, dedupeKey: 'plan_hold_skip_failed:l1', metadata: { holdId: 'h1', visitId: 'l1' } });
    expect(mockState.tables.plan_holds[0].status).toBe('active');
    expect(record().skipped).toEqual(['l2']);
  });
});

describe('runPlanHoldLifecycle', () => {
  const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
  const holdSeed = (holdOver = {}, visits = []) => seed({
    customers: [{ id: 'c1', first_name: 'Pat', phone: '+19415550000', monthly_rate: 60, billing_mode: 'monthly_membership', tier_protected_until: daysOut(20) }],
    components: [
      { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' },
      { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
    ],
    holds: [{ id: 'h1', customer_id: 'c1', family_key: 'lawn_care', status: 'active', resume_on: daysOut(20), held_monthly_rate: 90, reminder_sent_at: null, created_at: new Date(), ...holdOver }],
    visits,
  });

  test('texts once, 7 days before the first visit back, naming that visit\'s date; resumes the rate on the return date', async () => {
    // The first visit back is a week AFTER the return date; the skipped
    // in-pause visit and a cancelled one do not count as "back".
    holdSeed({}, [lawnVisit('paused', daysOut(8), { status: 'skipped' }), lawnVisit('gone', daysOut(21), { status: 'cancelled' }),
      lawnVisit('back', daysOut(27)), lawnVisit('later', daysOut(57))]);
    expect((await runPlanHoldLifecycle({ today: TODAY })).reminded).toBe(0); // 27 days out
    expect(mockSms).not.toHaveBeenCalled();

    const first = await runPlanHoldLifecycle({ today: daysOut(20) }); // 7 days before daysOut(27), and the return date
    expect(first.reminded).toBe(1);
    expect(first.resumed).toBe(1);
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(renderRequiredSmsTemplate).toHaveBeenLastCalledWith('plan_hold_resume_reminder',
      expect.objectContaining({ visit_date: displayOf(daysOut(27)), resume_date: displayOf(daysOut(27)) }), expect.anything());
    expect(mockSms.mock.calls[0][0]).toMatchObject({ metadata: expect.objectContaining({ plan_hold_id: 'h1', visit_id: 'back' }) });

    expect((await runPlanHoldLifecycle({ today: daysOut(21) })).reminded).toBe(0); // stamped, never re-sent
    const lawn = mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care');
    expect(Number(lawn.monthly_rate)).toBe(90);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150);
    expect(mockState.tables.customers[0].tier_protected_until).toBe(null);
    expect(mockState.tables.plan_holds[0].status).toBe('resumed');
    expect(mockReschedule).not.toHaveBeenCalled(); // nothing is ever shifted to make room for the notice
  });

  test('a short pause texts at once (first visit back under 7 days out); a RESUMED hold whose first visit back comes later still gets its text', async () => {
    holdSeed({ resume_on: daysOut(3), tier_protected_until: daysOut(3) }, [lawnVisit('back', daysOut(3))]);
    expect((await runPlanHoldLifecycle({ today: TODAY })).reminded).toBe(1);
    expect(renderRequiredSmsTemplate).toHaveBeenLastCalledWith('plan_hold_resume_reminder', expect.objectContaining({ visit_date: displayOf(daysOut(3)) }), expect.anything());

    // Dues came back on the return date (3 days ago); the first visit back is in 4 days.
    mockSms.mockClear();
    holdSeed({ status: 'resumed', resume_on: daysOut(-3) }, [lawnVisit('back', daysOut(4))]);
    expect((await runPlanHoldLifecycle({ today: TODAY })).reminded).toBe(1);
    expect(mockSms).toHaveBeenCalledTimes(1);
    expect(mockState.tables.plan_holds[0].reminder_sent_at).toBeTruthy();

    // A hold that ended over 90 days ago is history, not texted about.
    mockSms.mockClear();
    holdSeed({ status: 'resumed', resume_on: daysOut(-95) }, [lawnVisit('back', daysOut(2))]);
    expect((await runPlanHoldLifecycle({ today: TODAY })).reminded).toBe(0);
    expect(mockSms).not.toHaveBeenCalled();
  });

  test('the return date restores dues even when no text went out (no visit back yet): bell for the office, no message', async () => {
    holdSeed({ resume_on: daysOut(0) }, []);
    const out = await runPlanHoldLifecycle({ today: TODAY });
    expect(out).toMatchObject({ reminded: 0, resumed: 1 });
    expect(mockSms).not.toHaveBeenCalled();
    expect(mockState.tables.plan_holds[0].status).toBe('resumed');
    expect(Number(mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care').monthly_rate)).toBe(90);
    expect(bells('plan_hold_no_visit_back')).toHaveLength(1);
    expect(bells('plan_hold_no_visit_back')[0][3]).toMatchObject({ bell: true, dedupeKey: 'plan_hold_no_visit_back:h1' });

    // Before the return date, no visit yet is not a problem.
    mockNotifyAdmin.mockClear();
    holdSeed({ resume_on: daysOut(5) }, []);
    await runPlanHoldLifecycle({ today: TODAY });
    expect(bells('plan_hold_no_visit_back')).toHaveLength(0);
  });

  test('an undelivered text is retried next run and rings the office only when the first visit back is tomorrow or sooner', async () => {
    mockSms.mockResolvedValue({ sent: false });
    holdSeed({ resume_on: daysOut(5) }, [lawnVisit('back', daysOut(5))]);
    const week = await runPlanHoldLifecycle({ today: TODAY });
    expect(week).toMatchObject({ reminded: 0, errors: ['remind_unsent:h1'] });
    expect(mockState.tables.plan_holds[0].reminder_sent_at).toBeNull();
    expect(bells('plan_hold_restart_text_undelivered')).toHaveLength(0);

    await runPlanHoldLifecycle({ today: daysOut(4) }); // visit is tomorrow
    expect(mockState.tables.plan_holds[0].reminder_sent_at).toBeNull();
    expect(bells('plan_hold_restart_text_undelivered')).toHaveLength(1);
    expect(bells('plan_hold_restart_text_undelivered')[0][3]).toMatchObject({ bell: true, dedupeKey: 'plan_hold_restart_text_undelivered:h1' });
  });
});

describe('planScopedWindDown (ruling C-3)', () => {
  const visitRow = (family, extra = {}) => ({
    id: `v-${family}`, customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(10),
    recurring_ongoing: true, is_recurring: true, service_type: family === 'lawn_care' ? 'Lawn Care Service' : 'Quarterly Pest Control Service',
    ...extra,
  });

  test('fails closed on unowned scope, whole-account scope, and unattributed monthly lane', async () => {
    seed({ customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'monthly_membership', active: true }], visits: [visitRow('lawn_care'), visitRow('pest_control')] });
    expect((await planScopedWindDown('c1', ['mosquito'])).error).toBe('scope_not_owned');
    expect((await planScopedWindDown('c1', ['lawn_care', 'pest_control'])).error).toBe('scope_is_whole_account');
    expect((await planScopedWindDown('c1', ['lawn_care'])).error).toBe('scoped_unattributed');
  });

  test('demotes the tier and reprices the remaining family from its gross', async () => {
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'monthly_membership', active: true }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 90 },
        { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
      ],
      visits: [visitRow('lawn_care'), visitRow('pest_control')],
    });
    const plan = await planScopedWindDown('c1', ['lawn_care']);
    expect(plan.ok).toBe(true);
    expect(plan.tierBefore).toBe('Silver');
    expect(plan.tierAfter).toBe('Bronze');
    expect(plan.remaining).toEqual(['pest_control']);
    // Component is net of the Silver discount; Bronze reprices from gross.
    const gross = 60 / (1 - plan.discountBefore);
    const expected = Math.round(gross * (1 - plan.discountAfter) * 100) / 100;
    expect(plan.remainingRates[0].after).toBe(expected);
    expect(plan.scalarAfter).toBe(expected);
    // Demotion never lowers the remaining family's rate.
    expect(plan.remainingRates[0].after).toBeGreaterThanOrEqual(60);
  });

  test('a HELD remaining family reprices its saved hold rate, not its zeroed component', async () => {
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 60, billing_mode: 'monthly_membership', active: true }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' },
        { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
      ],
      holds: [{ id: 'h9', customer_id: 'c1', family_key: 'lawn_care', status: 'active', held_monthly_rate: 90, resume_on: daysOut(30), created_at: new Date() }],
      visits: [visitRow('lawn_care'), visitRow('pest_control')],
    });
    const plan = await planScopedWindDown('c1', ['pest_control']);
    expect(plan.ok).toBe(true);
    const lawn = plan.remainingRates.find((r) => r.family === 'lawn_care');
    expect(lawn.heldHoldId).toBe('h9');
    expect(lawn.before).toBe(90);
    expect(lawn.after).toBeGreaterThan(90); // Silver → Bronze from the HELD rate
    expect(plan.scalarAfter).toBe(0);      // held family contributes 0 until resume
  });

  test('a rate-bearing NON-monthly lane demotes the tier only — no attribution demand, scalar untouched (#3140)', async () => {
    // annual_prepay / per_visit rows carry a legacy monthly_rate; the old
    // rate>0 shortcut classified them monthly, failed closed on missing
    // components, and rewrote their monthly_rate (Codex #3669 r3 P2).
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'annual_prepay', active: true }],
      visits: [visitRow('lawn_care'), visitRow('pest_control')],
    });
    const plan = await planScopedWindDown('c1', ['lawn_care']);
    expect(plan.ok).toBe(true); // no scoped_unattributed despite zero components
    expect(plan.monthlyLane).toBe(false);
    expect(plan.perApplicationLane).toBe(false);
    expect(plan.tierAfter).toBe('Bronze');
    // applyScopedWindDown writes monthly_rate only when plan.monthlyLane —
    // the passthrough scalar + false flag mean the legacy rate is never touched.
    expect(plan.scalarAfter).toBe(150);
    expect(plan.remainingRates[0].after).toBe(null); // no monthly reprice
  });

  test('per-application lane: surviving uninvoiced rows are repriced at the demoted tier', async () => {
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true }],
      visits: [
        visitRow('lawn_care'),
        { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 },
      ],
    });
    const plan = await planScopedWindDown('c1', ['lawn_care']);
    expect(plan.ok).toBe(true);
    expect(plan.perApplicationLane).toBe(true);
    expect(plan.perAppRows).toHaveLength(1);
    expect(plan.perAppRows[0]).toMatchObject({ family: 'pest_control', before: 90 });
    expect(plan.perAppRows[0].after).toBeGreaterThan(90);
    // An already-INVOICED surviving row bills at its fixed terms — the
    // apply step skips it, so the plan (what the card shows, fingerprints,
    // and the operator approves) must not list it as a change (codex GH
    // r26 P1). A voided invoice does not fix the price.
    const invoicedId = plan.perAppRows[0].id;
    mockState.tables.invoices = [{ id: 'inv-1', scheduled_service_id: invoicedId, status: 'paid' }];
    const fixed = await planScopedWindDown('c1', ['lawn_care']);
    expect(fixed.ok).toBe(true);
    expect(fixed.perAppRows).toEqual([]);
    mockState.tables.invoices = [{ id: 'inv-1', scheduled_service_id: invoicedId, status: 'void' }];
    const voided = await planScopedWindDown('c1', ['lawn_care']);
    expect(voided.perAppRows).toHaveLength(1);
  });
});

describe('scoped wind-down under the rung-6 writer lock (#3666 r34 — the pricing race)', () => {
  const visitRow = (family, extra = {}) => ({
    id: `v-${family}`, customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(10),
    recurring_ongoing: true, is_recurring: true, service_type: family === 'lawn_care' ? 'Lawn Care Service' : 'Quarterly Pest Control Service',
    ...extra,
  });
  const perAppCustomer = () => ({ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true });

  test('pinnedScope: after the sweep the swept family owns no live rows, yet the boundary re-plan keeps it in scope and re-derives ONLY the surviving side', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    expect(entry.ok).toBe(true);
    // The sweep cancelled the lawn rows.
    mockState.tables.scheduled_services = [{ ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }];
    expect((await planScopedWindDown('c1', ['lawn_care'])).error).toBe('scope_not_owned');
    const fresh = await planScopedWindDown('c1', ['lawn_care'], require('../models/db'), { pinnedScope: entry.inScope });
    expect(fresh.ok).toBe(true);
    expect(fresh.inScope).toEqual(['lawn_care']);
    expect(fresh.remaining).toEqual(['pest_control']);
    expect(scopedPricingFingerprint(fresh)).toBe(scopedPricingFingerprint(entry));
    // A surviving-family visit that appeared during the sweep IS in the fresh plan.
    mockState.tables.scheduled_services.push({ ...visitRow('pest_control'), id: 'v-new', estimated_price: 90, primary_line_price: 90 });
    const drifted = await planScopedWindDown('c1', ['lawn_care'], require('../models/db'), { pinnedScope: entry.inScope });
    expect(drifted.perAppRows.map((r) => r.id).sort()).toEqual(['v-new', 'v-pest_control']);
    expect(scopedPricingFingerprint(drifted)).not.toBe(scopedPricingFingerprint(entry));
  });

  test('a surviving-family visit landing between approval and the boundary refuses the wind-down (scoped_pricing_changed) — no demote, no reprice', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    const approved = scopedPricingFingerprint(entry);
    mockState.tables.scheduled_services = [
      { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 },
      { ...visitRow('pest_control'), id: 'v-new', estimated_price: 90, primary_line_price: 90 },
    ];
    mockState.tables.service_requests = [{ id: 'req-1', metadata: null }];
    await expect(applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: approved }))
      .rejects.toMatchObject({ code: 'scoped_pricing_changed' });
    expect(mockState.tables.customers[0].waveguard_tier).toBe('Silver');
    expect(mockState.tables.scheduled_services.every((r) => r.estimated_price === 90)).toBe(true);
  });

  test('unchanged live state applies the FRESH plan under the lock — the lock is the first statement, the demote and reprice land, the request is stamped', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    const approved = scopedPricingFingerprint(entry);
    mockState.tables.scheduled_services = [{ ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }];
    mockState.tables.service_requests = [{ id: 'req-1', metadata: null }];
    require('../models/db').raw.mockClear();
    const out = await applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: approved });
    expect(lockCalls()[0]).toEqual(['customer-comms:c1']);
    expect(out.plan.remaining).toEqual(['pest_control']);
    expect(mockState.tables.customers[0].waveguard_tier).toBe('Bronze');
    expect(mockState.tables.scheduled_services[0].estimated_price).toBeGreaterThan(90);
    expect(JSON.parse(mockState.tables.service_requests[0].metadata).cancel_plan.scopedWindDownCommitted).toBe(true);
  });

  test('a plan hold takes the same writer lock before touching the ledger', async () => {
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'monthly_membership', active: true, tier_protected_until: null }],
      components: [{ customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 90 }, { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 }],
      visits: [visitRow('lawn_care'), visitRow('pest_control')],
    });
    const db = require('../models/db');
    db.raw.mockClear();
    // A ledger writer commits just before the hold's transaction opens: the
    // rate the hold records must be the one read UNDER the lock, not the
    // eligibility read from before the visit moves.
    const openTrx = db.transaction;
    db.transaction = async (cb) => {
      mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care').monthly_rate = 75;
      return openTrx(cb);
    };
    try {
      const res = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) });
      expect(res.holdId).toBeTruthy();
    } finally { db.transaction = openTrx; }
    expect(lockCalls()).toContainEqual(['customer-comms:c1']);
    expect(Number(mockState.tables.plan_holds[0].held_monthly_rate)).toBe(75);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(60);
  });
});

test('a hold is refused under the lock when a visit to skip was cancelled in the gap, a moved prepaid visit is gone, or a concurrent hold landed', async () => {
  const db = require('../models/db');
  seed({
    customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true, tier_protected_until: null }],
    visits: [lawnVisit('l1', daysOut(5))],
  });
  const openTrx = db.transaction;
  // A scoped wind-down cancelled the lawn visits between the plan and the hold write.
  db.transaction = async (cb) => { mockState.tables.scheduled_services[0].status = 'cancelled'; return openTrx(cb); };
  try {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) })).rejects.toMatchObject({ code: 'hold_setup_failed' });
  } finally { db.transaction = openTrx; }
  expect(mockState.tables.plan_holds || []).toHaveLength(0);
  expect(mockState.tables.customers[0].tier_protected_until).toBeNull();

  // A prepaid visit already moved to the return date is cancelled in the gap: refused, the move is put back.
  seed({
    customers: [{ id: 'c1', monthly_rate: null, billing_mode: 'per_application', active: true, tier_protected_until: null }],
    visits: [lawnVisit('p1', daysOut(5)), lawnVisit('s1', daysOut(12))],
  });
  mockCovered.mockResolvedValue(new Set(['p1']));
  db.transaction = async (cb) => { mockState.tables.scheduled_services.find((v) => v.id === 'p1').status = 'cancelled'; return openTrx(cb); };
  try {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) })).rejects.toMatchObject({ code: 'hold_setup_failed' });
  } finally { db.transaction = openTrx; }
  expect(mockReschedule).toHaveBeenLastCalledWith('p1', daysOut(5), { start: '08:00', end: '10:00' }, 'plan_hold_revert', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
  expect(mockState.tables.plan_holds || []).toHaveLength(0);

  // A concurrent hold for the same family committed first.
  seed({ customers: [{ id: 'c1', monthly_rate: null, billing_mode: 'per_application', active: true, tier_protected_until: null }], visits: [lawnVisit('l1', daysOut(5))] });
  db.transaction = async (cb) => { mockState.tables.plan_holds = [{ id: 'h-race', customer_id: 'c1', family_key: 'lawn_care', status: 'active', created_at: new Date() }]; return openTrx(cb); };
  try {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) })).rejects.toMatchObject({ code: 'hold_setup_failed' });
  } finally { db.transaction = openTrx; }
  expect(mockState.tables.plan_holds).toHaveLength(1);
});

test('a visit booked into the pause in the gap refuses the hold — the skip set must match the live in-pause set by identity', async () => {
  const db = require('../models/db');
  seed({
    customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true, tier_protected_until: null }],
    visits: [lawnVisit('l1', daysOut(5))],
  });
  const openTrx = db.transaction;
  db.transaction = async (cb) => {
    mockState.tables.scheduled_services.push(lawnVisit('l-new', daysOut(20)));
    return openTrx(cb);
  };
  try {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) })).rejects.toMatchObject({ code: 'hold_setup_failed' });
  } finally { db.transaction = openTrx; }
  expect(mockState.tables.plan_holds || []).toHaveLength(0);
  expect(mockTransition).not.toHaveBeenCalled();
});

describe('boundary re-plan refusals', () => {
  const visitRow = (family, extra = {}) => ({
    id: `v-${family}`, customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(10),
    recurring_ongoing: true, is_recurring: true, service_type: family === 'lawn_care' ? 'Lawn Care Service' : 'Quarterly Pest Control Service',
    ...extra,
  });
  const perAppCustomer = () => ({ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true });

  test('a live row still in the swept (pinned) family — booked after the sweep — refuses the wind-down instead of demoting around it', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    const approved = scopedPricingFingerprint(entry);
    // The sweep cancelled v-lawn_care; a new lawn visit was booked afterwards.
    mockState.tables.scheduled_services = [
      { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 },
      { ...visitRow('lawn_care'), id: 'lawn-new' },
    ];
    const fresh = await planScopedWindDown('c1', ['lawn_care'], require('../models/db'), { pinnedScope: entry.inScope });
    expect(fresh).toEqual(expect.objectContaining({ ok: false, error: 'scope_still_live', families: ['lawn_care'] }));
    mockState.tables.service_requests = [{ id: 'req-1', metadata: null }];
    await expect(applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: approved }))
      .rejects.toMatchObject({ code: 'scoped_pricing_changed' });
    expect(mockState.tables.customers[0].waveguard_tier).toBe('Silver');
  });

  test('a read failure during the boundary re-plan is NOT pricing drift — it propagates as a plain wind-down failure', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), { ...visitRow('pest_control'), estimated_price: 90, primary_line_price: 90 }] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    const db = require('../models/db');
    const real = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (String(table).startsWith('customers')) return { where() { return this; }, forUpdate() { return this; }, first: async () => { throw new Error('connection reset'); } };
      return real(table);
    });
    try {
      const err = await applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: scopedPricingFingerprint(entry) }).catch((e) => e);
      expect(err.message).toMatch(/connection reset/);
      expect(err.code).toBeUndefined();
    } finally { db.mockImplementation(real); }
  });
});

describe('boundary inputs and holds under the lock (Codex r3)', () => {
  const visitRow = (family, extra = {}) => ({
    id: `v-${family}`, customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(10),
    recurring_ongoing: true, is_recurring: true, service_type: family === 'lawn_care' ? 'Lawn Care Service' : 'Quarterly Pest Control Service',
    ...extra,
  });
  const perAppCustomer = () => ({ id: 'c1', waveguard_tier: 'Silver', monthly_rate: null, billing_mode: 'per_application', active: true });

  test('the fingerprint carries the pre-cancel tier and billing mode — a tier or mode edit during the sweep is refused even with unchanged priced outputs', async () => {
    seed({ customers: [perAppCustomer()], visits: [visitRow('lawn_care'), visitRow('pest_control')] });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    const approved = scopedPricingFingerprint(entry);
    expect(approved).toMatch(/\|tierbefore=Silver\|mode=per_application$/);
    // No priced rows (no per-app prices) → tier/monthly/rates/perapp identical…
    mockState.tables.scheduled_services = [visitRow('pest_control')];
    mockState.tables.customers[0].billing_mode = 'monthly_membership';
    mockState.tables.service_requests = [{ id: 'req-1', metadata: null }];
    // …but the lane changed: refused, nothing applied.
    await expect(applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: approved }))
      .rejects.toMatchObject({ code: 'scoped_pricing_changed' });
    expect(mockState.tables.customers[0].waveguard_tier).toBe('Silver');
  });

  test('the wind-down transaction locks the customers row and retires an in-scope hold that slipped in after the unlocked invalidation pass', async () => {
    seed({
      customers: [perAppCustomer()],
      visits: [visitRow('lawn_care'), visitRow('pest_control')],
      holds: [{ id: 'h-late', customer_id: 'c1', family_key: 'lawn_care', status: 'active', resume_on: daysOut(30) },
        { id: 'h-keep', customer_id: 'c1', family_key: 'pest_control', status: 'active', resume_on: daysOut(30) }],
    });
    const entry = await planScopedWindDown('c1', ['lawn_care']);
    mockState.tables.scheduled_services = [visitRow('pest_control')];
    mockState.tables.service_requests = [{ id: 'req-1', metadata: null }];
    mockState.forUpdate = 0;
    await applyScopedWindDown('c1', entry, { requestId: 'req-1', scopedFamilies: ['lawn_care'], approvedScopedPricing: scopedPricingFingerprint(entry) });
    expect(mockState.forUpdate).toBeGreaterThan(0);
    expect(mockState.tables.plan_holds.find((h) => h.id === 'h-late').status).toBe('cancelled');
    expect(mockState.tables.plan_holds.find((h) => h.id === 'h-keep').status).toBe('active');
  });
});
