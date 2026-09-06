// Exercise the real forecast, both HTTP handlers and the cron coordinator.
// Only persistence, plan lookup and auth are mocked; conversion/date math stay real.
jest.mock('../models/db', () => Object.assign(jest.fn(), { transaction: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireTechOrAdmin: jest.fn(), requireAdmin: jest.fn(),
}));

const db = require('../models/db');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
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
    return { mixCalculator: { items } };
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
  expect(buildPlanForService.mock.calls).toEqual([
    ['visit-1', { db: trx }], ['visit-2', { db: trx }], ['visit-3', { db: trx }],
  ]);
  expect(alert.insert).toHaveBeenCalledWith(expect.objectContaining({ dedupe_key: 'waveguard_inventory_forecast', severity: 'high' }));
  expect(alert.onConflict).toHaveBeenCalledWith('dedupe_key');
  expect(alert.merge).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', severity: 'high' }));
});
