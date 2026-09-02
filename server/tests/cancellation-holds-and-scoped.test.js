'use strict';
// C2 holds (ruling C-4) + the scoped wind-down plan (ruling C-3).
// db is mocked with a table router; SmartRebooker and messaging are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
const mockReschedule = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/rebooker', () => ({ reschedule: (...a) => mockReschedule(...a) }));
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
    whereIn(k, vals) { const c = String(k).split('.').pop(); filters.push((r) => vals.map(String).includes(String(r[c]))); return builder; },
    whereNot(arg) { const e = Object.entries(arg); filters.push((r) => !e.every(([k, v]) => String(r[k]) === String(v))); return builder; },
    whereNull(k) { filters.push((r) => r[k] == null); return builder; },
    whereRaw() { return builder; },
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

const { startHold, runPlanHoldLifecycle } = require('../services/cancellation-resolution/holds');
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

beforeEach(() => {
  mockReschedule.mockClear();
  mockSms.mockClear();
  seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership', tier_protected_until: null }] });
});

describe('startHold (ruling C-4)', () => {
  test('rejects a past or missing resume date and >180 days', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: null })).rejects.toMatchObject({ code: 'hold_date_invalid' });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(-1) })).rejects.toMatchObject({ code: 'hold_date_invalid' });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(181) })).rejects.toMatchObject({ code: 'hold_too_long' });
  });

  test('pest can never be held; once per family per 12 months', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'pest_control', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_family_invalid' });
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership' }],
      holds: [{ id: 'h0', customer_id: 'c1', family_key: 'lawn_care', status: 'resumed', created_at: new Date() }],
    });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_cooldown' });
  });

  test('a monthly-lane family with no ledger component fails closed', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_unattributed' });
  });

  test('a rate-bearing NON-monthly lane needs no attribution — no dues to suspend (#3140)', async () => {
    // annual_prepay carries a legacy monthly_rate but the dues cron never
    // bills it; the old rate>0 shortcut demanded a component and blocked the
    // hold (Codex #3669 r3 P2).
    seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'annual_prepay', tier_protected_until: null }] });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) });
    expect(result.holdId).toBeTruthy();
    expect(mockState.tables.plan_holds[0].held_monthly_rate).toBe(null);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150); // untouched
  });

  test('happy path: component suspended, scalar recomputed, tier protected, no visit spam', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly_membership', tier_protected_until: null }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 90 },
        { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
      ],
    });
    const result = await startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(90) });
    expect(result.holdId).toBeTruthy();
    const lawn = mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care');
    expect(Number(lawn.monthly_rate)).toBe(0);
    const customer = mockState.tables.customers[0];
    expect(Number(customer.monthly_rate)).toBe(60);
    expect(String(customer.tier_protected_until)).toBe(daysOut(90));
    expect(mockState.tables.plan_holds).toHaveLength(1);
    expect(Number(mockState.tables.plan_holds[0].held_monthly_rate)).toBe(90);
  });
});

describe('runPlanHoldLifecycle', () => {
  test('reminds once at ≤7 days out, resumes on the date and restores the rate', async () => {
    seed({
      customers: [{ id: 'c1', first_name: 'Pat', phone: '+19415550000', monthly_rate: 60, billing_mode: 'monthly_membership', tier_protected_until: daysOut(5) }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' },
        { customer_id: 'c1', family_key: 'pest_control', monthly_rate: 60 },
      ],
      holds: [{ id: 'h1', customer_id: 'c1', family_key: 'lawn_care', status: 'active', resume_on: daysOut(5), held_monthly_rate: 90, reminder_sent_at: null, created_at: new Date() }],
    });
    const first = await runPlanHoldLifecycle({ today: TODAY });
    expect(first.reminded).toBe(1);
    expect(first.resumed).toBe(0);
    expect(mockSms).toHaveBeenCalledTimes(1);

    const second = await runPlanHoldLifecycle({ today: TODAY });
    expect(second.reminded).toBe(0); // reminder claimed, never re-sent

    // The reminder only went out TODAY (5 days before resume) — the 7-day
    // notice period pushes the restart out, so the resume date itself does
    // NOT resume billing yet.
    const tooEarly = await runPlanHoldLifecycle({ today: daysOut(5) });
    expect(tooEarly.resumed).toBe(0);
    const onResume = await runPlanHoldLifecycle({ today: daysOut(7) });
    expect(onResume.resumed).toBe(1);
    const lawn = mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care');
    expect(Number(lawn.monthly_rate)).toBe(90);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150);
    expect(mockState.tables.customers[0].tier_protected_until).toBe(null);
    expect(mockState.tables.plan_holds[0].status).toBe('resumed');
  });
});

describe('runPlanHoldLifecycle — notice period (codex r2)', () => {
  test('a reminder delivered late pushes the restart AND the parked visits out 7 days from delivery', async () => {
    seed({
      customers: [{ id: 'c1', first_name: 'Pat', phone: '+19415550000', monthly_rate: 60, billing_mode: 'monthly_membership', tier_protected_until: daysOut(2) }],
      components: [{ customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' }],
      holds: [{ id: 'h2', customer_id: 'c1', family_key: 'lawn_care', status: 'active', resume_on: daysOut(2), held_monthly_rate: 90, reminder_sent_at: null, created_at: new Date(), moved_visits: JSON.stringify({ moved: [] }) }],
      visits: [{ id: 'v1', customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(2), service_type: 'Lawn Care Service', window_start: '08:00', window_end: '10:00' }],
    });
    // Day 0: reminder goes out (2 days before the old resume date).
    const first = await runPlanHoldLifecycle({ today: TODAY });
    expect(first.reminded).toBe(1);
    // Day 2: resume date reached but only 2 days of notice → restart and
    // the visit both move to day 7; billing stays suspended.
    const onOldDate = await runPlanHoldLifecycle({ today: daysOut(2) });
    expect(onOldDate.resumed).toBe(0);
    expect(String(mockState.tables.plan_holds[0].resume_on)).toBe(daysOut(7));
    expect(mockReschedule).toHaveBeenCalledWith('v1', daysOut(7), expect.objectContaining({ start: '08:00' }), 'plan_hold_notice', 'system', {});
    expect(Number(mockState.tables.customer_plan_rates[0].monthly_rate)).toBe(0);
    // Day 7: full notice elapsed → resumes.
    const onNew = await runPlanHoldLifecycle({ today: daysOut(7) });
    expect(onNew.resumed).toBe(1);
    expect(Number(mockState.tables.customer_plan_rates[0].monthly_rate)).toBe(90);
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
