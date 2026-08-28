// getAutopaySelectedMethodIds — the "which rows is Auto Pay USING" identity
// shared by the portal removal guard, the row hierarchy, and (by mirror)
// the detached-webhook cleanup. Broader than the chargeable resolver on
// purpose: expired/blocked in-charge rows are still selected.

jest.mock('../models/db', () => jest.fn());

const { getAutopaySelectedMethodIds } = require('../services/autopay-eligibility');

function knexFor(state) {
  return (table) => {
    const conds = [];
    const b = {};
    const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
    b.where = jest.fn((criteria) => {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
      return b;
    });
    b.orderBy = jest.fn(() => b);
    b.select = jest.fn(() => b);
    b.first = jest.fn(async () => rows()[0] || null);
    b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
    return b;
  };
}

const pm = (overrides) => ({
  customer_id: 'c1', processor: 'stripe', method_type: 'card', exp_month: 12, exp_year: 2032,
  is_default: false, autopay_enabled: false, ach_status: null, updated_at: '2026-01-01', ...overrides,
});

test('Auto Pay off → empty, regardless of flags', async () => {
  const state = { payment_methods: [pm({ id: 'a', stripe_payment_method_id: 'pm_a', is_default: true, autopay_enabled: true })] };
  const ids = await getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: false, autopay_payment_method_id: 'a', ach_status: null }, knexFor(state));
  expect(ids).toEqual([]);
});

test('pointer method that is chargeable → exactly that id', async () => {
  const state = { payment_methods: [
    pm({ id: 'a', stripe_payment_method_id: 'pm_a', is_default: true, autopay_enabled: true }),
    pm({ id: 'b', stripe_payment_method_id: 'pm_b' }),
  ] };
  const ids = await getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: 'a', ach_status: null }, knexFor(state));
  expect(ids).toEqual(['a']);
});

test('EXPIRED pointer stays selected; the chargeable fallback the walk would bill is selected too', async () => {
  const state = { payment_methods: [
    pm({ id: 'old', stripe_payment_method_id: 'pm_old', is_default: true, autopay_enabled: true, exp_month: 1, exp_year: 2020, updated_at: '2026-02-01' }),
    pm({ id: 'dup', stripe_payment_method_id: 'pm_dup', is_default: true, autopay_enabled: true, updated_at: '2026-01-01' }),
  ] };
  const ids = await getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: 'old', ach_status: null }, knexFor(state));
  expect(ids.sort()).toEqual(['dup', 'old']);
});

test('no pointer → every default+enabled row (the charge() walk candidates)', async () => {
  const state = { payment_methods: [
    pm({ id: 'x', stripe_payment_method_id: 'pm_x', is_default: true, autopay_enabled: true }),
    pm({ id: 'y', stripe_payment_method_id: 'pm_y', is_default: false, autopay_enabled: true }),
  ] };
  const ids = await getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: null, ach_status: null }, knexFor(state));
  expect(ids).toEqual(['x']);
});

test('missing customer fields are looked up, not assumed', async () => {
  const state = {
    customers: [{ id: 'c1', autopay_enabled: true, autopay_payment_method_id: 'a', ach_status: null }],
    payment_methods: [pm({ id: 'a', stripe_payment_method_id: 'pm_a', is_default: true, autopay_enabled: true })],
  };
  const ids = await getAutopaySelectedMethodIds({ id: 'c1' }, knexFor(state));
  expect(ids).toEqual(['a']);
});

test('resolver read failure → the pointer is still reported by default (safe direction: refuse removal); throws with rethrow', async () => {
  const boom = () => { throw new Error('db down'); };
  await expect(getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: 'a', ach_status: null }, boom)).resolves.toEqual(['a']);
  await expect(getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: null, ach_status: null }, boom)).resolves.toEqual([]);
  await expect(getAutopaySelectedMethodIds({ id: 'c1', autopay_enabled: true, autopay_payment_method_id: 'a', ach_status: null }, boom, { rethrow: true })).rejects.toThrow('db down');
});
