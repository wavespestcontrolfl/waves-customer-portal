// Exercise the real forecast, both HTTP handlers and the cron coordinator.
// Only persistence, plan lookup and auth are mocked; conversion/date math stay real.
jest.mock('../models/db', () => Object.assign(jest.fn(), { transaction: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), customerBillingModeColumnExists: jest.fn(async () => true) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireTechOrAdmin: jest.fn(), requireAdmin: jest.fn(),
}));

const db = require('../models/db');
const { buildPlanForService, customerBillingModeColumnExists } = require('../services/waveguard-plan-engine');
const { buildWaveGuardInventoryForecast, runWaveGuardInventoryForecastCheck } = require('../services/waveguard-inventory-forecast');
const router = require('../routes/admin-inventory');

// Read-only query double: unexpected tables/writes fail instead of touching a DB.
function readQuery(rows) {
  const q = {};
  for (const method of ['leftJoin', 'whereBetween', 'whereNotIn', 'whereIn', 'where', 'select', 'orderBy']) {
    q[method] = jest.fn(() => q);
  }
  q.limit = jest.fn(async () => rows);
  return q;
}

function item(id, amount, amountUnit, inventory) {
  return { product: { id, name: id, inventory }, mix: { amount, amountUnit } };
}

async function get(path, query = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods.get);
  const res = { json: jest.fn() };
  const next = jest.fn();
  await route.route.stack[0].handle({ query }, res, next);
  return { body: res.json.mock.calls[0]?.[0], next };
}

let visits;
let products;
beforeEach(() => {
  jest.resetAllMocks();
  customerBillingModeColumnExists.mockResolvedValue(true);
  // Fixed clock deliberately straddles UTC/ET dates; no freshness validator involved.
  jest.useFakeTimers().setSystemTime(new Date('2030-01-10T02:00:00Z'));
  visits = readQuery([
    { id: 'visit-1', scheduled_date: '2030-01-09' },
    { id: 'visit-2', scheduled_date: '2030-01-10' },
    { id: 'visit-3', scheduled_date: '2030-01-11' },
  ]);
  products = readQuery([]);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as ss') return visits;
    if (table === 'products_catalog') return products;
    throw new Error(`Unexpected table: ${table}`);
  });
  const stock = { unit: 'gal', onHand: 1, lowStockThreshold: 0.25 };
  buildPlanForService.mockImplementation(async (id) => {
    if (id === 'visit-3') throw new Error('Plan unavailable');
    const items = id === 'visit-2' ? [item('short', 96, 'fl_oz', stock)] : [
      item('short', 64, 'fl_oz', stock),
      item('warning', 96, 'fl_oz', stock),
      item('mismatch', 2, 'lb', { unit: 'gal', onHand: 10 }),
      item('untracked', 2, 'lb', { unit: 'lb', onHand: null }),
      item('ok', 1, 'lb', { unit: 'lb', onHand: 4 }),
      item('zero', 0, 'gal', stock),
    ];
    return { propertyGate: { serviceTier: 'Silver' }, mixCalculator: { items } };
  });
});
afterEach(() => jest.useRealTimers());

test('forecast converts quantities, orders risks and preserves partial plan failures', async () => {
  const result = await buildWaveGuardInventoryForecast({ days: 2, limit: 20 });
  expect(result).toMatchObject({
    startDate: '2030-01-09', endDate: '2030-01-11', days: 2,
    serviceCount: 3, productCount: 5,
    statusCounts: { short: 1, warning: 1, unit_mismatch: 1, not_tracked: 1, ok: 1 },
    generatedAt: '2030-01-10T02:00:00.000Z',
    errors: [{ serviceId: 'visit-3', scheduledDate: '2030-01-11', customerName: 'Customer', message: 'Plan unavailable' }],
  });
  expect(result.products.map(({ productId, status, committedDemand, projectedRemaining, recommendedOrderQuantity }) =>
    [productId, status, committedDemand, projectedRemaining, recommendedOrderQuantity])).toEqual([
    ['short', 'short', 1.25, -0.25, 0.5],
    ['warning', 'warning', 0.75, 0.25, 0],
    ['mismatch', 'unit_mismatch', 0, 10, 0],
    ['untracked', 'not_tracked', 2, null, 2],
    ['ok', 'ok', 1, 3, 0],
  ]);
  expect(result.products[0]).toMatchObject({
    firstShortDate: '2030-01-10', priority: 'urgent', shortfall: 0.25,
    conversionConfidence: 'converted', targetStock: 1.5,
    appointments: [{ serviceId: 'visit-1', inventoryAmount: 0.5 }, { serviceId: 'visit-2', inventoryAmount: 0.75 }],
  });
  expect(result.products[2]).toMatchObject({
    unconvertedDemand: 2, unitMismatchCount: 1, conversionConfidence: 'needs_review', appointments: [],
    mismatchAppointments: [{ serviceId: 'visit-1', amount: 2, inventoryAmount: null }],
  });
  expect(visits.whereBetween).toHaveBeenCalledWith('ss.scheduled_date', ['2030-01-09', '2030-01-11']);
  expect(visits.whereIn).toHaveBeenCalledWith('c.waveguard_tier', ['Bronze', 'Silver', 'Gold', 'Platinum']);
  expect(visits.whereNotIn).toHaveBeenCalledWith('ss.status', ['completed', 'cancelled', 'canceled', 'void']);
  expect(visits.limit).toHaveBeenCalledWith(20);
  expect(db.transaction).not.toHaveBeenCalled();
});

test.each([
  ['lawn_archived_recipe_unavailable', 'The assigned archived recipe cannot be reproduced with the current products and rates. Review the assigned protocol and enter the actual work.'],
  ['lawn_protocol_unresolved', 'The appointment has no matching lawn protocol; suggested amounts are unavailable.'],
  ['lawn_property_unresolved', 'The saved turf profile does not prove this service property; suggested amounts are unavailable.'],
])('forecast reports an appointment the planner withheld (%s) instead of counting zero demand', async (code, message) => {
  visits = readQuery([{ id: 'visit-withheld', scheduled_date: '2030-01-10', first_name: 'Ada', last_name: 'Lovelace' }]);
  buildPlanForService.mockResolvedValue({
    mixCalculator: { items: [] },
    propertyGate: { serviceTier: 'Silver', blocks: [{ code, severity: 'block', message }] },
  });
  const result = await buildWaveGuardInventoryForecast({ days: 2, limit: 20 });
  expect(result.errors).toEqual([{ serviceId: 'visit-withheld', scheduledDate: '2030-01-10', customerName: 'Ada Lovelace', message }]);
  expect(result).toMatchObject({ serviceCount: 1, productCount: 0, products: [] });
});

test.each([
  ['per_visit', {}, false],
  ['one_time', {}, false],
  ['per_application', {}, true],
  ['one_time', { protocolKey: 'protocol', protocolVersion: '1', windowKey: 'june' }, true],
])('forecast counts a lingering-tier visit on an explicit %s lane only when the program predicate applies (assignment %j → counted %s) (codex #4365 r7 P2)', async (billingMode, appointmentAssignment, counted) => {
  visits = readQuery([{ id: 'visit-lane', scheduled_date: '2030-01-10', first_name: 'Ada', last_name: 'Lovelace' }]);
  buildPlanForService.mockResolvedValue({
    propertyGate: { serviceTier: 'Silver', billingMode },
    appointmentAssignment,
    mixCalculator: { items: [item('short', 64, 'fl_oz', { unit: 'gal', onHand: 1, lowStockThreshold: 0.25 })] },
  });
  const result = await buildWaveGuardInventoryForecast({ days: 2, limit: 20 });
  expect(result.errors).toEqual([]);
  if (counted) {
    expect(result.productCount).toBe(1);
    expect(result.skippedNonProgram).toEqual([]);
  } else {
    expect(result.productCount).toBe(0);
    // Office-only lane stays out of the (technician-readable) response (codex #4365 r8 P2).
    expect(result.skippedNonProgram).toEqual([{ serviceId: 'visit-lane', scheduledDate: '2030-01-10', customerName: 'Ada Lovelace' }]);
  }
});

const laneWhereClause = (query) => {
  const clauses = query.where.mock.calls.map(([arg]) => arg).filter((arg) => typeof arg === 'function' && arg.name === 'programLane');
  if (!clauses.length) return null;
  const calls = [];
  const builder = {};
  for (const method of ['whereNull', 'orWhereNotIn', 'orWhere', 'whereNotNull']) {
    builder[method] = jest.fn((...args) => { calls.push([method, ...args]); if (method === 'orWhere' && typeof args[0] === 'function') args[0].call(builder); return builder; });
  }
  clauses[0].call(builder);
  return calls;
};

test('non-program lanes are excluded in SQL before the limit when the column exists (codex #4365 r8 P2)', async () => {
  await buildWaveGuardInventoryForecast({ days: 2, limit: 20 });
  const calls = laneWhereClause(visits);
  expect(calls).toEqual([
    ['whereNull', 'c.billing_mode'],
    ['orWhereNotIn', 'c.billing_mode', ['per_visit', 'one_time']],
    ['orWhere', expect.any(Function)],
    ['whereNotNull', 'ss.lawn_protocol_key'],
    ['whereNotNull', 'ss.lawn_protocol_version'],
    ['whereNotNull', 'ss.lawn_protocol_window_key'],
  ]);
  // The lane clause is applied before the limit consumes the window's slots.
  expect(visits.where.mock.invocationCallOrder.at(-1)).toBeLessThan(visits.limit.mock.invocationCallOrder[0]);
});

test('a legacy schema (no billing_mode column) adds no lane clause', async () => {
  customerBillingModeColumnExists.mockResolvedValue(false);
  await buildWaveGuardInventoryForecast({ days: 2, limit: 20 });
  expect(laneWhereClause(visits)).toBeNull();
});

test('forecast HTTP handler returns computed demand and forwards query bounds', async () => {
  const { body, next } = await get('/waveguard-forecast', { days: '2', limit: '20' });
  expect(next).not.toHaveBeenCalled();
  expect(body.forecast).toMatchObject({ days: 2, endDate: '2030-01-11', productCount: 5 });
  expect(body.forecast.products[0]).toMatchObject({ productId: 'short', committedDemand: 1.25, recommendedOrderQuantity: 0.5 });
  expect(visits.limit).toHaveBeenCalledWith(20);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('unit-review HTTP handler keeps only mismatches from the computed forecast', async () => {
  const { body, next } = await get('/unit-review', { days: '2', limit: '20' });
  expect(next).not.toHaveBeenCalled();
  expect(body).toMatchObject({ products: [], forecastError: null, counts: { products: 0, forecastRows: 1 } });
  expect(body.forecastRows).toEqual([{
    productId: 'mismatch', productName: 'mismatch', inventoryUnit: 'gal', demandUnit: 'lb',
    unconvertedDemand: 2, unitMismatchCount: 1,
    appointments: [expect.objectContaining({ serviceId: 'visit-1', inventoryAmount: null, unit: 'lb' })],
  }]);
  expect(visits.limit).toHaveBeenCalledWith(20);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('forecast failures propagate on the forecast route but preserve the unit-review catalog', async () => {
  const failure = new Error('Forecast read unavailable');
  visits.limit.mockRejectedValue(failure);
  products.limit.mockResolvedValue([{ id: 'catalog-1', name: 'Untracked product', inventory_unit: 'bottle' }]);
  const forecast = await get('/waveguard-forecast');
  expect(forecast.body).toBeUndefined();
  expect(forecast.next).toHaveBeenCalledWith(failure);
  const review = await get('/unit-review');
  expect(review.next).not.toHaveBeenCalled();
  expect(review.body).toMatchObject({ forecastRows: [], forecastError: failure.message, counts: { products: 1, forecastRows: 0 } });
  expect(review.body.products).toHaveLength(1);
});

test('cron runs forecast and deduplicated alert writes on its locked transaction', async () => {
  const alert = {};
  for (const method of ['insert', 'onConflict', 'merge']) alert[method] = jest.fn(() => alert);
  alert.returning = jest.fn(async () => [{ id: 'alert-1' }]);
  const trx = jest.fn((table) => {
    if (table === 'scheduled_services as ss') return visits;
    if (table === 'admin_alerts') return alert;
    throw new Error(`Unexpected transaction table: ${table}`);
  });
  trx.raw = jest.fn(async () => undefined);
  trx.schema = { hasTable: jest.fn(async () => true) };
  db.transaction.mockImplementation(async (fn) => fn(trx));

  const result = await runWaveGuardInventoryForecastCheck({ days: 2, limit: 20 });
  expect(result).toMatchObject({ skipped: false, productCount: 5, serviceCount: 3, short: 1, alert: { alertId: 'alert-1', actionable: 4 } });
  expect(db).not.toHaveBeenCalled();
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['waveguard-inventory-forecast-cron']);
  expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(buildPlanForService.mock.invocationCallOrder[0]);
  // One schema probe per batch, passed to every plan build (codex #4365 r4 P2).
  expect(customerBillingModeColumnExists).toHaveBeenCalledTimes(1);
  expect(customerBillingModeColumnExists).toHaveBeenCalledWith(trx);
  expect(buildPlanForService.mock.calls).toEqual([
    ['visit-1', { db: trx, billingModeColumnExists: true }], ['visit-2', { db: trx, billingModeColumnExists: true }], ['visit-3', { db: trx, billingModeColumnExists: true }],
  ]);
  expect(alert.insert).toHaveBeenCalledWith(expect.objectContaining({ dedupe_key: 'waveguard_inventory_forecast', severity: 'high' }));
  expect(alert.onConflict).toHaveBeenCalledWith('dedupe_key');
  expect(alert.merge).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', severity: 'high' }));
});
