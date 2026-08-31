/** Read-only detect step of the churned-accounts audit (now shared with the daily sweep). */
jest.mock('../models/db', () => jest.fn());
const { auditChurnedAccountsLiveState, CANCELLABLE } = require('../scripts/audit-churned-accounts-live-state');

function fakeDb(rows) {
  const db = jest.fn((table) => {
    const b = {};
    for (const m of ['where', 'whereIn', 'orWhere']) b[m] = jest.fn(() => b);
    b.select = jest.fn(async () => rows[table] || []);
    return b;
  });
  db.schema = { hasTable: jest.fn(async () => Object.prototype.hasOwnProperty.call(rows, 'customer_plan_rates')) };
  return db;
}

test('returns an empty result without touching other tables when nothing is churned', async () => {
  const db = fakeDb({ customers: [] });
  expect(await auditChurnedAccountsLiveState({ db, today: '2026-01-02' })).toEqual({ churned: 0, withLiveState: 0, counts: {}, findings: [] });
  expect(db).toHaveBeenCalledTimes(1);
});

test('flags every live-state signal by id only and counts by flag name', async () => {
  const db = fakeDb({
    customers: [
      { id: 'a', pipeline_stage: 'churned', active: false, waveguard_tier: 'Gold', monthly_rate: '79', billing_mode: null, autopay_enabled: true },
      { id: 'b', pipeline_stage: 'churned', active: false, waveguard_tier: null, monthly_rate: '50', billing_mode: 'per_visit', autopay_enabled: false },
      { id: 'c', pipeline_stage: 'active_customer', active: false, waveguard_tier: null, monthly_rate: 0, billing_mode: 'monthly_membership', autopay_enabled: false },
    ],
    customer_plan_rates: [{ customer_id: 'b' }],
    scheduled_services: [{ customer_id: 'c' }],
    payment_methods: [{ customer_id: 'a' }],
  });
  const res = await auditChurnedAccountsLiveState({ db, today: '2026-01-02' });
  expect(res.churned).toBe(3);
  expect(res.withLiveState).toBe(3);
  const flags = Object.fromEntries(res.findings.map((f) => [f.id, f.flags]));
  expect(flags.a).toEqual(['tier=Gold', 'monthly_rate=79', 'customer_autopay_on', 'method_autopay_on']);
  expect(flags.b).toEqual(['plan_rates_row']); // per_visit lane: a legacy rate is not live monthly state
  expect(flags.c).toEqual(expect.arrayContaining(['billing_mode=monthly_membership', 'recurring_ongoing', 'upcoming_visit']));
  expect(res.counts).toMatchObject({ tier: 1, monthly_rate: 1, plan_rates_row: 1 });
  expect(JSON.stringify(res)).not.toMatch(/name|phone|email/);
  expect(CANCELLABLE).toContain('scheduled');
});
