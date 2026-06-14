// Plan-gating for WaveGuard "existing customer" detection.
//
// The estimate flow must treat a customer as an EXISTING member only when they
// actually hold a WaveGuard plan (customers.waveguard_tier) — NOT merely because
// they have a recurring scheduled visit. Regression: Cristina Lipham was a "No
// Plan" lead whose first quarterly service had been scheduled; that single
// pending row wrongly waived her $99 setup and hid the annual-prepay option.

const {
  isMembershipCustomerRow,
  isActivePlanCustomer,
  loadExistingRecurringQualifyingRows,
} = require('../services/waveguard-existing-services');

function fakeDb({ customer, scheduledRows = [] } = {}) {
  const db = (table) => ({
    where: () => db(table),
    whereNotIn: () => db(table),
    columnInfo: async () => ({ is_recurring: {}, estimated_price: {} }),
    first: async () => (table === 'customers' ? customer : null),
    select: async () => (table === 'scheduled_services' ? scheduledRows : []),
  });
  return db;
}

describe('isMembershipCustomerRow', () => {
  test('real plan tiers are members', () => {
    for (const tier of ['Bronze', 'Silver', 'Gold', 'Platinum', 'silver']) {
      expect(isMembershipCustomerRow({ waveguard_tier: tier })).toBe(true);
    }
  });

  test('non-plan tiers are NOT members', () => {
    for (const tier of [null, undefined, '', 'none', 'None', 'One-Time', 'onetime', 'N/A']) {
      expect(isMembershipCustomerRow({ waveguard_tier: tier })).toBe(false);
    }
  });

  test('falls back to a positive recurring monthly_rate when no tier is set', () => {
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 95 })).toBe(true);
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 0 })).toBe(false);
  });
});

describe('isActivePlanCustomer', () => {
  test('true for a member, false for a No-Plan customer', async () => {
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: 'Gold' } }), 'c1')).toBe(true);
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: null } }), 'c1')).toBe(false);
  });

  test('false for an inactive member, missing customer, or missing args', async () => {
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: 'Gold', active: false } }), 'c1')).toBe(false);
    expect(await isActivePlanCustomer(fakeDb({ customer: null }), 'c1')).toBe(false);
    expect(await isActivePlanCustomer(null, 'c1')).toBe(false);
    expect(await isActivePlanCustomer(fakeDb({ customer: {} }), null)).toBe(false);
  });
});

describe('loadExistingRecurringQualifyingRows plan-gate', () => {
  const pestRow = { id: 's1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-09-12' };

  test('returns rows for an actual plan member', async () => {
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: 'Bronze' }, scheduledRows: [pestRow] });
    const rows = await loadExistingRecurringQualifyingRows(db, 'c1');
    expect(rows).toHaveLength(1);
  });

  test('returns [] for a No-Plan customer even with a pending recurring visit', async () => {
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: null }, scheduledRows: [pestRow] });
    const rows = await loadExistingRecurringQualifyingRows(db, 'c1');
    expect(rows).toEqual([]);
  });
});
