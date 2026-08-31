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
const { planScopedWindDown } = require('../services/cancellation-processor');
const { etDateString } = require('../utils/datetime-et');

function seed({ holds = [], customers = [], components = [], visits = [] } = {}) {
  mockState.tables = {
    plan_holds: holds,
    customers,
    customer_plan_rates: components,
    scheduled_services: visits,
    customer_interactions: [],
    services: [],
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
  seed({ customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly', tier_protected_until: null }] });
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
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly' }],
      holds: [{ id: 'h0', customer_id: 'c1', family_key: 'lawn_care', status: 'resumed', created_at: new Date() }],
    });
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_cooldown' });
  });

  test('a monthly-lane family with no ledger component fails closed', async () => {
    await expect(startHold({ customerId: 'c1', caseId: 'k', familyKey: 'lawn_care', resumeOn: daysOut(60) })).rejects.toMatchObject({ code: 'hold_unattributed' });
  });

  test('happy path: component suspended, scalar recomputed, tier protected, no visit spam', async () => {
    seed({
      customers: [{ id: 'c1', monthly_rate: 150, billing_mode: 'monthly', tier_protected_until: null }],
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
      customers: [{ id: 'c1', first_name: 'Pat', phone: '+19415550000', monthly_rate: 60, billing_mode: 'monthly', tier_protected_until: daysOut(5) }],
      components: [
        { customer_id: 'c1', family_key: 'lawn_care', monthly_rate: 0 },
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

    const onResume = await runPlanHoldLifecycle({ today: daysOut(5) });
    expect(onResume.resumed).toBe(1);
    const lawn = mockState.tables.customer_plan_rates.find((c) => c.family_key === 'lawn_care');
    expect(Number(lawn.monthly_rate)).toBe(90);
    expect(Number(mockState.tables.customers[0].monthly_rate)).toBe(150);
    expect(mockState.tables.customers[0].tier_protected_until).toBe(null);
    expect(mockState.tables.plan_holds[0].status).toBe('resumed');
  });
});

describe('planScopedWindDown (ruling C-3)', () => {
  const visitRow = (family, extra = {}) => ({
    id: `v-${family}`, customer_id: 'c1', status: 'confirmed', scheduled_date: daysOut(10),
    recurring_ongoing: true, is_recurring: true, service_type: family === 'lawn_care' ? 'Lawn Care Service' : 'Quarterly Pest Control Service',
    ...extra,
  });

  test('fails closed on unowned scope, whole-account scope, and unattributed monthly lane', async () => {
    seed({ customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'monthly', active: true }], visits: [visitRow('lawn_care'), visitRow('pest_control')] });
    expect((await planScopedWindDown('c1', ['mosquito'])).error).toBe('scope_not_owned');
    expect((await planScopedWindDown('c1', ['lawn_care', 'pest_control'])).error).toBe('scope_is_whole_account');
    expect((await planScopedWindDown('c1', ['lawn_care'])).error).toBe('scoped_unattributed');
  });

  test('demotes the tier and reprices the remaining family from its gross', async () => {
    seed({
      customers: [{ id: 'c1', waveguard_tier: 'Silver', monthly_rate: 150, billing_mode: 'monthly', active: true }],
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
});
